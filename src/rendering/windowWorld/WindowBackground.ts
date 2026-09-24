import { Mesh, MeshGeometry, Shader, Texture } from 'pixi.js';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from '../lighting/kelvin';
import LIGHTING_CORE from '../lighting/lightingCore.glsl?raw';
import type { SceneLightingGeometry } from '../lighting/SceneLightingPass';
import WORLD_RECONSTRUCT from '../lighting/worldReconstruct.glsl?raw';

/**
 * 窗户世界的背景 —— 对面那一段的原画，被一块**世界空间的楔形体**裁出来。
 *
 * 结构与 {@link import('../lighting/LitBackground').LitBackground} 逐条同构：采样自己的
 * 辐射场 → 雾 → 显示变换。**刻意走同一份 GLSL 切片**（`lightingCore.glsl` /
 * `worldReconstruct.glsl`，import 不改），于是窗里窗外的雾与色调映射是同一套算式——
 * 这是"窗里看着和正常场景一模一样"的根，不是靠对参数。
 *
 * 两处不同：
 * 1. 输出**带 alpha**（预乘），由楔形判定给出，于是这张 mesh 可以直接盖在主背景之上；
 * 2. 不接草木摆动。⚠ 已知差异：`sway.*` 那套拆层是**按主背景**烘的（见 scene-wind 机制卡），
 *    对面那张画没有自己的那一份，硬套会把植物挪到错的地方。所以窗里的草木是静的。
 *
 * ## 楔形（作者面上叫「扇形」）
 *
 * 判定**全程在 M-world**（铁律 0）：先 `wrPixelToQ` 拿 q，再 `wrQToWorld` 转成
 * M-world，然后才算角度、距离、高度。在 q 空间算一律不报错，只是张角会随场景的 M
 * 悄悄变形——同一组参数在这个场景是 60°、到另一个场景就不是了。
 *
 * 三条边界各自独立软化，全硬 = 边界锐利（像一道切口），全软 = 羽化（像一团光晕）。
 * 缺省给一点点软，作者在编辑器里调。
 */

