/**
 * 光柱着色的**唯一一份 GLSL 核心** + 把运行态打成 uniform 数值的**唯一一份打包函数**。
 *
 * 零 Pixi：游戏（`vfxBeamShaders.ts` 拼成 GlProgram）与粒子工作台（原画视图里的 WebGL 预览层，
 * `tools/vfx_workbench/bundle.py` 打包进页面）编译同一段核心、用同一个打包函数——两边不许各写一份。
 *
 * ## 宿主要提供的三样（核心只声明调用，不实现）
 *
 * - `float bmSceneDepth(vec2 scene)`：该画面点原画的深度（q.z，**已加遮挡容差**）；没有深度返回 `1e20`；
 * - `vec3 bmToLinear(vec3 srgb)`：sRGB → 线性（游戏用 `lcSrgbToLinear`，与粒子同一条解码路径）；
 * - `uniform sampler2D uBeamCookie`：图案遮罩（没有图案时绑任意一张，`uBeamCookieOn = 0` 不采样）。
 *
 * 核心输出 `vec4 bmEval(vec2 scene)`：rgb = 线性颜色（不含亮度），a = 亮度（≥ 0）；`a < 0` = 这一像素不在光柱里。
 * 显示变换与混合由宿主做：**显示颜色 × 亮度**（与粒子"显示颜色 × alpha"同一个约定，光柱里的尘埃也是这样亮的）。
 *
 * ## 模型（与 `systems/vfx/vfxBeam.ts` 头注释同一份）
 *
 * 3D：视线（正交，画面点固定、沿 q.z 走）与棱台的 N + 2 个半空间逐个求交得到 [qa, qb]，
 * 远端被原画深度截断；**只在取样段中点取一次样**（离得远，形状函数都平滑）。亮度 = 强度 × 起伏 × 淡入淡出
 * × 边缘遮罩 × 沿长度曲线 × 噪声 × 图案 × 厚度感 × 贴地软收尾。一切在 M-world（铁律 0）。
 * 2D：画面梯形里的横向 / 沿长度坐标，可选按锚点脚下的直立面做深度遮挡。
 */
import type { VfxBeamDef } from '../../data/types';
import {
  VFX_BEAM_MAX_CURVE_KEYS, VFX_BEAM_MAX_PLANES, VFX_BEAM_MAX_SIDES,
  type VfxSceneQAffine,
} from '../../systems/vfx/vfxBeam';
import type { VfxBeamRuntime } from '../../systems/vfx/vfxSim';

/** 混合模式编号（`uBeamBlend`） */
export const BEAM_BLEND_CODE = { add: 0, screen: 1, normal: 2 } as const;

export const BEAM_GLSL_UNIFORMS = /* glsl */ `
uniform float uBeamMode;
uniform vec4  uBeamS2W0;
uniform vec4  uBeamS2W1;
uniform vec4  uBeamS2W2;
uniform vec4  uBeamPlanes[${VFX_BEAM_MAX_PLANES}];
uniform int   uBeamPlaneCount;
uniform vec3  uBeamOrigin;
uniform vec3  uBeamAxis;
uniform vec3  uBeamRight;
uniform vec3  uBeamUp;
uniform float uBeamLength;
uniform vec4  uBeamSec;
uniform vec3  uBeamTan;
uniform vec2  uBeam2O;
uniform vec4  uBeam2D;
uniform vec3  uBeam2W;
uniform vec4  uBeamPlaneQ;
uniform vec3  uBeamColor0;
uniform vec3  uBeamColor1;
uniform float uBeamGain;
uniform float uBeamEdgeSoft;
uniform float uBeamThickness;
uniform float uBeamContactSoft;
uniform float uBeamWuPerQ;
uniform int   uBeamBlend;
uniform vec2  uBeamAlong[${VFX_BEAM_MAX_CURVE_KEYS}];
uniform int   uBeamAlongCount;
uniform vec4  uBeamNoise;
uniform vec3  uBeamNoiseVel;
uniform float uBeamTime;
uniform float uBeamCookieOn;
uniform vec4  uBeamCookieXf;
uniform vec2  uBeamCookieRot;
uniform float uBeamCookieStrength;
`;

