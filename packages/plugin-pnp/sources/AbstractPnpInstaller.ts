import {Installer, LinkOptions, LinkType, MessageName, DependencyMeta, FinalizeInstallStatus} from '@yarnpkg/core';
import {FetchResult, Descriptor, Locator, Package, BuildDirective}                            from '@yarnpkg/core';
import {miscUtils, structUtils}                                                               from '@yarnpkg/core';
import {FakeFS, PortablePath, ppath}                                                          from '@yarnpkg/fslib';
import {PackageRegistry, PnpSettings}                                                         from '@yarnpkg/pnp';
import mm                                                                                     from 'micromatch';

export abstract class AbstractPnpInstaller implements Installer {
  private readonly packageRegistry: PackageRegistry = new Map();

  private readonly blacklistedPaths: Set<PortablePath> = new Set();

  constructor(protected opts: LinkOptions) {
    this.opts = opts;
  }

  /**
   * Called in order to know whether the specified package has build scripts.
   */
  abstract getBuildScripts(locator: Locator, fetchResult: FetchResult): Promise<Array<BuildDirective>>;

  /**
   * Called to transform the package before it's stored in the PnP map. For
   * example we use this in the PnP linker to materialize the packages within
   * their own directories when they have build scripts.
   */
  abstract transformPackage(locator: Locator, dependencyMeta: DependencyMeta, packageFs: FakeFS<PortablePath>, flags: {hasBuildScripts: boolean}): Promise<FakeFS<PortablePath>>;

  /**
   * Called with the full settings, ready to be used by the @yarnpkg/pnp
   * package.
   */
  abstract finalizeInstallWithPnp(pnpSettings: PnpSettings): Promise<Array<FinalizeInstallStatus> | void>;

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    const key1 = structUtils.requirableIdent(pkg);
    const key2 = pkg.reference;

    const hasVirtualInstances =
      pkg.peerDependencies.size > 0 &&
      !structUtils.isVirtualLocator(pkg) &&
      !this.opts.project.tryWorkspaceByLocator(pkg);

    const buildScripts = !hasVirtualInstances
      ? await this.getBuildScripts(pkg, fetchResult)
      : [];

    if (buildScripts.length > 0 && !this.opts.project.configuration.get(`enableScripts`)) {
      this.opts.report.reportWarningOnce(MessageName.DISABLED_BUILD_SCRIPTS, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but all build scripts have been disabled.`);
      buildScripts.length = 0;
    }

    if (buildScripts.length > 0 && pkg.linkType !== LinkType.HARD && !this.opts.project.tryWorkspaceByLocator(pkg)) {
      this.opts.report.reportWarningOnce(MessageName.SOFT_LINK_BUILD, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but is referenced through a soft link. Soft links don't support build scripts, so they'll be ignored.`);
      buildScripts.length = 0;
    }

    const dependencyMeta = this.opts.project.getDependencyMeta(pkg, pkg.version);

