import { Assets, Texture, type Filter } from 'pixi.js';
import { Howl } from 'howler';
import type { SceneData, SceneDataRaw } from '../data/types';
import { resolveAssetPath } from './assetPath';
import { reportDevError, describeError } from './devErrorOverlay';
import { filterJsonUrl, sceneJsonUrl } from './projectPaths';
import { createFilterFromDef } from '../rendering/filter/FilterLoader';
import type { FilterDef } from '../rendering/filter/types';

const DEFAULT_SCENE_WIDTH = 800;
const DEFAULT_SCENE_HEIGHT = 600;

export type AssetType = 'json' | 'texture' | 'audio' | 'text' | 'bitmap' | 'filter';
export type LoadMode = 'stage' | 'runtime';

export interface AssetRef {
  type: AssetType;
  path: string;
  options?: { loop?: boolean };
  label?: string;
}

export interface AssetManifest {
  scopeId: string;
  refs: AssetRef[];
}

export interface AssetStats {
  hits: number;
  misses: number;
  loads: number;
  errors: number;
  evictions: number;
  entries: number;
  bytes: number;
  pinned: number;
}

export type AssetCacheLimitConfig = Partial<Record<AssetType, { bytes?: number; entries?: number }>>;

interface CacheEntry<T = unknown> {
  key: string;
  type: AssetType;
  value: T;
  bytes: number;
  lastUsed: number;
  pins: Set<string>;
}

interface CacheBucket<T = unknown> {
  entries: Map<string, CacheEntry<T>>;
  inflight: Map<string, Promise<T>>;
  errors: Map<string, unknown>;
  limitBytes?: number;
  limitEntries?: number;
  stats: Omit<AssetStats, 'entries' | 'bytes' | 'pinned'>;
}

const MB = 1024 * 1024;
const SAFE_MAX_TEXTURE_SIZE = 2048;

const DEFAULT_LIMITS: Record<AssetType, { bytes?: number; entries?: number }> = {
  json: { bytes: 32 * MB },
  texture: { bytes: 256 * MB },
  audio: { bytes: 64 * MB },
  text: { bytes: 32 * MB },
  bitmap: { bytes: 64 * MB },
  filter: { entries: 64 },
};

