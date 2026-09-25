/**
 * 资源门面(移植自 PixiJS v8.17(MIT):`assets/Assets`,逐行对应;只装游戏用得到的插件)。
 *
 * `Assets.load(url | url[] | {alias, src, data})` → resolver 把键解析成资源描述 → loader 按绝对地址
 * 去重装载 → 结果按 `[src, ...alias]` 全部写进 `Cache`。`Assets.get(键)` 读缓存;`Assets.unload`
 * 从缓存摘掉并交给装载插件卸载(纹理 = `destroy(true)`)。
 *
 * 装的插件(顺序同 Pixi 的优先级排序):
 * - 装载:loadTextures(High)、loadJson、loadTxt(Low)。图片装载参数见 `loader/parsers/loadTextures.ts`。
 * - 地址解析:resolveTextureUrl、resolveJsonUrl(读 `@2x` 分辨率与格式)。
 * - 缓存:cacheTextureArray。
 * - 格式探测:avif、webp、png/jpg/jpeg(init 时跑一次,只影响多候选地址的挑选)。
 * 没移植:SVG / 视频 / 网页字体 / 位图字体 / spritesheet 装载、backgroundLoad(游戏不用)。
 *
 * 另外:本模块加载时向 `Texture` 注册缓存查询,使 `Texture.from('已载入的键')` 与 Pixi 一样查 Assets 缓存。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Texture, setTextureCacheLookup } from '../textures/Texture';
import { Cache, cacheTextureArray } from './cache/Cache';
import { detectAvif, detectDefaults, detectWebp } from './detections/detections';
import { Loader } from './loader/Loader';
import { loadJson, loadTxt } from './loader/parsers/loadJson';
import { loadTextures } from './loader/parsers/loadTextures';
import { resolveJsonUrl, resolveTextureUrl } from './resolver/parsers';
import { Resolver } from './resolver/Resolver';
import { convertToList, isSingleItem } from './utils/helpers';
import { warn } from './utils/warn';
import type {
  ArrayOr,
  AssetInitOptions,
  AssetsBundle,
  AssetsPreferences,
  FormatDetectionParser,
  LoadOptions,
  ParserExtensionMeta,
  ProgressCallback,
  ResolvedAsset,
  UnresolvedAsset,
} from './types';

export class AssetsClass {
  /** 键 → 资源描述 */
  resolver: Resolver;
  /** 装载与去重 */
  loader: Loader;
  /** 全局缓存 */
  cache: typeof Cache;

  private readonly _detections: FormatDetectionParser[] = [];
  private _initialized = false;

  constructor() {
    this.resolver = new Resolver();
    this.loader = new Loader();
    this.cache = Cache;
    this.reset();
  }

  /**
   * 初始化(可选;第一次 load 时自动以缺省参数调用)。跑格式探测、设 resolver 偏好。
   * 已初始化过再调只告警。
   */
  async init(options: AssetInitOptions = {}): Promise<void> {
    if (this._initialized) {
      warn('[Assets]AssetManager already initialized, did you load before calling this Assets.init()?');
      return;
    }
    this._initialized = true;
    if (options.defaultSearchParams) {
      this.resolver.setDefaultSearchParams(options.defaultSearchParams);
    }
    if (options.basePath) {
      this.resolver.basePath = options.basePath;
    }
    if (options.bundleIdentifier) {
      this.resolver.setBundleIdentifier(options.bundleIdentifier);
    }
    if (options.manifest) {
      let manifest = options.manifest;
      if (typeof manifest === 'string') {
        manifest = await this.load(manifest);
      }
      this.resolver.addManifest(manifest as Exclude<typeof manifest, string>);
    }
    const resolutionPref = options.texturePreference?.resolution ?? 1;
    const resolution = typeof resolutionPref === 'number' ? [resolutionPref] : resolutionPref;
    const formats = await this._detectFormats({
      preferredFormats: options.texturePreference?.format,
      skipDetections: options.skipDetections,
      detections: this._detections,
    });
    this.resolver.prefer({
      params: {
        format: formats,
        resolution,
      },
    });
    if (options.preferences) {
      this.setPreferences(options.preferences);
    }
    if (options.loadOptions) {
      this.loader.loadOptions = {
        ...this.loader.loadOptions,
        ...options.loadOptions,
      };
    }
  }

  /** 登记资源(别名 → 地址 / 数据),不装载 */
  add(assets: ArrayOr<UnresolvedAsset>): void {
    this.resolver.add(assets);
  }

  /**
   * 装载资源。
   * - `load('a.png')` / `load({ src, data })` → 资源本身;
   * - `load(['a.png', 'b.png'])` → `{ 'a.png': 资源, 'b.png': 资源 }`。
   * 没登记过的字符串键按"键即地址"登记;对象按其 alias(没有则 src)登记(已登记的键不覆盖)。
   */
  async load<T = any>(urls: string | UnresolvedAsset, onProgress?: ProgressCallback | LoadOptions): Promise<T>;
  async load<T = any>(urls: string[] | UnresolvedAsset[], onProgress?: ProgressCallback | LoadOptions): Promise<Record<string, T>>;
  async load<T = any>(
    urls: ArrayOr<string> | ArrayOr<UnresolvedAsset>,
    onProgress?: ProgressCallback | LoadOptions,
  ): Promise<T | Record<string, T>> {
    if (!this._initialized) {
      await this.init();
    }
    const singleAsset = isSingleItem(urls);
    const urlArray = convertToList<UnresolvedAsset | string>(urls as ArrayOr<string | UnresolvedAsset>).map((url) => {
      if (typeof url !== 'string') {
        const aliases = this.resolver.getAlias(url);
        if (aliases.some((alias) => !this.resolver.hasKey(alias))) {
          this.add(url);
        }
        return Array.isArray(aliases) ? aliases[0] : aliases;
      }
      if (!this.resolver.hasKey(url)) this.add({ alias: url, src: url });
      return url;
    });
    const resolveResults = this.resolver.resolve(urlArray);
    const out = await this._mapLoadToResolve<T>(resolveResults, onProgress);
    return singleAsset ? out[urlArray[0]] : out;
  }

  /** 登记一个 bundle */
  addBundle(bundleId: string, assets: AssetsBundle['assets']): void {
    this.resolver.addBundle(bundleId, assets);
  }

  /** 装载一个或多个 bundle;单个 → `{ 别名: 资源 }`,多个 → `{ bundleId: { 别名: 资源 } }` */
  async loadBundle(bundleIds: ArrayOr<string>, onProgress?: ProgressCallback): Promise<any> {
    if (!this._initialized) {
      await this.init();
    }
    let singleAsset = false;
    if (typeof bundleIds === 'string') {
      singleAsset = true;
      bundleIds = [bundleIds];
    }
    const resolveResults = this.resolver.resolveBundle(bundleIds) as Record<string, Record<string, ResolvedAsset>>;
    const out: Record<string, Record<string, any>> = {};
    const keys = Object.keys(resolveResults);
    let total = 0;
    const counts: number[] = [];
    const _onProgress = (): void => {
      onProgress?.(counts.reduce((a, b) => a + b, 0) / total);
    };
    const promises = keys.map((bundleId, i) => {
      const resolveResult = resolveResults[bundleId];
      const values = Object.values(resolveResult);
      const totalAssetsToLoad = [...new Set(values.flat())];
      const progressSize = totalAssetsToLoad.reduce((sum, asset) => sum + (asset.progressSize || 1), 0);
      counts.push(0);
      total += progressSize;
      return this._mapLoadToResolve(resolveResult, (e) => {
        counts[i] = e * progressSize;
        _onProgress();
      }).then((resolveResult2) => {
        out[bundleId] = resolveResult2;
      });
    });
    await Promise.all(promises);
    return singleAsset ? out[bundleIds[0]] : out;
  }

  /** 重置:清 resolver / loader 登记与缓存,回到未初始化(不销毁已载资源) */
  reset(): void {
    this.resolver.reset();
    this.loader.reset();
    this.cache.reset();
    this._initialized = false;
  }

  /** 读缓存:单键 → 资源(没有则告警、返回 undefined);数组 → `{ 下标: 资源 }`(同 Pixi) */
  get<T = any>(keys: string): T;
  get<T = any>(keys: string[]): Record<string, T>;
  get<T = any>(keys: ArrayOr<string>): T | Record<string, T> {
    if (typeof keys === 'string') {
      return Cache.get(keys);
    }
    const assets: Record<string, T> = {};
    for (let i = 0; i < keys.length; i++) {
      assets[i] = Cache.get(keys[i]);
    }
    return assets;
  }

  private async _mapLoadToResolve<T>(
    resolveResults: ResolvedAsset | Record<string, ResolvedAsset>,
    progressOrLoadOptions?: ProgressCallback | LoadOptions,
  ): Promise<Record<string, T>> {
    const resolveArray = [...new Set(Object.values(resolveResults as Record<string, ResolvedAsset>))];
    const loadedAssets = await this.loader.load<T>(resolveArray, progressOrLoadOptions);
    const out: Record<string, T> = {};
    resolveArray.forEach((resolveResult) => {
      const asset = loadedAssets[resolveResult.src as string];
      const keys = [resolveResult.src as string];
      if (resolveResult.alias) {
        keys.push(...resolveResult.alias);
      }
      keys.forEach((key) => {
        out[key] = asset;
      });
      Cache.set(keys, asset);
    });
    return out;
  }

  /** 卸载:从缓存摘掉(按 src 摘,同批别名一起)并交给装载插件卸载 */
  async unload(urls: ArrayOr<string> | ResolvedAsset | ResolvedAsset[]): Promise<void> {
    if (!this._initialized) {
      await this.init();
    }
    const urlArray = convertToList<string | ResolvedAsset>(urls as ArrayOr<string | ResolvedAsset>)
      .map((url) => (typeof url !== 'string' ? (url.src as string) : url));
    const resolveResults = this.resolver.resolve(urlArray);
    await this._unloadFromResolved(resolveResults);
  }

  /** 卸载 bundle */
  async unloadBundle(bundleIds: ArrayOr<string>): Promise<void> {
    if (!this._initialized) {
      await this.init();
    }
    bundleIds = convertToList<string>(bundleIds);
    const resolveResults = this.resolver.resolveBundle(bundleIds) as Record<string, Record<string, ResolvedAsset>>;
    const promises = Object.keys(resolveResults).map((bundleId) => this._unloadFromResolved(resolveResults[bundleId]));
    await Promise.all(promises);
  }

  private async _unloadFromResolved(resolveResult: Record<string, ResolvedAsset>): Promise<void> {
    const resolveArray = Object.values(resolveResult);
    resolveArray.forEach((resolveResult2) => {
      Cache.remove(resolveResult2.src);
    });
    await this.loader.unload(resolveArray);
  }

  private async _detectFormats(options: {
    preferredFormats?: ArrayOr<string>;
    skipDetections?: boolean;
    detections: FormatDetectionParser[];
  }): Promise<string[]> {
    let formats: string[] = [];
    if (options.preferredFormats) {
      formats = Array.isArray(options.preferredFormats) ? options.preferredFormats : [options.preferredFormats];
    }
    for (const detection of options.detections) {
      if (options.skipDetections || (await detection.test())) {
        formats = await detection.add(formats);
      } else if (!options.skipDetections) {
        formats = await detection.remove(formats);
      }
    }
    formats = formats.filter((format, index) => formats.indexOf(format) === index);
    return formats;
  }

  /** 已装的格式探测插件 */
  get detections(): FormatDetectionParser[] {
    return this._detections;
  }

  /** 按键名改各装载插件的 config(如 `{ preferWorkers: false }`) */
  setPreferences(preferences: Partial<AssetsPreferences>): void {
    this.loader.parsers.forEach((parser) => {
      if (!parser.config) return;
      Object.keys(parser.config)
        .filter((key) => key in preferences)
        .forEach((key) => {
          (parser.config as Record<string, unknown>)[key] = preferences[key];
        });
    });
  }
}

