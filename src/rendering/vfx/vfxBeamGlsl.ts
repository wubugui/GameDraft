/**
 * 把光柱运行态打成 uniform 数值的**唯一一份打包函数**（游戏的 `VfxBeamView` 与粒子工作台共用，两边不许各写一份）。
 *
 * 零 Pixi / 零 DOM：`tools/vfx_workbench/bundle.py` 把它原样打进页面。文件名是历史名——这里曾经还放着光柱着色的
 * GLSL 核心；游戏与工作台都只画 WGSL 之后那份 GLSL 已删，着色核心只在 `vfxBeamWgsl.ts`（模型见 `systems/vfx/vfxBeam.ts` 头注释）。
 */
import type { VfxBeamDef } from '../../data/types';
import {
  VFX_BEAM_MAX_CURVE_KEYS, VFX_BEAM_MAX_PLANES,
  type VfxSceneQAffine,
} from '../../systems/vfx/vfxBeam';
import type { VfxBeamRuntime } from '../../systems/vfx/vfxSim';

/** 混合模式编号（`uBeamBlend`） */
export const BEAM_BLEND_CODE = { add: 0, screen: 1, normal: 2 } as const;

/** 一根光柱的 uniform 数值（名字与 `vfxBeamWgsl.ts` 的 `VfxBeamUniforms` 结构成员逐字对应，`vfxWgsl.test.ts` 钉着） */
export interface VfxBeamUniformValues {
  uBeamMode: number;
  uBeamS2W0: Float32Array;
  uBeamS2W1: Float32Array;
  uBeamS2W2: Float32Array;
  uBeamPlanes: Float32Array;
  uBeamPlaneCount: number;
  uBeamOrigin: Float32Array;
  uBeamAxis: Float32Array;
  uBeamRight: Float32Array;
  uBeamUp: Float32Array;
  uBeamLength: number;
  uBeamSec: Float32Array;
  uBeamTan: Float32Array;
  uBeam2O: Float32Array;
  uBeam2D: Float32Array;
  uBeam2W: Float32Array;
  uBeamPlaneQ: Float32Array;
  uBeamColor0: Float32Array;
  uBeamColor1: Float32Array;
  uBeamGain: number;
  uBeamEdgeSoft: number;
  uBeamThickness: number;
  uBeamContactSoft: number;
  uBeamWuPerQ: number;
  uBeamBlend: number;
  uBeamAlong: Float32Array;
  uBeamAlongCount: number;
  uBeamNoise: Float32Array;
  uBeamNoiseVel: Float32Array;
  uBeamTime: number;
  uBeamCookieOn: number;
  uBeamCookieXf: Float32Array;
  uBeamCookieRot: Float32Array;
  uBeamCookieStrength: number;
}

export function createBeamUniformValues(): VfxBeamUniformValues {
  return {
    uBeamMode: 0,
    uBeamS2W0: new Float32Array(4), uBeamS2W1: new Float32Array(4), uBeamS2W2: new Float32Array(4),
    uBeamPlanes: new Float32Array(VFX_BEAM_MAX_PLANES * 4), uBeamPlaneCount: 0,
    uBeamOrigin: new Float32Array(3), uBeamAxis: new Float32Array(3), uBeamRight: new Float32Array(3),
    uBeamUp: new Float32Array(3), uBeamLength: 1,
    uBeamSec: new Float32Array(4), uBeamTan: new Float32Array(3),
    uBeam2O: new Float32Array(2), uBeam2D: new Float32Array(4), uBeam2W: new Float32Array([1, 0, 0]),
    uBeamPlaneQ: new Float32Array(4),
    uBeamColor0: new Float32Array([1, 1, 1]), uBeamColor1: new Float32Array([1, 1, 1]),
    uBeamGain: 0, uBeamEdgeSoft: 0, uBeamThickness: 0, uBeamContactSoft: 0, uBeamWuPerQ: 1, uBeamBlend: 0,
    uBeamAlong: new Float32Array(VFX_BEAM_MAX_CURVE_KEYS * 2), uBeamAlongCount: 0,
    uBeamNoise: new Float32Array(4), uBeamNoiseVel: new Float32Array(3), uBeamTime: 0,
    uBeamCookieOn: 0, uBeamCookieXf: new Float32Array([1, 1, 0, 0]), uBeamCookieRot: new Float32Array([1, 0]),
    uBeamCookieStrength: 0,
  };
}

/** 本帧打包需要的场景量 */
export interface VfxBeamPackEnv {
  /** 世界 ↔ (画面, q.z) 仿射（`sceneQAffine(space)`）；3D 光柱没有它就不画 */
  affine: VfxSceneQAffine | null;
  /** 1 q = 多少 wu */
  wuPerQ: number;
  /** 模拟钟（秒）：噪声流动 */
  time: number;
  /**
   * 2D 深度面：锚点脚下直立面上一画面点对应的世界点（`VfxSpace.uprightWorldAtScene`）与 世界 → q（`toQ`）。
   * 没有（planar 近似 / 测试桩）⇒ 2D 光柱不做深度遮挡。
   */
  uprightQz: ((footX: number, footY: number, sx: number, sy: number) => number) | null;
  /** 本场景有没有原画深度（没有 ⇒ 2D 遮挡关掉） */
  hasDepth: boolean;
}

/**
 * 把一根光柱此刻的状态写进 `out`。返回 false = 这一帧不画（退化 / 3D 缺仿射 / 全暗）。
 * `pulse` / `fade` 由调用方给（模拟算好的），打包不读钟。
 */
