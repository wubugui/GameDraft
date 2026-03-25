import { Assets, Texture } from 'pixi.js';
import type { SceneData, SceneDataRaw } from '../data/types';
import { resolveAssetPath } from './assetPath';

const DEFAULT_SCENE_WIDTH = 800;
const DEFAULT_SCENE_HEIGHT = 600;

export class AssetManager {
  private jsonCache: Map<string, unknown> = new Map();
  private textCache: Map<string, string> = new Map();

  async loadTexture(path: string): Promise<Texture> {
    const resolved = resolveAssetPath(path);
    return await Assets.load(resolved);
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

  resolveSceneAssetPath(sceneId: string, imagePath: string): string {
    if (!imagePath || imagePath.startsWith('/') || imagePath.startsWith('assets/')) return imagePath;
    return `assets/scenes/${sceneId}/${imagePath}`;
  }

  async loadSceneData(sceneId: string): Promise<SceneData> {
    const raw = await this.loadJson<SceneDataRaw>(`assets/scenes/${sceneId}.json`);
    const scale = raw.backgroundScale ?? 1;

    if (raw.backgrounds) {
      for (const layer of raw.backgrounds) {
        layer.image = this.resolveSceneAssetPath(sceneId, layer.image);
      }
    }
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
