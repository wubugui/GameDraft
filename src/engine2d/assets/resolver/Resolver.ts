/**
 * 资源地址解析器(移植自 PixiJS v8.17(MIT):`assets/resolver/Resolver`,算法逐行对应)。
 *
 * 管"键 → 资源描述":`add` 登记别名与候选地址(展开 `{a,b}` 模板、用解析插件从 url 读出
 * resolution / format),`resolve` 按偏好(format / resolution 的优先序)从候选里挑一个;
 * 没登记过的键按"键即地址"现造一个描述。还管 bundle、basePath / rootPath、默认查询参数。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { warn } from '../utils/warn';
import { path } from '../utils/path';
import { convertToList, createStringVariations, isSingleItem } from '../utils/helpers';
import type {
  ArrayOr,
  AssetsBundle,
  AssetsManifest,
  BundleIdentifierOptions,
  PreferOrder,
  ResolvedAsset,
  ResolvedSrc,
  ResolveURLParser,
  UnresolvedAsset,
} from '../types';

type RequiredPreferOrder = Required<PreferOrder>;

export class Resolver {
  /** 从文件名里读分辨率的规则:`foo@2x.png` → 2(同 Pixi,可改) */
  static RETINA_PREFIX = /@([0-9\.]+)x/;

  private readonly _defaultBundleIdentifierOptions: Required<BundleIdentifierOptions> = {
    connector: '-',
    createBundleAssetId: (bundleId, assetId) => `${bundleId}${this._bundleIdConnector}${assetId}`,
    extractAssetIdFromBundle: (bundleId, assetBundleId) => assetBundleId.replace(`${bundleId}${this._bundleIdConnector}`, ''),
  };
  private _bundleIdConnector = this._defaultBundleIdentifierOptions.connector;
  private _createBundleAssetId: (bundleId: string, assetId: string) => string = this._defaultBundleIdentifierOptions.createBundleAssetId;
  private _extractAssetIdFromBundle: (bundleId: string, assetBundleId: string) => string =
    this._defaultBundleIdentifierOptions.extractAssetIdFromBundle;
  private _assetMap: Record<string, ResolvedAsset[]> = {};
  private _preferredOrder: RequiredPreferOrder[] = [];
  private readonly _parsers: ResolveURLParser[] = [];
  private _resolverHash: Record<string, ResolvedAsset> = {};
  private _rootPath: string | null = null;
  private _basePath: string | null = null;
  private _manifest: AssetsManifest | null = null;
  private _bundles: Record<string, string[]> = {};
  private _defaultSearchParams: string | null = null;

  setBundleIdentifier(bundleIdentifier: BundleIdentifierOptions): void {
    this._bundleIdConnector = bundleIdentifier.connector ?? this._bundleIdConnector;
    this._createBundleAssetId = bundleIdentifier.createBundleAssetId ?? this._createBundleAssetId;
    this._extractAssetIdFromBundle = bundleIdentifier.extractAssetIdFromBundle ?? this._extractAssetIdFromBundle;
    if (this._extractAssetIdFromBundle('foo', this._createBundleAssetId('foo', 'bar')) !== 'bar') {
      throw new Error('[Resolver] GenerateBundleAssetId are not working correctly');
    }
  }

  /** 加一条偏好(如 `{ params: { format: ['webp','png'], resolution: [2,1] } }`) */
  prefer(...preferOrders: PreferOrder[]): void {
    preferOrders.forEach((prefer) => {
      this._preferredOrder.push(prefer as RequiredPreferOrder);
      if (!prefer.priority) {
        prefer.priority = Object.keys(prefer.params);
      }
    });
    this._resolverHash = {};
  }

  set basePath(basePath: string | null) {
    this._basePath = basePath;
  }
  get basePath(): string | null {
    return this._basePath;
  }

  set rootPath(rootPath: string | null) {
    this._rootPath = rootPath;
  }
  get rootPath(): string | null {
    return this._rootPath;
  }

  get parsers(): ResolveURLParser[] {
    return this._parsers;
  }

  reset(): void {
    this.setBundleIdentifier(this._defaultBundleIdentifierOptions);
    this._assetMap = {};
    this._preferredOrder = [];
    this._resolverHash = {};
    this._rootPath = null;
    this._basePath = null;
    this._manifest = null;
    this._bundles = {};
    this._defaultSearchParams = null;
  }

  setDefaultSearchParams(searchParams: string | Record<string, unknown>): void {
    if (typeof searchParams === 'string') {
      this._defaultSearchParams = searchParams;
    } else {
      const queryValues = searchParams as Record<string, any>;
      this._defaultSearchParams = Object.keys(queryValues)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryValues[key])}`)
        .join('&');
    }
  }

  /** 资源的全部别名:有 alias 用 alias,否则用 src(对象 src 取其 .src) */
  getAlias(asset: UnresolvedAsset): string[] {
    const { alias, src } = asset;
    const aliasesToUse = convertToList<string>(
      (alias || src) as ArrayOr<string>,
      (value: any) => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map((v) => v?.src ?? v);
        if (value?.src) return value.src;
        return value;
      },
      true,
    );
    return aliasesToUse;
  }

  removeAlias(alias: string, asset?: ResolvedAsset): void {
    if (!this._assetMap[alias]) return;
    if (asset && asset !== this._resolverHash[alias]) return;
    delete this._resolverHash[alias];
    delete this._assetMap[alias];
  }

  addManifest(manifest: AssetsManifest): void {
    if (this._manifest) {
      warn('[Resolver] Manifest already exists, this will be overwritten');
    }
    this._manifest = manifest;
    manifest.bundles.forEach((bundle) => {
      this.addBundle(bundle.name, bundle.assets);
    });
  }

  addBundle(bundleId: string, assets: AssetsBundle['assets']): void {
    const assetNames: string[] = [];
    let convertedAssets: UnresolvedAsset[] = assets as UnresolvedAsset[];
    if (!Array.isArray(assets)) {
      convertedAssets = Object.entries(assets).map(([alias, src]) => {
        if (typeof src === 'string' || Array.isArray(src)) {
          return { alias, src };
        }
        return { alias, ...src };
      });
    }
    convertedAssets.forEach((asset) => {
      const srcs = asset.src;
      const aliases = asset.alias;
      let ids: string[];
      if (typeof aliases === 'string') {
        const bundleAssetId = this._createBundleAssetId(bundleId, aliases);
        assetNames.push(bundleAssetId);
        ids = [aliases, bundleAssetId];
      } else {
        const bundleIds = (aliases as string[]).map((name) => this._createBundleAssetId(bundleId, name));
        assetNames.push(...bundleIds);
        ids = [...(aliases as string[]), ...bundleIds];
      }
      this.add({
        ...asset,
        ...{
          alias: ids,
          src: srcs,
        },
      });
    });
    this._bundles[bundleId] = assetNames;
  }

  add(aliases: ArrayOr<UnresolvedAsset>): void {
    const assets: UnresolvedAsset[] = [];
    if (Array.isArray(aliases)) {
      assets.push(...aliases);
    } else {
      assets.push(aliases);
    }
    const keyCheck = (key: string): void => {
      if (this.hasKey(key)) {
        warn(`[Resolver] already has key: ${key} overwriting`);
      }
    };
    const assetArray = convertToList<UnresolvedAsset>(assets);
    assetArray.forEach((asset) => {
      const { src } = asset;
      let { data, format, loadParser: userDefinedLoadParser, parser: userDefinedParser } = asset;
      const srcsToUse: (string | ResolvedSrc)[][] = convertToList<string | ResolvedSrc>(src as ArrayOr<string | ResolvedSrc>)
        .map((src2) => {
          if (typeof src2 === 'string') {
            return createStringVariations(src2);
          }
          return Array.isArray(src2) ? src2 : [src2];
        });
      const aliasesToUse = this.getAlias(asset);
      Array.isArray(aliasesToUse) ? aliasesToUse.forEach(keyCheck) : keyCheck(aliasesToUse);
      const resolvedAssets: ResolvedAsset[] = [];
      const parseUrl = (url: string): ResolvedAsset => {
        const parser = this._parsers.find((p) => p.test(url));
        return {
          src: url,
          ...parser?.parse(url),
        };
      };
      srcsToUse.forEach((srcs) => {
        srcs.forEach((src2) => {
          let formattedAsset: ResolvedAsset = {};
          if (typeof src2 !== 'object') {
            formattedAsset = parseUrl(src2);
          } else {
            data = src2.data ?? data;
            format = src2.format ?? format;
            if (src2.loadParser || src2.parser) {
              userDefinedLoadParser = src2.loadParser ?? userDefinedLoadParser;
              userDefinedParser = src2.parser ?? userDefinedParser;
            }
            formattedAsset = {
              ...parseUrl(src2.src as string),
              ...src2,
            };
          }
          if (!aliasesToUse) {
            throw new Error(`[Resolver] alias is undefined for this asset: ${formattedAsset.src}`);
          }
          formattedAsset = this._buildResolvedAsset(formattedAsset, {
            aliases: aliasesToUse,
            data,
            format,
            loadParser: userDefinedLoadParser,
            parser: userDefinedParser,
            progressSize: asset.progressSize,
          });
          resolvedAssets.push(formattedAsset);
        });
      });
      aliasesToUse.forEach((alias) => {
        this._assetMap[alias] = resolvedAssets;
      });
    });
  }

  resolveBundle(bundleIds: ArrayOr<string>): Record<string, ResolvedAsset> | Record<string, Record<string, ResolvedAsset>> {
    const singleAsset = isSingleItem(bundleIds);
    bundleIds = convertToList<string>(bundleIds);
    const out: Record<string, Record<string, ResolvedAsset>> = {};
    bundleIds.forEach((bundleId) => {
      const assetNames = this._bundles[bundleId];
      if (assetNames) {
        const results = this.resolve(assetNames) as Record<string, ResolvedAsset>;
        const assets: Record<string, ResolvedAsset> = {};
        for (const key in results) {
          const asset = results[key];
          assets[this._extractAssetIdFromBundle(bundleId, key)] = asset;
        }
        out[bundleId] = assets;
      }
    });
    return singleAsset ? out[bundleIds[0]] : out;
  }

  resolveUrl(key: ArrayOr<string>): string | Record<string, string> {
    const result = this.resolve(key);
    if (typeof key !== 'string') {
      const out: Record<string, string> = {};
      for (const i in result as Record<string, ResolvedAsset>) {
        out[i] = (result as Record<string, ResolvedAsset>)[i].src as string;
      }
      return out;
    }
    return (result as ResolvedAsset).src as string;
  }

  resolve(keys: string): ResolvedAsset;
  resolve(keys: string[]): Record<string, ResolvedAsset>;
  resolve(keys: ArrayOr<string>): ResolvedAsset | Record<string, ResolvedAsset>;
  resolve(keys: ArrayOr<string>): ResolvedAsset | Record<string, ResolvedAsset> {
    const singleAsset = isSingleItem(keys);
    keys = convertToList<string>(keys);
    const result: Record<string, ResolvedAsset> = {};
    keys.forEach((key) => {
      if (!this._resolverHash[key]) {
        if (this._assetMap[key]) {
          let assets = this._assetMap[key];
          const preferredOrder = this._getPreferredOrder(assets);
          preferredOrder?.priority.forEach((priorityKey) => {
            preferredOrder.params[priorityKey].forEach((value: unknown) => {
              const filteredAssets = assets.filter((asset) => {
                if (asset[priorityKey]) {
                  return asset[priorityKey] === value;
                }
                return false;
              });
              if (filteredAssets.length) {
                assets = filteredAssets;
              }
            });
          });
          this._resolverHash[key] = assets[0];
        } else {
          this._resolverHash[key] = this._buildResolvedAsset({
            alias: [key],
            src: key,
          }, {});
        }
      }
      result[key] = this._resolverHash[key];
    });
    return singleAsset ? result[keys[0]] : result;
  }

  hasKey(key: string): boolean {
    return !!this._assetMap[key];
  }

  hasBundle(key: string): boolean {
    return !!this._bundles[key];
  }

  private _getPreferredOrder(assets: ResolvedAsset[]): RequiredPreferOrder | undefined {
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const preferred = this._preferredOrder.find((preference) => preference.params.format.includes(asset.format));
      if (preferred) {
        return preferred;
      }
    }
    return this._preferredOrder[0];
  }

  private _appendDefaultSearchParams(url: string): string {
    if (!this._defaultSearchParams) return url;
    const paramConnector = /\?/.test(url) ? '&' : '?';
    return `${url}${paramConnector}${this._defaultSearchParams}`;
  }

  private _buildResolvedAsset(
    formattedAsset: ResolvedAsset,
    data: {
      aliases?: string[];
      data?: Record<string, unknown>;
      loadParser?: string;
      parser?: string;
      format?: string;
      progressSize?: number;
    },
  ): ResolvedAsset {
    const { aliases, data: assetData, loadParser, parser, format, progressSize } = data;
    if (this._basePath || this._rootPath) {
      formattedAsset.src = path.toAbsolute(formattedAsset.src as string, this._basePath, this._rootPath);
    }
    formattedAsset.alias = aliases ?? formattedAsset.alias ?? [formattedAsset.src as string];
    formattedAsset.src = this._appendDefaultSearchParams(formattedAsset.src as string);
    formattedAsset.data = { ...(assetData || {}), ...formattedAsset.data };
    formattedAsset.loadParser = loadParser ?? formattedAsset.loadParser;
    formattedAsset.parser = parser ?? formattedAsset.parser;
    formattedAsset.format = format ?? formattedAsset.format ?? getUrlExtension(formattedAsset.src);
    if (progressSize !== undefined) {
      formattedAsset.progressSize = progressSize;
    }
    return formattedAsset;
  }
}

/** url 的扩展名(去掉 ?query 与 #hash) */
export function getUrlExtension(url: string): string {
  return (url.split('.').pop() as string).split('?').shift()!.split('#').shift()!;
}

/** 从 url 里读分辨率(`@2x` → 2),读不到给 defaultValue(同 Pixi `getResolutionOfUrl`) */
export function getResolutionOfUrl(url: string, defaultValue = 1): number {
  const resolution = Resolver.RETINA_PREFIX?.exec(url);
  if (resolution) {
    return parseFloat(resolution[1]);
  }
  return defaultValue;
}