/** 按 Pixi `extensions.handleByList` 的规则插入:按 priority 降序(缺省 -1),同优先级保持加入顺序 */
function addByPriority<T extends { extension?: ParserExtensionMeta }>(list: T[], ...items: T[]): void {
  const priorityOf = (item: T): number => item.extension?.priority ?? -1;
  for (const item of items) {
    if (list.includes(item)) continue;
    list.push(item);
    list.sort((a, b) => priorityOf(b) - priorityOf(a));
  }
}

/** 全局资源门面(同 Pixi `Assets`) */
export const Assets = new AssetsClass();

// 同 Pixi `Assets.mjs` 末尾 extensions.add(...) 的注册顺序
addByPriority(Assets.cache.parsers, cacheTextureArray);
addByPriority(Assets.detections, detectDefaults, detectAvif, detectWebp);
addByPriority(Assets.loader.parsers, loadJson, loadTxt, loadTextures);
addByPriority(Assets.resolver.parsers, resolveTextureUrl, resolveJsonUrl);

// Texture.from('键') 查 Assets 缓存(同 Pixi 的 textureFrom:字符串一律走 Cache)
setTextureCacheLookup((id: string) => {
  if (!Cache.has(id)) return undefined;
  const value = Cache.get(id);
  return value instanceof Texture ? value : undefined;
});
