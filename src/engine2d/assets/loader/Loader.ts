/**
 * 资源装载器(移植自 PixiJS v8.17(MIT):`assets/loader/Loader`,逐行对应)。
 *
 * - 按**绝对地址**去重:`promiseCache[绝对url]` 存在就复用那次装载(同一地址先到先得,
 *   后来者的 `data` 不再生效——与 Pixi 相同)。
 * - 选装载插件:资源指定了 `parser`(或旧名 `loadParser`)就按 name / id 找;否则按插件顺序
 *   (优先级高的在前)取第一个 `test(url)` 通过的。
 * - 失败策略:throw(缺省)/ skip / retry。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { warn } from '../utils/warn';
import { path } from '../utils/path';
import { convertToList, isSingleItem } from '../utils/helpers';
import type { LoaderParser, LoadOptions, ProgressCallback, ResolvedAsset } from '../types';

/** 一次装载:promise + 最终负责的插件(unload 时用它) */
export interface PromiseAndParser {
  promise: Promise<any>;
  parser: LoaderParser | null;
}

export class Loader {
  /** 全部装载的缺省选项 */
  static defaultOptions: LoadOptions = {
    onProgress: undefined,
    onError: undefined,
    strategy: 'throw',
    retryCount: 3,
    retryDelay: 250,
  };

  /** 本装载器的选项(Assets.init 的 loadOptions 写在这里) */
  loadOptions: LoadOptions = { ...Loader.defaultOptions };

  private readonly _parsers: LoaderParser[] = [];
  private _parserHash: Record<string, LoaderParser> = {};
  private _parsersValidated = false;

  /** 装载插件表(改了会在下次 load 前重建 name/id 索引) */
  readonly parsers: LoaderParser[] = new Proxy(this._parsers, {
    set: (target, key, value) => {
      this._parsersValidated = false;
      (target as any)[key] = value;
      return true;
    },
  });

  /** 绝对地址 → 进行中 / 已完成的装载 */
  promiseCache: Record<string, PromiseAndParser> = {};

  /** 清掉装载缓存(不销毁已载资源) */
  reset(): void {
    this._parsersValidated = false;
    this.promiseCache = {};
  }

  private _getLoadPromiseAndParser(url: string, data: ResolvedAsset): PromiseAndParser {
    const result: PromiseAndParser = {
      promise: null as unknown as Promise<any>,
      parser: null,
    };
    result.promise = (async () => {
      let asset: any = null;
      let parser: LoaderParser | null = null;
      if (data.parser || data.loadParser) {
        parser = this._parserHash[(data.parser || data.loadParser) as string];
        if (data.loadParser) {
          warn(`[Assets] "loadParser" is deprecated, use "parser" instead for ${url}`);
        }
        if (!parser) {
          warn(`[Assets] specified load parser "${data.parser || data.loadParser}" not found while loading ${url}`);
        }
      }
      if (!parser) {
        for (let i = 0; i < this.parsers.length; i++) {
          const parserX = this.parsers[i];
          if (parserX.load && parserX.test?.(url, data, this)) {
            parser = parserX;
            break;
          }
        }
        if (!parser) {
          warn(`[Assets] ${url} could not be loaded as we don't know how to parse it, ensure the correct parser has been added`);
          return null;
        }
      }
      asset = await (parser.load as NonNullable<LoaderParser['load']>).call(parser, url, data, this);
      result.parser = parser;
      for (let i = 0; i < this.parsers.length; i++) {
        const parser2 = this.parsers[i];
        if (parser2.parse) {
          if (parser2.parse && (await parser2.testParse?.(asset, data, this))) {
            asset = (await parser2.parse(asset, data, this)) || asset;
            result.parser = parser2;
          }
        }
      }
      return asset;
    })();
    return result;
  }