    if (buildScripts.length > 0 && dependencyMeta && dependencyMeta.built === false) {
      this.opts.report.reportInfoOnce(MessageName.BUILD_DISABLED, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but its build has been explicitly disabled through configuration.`);
      buildScripts.length = 0;
    }

    const packageFs = !hasVirtualInstances && pkg.linkType !== LinkType.SOFT
      ? await this.transformPackage(pkg, dependencyMeta, fetchResult.packageFs, {hasBuildScripts: buildScripts.length > 0})
      : fetchResult.packageFs;

    const packageRawLocation = ppath.resolve(packageFs.getRealPath(), ppath.relative(PortablePath.root, fetchResult.prefixPath));

    const packageLocation = this.normalizeDirectoryPath(packageRawLocation);
    const packageDependencies = new Map<string, string | [string, string] | null>();
    const packagePeers = new Set<string>();

    for (const descriptor of pkg.peerDependencies.values()) {
      packageDependencies.set(structUtils.requirableIdent(descriptor), null);
      packagePeers.add(structUtils.stringifyIdent(descriptor));
    }

    miscUtils.getMapWithDefault(this.packageRegistry, key1).set(key2, {
      packageLocation,
      packageDependencies,
      packagePeers,
      linkType: pkg.linkType,
      discardFromLookup: fetchResult.discardFromLookup || false,
    });

    if (hasVirtualInstances)
      this.blacklistedPaths.add(packageLocation);

    return {
      packageLocation: packageRawLocation,
      buildDirective: buildScripts.length > 0 ? buildScripts as BuildDirective[] : null,
    };
  }

  async attachInternalDependencies(locator: Locator, dependencies: Array<[Descriptor, Locator]>) {
    const packageInformation = this.getPackageInformation(locator);

    for (const [descriptor, locator] of dependencies) {
      const target = !structUtils.areIdentsEqual(descriptor, locator)
        ? [structUtils.requirableIdent(locator), locator.reference] as [string, string]
        : locator.reference;

      packageInformation.packageDependencies.set(structUtils.requirableIdent(descriptor), target);
    }
  }

  async attachExternalDependents(locator: Locator, dependentPaths: Array<PortablePath>) {
    for (const dependentPath of dependentPaths) {
      const packageInformation = this.getDiskInformation(dependentPath);

      packageInformation.packageDependencies.set(structUtils.requirableIdent(locator), locator.reference);
    }
  }

  async finalizeInstall() {
    this.trimBlacklistedPackages();

    this.packageRegistry.set(null, new Map([
      [null, this.getPackageInformation(this.opts.project.topLevelWorkspace.anchoredLocator)],
    ]));

    const buildIgnorePattern = (ignorePatterns: Array<string>) => {
      if (ignorePatterns.length === 0)
        return null;

      return ignorePatterns.map(pattern => {
        return `(${mm.makeRe(pattern, {
          // @ts-ignore
          windows: false,
        }).source})`;
      }).join(`|`);
    };

    const pnpFallbackMode = this.opts.project.configuration.get(`pnpFallbackMode`);

    const blacklistedLocations = this.blacklistedPaths;
    const dependencyTreeRoots = this.opts.project.workspaces.map(({anchoredLocator}) => ({name: structUtils.requirableIdent(anchoredLocator), reference: anchoredLocator.reference}));
    const enableTopLevelFallback = pnpFallbackMode !== `none`;
    const fallbackExclusionList = [];
    const fallbackPool = this.getPackageInformation(this.opts.project.topLevelWorkspace.anchoredLocator).packageDependencies;
    const ignorePattern = buildIgnorePattern([`.vscode/pnpify/**`, ...this.opts.project.configuration.get(`pnpIgnorePatterns`)]);
    const packageRegistry = this.packageRegistry;
    const shebang = this.opts.project.configuration.get(`pnpShebang`);

    if (pnpFallbackMode === `dependencies-only`)
      for (const pkg of this.opts.project.storedPackages.values())
        if (this.opts.project.tryWorkspaceByLocator(pkg))
          fallbackExclusionList.push({name: structUtils.requirableIdent(pkg), reference: pkg.reference});

    return await this.finalizeInstallWithPnp({
      blacklistedLocations,
      dependencyTreeRoots,
      enableTopLevelFallback,
      fallbackExclusionList,
      fallbackPool,
      ignorePattern,
      packageRegistry,
      shebang,
    });
  }

  private getPackageInformation(locator: Locator) {
    const key1 = structUtils.requirableIdent(locator);
    const key2 = locator.reference;

    const packageInformationStore = this.packageRegistry.get(key1);
    if (!packageInformationStore)
      throw new Error(`Assertion failed: The package information store should have been available (for ${structUtils.prettyIdent(this.opts.project.configuration, locator)})`);

    const packageInformation = packageInformationStore.get(key2);
    if (!packageInformation)
      throw new Error(`Assertion failed: The package information should have been available (for ${structUtils.prettyLocator(this.opts.project.configuration, locator)})`);

    return packageInformation;
  }

  private getDiskInformation(path: PortablePath) {
    const packageStore = miscUtils.getMapWithDefault(this.packageRegistry, `@@disk`);
    const normalizedPath = this.normalizeDirectoryPath(path);

    return miscUtils.getFactoryWithDefault(packageStore, normalizedPath, () => ({
      packageLocation: normalizedPath,
      packageDependencies: new Map(),
      packagePeers: new Set(),
      linkType: LinkType.SOFT,
      discardFromLookup: false,
    }));
  }

  private trimBlacklistedPackages() {
    for (const packageStore of this.packageRegistry.values()) {
      for (const [key2, packageInformation] of packageStore) {
        if (this.blacklistedPaths.has(packageInformation.packageLocation)) {
          packageStore.delete(key2);
        }
      }
    }
  }

  private normalizeDirectoryPath(folder: PortablePath) {
    let relativeFolder = ppath.relative(this.opts.project.cwd, folder);

    if (!relativeFolder.match(/^\.{0,2}\//))
      // Don't use ppath.join here, it ignores the `.`
      relativeFolder = `./${relativeFolder}` as PortablePath;

    return relativeFolder.replace(/\/?$/, '/')  as PortablePath;
  }
}