export const BEAM_GLSL_CORE = /* glsl */ `
const float BM_PI = 3.14159265358979;

float bmHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float bmValueNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = bmHash(i);
    float n100 = bmHash(i + vec3(1.0, 0.0, 0.0));
    float n010 = bmHash(i + vec3(0.0, 1.0, 0.0));
    float n110 = bmHash(i + vec3(1.0, 1.0, 0.0));
    float n001 = bmHash(i + vec3(0.0, 0.0, 1.0));
    float n101 = bmHash(i + vec3(1.0, 0.0, 1.0));
    float n011 = bmHash(i + vec3(0.0, 1.0, 1.0));
    float n111 = bmHash(i + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float bmFbm(vec3 x) {
    return 0.62 * bmValueNoise(x) + 0.38 * bmValueNoise(x * 2.03 + vec3(17.1, 3.7, 9.2));
}

// 与 vfxBeam.ts beamEdgeMask 同式
float bmEdgeMask(float edge) {
    if (edge < 0.0) return 0.0;
    return uBeamEdgeSoft > 1e-4 ? smoothstep(0.0, uBeamEdgeSoft, edge) : 1.0;
}

// 与 vfxCurve.ts sampleCurve 同一口径：空 = 恒 1，超出两端取端点
float bmAlong(float t) {
    if (uBeamAlongCount <= 0) return 1.0;
    if (t <= uBeamAlong[0].x) return uBeamAlong[0].y;
    for (int i = 1; i < ${VFX_BEAM_MAX_CURVE_KEYS}; i++) {
        if (i >= uBeamAlongCount) break;
        vec2 b = uBeamAlong[i];
        if (t <= b.x) {
            vec2 a = uBeamAlong[i - 1];
            float k = b.x > a.x ? (t - a.x) / (b.x - a.x) : 1.0;
            return a.y + (b.y - a.y) * k;
        }
    }
    return uBeamAlong[uBeamAlongCount - 1].y;
}

// 亮度 × 颜色（线性）；u / v = 截面归一化坐标（-1..1），noisePos = 取噪声的位置
vec4 bmShade(float t01, float u, float v, vec3 noisePos, float weight) {
    float amount = uBeamGain * bmAlong(t01) * weight;
    if (uBeamNoise.x > 0.0) {
        vec3 np = (noisePos - uBeamNoiseVel * uBeamTime) * uBeamNoise.y;
        amount *= max(0.0, 1.0 + uBeamNoise.x * (2.0 * bmFbm(np) - 1.0));
    }
    if (uBeamCookieOn > 0.5) {
        vec2 c = vec2(u, v) * 0.5;
        c = vec2(c.x * uBeamCookieRot.x - c.y * uBeamCookieRot.y, c.x * uBeamCookieRot.y + c.y * uBeamCookieRot.x);
        c = c * uBeamCookieXf.xy + 0.5 + uBeamCookieXf.zw;
        float cv = texture(uBeamCookie, fract(c)).r;
        amount *= mix(1.0, cv, uBeamCookieStrength);
    }
    // 颜色（线性）与亮度分开交给宿主：亮度乘在**显示空间**（与粒子 alpha × 显示颜色同一个约定），
    // 否则线性亮度过 sRGB 编码，暗部被放大，边缘软度看上去是硬边
    vec3 col = bmToLinear(mix(uBeamColor0, uBeamColor1, clamp(t01, 0.0, 1.0)));
    return vec4(col, amount);
}

vec4 bmEval3d(vec2 s) {
    vec4 h = vec4(s, 0.0, 1.0);
    vec3 P0 = vec3(dot(uBeamS2W0, h), dot(uBeamS2W1, h), dot(uBeamS2W2, h));
    vec3 d = vec3(uBeamS2W0.z, uBeamS2W1.z, uBeamS2W2.z);
    float qa = -1e20;
    float qb = 1e20;
    for (int i = 0; i < ${VFX_BEAM_MAX_PLANES}; i++) {
        if (i >= uBeamPlaneCount) break;
        vec4 pl = uBeamPlanes[i];
        float num = dot(pl.xyz, P0) + pl.w;
        float den = dot(pl.xyz, d);
        if (abs(den) < 1e-12) {
            if (num > 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
        } else {
            float q = -num / den;
            if (den > 0.0) qb = min(qb, q); else qa = max(qa, q);
        }
    }
    if (qb <= qa) return vec4(0.0, 0.0, 0.0, -1.0);
    bool clipped = false;
    float sd = bmSceneDepth(s);
    if (sd < qb) { qb = sd; clipped = true; }
    if (qb <= qa) return vec4(0.0, 0.0, 0.0, -1.0);
    float dl = length(d);
    float chordWu = (qb - qa) * dl;
    vec3 P = P0 + d * (0.5 * (qa + qb));
    vec3 rel = P - uBeamOrigin;
    float t = dot(rel, uBeamAxis);
    float lx = dot(rel, uBeamRight);
    float ly = dot(rel, uBeamUp);
    float edge;
    float u;
    float v;
    float refThick;
    if (uBeamSec.x < 0.5) {
        float hw = max(1e-4, uBeamSec.z + t * uBeamTan.x);
        float hh = max(1e-4, uBeamSec.w + t * uBeamTan.y);
        u = lx / hw;
        v = ly / hh;
        edge = min(1.0 - abs(u), 1.0 - abs(v));
        refThick = hw + hh;
    } else {
        int n = int(uBeamSec.y + 0.5);
        float r = max(1e-4, uBeamSec.z + t * uBeamTan.x);
        float ap = r * cos(BM_PI / float(n));
        edge = 1e20;
        for (int k = 0; k < ${VFX_BEAM_MAX_SIDES}; k++) {
            if (k >= n) break;
            float phi = BM_PI * 0.5 + 2.0 * BM_PI * float(k) / float(n);
            edge = min(edge, (ap - (lx * cos(phi) + ly * sin(phi))) / ap);
        }
        u = lx / r;
        v = ly / r;
        refThick = 2.0 * ap;
    }
    float thick = mix(1.0, min(chordWu / max(refThick, 1e-3), 3.0), clamp(uBeamThickness, 0.0, 1.0));
    float contact = (clipped && uBeamContactSoft > 0.0) ? smoothstep(0.0, uBeamContactSoft, chordWu) : 1.0;
    return bmShade(t / uBeamLength, u, v, P, bmEdgeMask(edge) * thick * contact);
}

vec4 bmEval2d(vec2 s) {
    vec2 p = s - uBeam2O;
    float along = dot(p, uBeam2D.xy) / uBeam2W.x;
    if (along < 0.0 || along > 1.0) return vec4(0.0, 0.0, 0.0, -1.0);
    float hw = mix(uBeam2W.y, uBeam2W.z, along);
    if (hw <= 1e-4) return vec4(0.0, 0.0, 0.0, -1.0);
    float u = dot(p, uBeam2D.zw) / hw;
    float edge = 1.0 - abs(u);
    if (edge < 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
    float contact = 1.0;
    if (uBeamPlaneQ.w > 0.5) {
        float sd = bmSceneDepth(s);
        if (sd < 1e19) {
            float gap = sd - dot(uBeamPlaneQ.xyz, vec3(s, 1.0));
            if (gap < 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
            if (uBeamContactSoft > 0.0) contact = smoothstep(0.0, uBeamContactSoft, gap * uBeamWuPerQ);
        }
    }
    return bmShade(along, u, along * 2.0 - 1.0, vec3(s, 0.0), bmEdgeMask(edge) * contact);
}

vec4 bmEval(vec2 s) {
    return uBeamMode < 0.5 ? bmEval3d(s) : bmEval2d(s);
}
`;

/** 一根光柱的 uniform 数值（名字与 {@link BEAM_GLSL_UNIFORMS} 逐字对应） */
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