  /**
   * 装载一个或一批资源。
   * @returns 单个 → 资源本身;数组 → `{ [src]: 资源 }`
   */
  async load<T = any>(assetsToLoadIn: string | ResolvedAsset, onProgress?: ProgressCallback | LoadOptions): Promise<T>;
  async load<T = any>(
    assetsToLoadIn: string[] | ResolvedAsset[],
    onProgress?: ProgressCallback | LoadOptions,
  ): Promise<Record<string, T>>;
  async load<T = any>(
    assetsToLoadIn: string | string[] | ResolvedAsset | ResolvedAsset[],
    onProgressOrOptions?: ProgressCallback | LoadOptions,
  ): Promise<T | Record<string, T>> {
    if (!this._parsersValidated) {
      this._validateParsers();
    }
    const options: LoadOptions = typeof onProgressOrOptions === 'function'
      ? { ...Loader.defaultOptions, ...this.loadOptions, onProgress: onProgressOrOptions }
      : { ...Loader.defaultOptions, ...this.loadOptions, ...(onProgressOrOptions || {}) };
    const { onProgress, onError, strategy, retryCount, retryDelay } = options;
    let count = 0;
    const assets: Record<string, T> = {};
    const singleAsset = isSingleItem(assetsToLoadIn);
    const assetsToLoad = convertToList<ResolvedAsset>(assetsToLoadIn as any, (item) => ({
      alias: [item],
      src: item,
      data: {},
    }));
    const total = assetsToLoad.reduce((sum, asset) => sum + (asset.progressSize || 1), 0);
    const promises = assetsToLoad.map(async (asset) => {
      const url = path.toAbsolute(asset.src as string);
      if (assets[asset.src as string]) return;
      await this._loadAssetWithRetry(url, asset, { onProgress, onError, strategy, retryCount, retryDelay }, assets);
      count += asset.progressSize || 1;
      if (onProgress) onProgress(count / total);
    });
    await Promise.all(promises);
    return singleAsset ? assets[assetsToLoad[0].src as string] : assets;
  }

  /** 卸载:等装载完成后交给负责的插件 unload(纹理 = destroy(true)) */
  async unload(assetsToUnloadIn: string | string[] | ResolvedAsset | ResolvedAsset[]): Promise<void> {
    const assetsToUnload = convertToList<ResolvedAsset>(assetsToUnloadIn as any, (item) => ({
      alias: [item],
      src: item,
    }));
    const promises = assetsToUnload.map(async (asset) => {
      const url = path.toAbsolute(asset.src as string);
      const loadPromise = this.promiseCache[url];
      if (loadPromise) {
        const loadedAsset = await loadPromise.promise;
        delete this.promiseCache[url];
        await loadPromise.parser?.unload?.(loadedAsset, asset, this);
      }
    });
    await Promise.all(promises);
  }

  private _validateParsers(): void {
    this._parsersValidated = true;
    this._parserHash = this._parsers
      .filter((parser) => parser.name || parser.id)
      .reduce((hash, parser) => {
        if (!parser.name && !parser.id) {
          warn('[Assets] parser should have an id');
        } else if (hash[parser.name] || hash[parser.id]) {
          warn(`[Assets] parser id conflict "${parser.id}"`);
        }
        hash[parser.name] = parser;
        if (parser.id) hash[parser.id] = parser;
        return hash;
      }, {} as Record<string, LoaderParser>);
  }

  private async _loadAssetWithRetry(
    url: string,
    asset: ResolvedAsset,
    options: LoadOptions,
    assets: Record<string, any>,
  ): Promise<void> {
    let attempt = 0;
    const { onError, strategy, retryCount, retryDelay } = options;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    while (true) {
      try {
        if (!this.promiseCache[url]) {
          this.promiseCache[url] = this._getLoadPromiseAndParser(url, asset);
        }
        assets[asset.src as string] = await this.promiseCache[url].promise;
        return;
      } catch (e) {
        delete this.promiseCache[url];
        delete assets[asset.src as string];
        attempt++;
        const isLast = strategy !== 'retry' || attempt > (retryCount as number);
        if (strategy === 'retry' && !isLast) {
          if (onError) onError(e as Error, asset);
          await wait(retryDelay as number);
          continue;
        }
        if (strategy === 'skip') {
          if (onError) onError(e as Error, asset);
          return;
        }
        if (onError) onError(e as Error, asset);
        const error = new Error(`[Loader.load] Failed to load ${url}.\n${e}`);
        if (e instanceof Error && e.stack) {
          error.stack = e.stack;
        }
        throw error;
      }
    }
  }
}
