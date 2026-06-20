import type { Texture } from 'pixi.js';
import type { ResolvedLightEnv } from './lightEnv';
import type { ShadowProjectionField } from './shadowField';

/**
 * 阴影数据源：玩家 / NPC 的统一只读视图（由 Game 适配，避免阴影模块直依赖实体类）。
 */
export interface ShadowSource {
  getFootX(): number;
  getFootY(): number;
  getWorldWidth(): number;
  getWorldHeight(): number;
  /** 当前显示帧纹理（形状感知）；无则不画 */
  getTexture(): Texture | null;
  /** 左右朝向（与角色镜像一致） */
  getFacing(): 1 | -1;
  isVisible(): boolean;
}

/**
 * 阴影系统的场景上下文：来自 SceneDepthSystem.getShadowSceneContext()。
 * planar 与 real(deferred) 共用——
 * - real：用 depthTexture(GPU) + 完整 9 元 R + ppu/cx/cy + floorA/B + depth_mapping 在片元重建真实 3D。
 * - planar：用 depthTexture/collisionTexture(GPU) 做碰撞裁切 + 遮挡 blend；depthPixels(CPU) 做 drape。
 */
export interface ShadowSceneContext {
  depthTexture: Texture;
  collisionTexture: Texture | null;
  /** 深度图 CPU 像素（RGBA），供 planar 的 depth-drape 逐顶点采样 */
  depthPixels: Uint8ClampedArray | null;
  depthPxW: number;
  depthPxH: number;
  sceneW: number;
  sceneH: number;
  worldToPixelX: number;
  worldToPixelY: number;
  invert: number;
  scale: number;
  offset: number;
  floorA: number;
  floorB: number;
  floorOffset: number;
  tolerance: number;
  occlusionBlendFactor: number;
  ppu: number;
  cx: number;
  cy: number;
  r00: number; r01: number; r02: number;
  r10: number; r11: number; r12: number;
  r20: number; r21: number; r22: number;
  colXMin: number;
  colZMin: number;
  colCellSize: number;
  colGridW: number;
  colGridH: number;
}

/** 阴影实现统一接口（PlanarEntityShadow / DeferredEntityShadow 各实现一版）。 */
export interface IEntityShadow {
  update(src: ShadowSource, env: ResolvedLightEnv, field?: ShadowProjectionField | null): void;
  destroy(): void;
}