function createBucket<T = unknown>(type: AssetType): CacheBucket<T> {
  const limits = DEFAULT_LIMITS[type];
  return {
    entries: new Map(),
    inflight: new Map(),
    errors: new Map(),
    limitBytes: limits.bytes,
    limitEntries: limits.entries,
    stats: { hits: 0, misses: 0, loads: 0, errors: 0, evictions: 0 },
  };
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function jsonBytes(value: unknown): number {
  try {
    return textBytes(JSON.stringify(value));
  } catch {
    return 1024;
  }
}

function textureBytes(texture: Texture): number {
  return Math.max(1, texture.width) * Math.max(1, texture.height) * 4;
}

function assertSafeTextureSize(texture: Texture, key: string): void {
  if (texture.width <= SAFE_MAX_TEXTURE_SIZE && texture.height <= SAFE_MAX_TEXTURE_SIZE) return;
  throw new Error(
    `texture exceeds safe max ${SAFE_MAX_TEXTURE_SIZE}px: ${key} (${texture.width}x${texture.height})`,
  );
}

function bitmapBytes(bitmap: ImageBitmap): number {
  return Math.max(1, bitmap.width) * Math.max(1, bitmap.height) * 4;
}

export class AssetManager {
  private buckets: Record<AssetType, CacheBucket> = {
    json: createBucket('json'),
    texture: createBucket('texture'),
    audio: createBucket('audio'),
    text: createBucket('text'),
    bitmap: createBucket('bitmap'),
    filter: createBucket('filter'),
  };
  private logicalClock = 0;
  private scopeRefs = new Map<string, AssetRef[]>();
  private readonly verboseStageLog =
    typeof import.meta !== 'undefined'
    && import.meta.env?.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('assetDebug');

  constructor(limits: AssetCacheLimitConfig = {}) {
    for (const [type, limit] of Object.entries(limits) as Array<[AssetType, { bytes?: number; entries?: number }]>) {
      if (limit.bytes !== undefined) this.buckets[type].limitBytes = limit.bytes;
      if (limit.entries !== undefined) this.buckets[type].limitEntries = limit.entries;
    }
  }

  private touch<T>(bucket: CacheBucket<T>, entry: CacheEntry<T>): T {
    entry.lastUsed = ++this.logicalClock;
    bucket.entries.delete(entry.key);
    bucket.entries.set(entry.key, entry);
    return entry.value;
  }

  private getFromBucket<T>(type: AssetType, key: string): T | null {
    const bucket = this.buckets[type] as CacheBucket<T>;
    const entry = bucket.entries.get(key);
    if (!entry) {
      bucket.stats.misses++;
      return null;
    }
    bucket.stats.hits++;
    return this.touch(bucket, entry);
  }

  private async loadIntoBucket<T>(
    type: AssetType,
    key: string,
    loader: () => Promise<T>,
    sizeOf: (value: T) => number,
  ): Promise<T> {
    const cached = this.getFromBucket<T>(type, key);
    if (cached) return cached;

    const bucket = this.buckets[type] as CacheBucket<T>;
    const inflight = bucket.inflight.get(key);
    if (inflight) return inflight;

    const p = loader()
      .then((value) => {
        bucket.inflight.delete(key);
        bucket.errors.delete(key);
        bucket.stats.loads++;
        const existing = bucket.entries.get(key);
        const pins = existing?.pins ?? this.scopesForKey(type, key);
        const entry: CacheEntry<T> = {
          key,
          type,
          value,
          bytes: Math.max(1, sizeOf(value)),
          lastUsed: ++this.logicalClock,
          pins,
        };
        bucket.entries.set(key, entry);
        this.evict(type);
        return value;
      })
      .catch((e) => {
        bucket.inflight.delete(key);
        bucket.errors.set(key, e);
        bucket.stats.errors++;
        reportDevError(`[${type}] 加载失败: ${key}\n${describeError(e)}`);
        throw e;
      });
    bucket.inflight.set(key, p);
    return p;
  }

  private evict(type: AssetType): void {
    const bucket = this.buckets[type];
    const overLimits = (): boolean => {
      if (bucket.limitEntries !== undefined && bucket.entries.size > bucket.limitEntries) return true;
      if (bucket.limitBytes !== undefined && this.bucketBytes(bucket) > bucket.limitBytes) return true;
      return false;
    };

    while (overLimits()) {
      let victim: CacheEntry | null = null;
      for (const entry of bucket.entries.values()) {
        if (entry.pins.size > 0) continue;
        if (!victim || entry.lastUsed < victim.lastUsed) victim = entry;
      }
      if (!victim) break;
      this.disposeEntry(victim);
      bucket.entries.delete(victim.key);
      bucket.stats.evictions++;
    }
  }

  private bucketBytes(bucket: CacheBucket): number {
    let total = 0;
    for (const entry of bucket.entries.values()) total += entry.bytes;
    return total;
  }

  private disposeEntry(entry: CacheEntry): void {
    if (entry.type === 'texture') {
      const texture = entry.value as Texture;
      texture.source?.unload();
    }
    if (entry.type === 'audio') {
      (entry.value as Howl).unload();
    }
    if (entry.type === 'bitmap') {
      (entry.value as ImageBitmap).close();
    }
  }

  private keyForRef(ref: AssetRef): string {
    if (ref.type === 'filter') return ref.path.trim();
    const resolved = resolveAssetPath(ref.path);
    if (ref.type === 'audio') return `${resolved}::loop=${ref.options?.loop === true ? '1' : '0'}`;
    return resolved;
  }

  async loadTexture(path: string): Promise<Texture> {
    const resolved = resolveAssetPath(path);
    return this.loadIntoBucket<Texture>(
      'texture',
      resolved,
      async () => {
        const texture = await Assets.load<Texture>(resolved);
        assertSafeTextureSize(texture, resolved);
        return texture;
      },
      textureBytes,
    );
  }

  getTexture(path: string): Texture | null {
    return this.getFromBucket<Texture>('texture', resolveAssetPath(path));
  }

  async loadJson<T = unknown>(path: string): Promise<T> {
    const resolved = resolveAssetPath(path);
    return this.loadIntoBucket<T>(
      'json',
      resolved,
      async () => {
        const response = await fetch(resolved);
        if (!response.ok) throw new Error(`fetch ${response.status} for ${resolved}`);
        return await response.json() as T;
      },
      jsonBytes,
    );
  }

  getJson<T = unknown>(path: string): T | null {
    return this.getFromBucket<T>('json', resolveAssetPath(path));
  }

  async loadText(path: string): Promise<string> {
    const resolved = resolveAssetPath(path);
    return this.loadIntoBucket<string>(
      'text',
      resolved,
      async () => {
        const response = await fetch(resolved);
        if (!response.ok) throw new Error(`fetch ${response.status} for ${resolved}`);
        return await response.text();
      },
      textBytes,
    );
  }

  getText(path: string): string | null {
    return this.getFromBucket<string>('text', resolveAssetPath(path));
  }

  async loadBitmap(path: string): Promise<ImageBitmap> {
    const resolved = resolveAssetPath(path);
    return this.loadIntoBucket<ImageBitmap>(
      'bitmap',
      resolved,
      async () => {
        const resp = await fetch(resolved);
        if (!resp.ok) throw new Error(`fetch ${resp.status} for ${resolved}`);
        return await createImageBitmap(await resp.blob());
      },
      bitmapBytes,
    );
  }

  getBitmap(path: string): ImageBitmap | null {
    return this.getFromBucket<ImageBitmap>('bitmap', resolveAssetPath(path));
  }

  async loadAudio(path: string, options: { loop?: boolean } = {}): Promise<Howl> {
    const loop = options.loop === true;
    const resolved = resolveAssetPath(path);
    const key = `${resolved}::loop=${loop ? '1' : '0'}`;
    return this.loadIntoBucket<Howl>(
      'audio',
      key,
      () => new Promise<Howl>((resolve, reject) => {
        const h = new Howl({
          src: [resolved],
          loop,
          preload: true,
          volume: 0,
          onload: () => resolve(h),
          onloaderror: (_id, error) => reject(error),
        });
      }),
      () => MB,
    );
  }

  getAudio(path: string, options: { loop?: boolean } = {}): Howl | null {
    const resolved = resolveAssetPath(path);
    return this.getFromBucket<Howl>('audio', `${resolved}::loop=${options.loop === true ? '1' : '0'}`);
  }

  async loadFilter(filterId: string): Promise<Filter> {
    const id = filterId.trim();
    return this.loadIntoBucket<Filter>(
      'filter',
      id,
      async () => {
        const def = await this.loadJson<FilterDef>(filterJsonUrl(id));
        return createFilterFromDef(def);
      },
      () => 1,
    );
  }

  getFilter(filterId: string): Filter | null {
    return this.getFromBucket<Filter>('filter', filterId.trim());
  }

  async preloadManifest(
    manifest: AssetManifest,
    options: {
      mode?: LoadMode;
      onProgress?: (ratio01: number, label: string) => void;
      tolerateErrors?: boolean;
    } = {},
  ): Promise<void> {
    const refs = this.dedupeRefs(manifest.refs);
    this.pinScope(manifest.scopeId, refs);
    const total = Math.max(1, refs.length);
    let done = 0;
    const start = performance.now();
    options.onProgress?.(0, refs.length > 0 ? '资源准备' : '资源准备完成');
    const loadOne = async (ref: AssetRef): Promise<void> => {
      const label = ref.label ?? `${ref.type}: ${ref.path}`;
      const itemStart = performance.now();
      try {
        await this.loadRef(ref);
        this.pinLoadedRef(manifest.scopeId, ref);
      } catch (e) {
        if (!options.tolerateErrors) throw e;
        console.warn(`AssetManager: preload failed (${label})`, e);
      } finally {
        done++;
        options.onProgress?.(Math.min(1, done / total), label);
        if (this.verboseStageLog && options.mode === 'stage') {
          console.debug(`[assets] ${manifest.scopeId} ${label} ${Math.round(performance.now() - itemStart)}ms`);
        }
      }
    };
    await Promise.all(refs.map(loadOne));
    if (this.verboseStageLog && options.mode === 'stage') {
      console.debug(`[assets] ${manifest.scopeId} total ${Math.round(performance.now() - start)}ms (${refs.length} refs)`);
    }
  }

  async loadRef(ref: AssetRef): Promise<unknown> {
    switch (ref.type) {
      case 'json': return await this.loadJson(ref.path);
      case 'texture': return await this.loadTexture(ref.path);
      case 'audio': return await this.loadAudio(ref.path, ref.options);
      case 'text': return await this.loadText(ref.path);
      case 'bitmap': return await this.loadBitmap(ref.path);
      case 'filter': return await this.loadFilter(ref.path);
    }
  }

  pinScope(scopeId: string, refs: AssetRef[]): void {
    this.releaseScope(scopeId);
    const deduped = this.dedupeRefs(refs);
    this.scopeRefs.set(scopeId, deduped);
    for (const ref of deduped) {
      const bucket = this.buckets[ref.type];
      const entry = bucket.entries.get(this.keyForRef(ref));
      entry?.pins.add(scopeId);
    }
  }

  private pinLoadedRef(scopeId: string, ref: AssetRef): void {
    const bucket = this.buckets[ref.type];
    const entry = bucket.entries.get(this.keyForRef(ref));
    entry?.pins.add(scopeId);
  }

  private scopesForKey(type: AssetType, key: string): Set<string> {
    const pins = new Set<string>();
    for (const [scopeId, refs] of this.scopeRefs.entries()) {
      if (refs.some(ref => ref.type === type && this.keyForRef(ref) === key)) {
        pins.add(scopeId);
      }
    }
    return pins;
  }

  releaseScope(scopeId: string): void {
    const refs = this.scopeRefs.get(scopeId);
    if (!refs) return;
    for (const ref of refs) {
      const bucket = this.buckets[ref.type];
      const entry = bucket.entries.get(this.keyForRef(ref));
      entry?.pins.delete(scopeId);
    }
    this.scopeRefs.delete(scopeId);
    for (const type of Object.keys(this.buckets) as AssetType[]) this.evict(type);
  }

  getStats(): Record<AssetType, AssetStats> {
    const out = {} as Record<AssetType, AssetStats>;
    for (const type of Object.keys(this.buckets) as AssetType[]) {
      const bucket = this.buckets[type];
      let pinned = 0;
      for (const entry of bucket.entries.values()) {
        if (entry.pins.size > 0) pinned++;
      }
      out[type] = {
        ...bucket.stats,
        entries: bucket.entries.size,
        bytes: this.bucketBytes(bucket),
        pinned,
      };
    }
    return out;
  }

  clearCache(type?: AssetType): void {
    const types = type ? [type] : Object.keys(this.buckets) as AssetType[];
    for (const t of types) {
      const bucket = this.buckets[t];
      for (const entry of bucket.entries.values()) this.disposeEntry(entry);
      bucket.entries.clear();
      bucket.inflight.clear();
      bucket.errors.clear();
    }
    if (!type) this.scopeRefs.clear();
  }

  resolveSceneAssetPath(sceneId: string, imagePath: string): string {
    if (!imagePath || imagePath.startsWith('/') || imagePath.startsWith('resources/')) return imagePath;
    return `resources/runtime/scenes/${sceneId}/${imagePath}`;
  }

  /**
   * 加载场景数据。
   * worldWidth/worldHeight 定义场景的世界尺寸。
   * 如果某个为 0 或缺失，用背景图尺寸按比例计算。
   */
  async loadSceneData(sceneId: string): Promise<SceneData> {
    const cached = await this.loadJson<SceneDataRaw>(sceneJsonUrl(sceneId));
    const raw = JSON.parse(JSON.stringify(cached)) as SceneDataRaw;

    // 背景图文件名强约束：场景主背景只能叫 background.png。名字不对直接报错、不加载，
    // 避免带着错误资源引用半死不活地跑（编辑器导入背景时统一迁入并命名为 background.png）。
    if (raw.backgrounds && raw.backgrounds.length > 0) {
      const primaryImage = raw.backgrounds[0]?.image;
      if (primaryImage !== 'background.png') {
        throw new Error(
          `场景 "${sceneId}" 的背景图文件名必须是 background.png，实际为 "${primaryImage}"。` +
          `请在编辑器中重新导入背景图。`,
        );
      }
    }

    if (raw.backgrounds) {
      for (const layer of raw.backgrounds) {
        layer.image = this.resolveSceneAssetPath(sceneId, layer.image);
      }
    }

    if (raw.worldWidth && raw.worldHeight && raw.worldWidth > 0 && raw.worldHeight > 0) {
      return raw as SceneData;
    }

    if (raw.backgrounds && raw.backgrounds.length > 0) {
      try {
        const texture = await this.loadTexture(raw.backgrounds[0].image);
        const texW = texture.width;
        const texH = texture.height;
        const ratio = texH / texW;

        let worldWidth: number;
        let worldHeight: number;

        if (raw.worldWidth && raw.worldWidth > 0) {
          worldWidth = raw.worldWidth;
          worldHeight = Math.round(worldWidth * ratio);
        } else if (raw.worldHeight && raw.worldHeight > 0) {
          worldHeight = raw.worldHeight;
          worldWidth = Math.round(worldHeight / ratio);
        } else {
          worldWidth = texW;
          worldHeight = texH;
        }

        return { ...raw, worldWidth, worldHeight } as SceneData;
      } catch (_e) {
        // 背景加载失败，使用默认尺寸
      }
    }

    return {
      ...raw,
      worldWidth: raw.worldWidth ?? DEFAULT_SCENE_WIDTH,
      worldHeight: raw.worldHeight ?? DEFAULT_SCENE_HEIGHT,
    } as SceneData;
  }

  private dedupeRefs(refs: AssetRef[]): AssetRef[] {
    const seen = new Set<string>();
    const out: AssetRef[] = [];
    for (const ref of refs) {
      if (!ref.path?.trim()) continue;
      const key = `${ref.type}:${this.keyForRef(ref)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
    return out;
  }
}
