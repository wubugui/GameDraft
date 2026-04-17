import type { SceneDepthSystem } from '../core/SceneDepthSystem';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import type { AssetManager } from '../core/AssetManager';
import { Texture } from 'pixi.js';
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
  /** 写入 F2「日志」页，用于移动端深度/贴图绑定验证 */
  private readonly panelLog?: (msg: string) => void;

  constructor(
    depthSystem: SceneDepthSystem,
    camera: Camera,
    renderer: Renderer,
    assetManager: AssetManager,
    panelLog?: (msg: string) => void,
  ) {
    this.depthSystem = depthSystem;
    this.camera = camera;
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.panelLog = panelLog;

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

    if (mode === 'depth' && this.panelLog) {
      const wc = this.renderer.worldContainer;
      const S = this.camera.getProjectionScale();
      const sw = this.sceneW * S;
      const sh = this.sceneH * S;
      const dt = this.depthSystem.currentDepthTexture;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 0;
      const sameWhite = dt != null && dt === Texture.WHITE;
      const rType = (this.renderer.app.renderer as { type?: number }).type;
      this.panelLog(
        `F2深度模式: sceneId=${this.currentSceneId || '—'} depthEnabled=${this.depthSystem.isEnabled} ` +
          `curTex=${dt ? `${dt.width}x${dt.height} uid=${dt.uid} WHITE=${sameWhite}` : 'null'} ` +
          `wc=(${wc.x.toFixed(1)},${wc.y.toFixed(1)}) S=${S.toFixed(3)} scenePx=${sw.toFixed(1)}x${sh.toFixed(1)} ` +
          `appScreen=${this.renderer.screenWidth}x${this.renderer.screenHeight} dpr=${dpr} pixiRendererType=${rType ?? '?'}`,
      );
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

    if (this.panelLog) {
      const sameWhite = depthTexture === Texture.WHITE;
      this.panelLog(
        `onSceneLoaded: ${sceneId} depthTex=${texWidth}x${texHeight} uid=${depthTexture.uid} ` +
          `WHITE=${sameWhite} depth_map=${cfg.depth_map} invert=${cfg.depth_mapping.invert} ` +
          `scale=${cfg.depth_mapping.scale} offset=${cfg.depth_mapping.offset}`,
      );
    }

    if (this.currentMode === 'collision') {
      this.loadCollisionTexture();
    }
  }

  /** 调试：仅更新世界尺寸（与 applyDebugWorldSize 一致时背景调试叠加仍对齐） */
  updateSceneWorldSize(worldWidth: number, worldHeight: number): void {
    this.sceneW = worldWidth;
    this.sceneH = worldHeight;
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
