import type { ResolvedLightEnv } from './lightEnv';

const DEG2RAD = Math.PI / 180;

/** 某个世界落点处的阴影投射参数。 */
export interface ShadowProjection {
  /** 阴影投射方向（弧度，世界 XY，阴影指向；已是光来向的反方向） */
  angleRad: number;
  /** 阴影长度相对角色高度的倍率 */
  length: number;
}

/**
 * 阴影投射场：给定世界落点，返回该处的阴影方向与长度。
 *
 * 这是「阴影方向来源」的抽象接口 —— EntityShadow 不直接读 LightEnv，而是问这个场。
 * 当前只有一个均匀实现（全局 LightEnv 主光推出方向/长度）；未来可换成在场景里放置的
 * 「灯光方向场」（网格/纹理），让阴影按角色所在位置实时采样方向与长度，无需改 EntityShadow。
 */
export interface ShadowProjectionField {
  sample(worldX: number, worldY: number): ShadowProjection;
}

/**
 * 均匀场：处处返回全局 LightEnv 主光推导出的阴影方向/长度。
 * 按引用持有 ResolvedLightEnv，因此 F2 实时修改 `key.azimuthDeg` / `shadow.length` 会即时反映。
 */
export class UniformShadowField implements ShadowProjectionField {
  constructor(private readonly env: ResolvedLightEnv) {}

  sample(): ShadowProjection {
    return {
      angleRad: (this.env.key.azimuthDeg + 180) * DEG2RAD,
      length: this.env.shadow.length,
    };
  }
}
