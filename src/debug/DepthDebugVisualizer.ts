import type { SceneDepthSystem } from '../core/SceneDepthSystem';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import type { AssetManager } from '../core/AssetManager';
import type { Texture } from 'pixi.js';
import type { SceneDepthConfig } from '../data/types';
import { BackgroundDebugFilter } from '../rendering/BackgroundDebugFilter';

export type BgDebugMode = 'off' | 'depth' | 'collision' | 'uv';

const MODE_MAP: Record<BgDebugMode, number> = {
  off: 0,
  depth: 1,
  collision: 2,
  uv: 3,
};

/**
 * 背景调试可视化
 *
 * 通过 BackgroundDebugFilter 直接在背景上渲染调试信息。
 * 由 F2 DebugPanel 控制开关和模式选择。
 */
export class DepthDebugVisualizer {
  private depthSystem: SceneDepthSystem;
  private camera: Camera;
  private renderer: Renderer;
  private assetManager: AssetManager;

  private filter: BackgroundDebugFilter;
  private currentMode: BgDebugMode = 'off';
  private collisionTextureLoaded = false;
  private currentSceneId = '';
  private collisionMapName = '';
  private sceneW = 0;
  private sceneH = 0;

  constructor(
    depthSystem: SceneDepthSystem,
    camera: Camera,
    renderer: Renderer,
    assetManager: AssetManager,
  ) {
    this.depthSystem = depthSystem;
    this.camera = camera;
    this.renderer = renderer;
    this.assetManager = assetManager;

    this.filter = new BackgroundDebugFilter();
    this.renderer.backgroundLayer.filters = [this.filter];
  }

  get mode(): BgDebugMode { return this.currentMode; }

  setMode(mode: BgDebugMode): void {
    this.currentMode = mode;
    this.filter.setMode(MODE_MAP[mode]);

    if (mode === 'collision' && !this.collisionTextureLoaded) {
      this.loadCollisionTexture();
    }
  }

  /** 场景加载后调用，将深度配置和纹理尺寸传给 filter */
  onSceneLoaded(
    sceneId: string,
    depthTexture: Texture,
    texWidth: number,
    texHeight: number,
    worldWidth: number,
    worldHeight: number,
    cfg: SceneDepthConfig,
  ): void {
    this.currentSceneId = sceneId;
    this.collisionTextureLoaded = false;
    this.collisionMapName = cfg.collision_map ?? 'collision.png';
    this.sceneW = worldWidth;
    this.sceneH = worldHeight;
    this.filter.loadSceneData(depthTexture, texWidth, texHeight, cfg);

    if (this.currentMode === 'collision') {
      this.loadCollisionTexture();
    }
  }

  /** 场景卸载时重置（filter 保留在 backgroundLayer 上，mode=off 即透传） */
  onSceneUnloaded(): void {
    this.collisionTextureLoaded = false;
    this.currentSceneId = '';
  }

  private async loadCollisionTexture(): Promise<void> {
    if (!this.currentSceneId) return;
    try {
      const path = `assets/scenes/${this.currentSceneId}/${this.collisionMapName}`;
      const tex = await this.assetManager.loadTexture(path);
      this.filter.setCollisionTexture(tex);
      this.collisionTextureLoaded = true;
    } catch (e) {
      console.warn('[BgDebug] Failed to load collision texture:', e);
    }
  }

  update(): void {
    if (this.currentMode === 'off') return;
    const wc = this.renderer.worldContainer;
    this.filter.setWorldContainerPos(wc.x, wc.y);
    const S = this.camera.getProjectionScale();
    this.filter.setSceneSize(this.sceneW * S, this.sceneH * S);
  }

  destroy(): void {
    this.filter.setMode(0);
    if (this.renderer.backgroundLayer.filters) {
      this.renderer.backgroundLayer.filters = this.renderer.backgroundLayer.filters
        .filter(f => f !== this.filter);
    }
  }
}
