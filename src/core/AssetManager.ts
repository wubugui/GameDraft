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

  /**
   * 有首张背景且加载成功时：世界宽高恒为「纹理像素 × 同一 drawScale」，与深度图/碰撞 1:1。
   * drawScale 只来自 backgroundWorldWidth 或 backgroundScale；JSON 里的 width/height 不参与（与迭代前行为一致）。
   */
  async loadSceneData(sceneId: string): Promise<SceneData> {
    const raw = await this.loadJson<SceneDataRaw>(`assets/scenes/${sceneId}.json`);

    if (raw.backgrounds) {
      for (const layer of raw.backgrounds) {
        layer.image = this.resolveSceneAssetPath(sceneId, layer.image);
      }
    }

    const hasExplicitSize =
      typeof raw.width === 'number' && typeof raw.height === 'number' && raw.width > 0 && raw.height > 0;

    if (raw.backgrounds && raw.backgrounds.length > 0) {
      try {
        const texture = await this.loadTexture(raw.backgrounds[0].image);
        const texW = texture.width;
        const texH = texture.height;

        let backgroundDrawScale: number;
        if (typeof raw.backgroundWorldWidth === 'number' && raw.backgroundWorldWidth > 0) {
          backgroundDrawScale = raw.backgroundWorldWidth / texW;
        } else {
          backgroundDrawScale = raw.backgroundScale ?? 1;
        }

        const width = Math.round(texW * backgroundDrawScale);
        const height = Math.round(texH * backgroundDrawScale);

        return { ...raw, width, height, backgroundDrawScale } as SceneData;
      } catch (_e) {
        // 首张背景加载失败时用 JSON 或默认尺寸
      }
    }

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
