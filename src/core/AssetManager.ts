import { Assets, Texture } from 'pixi.js';
import type { SceneData, SceneDataRaw } from '../data/types';

const DEFAULT_SCENE_WIDTH = 800;
const DEFAULT_SCENE_HEIGHT = 600;

export class AssetManager {
  private jsonCache: Map<string, unknown> = new Map();
  private textCache: Map<string, string> = new Map();

  async loadTexture(path: string): Promise<Texture> {
    return await Assets.load(path);
  }

  async loadJson<T = unknown>(path: string): Promise<T> {
    if (this.jsonCache.has(path)) {
      return this.jsonCache.get(path) as T;
    }
    const response = await fetch(path);
    const data = await response.json();
    this.jsonCache.set(path, data);
    return data as T;
  }

  async loadText(path: string): Promise<string> {
    if (this.textCache.has(path)) {
      return this.textCache.get(path)!;
    }
    const response = await fetch(path);
    const text = await response.text();
    this.textCache.set(path, text);
    return text;
  }

  async loadSceneData(sceneId: string): Promise<SceneData> {
    const raw = await this.loadJson<SceneDataRaw>(`/assets/scenes/${sceneId}.json`);
    const scale = raw.backgroundScale ?? 1;

    if (raw.backgrounds && raw.backgrounds.length > 0) {
      try {
        const texture = await this.loadTexture(raw.backgrounds[0].image);
        const w = Math.round(texture.width * scale);
        const h = Math.round(texture.height * scale);
        return { ...raw, width: w, height: h } as SceneData;
      } catch (_e) {
        // 首张背景加载失败时用 JSON 或默认尺寸
      }
    }

    const hasExplicitSize =
      typeof raw.width === 'number' && typeof raw.height === 'number' && raw.width > 0 && raw.height > 0;
    if (hasExplicitSize) {
      return raw as SceneData;
    }

    return {
      ...raw,
      width: raw.width ?? DEFAULT_SCENE_WIDTH,
      height: raw.height ?? DEFAULT_SCENE_HEIGHT,
    } as SceneData;
  }

  clearCache(): void {
    this.jsonCache.clear();
    this.textCache.clear();
  }
}
