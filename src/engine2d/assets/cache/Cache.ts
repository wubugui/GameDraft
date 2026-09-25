/**
 * 全局资源缓存(移植自 PixiJS v8.17(MIT):`assets/cache/Cache` + `cache/parsers/cacheTextureArray`)。
 *
 * 一份资源可以挂多个键(src + 全部别名);`remove(任一键)` 把同批的键一起删。
 * 缓存插件可以把一份资源拆成多条(纹理数组 → `key`、`key2`、`key3`…)。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Texture } from '../../textures/Texture';
import { warn } from '../utils/warn';
import { convertToList } from '../utils/helpers';
import type { CacheParser } from '../types';

interface CachedAssets {
  cacheKeys: string[];
  keys: string[];
}

/** 纹理数组:按 `key`、`key2`、`key3`… 逐张入缓存(同 Pixi `cacheTextureArray`) */
export const cacheTextureArray: CacheParser<Texture[]> = {
  extension: { type: 'cache-parser', name: 'cacheTextureArray' },
  test: (asset: unknown) => Array.isArray(asset) && asset.every((t) => t instanceof Texture),
  getCacheableAssets: (keys: string[], asset: Texture[]) => {
    const out: Record<string, Texture> = {};
    keys.forEach((key) => {
      asset.forEach((item, i) => {
        out[key + (i === 0 ? '' : i + 1)] = item;
      });
    });
    return out;
  },
};

class CacheClass {
  private readonly _parsers: CacheParser[] = [];
  private readonly _cache: Map<any, any> = new Map();
  private readonly _cacheMap: Map<string, CachedAssets> = new Map();

  /** 清空缓存(不销毁资源) */
  reset(): void {
    this._cacheMap.clear();
    this._cache.clear();
  }

  has(key: any): boolean {
    return this._cache.has(key);
  }

  /** 取资源;没有时告警并返回 undefined(同 Pixi) */
  get<T = any>(key: any): T {
    const result = this._cache.get(key);
    if (!result) {
      warn(`[Assets] Asset id ${key} was not found in the Cache`);
    }
    return result as T;
  }

  set(key: any | any[], value: unknown): void {
    const keys = convertToList<string>(key);
    let cacheableAssets: Record<string, any> | undefined;
    for (let i = 0; i < this.parsers.length; i++) {
      const parser = this.parsers[i];
      if (parser.test(value)) {
        cacheableAssets = parser.getCacheableAssets(keys, value);
        break;
      }
    }
    const cacheableMap = new Map(Object.entries(cacheableAssets || {}));
    if (!cacheableAssets) {
      keys.forEach((key2) => {
        cacheableMap.set(key2, value);
      });
    }
    const cacheKeys = [...cacheableMap.keys()];
    const cachedAssets: CachedAssets = { cacheKeys, keys };
    keys.forEach((key2) => {
      this._cacheMap.set(key2, cachedAssets);
    });
    cacheKeys.forEach((key2) => {
      const val = cacheableAssets ? cacheableAssets[key2] : value;
      if (this._cache.has(key2) && this._cache.get(key2) !== val) {
        warn('[Cache] already has key:', key2);
      }
      this._cache.set(key2, cacheableMap.get(key2));
    });
  }

  remove(key: any): void {
    if (!this._cacheMap.has(key)) {
      warn(`[Assets] Asset id ${key} was not found in the Cache`);
      return;
    }
    const cacheMap = this._cacheMap.get(key)!;
    const cacheKeys = cacheMap.cacheKeys;
    cacheKeys.forEach((key2) => {
      this._cache.delete(key2);
    });
    cacheMap.keys.forEach((key2) => {
      this._cacheMap.delete(key2);
    });
  }

  get parsers(): CacheParser[] {
    return this._parsers;
  }
}

/** 全局缓存单例(同 Pixi `Cache`) */
export const Cache = new CacheClass();
export type { CacheClass };
