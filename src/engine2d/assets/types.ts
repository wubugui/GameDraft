/**
 * 资源系统的公共类型(移植自 PixiJS v8.17(MIT):`assets/types`、`assets/loader/parsers/LoaderParser`、
 * `assets/resolver/types`、`assets/cache/CacheParser`、`assets/detections/types`)。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Loader } from './loader/Loader';

export type ArrayOr<T> = T | T[];

export type LoadParserName = 'loadJson' | 'loadTextures' | 'loadTxt' | (string & {});
export type AssetParser = 'json' | 'text' | 'texture' | (string & {});

/** 解析完的资源描述:src 是单个地址,alias 是全部别名 */
export interface ResolvedAsset<T = any> {
  alias?: string[];
  src?: string;
  /** 传给装载器的额外数据(纹理:TextureSource 的构造参数,如 alphaMode / resolution / scaleMode) */
  data?: T;
  format?: string;
  /** @deprecated 同 Pixi:用 parser */
  loadParser?: LoadParserName;
  /** 指定装载器(按 name 或 id) */
  parser?: AssetParser;
  progressSize?: number;
  [key: string]: any;
}

export type ResolvedSrc = Pick<ResolvedAsset, 'src' | 'format' | 'loadParser' | 'parser' | 'data'>;

export type AssetSrc = ArrayOr<string> | (ArrayOr<ResolvedSrc> & { [key: string]: any });

/** 用户给的资源描述:src 可以是多个候选 / 带 {a,b} 变体的模板 */
export type UnresolvedAsset<T = any> = Pick<ResolvedAsset<T>, 'data' | 'format' | 'loadParser' | 'parser'> & {
  alias?: ArrayOr<string>;
  src?: AssetSrc;
  progressSize?: number;
  [key: string]: any;
};

export interface AssetsBundle {
  name: string;
  assets: UnresolvedAsset[] | Record<string, ArrayOr<string> | UnresolvedAsset>;
}

export interface AssetsManifest {
  bundles: AssetsBundle[];
}

export type ProgressCallback = (progress: number) => void;

/** 装载选项(同 Pixi `LoadOptions`) */
export interface LoadOptions {
  onProgress?: (progress: number) => void;
  onError?: (error: Error, url: string | ResolvedAsset) => void;
  /** throw(缺省)= 一个失败整批失败;skip = 跳过失败的;retry = 重试 retryCount 次后再抛 */
  strategy?: 'throw' | 'skip' | 'retry';
  retryCount?: number;
  retryDelay?: number;
}

/** 装载器插件优先级(同 Pixi `LoaderParserPriority`) */
export enum LoaderParserPriority {
  Low = 0,
  Normal = 1,
  High = 2,
}

/** 插件元数据(Pixi 的 ExtensionMetadata 子集:engine2d 没有 extensions 注册表,只用 priority / name 排序) */
export interface ParserExtensionMeta {
  type?: string;
  priority?: number;
  name?: string;
}

/** 装载器插件(同 Pixi `LoaderParser`) */
export interface LoaderParser<ASSET = any, META_DATA = any, CONFIG = Record<string, any>> {
  extension?: ParserExtensionMeta;
  config?: CONFIG;
  name: string;
  id: string;
  test?: (url: string, resolvedAsset?: ResolvedAsset<META_DATA>, loader?: Loader) => boolean;
  load?: (url: string, resolvedAsset?: ResolvedAsset<META_DATA>, loader?: Loader) => Promise<ASSET>;
  testParse?: (asset: ASSET, resolvedAsset?: ResolvedAsset<META_DATA>, loader?: Loader) => Promise<boolean>;
  parse?: (asset: ASSET, resolvedAsset?: ResolvedAsset<META_DATA>, loader?: Loader) => Promise<ASSET>;
  unload?: (asset: ASSET, resolvedAsset?: ResolvedAsset<META_DATA>, loader?: Loader) => Promise<void> | void;
}

/** 地址解析插件(同 Pixi `ResolveURLParser`):从 url 里读出 resolution / format 等 */
export interface ResolveURLParser {
  extension?: ParserExtensionMeta;
  test: (url: string) => boolean;
  parse: (value: string) => ResolvedAsset & { src: string };
}

/** 缓存插件(同 Pixi `CacheParser`):一份资源按多个键入缓存 */
export interface CacheParser<T = any> {
  extension?: ParserExtensionMeta;
  config?: Record<string, any>;
  test: (asset: T) => boolean;
  getCacheableAssets: (keys: string[], asset: T) => Record<string, any>;
}

/** 格式探测插件(同 Pixi `FormatDetectionParser`) */
export interface FormatDetectionParser {
  extension?: ParserExtensionMeta;
  test: () => Promise<boolean>;
  add: (formats: string[]) => Promise<string[]>;
  remove: (formats: string[]) => Promise<string[]>;
}

/** 同 Pixi `PreferOrder` */
export interface PreferOrder {
  priority?: string[];
  params: { [key: string]: any };
}

/** 同 Pixi `BundleIdentifierOptions` */
export interface BundleIdentifierOptions {
  connector?: string;
  createBundleAssetId?: (bundleId: string, assetId: string) => string;
  extractAssetIdFromBundle?: (bundleId: string, assetBundleId: string) => string;
}

/** 装载器插件的可调项(`Assets.setPreferences` 按键名写进各插件的 config) */
export interface AssetsPreferences {
  /** 纹理:优先用 createImageBitmap 解码 */
  preferCreateImageBitmap?: boolean;
  /** 纹理:优先在 Worker 里 fetch + 解码 */
  preferWorkers?: boolean;
  /** 纹理:走 <img> 时的 crossOrigin */
  crossOrigin?: HTMLImageElement['crossOrigin'];
  [key: string]: any;
}

/** 同 Pixi `AssetInitOptions` */
export interface AssetInitOptions {
  basePath?: string;
  defaultSearchParams?: string | Record<string, any>;
  manifest?: string | AssetsManifest;
  texturePreference?: {
    resolution?: number | number[];
    format?: ArrayOr<string>;
  };
  skipDetections?: boolean;
  bundleIdentifier?: BundleIdentifierOptions;
  preferences?: Partial<AssetsPreferences>;
  loadOptions?: Partial<LoadOptions>;
}