export function packBeamUniforms(
  b: VfxBeamRuntime, pulse: number, env: VfxBeamPackEnv, out: VfxBeamUniformValues,
): boolean {
  const def: VfxBeamDef = b.def;
  const look = b.look;
  const gain = look.intensity * pulse * b.fade;
  if (!(gain > 0)) return false;
  out.uBeamGain = gain;
  out.uBeamEdgeSoft = look.edgeSoftness;
  out.uBeamThickness = look.thickness;
  out.uBeamContactSoft = look.contactSoftWu;
  out.uBeamWuPerQ = env.wuPerQ;
  out.uBeamBlend = BEAM_BLEND_CODE[look.blend];
  out.uBeamColor0.set(look.color);
  out.uBeamColor1.set(look.colorEnd);
  const curve = def.alongCurve ?? [];
  const nk = Math.min(curve.length, VFX_BEAM_MAX_CURVE_KEYS);
  for (let i = 0; i < nk; i++) { out.uBeamAlong[i * 2] = curve[i][0]; out.uBeamAlong[i * 2 + 1] = curve[i][1]; }
  out.uBeamAlongCount = nk;
  const nz = def.noise;
  if (nz && nz.strength > 0 && nz.scaleWu > 0) {
    out.uBeamNoise[0] = nz.strength; out.uBeamNoise[1] = 1 / nz.scaleWu;
    const v = nz.velocity ?? [0, 0, 0];
    out.uBeamNoiseVel[0] = v[0]; out.uBeamNoiseVel[1] = v[1]; out.uBeamNoiseVel[2] = def.mode === '2d' ? 0 : v[2];
  } else {
    out.uBeamNoise[0] = 0;
  }
  out.uBeamTime = env.time;
  const ck = def.cookie;
  out.uBeamCookieOn = ck ? 1 : 0;
  if (ck) {
    const sc = ck.scale ?? [1, 1], of = ck.offset ?? [0, 0];
    out.uBeamCookieXf[0] = sc[0]; out.uBeamCookieXf[1] = sc[1]; out.uBeamCookieXf[2] = of[0]; out.uBeamCookieXf[3] = of[1];
    const r = ((ck.rotationDeg ?? 0) * Math.PI) / 180;
    out.uBeamCookieRot[0] = Math.cos(r); out.uBeamCookieRot[1] = Math.sin(r);
    out.uBeamCookieStrength = ck.strength ?? 1;
  }
  if (b.frame3d) {
    const f = b.frame3d;
    const inv = env.affine?.inv;
    if (!inv) return false;
    out.uBeamMode = 0;
    out.uBeamS2W0[0] = inv[0]; out.uBeamS2W0[1] = inv[1]; out.uBeamS2W0[2] = inv[2]; out.uBeamS2W0[3] = inv[3];
    out.uBeamS2W1[0] = inv[4]; out.uBeamS2W1[1] = inv[5]; out.uBeamS2W1[2] = inv[6]; out.uBeamS2W1[3] = inv[7];
    out.uBeamS2W2[0] = inv[8]; out.uBeamS2W2[1] = inv[9]; out.uBeamS2W2[2] = inv[10]; out.uBeamS2W2[3] = inv[11];
    out.uBeamPlanes.fill(0);
    out.uBeamPlanes.set(f.planes);
    out.uBeamPlaneCount = f.planeCount;
    out.uBeamOrigin.set(f.origin); out.uBeamAxis.set(f.axis); out.uBeamRight.set(f.right); out.uBeamUp.set(f.up);
    out.uBeamLength = f.length;
    out.uBeamSec[0] = f.polygon ? 1 : 0; out.uBeamSec[1] = f.sides;
    out.uBeamSec[2] = f.polygon ? f.radius0 : f.halfW0; out.uBeamSec[3] = f.halfH0;
    out.uBeamTan[0] = f.polygon ? f.tanR : f.tanW; out.uBeamTan[1] = f.tanH; out.uBeamTan[2] = 0;
    return true;
  }
  if (b.frame2d) {
    const f = b.frame2d;
    out.uBeamMode = 1;
    out.uBeam2O[0] = f.ox; out.uBeam2O[1] = f.oy;
    out.uBeam2D[0] = f.dx; out.uBeam2D[1] = f.dy; out.uBeam2D[2] = f.nx; out.uBeam2D[3] = f.ny;
    out.uBeam2W[0] = f.length; out.uBeam2W[1] = f.halfW0; out.uBeam2W[2] = f.halfW1;
    const occ = def.shape2d?.occludeByDepth === true && env.hasDepth && !!env.uprightQz;
    if (occ) {
      // 直立面上的 q.z 在画面上是仿射的：三点探出 qz = a·sx + b·sy + c
      const fx = b.foot.x, fy = b.foot.y;
      const q0 = env.uprightQz!(fx, fy, fx, fy);
      const qx = env.uprightQz!(fx, fy, fx + 1, fy);
      const qy = env.uprightQz!(fx, fy, fx, fy + 1);
      const a = qx - q0, c2 = qy - q0;
      out.uBeamPlaneQ[0] = a; out.uBeamPlaneQ[1] = c2; out.uBeamPlaneQ[2] = q0 - a * fx - c2 * fy; out.uBeamPlaneQ[3] = 1;
    } else {
      out.uBeamPlaneQ[3] = 0;
    }
    return true;
  }
  return false;
}
