import { Filter, GlProgram, type Texture, type TextureSource } from 'pixi.js';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import SHADE_CORE_3 from './shadeCore3.glsl?raw';
import type { SceneLightingGeometry } from './SceneLightingPass';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

/**
 * `renderRaw` 装饰实体的重打光滤镜 —— **只吃比值，不做基底反解**。
 *
 * ## 这类实体是什么
 *
 * 「从背景抠出、贴回原位做循环动画」的补丁（茶馆里那五个 `fx_patron_*` 坐客就是）。
 * 它们的像素**取自已经烤好光照的背景**，所以历来刻意不附加逐 entity 光照 ——
 * 叠一层角色着色会与背景色调不符、露出方框接缝（见 `EntityDef.renderRaw`）。
 *
 * ## 但它们必须跟着重打光变
 *
 * `gi = 1` 时背景渲出来精确等于原画，补丁与背景严丝合缝。可作者一旦把 `gi` 调低、
 * 把天光/灯加上去，背景变了而补丁不变 —— 它们就浮出来了（实测 teahouse
 * `gi` 1.0→0.15：背景亮度 20.75→10.00，五个坐客纹丝不动）。
 *
 * ## 怎么修：把比例式**原样**用在补丁上
 *
 * 补丁的像素是原画在那个位置的出射辐射，所以它该走的正是背景走的那条变换：
 *
 * ```
 * I_out = I_补丁 × E_目标 / E
 * ```
 *
 * 而 `E_目标/E` 无需重算光照 —— 场景 pass 的输出里就有：
 *
 * ```
 * lit      = base·E_目标 + emissive      ← 场景 pass 的 RT
 * 反射部分 = lit − emissive               = base·E_目标
 * 分母     = base·E                       ← base.png 与 irradiance.png 直接给
 * 比值     = (lit − emissive) / (base·E)  = E_目标/E
 * ```
 *
 * ★ **`gi = 1` 时分子分母恒等 ⇒ 比值恒为 1 ⇒ 像素精确不变。** 这条是这个滤镜
 *   能上线的前提：现状已经是精确的，任何改动都不许把它弄丢。
 *
 * ⚠ 不能用整像素的 `lit / 原画` 当比值：背景那个像素若含自发光（灶口、灯笼），
 *   比值会把自发光也算进去，而补丁是**反射体**，会被凭空提亮。
 *
 * ⚠ 补丁没有自己的 `emissive`：它就是一块反射面。要让某个装饰**发光**，
 *   那是另一回事（走 `emissive` 载荷或摆灯），不在这条路径里。
 */

function slice(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[RawPatchRelightFilter] GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

// ⚠ lightingCore 依赖 worldReconstruct 的 wr* 系列（march 与深度解码），
//   少拼这一段整个 shader 链接不上 —— glslSymbols.test 锁着这条依赖。
const WR = slice(WORLD_RECONSTRUCT, 'WR_CORE');
const LC = slice(LIGHTING_CORE, 'LIGHTING_CORE');
const SC3 = slice(SHADE_CORE_3, 'SHADE_CORE_3');

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vScreenPos;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y)
               - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
    // 世界容器内的屏幕像素坐标（与 DepthOcclusionFilter 逐字同式）
    vScreenPos = aPosition * uOutputFrame.zw + uOutputFrame.xy;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vTextureCoord;
in vec2 vScreenPos;
out vec4 finalColor;

uniform sampler2D uTexture;        // 补丁自身（premultiplied）
uniform sampler2D uRadiance;       // 场景 pass 的线性 HDR 输出
uniform sampler2D uBase;           // lighting3/base.png
uniform sampler2D uIrradiance;     // lighting3/irradiance.png

uniform vec2  uSceneSize;          // 场景世界宽高
uniform float uProjectionScale;    // Camera 投影 S：世界单位 → 屏幕像素
uniform vec2  uWorldContainerPos;

uniform float uBaseScale;
uniform float uBaseLogSpan;
uniform float uIrradianceScale;
uniform float uIrradianceLogSpan;

uniform float uEv;
uniform int   uTonemap;
uniform vec3  uWhiteBalance;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform vec3  uLiftColor;

