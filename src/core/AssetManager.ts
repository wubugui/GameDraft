import { Assets, Texture } from 'pixi.js';
import type { SceneData } from '../data/types';

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
    return this.loadJson<SceneData>(`/assets/scenes/${sceneId}.json`);
  }

  clearCache(): void {
    this.jsonCache.clear();
    this.textCache.clear();
  }
}
