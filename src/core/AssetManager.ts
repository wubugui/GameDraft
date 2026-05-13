import { Assets, Texture } from 'pixi.js';
import { Howl } from 'howler';
import type { SceneData, SceneDataRaw } from '../data/types';
import { resolveAssetPath } from './assetPath';

const DEFAULT_SCENE_WIDTH = 800;
const DEFAULT_SCENE_HEIGHT = 600;

export class AssetManager {
  private jsonCache: Map<string, unknown> = new Map();
  private textCache: Map<string, string> = new Map();
  private audioCache: Map<string, Howl> = new Map();

  private audioKey(path: string, loop: boolean): string {
    return `${resolveAssetPath(path)}::loop=${loop ? '1' : '0'}`;
  }

  async loadTexture(path: string): Promise<Texture> {
    const resolved = resolveAssetPath(path);
    return await Assets.load(resolved);
  }

  getTexture(path: string): Texture | null {
    const resolved = resolveAssetPath(path);
    return Assets.get<Texture>(resolved) ?? null;
  }

  async loadJson<T = unknown>(path: string): Promise<T> {
    const resolved = resolveAssetPath(path);
    if (this.jsonCache.has(resolved)) {
      return this.jsonCache.get(resolved) as T;
    }
    const response = await fetch(resolved);
    const data = await response.json();
    this.jsonCache.set(resolved, data);
    return data as T;
  }

  async loadText(path: string): Promise<string> {
    const resolved = resolveAssetPath(path);
    if (this.textCache.has(resolved)) {
      return this.textCache.get(resolved)!;
    }
    const response = await fetch(resolved);
    const text = await response.text();
    this.textCache.set(resolved, text);
    return text;
  }

  async loadAudio(path: string, options: { loop?: boolean } = {}): Promise<Howl> {
    const loop = options.loop === true;
    const resolved = resolveAssetPath(path);
    const key = this.audioKey(path, loop);
    const cached = this.audioCache.get(key);
    if (cached) return cached;

    const howl = await new Promise<Howl>((resolve, reject) => {
      const h = new Howl({
        src: [resolved],
        loop,
        preload: true,
        volume: 0,
        onload: () => resolve(h),
        onloaderror: (_id, error) => reject(error),
      });
    });
    this.audioCache.set(key, howl);
    return howl;
  }

  getAudio(path: string, options: { loop?: boolean } = {}): Howl | null {
    return this.audioCache.get(this.audioKey(path, options.loop === true)) ?? null;
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
    const cached = await this.loadJson<SceneDataRaw>(`assets/scenes/${sceneId}.json`);
    const raw = JSON.parse(JSON.stringify(cached)) as SceneDataRaw;

    if (raw.backgrounds) {
      for (const layer of raw.backgrounds) {
        layer.image = this.resolveSceneAssetPath(sceneId, layer.image);
      }
    }

    // 已有完整的世界尺寸
    if (raw.worldWidth && raw.worldHeight && raw.worldWidth > 0 && raw.worldHeight > 0) {
      return raw as SceneData;
    }

    // 需要从背景图推导尺寸
    if (raw.backgrounds && raw.backgrounds.length > 0) {
      try {
        const texture = await this.loadTexture(raw.backgrounds[0].image);
        const texW = texture.width;
        const texH = texture.height;
        const ratio = texH / texW;

        let worldWidth: number;
        let worldHeight: number;

        if (raw.worldWidth && raw.worldWidth > 0) {
          // 有宽度，按比例计算高度
          worldWidth = raw.worldWidth;
          worldHeight = Math.round(worldWidth * ratio);
        } else if (raw.worldHeight && raw.worldHeight > 0) {
          // 有高度，按比例计算宽度
          worldHeight = raw.worldHeight;
          worldWidth = Math.round(worldHeight / ratio);
        } else {
          // 都没有，使用背景图像素作为世界尺寸
          worldWidth = texW;
          worldHeight = texH;
        }

        return { ...raw, worldWidth, worldHeight } as SceneData;
      } catch (_e) {
        // 背景加载失败，使用默认尺寸
      }
    }

    // 无背景或加载失败，使用默认尺寸
    return {
      ...raw,
      worldWidth: raw.worldWidth ?? DEFAULT_SCENE_WIDTH,
      worldHeight: raw.worldHeight ?? DEFAULT_SCENE_HEIGHT,
    } as SceneData;
  }

  clearCache(): void {
    this.jsonCache.clear();
    this.textCache.clear();
    this.audioCache.forEach((howl) => howl.unload());
    this.audioCache.clear();
  }
}
