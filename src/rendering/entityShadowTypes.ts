import type { Texture } from '../engine2d';
import type { ResolvedLightEnv } from './lightEnv';
import type { ShadowProjectionField } from './shadowField';
import type { ResolvedContactAo } from './contactAo';
import type { ContactAoSource } from './contactAoSources';

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
 * - real：用 depthTexture(GPU) + 完整 9 元 R + ppu/cx/cy + depth_mapping 在片元重建真实 3D。
 * - planar：用 depthTexture/collisionTexture(GPU) 做碰撞裁切 + 遮挡 blend。
 */
export interface ShadowSceneContext {
  depthTexture: Texture;
  collisionTexture: Texture | null;
  sceneW: number;
  sceneH: number;
  worldToPixelX: number;
  worldToPixelY: number;
  invert: number;
  scale: number;
  offset: number;
  floorOffset: number;
  /** 行走面深度场(GPU,RG16)+解码区间。影子落地面逐像素取它,floor 拟合直线已废除 */
  groundTexture: import('../engine2d').TextureSource | null;
  groundMin: number;
  groundMax: number;
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

/**
 * 影子的**形状**参数（与浓度/方向/长度无关的那一半）。
 *
 * 为什么不塞进 `ResolvedLightEnv.shadow`：那个类型是场景光环境的公共面，没接绑定的场景
 * 也在读它；而形状只有"绑了灯、知道灯在哪"的路径才解得出来，挂过去等于给所有场景开一个
 * 永远是缺省值的字段。传 null / 不传 = 恒等形状（= 2026-08-22 之前的行为）。
 */
export interface ShadowShapeParams {
  /**
   * 头端半宽 ÷ 底边半宽。角色是竖直片、灯是有限远的点 → 投影会**散开**：
   * 灯越低（相对角色高），头端越宽。平行光恒 1（平行光线不散）。
   */
  spread: number;
  /**
   * 底边半宽的横向系数 = **迎光截面**。人在平面上近似成椭圆（左右宽、前后薄）：
   * 正面/背面受光时影子该有肩宽（1），侧向受光时只该有体厚（≈0.38）。
   * 剪影贴图永远是正面帧，这个系数是"换侧面剪影"的一阶近似。
   */
  widthScale: number;
}

/** 未解出形状时的恒等值：平行四边形、不压窄——与本次改动之前逐像素一致。 */
export const IDENTITY_SHADOW_SHAPE: ShadowShapeParams = { spread: 1, widthScale: 1 };

/**
 * 胶囊 AO（脚底接触 AO）的输入，只给画接触阴影的主实例。
 *
 * 作者面（制作人 2026-09-24）：接触 AO 缺省开（简单 AO）；方向 AO 缺省也开。方向部分由几路光
 * 各投各的软影、按各自在地面照度里的占比加权（见 `contactAoSources.ts`）；方向来源选
 * 「跟阴影绑定」「场景主光」时只有一路、权重 1。浓度上限只认解出来的 `ao.darkness`。
 */
export interface ContactAoParams {
  /** 这个实体解好的接触 AO 参数（`resolveContactAo`）。 */
  ao: ResolvedContactAo;
  /** 方向部分的几路光（≤ MAX_CONTACT_AO_SOURCES，权重和 ≤ 1）；空 = 只画无方向部分（没勾方向 AO 也是空）。 */
  sources: readonly ContactAoSource[];
  /** 1 个 q 单位 = 多少 wu（铁律 0：光照的长度一律 wu）。 */
  wuPerQUnit: number;
}

/** 阴影实现统一接口（PlanarEntityShadow / DeferredEntityShadow 各实现一版）。 */
export interface IEntityShadow {
  update(
    src: ShadowSource,
    env: ResolvedLightEnv,
    field?: ShadowProjectionField | null,
    shape?: ShadowShapeParams | null,
    contactAo?: ContactAoParams | null,
  ): void;
  /**
   * 深度调参（F2 tolerance/floorOffset/occlusionBlendFactor）广播入口：
   * 构造时这些值以快照烘焙进 shader uniform，运行时改参须经此传播。
   * 不消费深度参数的实现（deferred）可不实现。
   */
  setDepthParams?(tolerance: number, floorOffset: number, occlusionBlendFactor: number): void;
  destroy(): void;
}