${WR}
${LC}
${SC3}

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a < 0.004) { discard; }

    // ---- 屏幕像素 → 场景 UV（与 DepthOcclusionFilter 同一套换算）----
    float S = max(uProjectionScale, 1e-6);
    vec2 w = (vScreenPos - uWorldContainerPos) / S;
    vec2 uv = w / max(uSceneSize, vec2(1e-6));

    // 补丁的线性 HDR 辐射（与烘焙侧同一条 to_hdr 曲线）
    vec3 lin = lcSrgbToLinear(color.rgb / max(color.a, 1e-4));
    vec3 hdr = sc3ToHdr(lin);

    vec3 ratio = vec3(1.0);
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
        // ⚠ 三张原生图必须**取同一个纹素**，不能各自做线性过滤。
        //   lit 是场景 pass 在某个纹素上算出来的一个值，而 base/emissive 若在
        //   补丁像素对应的 uv 上被过滤，拿到的是邻居的混合 —— 而
        //   blend(f(x)) ≠ f(blend(x))，比值就不再是 1 了。
        //   实测那样会让补丁在 gi=1 时也变亮 0.2%–4.7%（梯度陡的地方最明显），
        //   而 gi=1 必须**逐像素不变**，这是这条路径能上线的前提。
        //   E 是 work 分辨率的，pass 那边就是过滤采的 —— 所以这里也过滤采，
        //   但采在**纹素中心**上，与 pass 用的是同一个采样点。
        ivec2 sz = textureSize(uRadiance, 0);
        ivec2 tc = clamp(ivec2(uv * vec2(sz)), ivec2(0), sz - ivec2(1));
        vec2 cuv = (vec2(tc) + vec2(0.5)) / vec2(sz);

        vec3 basePx = texelFetch(uBase, tc, 0).rgb;
        vec3 base = sc3DecodeLogHdr(basePx, uBaseScale, uBaseLogSpan)
                  * step(vec3(0.5 / 255.0), basePx);
        vec3 E = sc3DecodeLogHdr(texture(uIrradiance, cuv).rgb,
                                 uIrradianceScale, uIrradianceLogSpan);
        vec3 emis = sc3ToHdr(lcSrgbToLinear(texelFetch(uEmissiveTex, tc, 0).rgb))
                  * uBakedEmissive;
        vec3 lit = texelFetch(uRadiance, tc, 0).rgb;

        // ★ 只取**反射**那一份的比值：背景像素若含自发光（灶口、灯笼），
        //   把它算进去会凭空提亮补丁 —— 补丁是反射体，没有自己的自发光。
        vec3 refl = max(lit - emis, vec3(0.0));
        vec3 den = base * E;
        // ⚠ K 是暗部护栏：den 在暗角能小到 1e-5，除下去会放大量化噪点。
        //   加同一个 K 之后暗处比值平滑地趋近 1（= 不改动），是安全的那一侧。
        const float K = 1e-4;
        ratio = (refl + vec3(K)) / (den + vec3(K));
    }

    // ★ 与背景**同一组**显示变换。gi = 1 且 reinhard/ev0 时这整条化简成恒等：
    //   ratio ≡ 1 ⇒ displayTransform(to_hdr(lin)) = linearToSrgb(from_hdr(to_hdr(lin)))
    //   = linearToSrgb(lin) = 原样的补丁像素。
    vec3 disp = lcDisplayTransform(hdr * ratio, uEv, uTonemap, uWhiteBalance,
                                   uSaturation, uContrast, uLift, uLiftColor);
    finalColor = vec4(disp * color.a, color.a);
}
`;

const TONEMAP_CODE: Record<string, number> = { none: 0, reinhard: 1, filmic: 2 };

let sharedProgram: GlProgram | null = null;
function getSharedProgram(): GlProgram {
  if (!sharedProgram) {
    sharedProgram = GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'raw-patch-relight' });
  }
  return sharedProgram;
}

export class RawPatchRelightFilter extends Filter {
  /** 标记：`Game` 用它认出自己挂的这一层，切换时好摘掉。 */
  readonly _isRawPatchRelight = true;

  constructor(geo: SceneLightingGeometry, radiance: Texture) {
    super({
      glProgram: getSharedProgram(),
      resources: {
        rawPatch: {
          uSceneSize: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uProjectionScale: { value: 1, type: 'f32' },
          uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uBaseScale: { value: geo.baseScale, type: 'f32' },
          uBaseLogSpan: { value: geo.baseLogSpan, type: 'f32' },
          uIrradianceScale: { value: geo.irradianceScale, type: 'f32' },
          uIrradianceLogSpan: { value: geo.irradianceLogSpan, type: 'f32' },
          uEv: { value: 0, type: 'f32' },
          uTonemap: { value: 1, type: 'i32' },
          uWhiteBalance: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSaturation: { value: 1, type: 'f32' },
          uContrast: { value: 1, type: 'f32' },
          uLift: { value: 0, type: 'f32' },
          uLiftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        },
        uRadiance: radiance.source as TextureSource,
        uBase: geo.base.source,
        uIrradiance: geo.irradiance.source,
      },
    });
  }

  private get u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)
      .rawPatch?.uniforms;
  }

  setSceneSize(w: number, h: number): void {
    (this.u?.uSceneSize as Float32Array | undefined)?.set([w, h]);
  }

  setProjectionScale(s: number): void {
    const u = this.u;
    if (u) u.uProjectionScale = s;
  }

  setWorldContainerPos(x: number, y: number): void {
    (this.u?.uWorldContainerPos as Float32Array | undefined)?.set([x, y]);
  }

  /** 显示变换与自发光缩放跟着场景参数走 —— 与背景**同一组**，不另立一份。 */
  applyParams(def: SceneLightingDef): void {
    const u = this.u;
    if (!u) return;
    const d = def.display;
    u.uEv = d.ev;
    u.uTonemap = TONEMAP_CODE[d.tonemap] ?? 0;
    (u.uWhiteBalance as Float32Array).set(resolveLightColor(undefined, d.whiteKelvin));
    u.uSaturation = d.saturation;
    u.uContrast = d.contrast;
    u.uLift = d.lift;
    (u.uLiftColor as Float32Array).set(resolveLightColor(undefined, d.liftKelvin));
  }
}