function slice(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[WindowBackground] GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

const WR_CORE = slice(WORLD_RECONSTRUCT, 'WR_CORE');
const LC = slice(LIGHTING_CORE, 'LIGHTING_CORE');

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUv;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uRadiance;     // 对面那一段的线性 HDR 辐射场
uniform sampler2D uDepth;        // 深度图（各时段共享几何，与主场景同一张）

uniform vec3  uCal;              // ppu, cx, cy
uniform vec3  uDepthMap;         // invert, scale, offset
uniform vec2  uDepthTexSize;
uniform vec3  uMRow0;            // M.R 三行：q → M-world
uniform vec3  uMRow1;
uniform vec3  uMRow2;
// 1 个 q 单位 = 多少 wu。**楔形的顶点与距离全是 wu**（CPU 侧那条链末尾乘过它），
// 所以 R·q 必须也乘上它才同尺。少乘这一步不报错，只是判定整体缩小到 1/wuPerQ、
// 锥体永远罩不到任何像素——实测雾津一带 wuPerQUnit≈450，差 450 倍。
uniform float uWuPerQ;

// 雾（与主背景同式）
uniform float uFogSigma;
uniform float uFogScaleH;
uniform float uFogBaseY;
uniform vec3  uFogColor;

// 显示变换（与主背景同式）
uniform float uEv;
uniform int   uTonemap;
uniform vec3  uWhiteBalance;
uniform float uContrast;
uniform float uSaturation;
uniform float uLift;
uniform vec3  uLiftColor;

// 楔形（M-world，wu）。顶点与朝向由 CPU 侧 windowWorldCone.solveCone **解一次**、
// 两边共用：窗里的实体也要按同一个楔形裁，解两遍迟早漂成「实体与背景各按各的边界」。
//
// ⚠ CPU 那一份必须与本 shader 吃**同一个深度族**：它读的是同一张 depth_map 的 CPU 副本、
//   走 wrDecodeSceneDepthFromBytes（与本文件的 wrDecodeSceneDepth 逐字对应）。
//   早先用烘焙的行走面深度场（ground_d 族）算顶点，与像素这一族"同量纲"只靠烘焙保证、
//   运行时无交叉校验（worldReconstruct.glsl 原话），实测跑马梁两族值域差着一截 ——
//   锥体深度整体错位、角度全不对，而且**一句报错都没有**。
uniform vec3  uApex;             // 顶点（已含抬高）
uniform vec3  uAxis;             // 水平朝向（已归一）
uniform float uCosHalf;          // cos(半角)
uniform vec2  uRange;            // [近截距, 远截距] wu
uniform vec2  uHeight;           // 相对顶点的 [下, 上] 世界 Y 偏移；上<=下 = 不限高
uniform vec3  uSoft;             // [角度软化(cos 差), 距离软化(wu), 高度软化(wu)]
uniform float uOpacity;          // 整体不透明度（开合渐变用）

${WR_CORE}
${LC}

/** 上升沿：x <= e0 给 0，x >= e0+w 给 1；w<=0 即硬边。 */
float softStep(float x, float e0, float w) {
    if (w <= 0.0) return x >= e0 ? 1.0 : 0.0;
    return clamp((x - e0) / w, 0.0, 1.0);
}

void main(void) {
    // ── 1. 这个像素在 M-world 的什么位置（铁律 0：先转到世界空间）──
    vec2 px = vUv * uDepthTexSize;
    float d = wrDecodeSceneDepth(texture(uDepth, vUv), uDepthMap.x, uDepthMap.y, uDepthMap.z);
    vec3 q = wrPixelToQ(px, uCal.x, uCal.y, uCal.z, d);
    // 两个尺各留一份，别混：
    //   Wq —— q 尺，雾要用（与 LitBackground 的 wrQToWorldRow(uMRow1,q) 逐字同值）
    //   W  —— wu 尺，楔形要用（顶点与半径都是 wu）
    vec3 Wq = wrQToWorld(uMRow0, uMRow1, uMRow2, q);
    vec3 W = Wq * uWuPerQ;

    // ── 2. 楔形判定（顶点与朝向由 CPU 解好传进来，见上面 uApex 的注释）──
    vec3 rel = W - uApex;
    // 水平分量：世界 Y 就是高度轴，直接把 y 清零即可。
    vec3 relH = vec3(rel.x, 0.0, rel.z);
    float dist = length(relH);
    float mask = 1.0;

    // 距离：近端与远端各一道软边
    mask *= softStep(dist, uRange.x, uSoft.y);
    mask *= 1.0 - softStep(dist, uRange.y - uSoft.y, uSoft.y);

    // 角度：与轴的夹角余弦。dist 极小时整个近端算"在里面"，避免 0/0 抖动。
    if (dist > 1e-4) {
        float c = dot(relH / dist, uAxis);
        mask *= softStep(c, uCosHalf, uSoft.x);
    }

    // 高度：可选的上下夹层
    if (uHeight.y > uHeight.x) {
        mask *= softStep(rel.y, uHeight.x, uSoft.z);
        mask *= 1.0 - softStep(rel.y, uHeight.y - uSoft.z, uSoft.z);
    }

    float a = clamp(mask, 0.0, 1.0) * clamp(uOpacity, 0.0, 1.0);
    if (a <= 0.0) { fragColor = vec4(0.0); return; }

    // ── 3. 与主背景同一条链：辐射场 → 雾 → 显示变换 ──
    vec3 lin = texture(uRadiance, vUv).rgb;
    if (uFogSigma > 0.0) {
        // ⚠ 雾走 **Wq**（q 尺）——与主背景 LitBackground 的算式逐字同尺。
        //   这里换成 wu 会让窗里的雾浓度与窗外不是一回事，边界上直接看得出来。
        float worldY = Wq.y;
        float dist2 = max(d - uDepthMap.z, 0.0);
        float yCam = worldY - uMRow1.z * dist2;
        float od = lcOpticalDepth(dist2, yCam, worldY, uFogSigma, uFogScaleH, uFogBaseY);
        lin = lcApplyFog(lin, od, uFogColor);
    }
    vec3 rgb = lcDisplayTransform(lin, uEv, uTonemap, uWhiteBalance,
                                  uSaturation, uContrast, uLift, uLiftColor);
    // 预乘 alpha：Pixi 的 normal 混合是 (ONE, ONE_MINUS_SRC_ALPHA)
    fragColor = vec4(rgb * a, a);
}
`;

/**
 * 楔形的全部参数。逐帧可写，不触发任何重算。
 * 顶点与朝向由 `windowWorldCone.solveCone` 在 CPU 侧解出（**同一份解算，两边共用**）。
 */
export interface WindowConeParams {
  /** 顶点（M-world，wu，已含抬高）。 */
  apex: readonly [number, number, number];
  /** 水平朝向（M-world，已归一）。 */
  axisH: readonly [number, number, number];
  /** 半角（度）。 */
  halfAngleDeg: number;
  /** 近截距、远截距（wu）。 */
  range: [number, number];
  /** 相对顶点的下/上世界 Y 偏移（wu）；`up <= down` = 不限高。 */
  height: [number, number];
  /** 边界软化：[角度(度), 距离(wu), 高度(wu)]。全 0 = 硬边。 */
  soft: [number, number, number];
  /** 整体不透明度，开合渐变用。 */
  opacity: number;
}

export class WindowBackground {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly shader: Shader;
  private destroyed = false;

  constructor(
    radiance: Texture,
    geo: SceneLightingGeometry,
    worldW: number,
    worldH: number,
  ) {
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, worldW, 0, worldW, worldH, 0, worldH]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      resources: {
        uRadiance: radiance.source,
        uDepth: geo.depth.source,
        winBg: {
          uCal: { value: new Float32Array(geo.cal), type: 'vec3<f32>' },
          uDepthMap: { value: new Float32Array(geo.depthMapping), type: 'vec3<f32>' },
          uDepthTexSize: { value: new Float32Array(geo.depthSize), type: 'vec2<f32>' },
          uMRow0: { value: new Float32Array(geo.mRows[0]), type: 'vec3<f32>' },
          uMRow1: { value: new Float32Array(geo.mRows[1]), type: 'vec3<f32>' },
          uMRow2: { value: new Float32Array(geo.mRows[2]), type: 'vec3<f32>' },
          uWuPerQ: { value: geo.wuPerQUnit, type: 'f32' },
          uFogSigma: { value: 0, type: 'f32' },
          uFogScaleH: { value: 1, type: 'f32' },
          uFogBaseY: { value: 0, type: 'f32' },
          uFogColor: { value: new Float32Array([0.5, 0.55, 0.6]), type: 'vec3<f32>' },
          uEv: { value: 0, type: 'f32' },
          uTonemap: { value: 0, type: 'i32' },
          uWhiteBalance: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uContrast: { value: 1, type: 'f32' },
          uSaturation: { value: 1, type: 'f32' },
          uLift: { value: 0, type: 'f32' },
          uLiftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uApex: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
          uAxis: { value: new Float32Array([1, 0, 0]), type: 'vec3<f32>' },
          uCosHalf: { value: Math.cos((30 * Math.PI) / 180), type: 'f32' },
          uRange: { value: new Float32Array([0, 1000]), type: 'vec2<f32>' },
          uHeight: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uSoft: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
          uOpacity: { value: 1, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });
  }

  /** 写雾与显示变换。必须与主背景喂**同一份** `def` 的口径，否则窗内窗外色调分家。 */
  applyParams(def: SceneLightingDef): void {
    const u = this.shader.resources.winBg?.uniforms;
    if (!u) return;

    const d = def.display;
    u.uEv = d.ev;
    u.uTonemap = d.tonemap === 'reinhard' ? 1 : d.tonemap === 'filmic' ? 2 : 0;
    u.uWhiteBalance.set(resolveLightColor(undefined, d.whiteKelvin));
    u.uContrast = d.contrast;
    u.uSaturation = d.saturation;
    u.uLift = d.lift;
    u.uLiftColor.set(resolveLightColor(undefined, d.liftKelvin));

    const f = def.fog;
    if (f && f.sigma > 0) {
      u.uFogSigma = f.sigma;
      u.uFogScaleH = f.scaleHeight;
      u.uFogBaseY = f.baseHeight;
      const c = resolveLightColor(f.color, f.kelvin);
      u.uFogColor.set([c[0] * f.scatter, c[1] * f.scatter, c[2] * f.scatter]);
    } else {
      u.uFogSigma = 0;
    }
  }

  /** 逐帧写楔形。角度在这里转成余弦——shader 里不做三角函数。 */
  applyCone(c: WindowConeParams): void {
    const u = this.shader.resources.winBg?.uniforms;
    if (!u) return;
    u.uApex.set(c.apex as ArrayLike<number>);
    u.uAxis.set(c.axisH as ArrayLike<number>);
    const half = Math.max(0, Math.min(89.9, c.halfAngleDeg));
    u.uCosHalf = Math.cos((half * Math.PI) / 180);
    u.uRange.set(c.range);
    u.uHeight.set(c.height);
    // 角度软化按**余弦差**喂进去：shader 里比的是余弦，换算一次就省掉逐像素反三角。
    const softA = Math.max(0, Math.min(89.9, c.soft[0]));
    const cosSoft = Math.max(0, Math.cos((Math.max(0, half - softA) * Math.PI) / 180) - u.uCosHalf);
    u.uSoft.set([cosSoft, c.soft[1], c.soft[2]]);
    u.uOpacity = c.opacity;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mesh.destroy();
  }
}
