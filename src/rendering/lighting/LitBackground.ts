import { Mesh, MeshGeometry, Shader, Texture, type Renderer } from '../../engine2d';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import type { SceneLightingGeometry } from './SceneLightingPass';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';
import { LC_WGSL, WR_CORE_WGSL } from './wgslChunks';
import { samplerOf } from '../legacy/gpuSampler';

/**
 * 被点亮的背景 —— 两级结构的**第二级（逐帧）**。
 *
 * 采样 {@link SceneLightingPass} 缓存好的线性 HDR 辐射场，再走
 * **雾 → 显示变换**，最后输出到屏幕。
 *
 * ## 为什么不做全屏 filter
 *
 * 1. 辐射场必须线性 HDR，全屏 pass 要求整个 worldContainer 先渲进 HDR RT——代价与风险都高；
 * 2. worldContainer 那层只有颜色**没有深度**，雾算不了；
 * 3. 正面撞 Pixi 坑①②③（多 RT 清屏串台 / 纹理销毁顺序烧毁滤镜 / 调试滤镜拖垮整场景照明）。
 *
 * 改成背景与角色**各自在自己的 shader 里调同一份 `lightingCore.glsl`**，吃同一组参数、
 * 各用自己的深度。一致性由共用代码保证——比全屏 pass 更强：全屏 pass 只能保证"作用在
 * 同一张图上"，保证不了角色着色阶段的口径一致。
 *
 * ⚠ 本类只负责背景。角色侧在 P3 接同一份 GLSL 与同一组 uniform。
 */

function slice(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[LitBackground] GLSL 缺切片标记 ${tag}`);
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

uniform sampler2D uRadiance;     // 缓存好的线性 HDR 辐射场
uniform sampler2D uDepth;        // 深度图（雾要用视距与高度）
// 草木摆动（没接时 uSwayOn = 0，三张图绑的是占位）：先用本像素 uv 读位移图，
// 植物像素去源 uv 取光照缓存与深度；露出来的地方取"扣掉植物"那份光照缓存与深度
uniform sampler2D uUvMap;        // RG = (源 uv − 本像素 uv) × 覆盖度，A = 覆盖度
uniform sampler2D uRadiancePlate;
uniform sampler2D uDepthPlate;
uniform int   uSwayOn;

uniform vec3  uCal;              // ppu, cx, cy
uniform vec3  uDepthMap;         // invert, scale, offset
uniform vec2  uDepthTexSize;
uniform vec3  uMRow1;            // M.R 第 1 行（取世界 Y）

// 雾（σ 定义，见 lcOpticalDepth）
uniform float uFogSigma;
uniform float uFogScaleH;        // 世界单位
uniform float uFogBaseY;         // 世界单位
uniform vec3  uFogColor;

// 显示变换
uniform float uEv;
uniform int   uTonemap;
uniform vec3  uWhiteBalance;
uniform float uContrast;
uniform float uSaturation;
uniform float uLift;
uniform vec3  uLiftColor;

${WR_CORE}
${LC}

void main(void) {
    vec2 src = vUv;
    float cover = 1.0;
    if (uSwayOn > 0) {
        vec4 m = texture(uUvMap, vUv);
        cover = clamp(m.a, 0.0, 1.0);
        if (m.a > 0.002) { src = vUv + m.rg / m.a; }
    }
    vec3 lin = texture(uRadiance, src).rgb;
    if (uSwayOn > 0 && cover < 0.999) {
        lin = mix(texture(uRadiancePlate, vUv).rgb, lin, cover);
    }

    if (uFogSigma > 0.0) {
        // 该像素的伪世界位置 → 世界 Y 与视距（正交相机 ⇒ 视线方向恒定，积分有闭式解）
        vec2 px = vUv * uDepthTexSize;
        float d = wrDecodeSceneDepth(texture(uDepth, src), uDepthMap.x, uDepthMap.y, uDepthMap.z);
        if (uSwayOn > 0 && cover < 0.999) {
            float dPlate = wrDecodeSceneDepth(texture(uDepthPlate, vUv), uDepthMap.x, uDepthMap.y, uDepthMap.z);
            d = mix(dPlate, d, cover);
        }
        vec3 q = wrPixelToQ(px, uCal.x, uCal.y, uCal.z, d);
        float worldY = wrQToWorldRow(uMRow1, q);
        // 视距用深度直接代理（正交相机下深度即沿视轴的行程）
        float dist = max(d - uDepthMap.z, 0.0);
        // 相机侧的高度：沿视线回退到相机平面，取那一端的 Y。
        // 正交下视线方向恒定，用同一行 M 对 (0,0,-dist) 求增量即可。
        float yCam = worldY - uMRow1.z * dist;
        float od = lcOpticalDepth(dist, yCam, worldY, uFogSigma, uFogScaleH, uFogBaseY);
        lin = lcApplyFog(lin, od, uFogColor);
    }

    fragColor = vec4(lcDisplayTransform(lin, uEv, uTonemap, uWhiteBalance,
                                        uSaturation, uContrast, uLift, uLiftColor), 1.0);
}
`;

// ============================================================================
// WebGPU 版(WGSL)。与上面 VERT / FRAG 逐句对应,GLSL 原样保留(WebGL 仍走它);等价由
// tools/render_parity 的「场景光照 /」用例钉住,改一边必须同步改另一边并重跑对照。
//
// 拼接:WR_CORE / LIGHTING_CORE 的 WGSL 切片(wgslChunks)各拼一次,片段一个绑定都不读。
// 绑定按 Pixi 网格约定:第 0 / 1 组由 Pixi 挂,本类的纹理 / 采样器 / uniform 组在第 2 组,
// 变量名 = resources 键名,纹理声明顺序 = resources 里的相对顺序(WebGL 纹理单元不挪);
// 每张纹理紧跟一个 *Sampler = samplerOf(source)(WebGL 侧不认识这些键,Pixi 忽略),setSway 换图时一并换。
// litBg 结构体成员顺序 = JS 里 uniforms 的声明顺序。
//
// 与 GLSL 的形式差异(数值不变):露出处那两次采样在「cover < 0.999」这个逐像素分支里,
// WGSL 的 textureSample 只许在一致控制流里调,改 textureSampleLevel(…, 0)(光照缓存与深度图都是
// 单级纹理,与 GLSL texture() 等价);其余采样照 GLSL 用 textureSample。
// ⚠ struct 体内不写注释(Pixi 用正则抽成员)。
// ============================================================================

const WGSL_VERT = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUv: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
    let clip = (globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy;
    return VSOutput(vec4<f32>(clip, 0.0, 1.0), aUV);
}
`;

const WGSL = /* wgsl */ `${WGSL_VERT}
struct LitBgUniforms {
    uSwayOn: i32,
    uCal: vec3<f32>,
    uDepthMap: vec3<f32>,
    uDepthTexSize: vec2<f32>,
    uMRow1: vec3<f32>,
    uFogSigma: f32,
    uFogScaleH: f32,
    uFogBaseY: f32,
    uFogColor: vec3<f32>,
    uEv: f32,
    uTonemap: i32,
    uWhiteBalance: vec3<f32>,
    uContrast: f32,
    uSaturation: f32,
    uLift: f32,
    uLiftColor: vec3<f32>,
}

@group(2) @binding(0) var uRadiance: texture_2d<f32>;
@group(2) @binding(1) var uRadianceSampler: sampler;
@group(2) @binding(2) var uDepth: texture_2d<f32>;
@group(2) @binding(3) var uDepthSampler: sampler;
@group(2) @binding(4) var uUvMap: texture_2d<f32>;
@group(2) @binding(5) var uUvMapSampler: sampler;
@group(2) @binding(6) var uRadiancePlate: texture_2d<f32>;
@group(2) @binding(7) var uRadiancePlateSampler: sampler;
@group(2) @binding(8) var uDepthPlate: texture_2d<f32>;
@group(2) @binding(9) var uDepthPlateSampler: sampler;
@group(2) @binding(10) var<uniform> litBg: LitBgUniforms;

${WR_CORE_WGSL}
${LC_WGSL}

@fragment
fn mainFragment(input: VSOutput) -> @location(0) vec4<f32> {
    let vUv = input.vUv;
    // 草木摆动:先读位移图,植物像素去源 uv 取光照缓存与深度;露出处取扣掉植物那份
    var src = vUv;
    var cover = 1.0;
    if (litBg.uSwayOn > 0) {
        let m = textureSample(uUvMap, uUvMapSampler, vUv);
        cover = clamp(m.a, 0.0, 1.0);
        if (m.a > 0.002) { src = vUv + m.rg / m.a; }
    }
    var lin = textureSample(uRadiance, uRadianceSampler, src).rgb;
    if (litBg.uSwayOn > 0 && cover < 0.999) {
        lin = mix(textureSampleLevel(uRadiancePlate, uRadiancePlateSampler, vUv, 0.0).rgb, lin, cover);
    }

    if (litBg.uFogSigma > 0.0) {
        // 伪世界位置 → 世界 Y 与视距(正交相机 ⇒ 视线方向恒定,积分有闭式解;推导见 GLSL)
        let px = vUv * litBg.uDepthTexSize;
        var d = wrDecodeSceneDepth(textureSample(uDepth, uDepthSampler, src),
                                   litBg.uDepthMap.x, litBg.uDepthMap.y, litBg.uDepthMap.z);
        if (litBg.uSwayOn > 0 && cover < 0.999) {
            let dPlate = wrDecodeSceneDepth(textureSampleLevel(uDepthPlate, uDepthPlateSampler, vUv, 0.0),
                                            litBg.uDepthMap.x, litBg.uDepthMap.y, litBg.uDepthMap.z);
            d = mix(dPlate, d, cover);
        }
        let q = wrPixelToQ(px, litBg.uCal.x, litBg.uCal.y, litBg.uCal.z, d);
        let worldY = wrQToWorldRow(litBg.uMRow1, q);
        let dist = max(d - litBg.uDepthMap.z, 0.0);
        let yCam = worldY - litBg.uMRow1.z * dist;
        let od = lcOpticalDepth(dist, yCam, worldY, litBg.uFogSigma, litBg.uFogScaleH, litBg.uFogBaseY);
        lin = lcApplyFog(lin, od, litBg.uFogColor);
    }

    return vec4<f32>(lcDisplayTransform(lin, litBg.uEv, litBg.uTonemap, litBg.uWhiteBalance,
                                        litBg.uSaturation, litBg.uContrast, litBg.uLift, litBg.uLiftColor), 1.0);
}
`;

export class LitBackground {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly shader: Shader;
  private destroyed = false;
  /** 没接草木时三张槽位要绑的占位（与创建 shader 的那一处同处维护，见 pixi-v8-traps） */
  private readonly placeholders: { uvMap: Texture; radiancePlate: Texture; depthPlate: Texture };

  /**
   * @param radiance {@link SceneLightingPass} 的缓存 RT
   * @param worldW/worldH 场景世界尺寸（quad 就铺满它，与原背景 Sprite 的摆法一致）
   */
  constructor(
    radiance: Texture,
    geo: SceneLightingGeometry,
    mRow1: [number, number, number],
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
      gpu: {
        vertex: { source: WGSL, entryPoint: 'mainVertex' },
        fragment: { source: WGSL, entryPoint: 'mainFragment' },
      },
      // *Sampler:WGSL 的纹理要单独的采样器(WebGL 侧没有这些名字,Pixi 忽略)。一律 samplerOf(source)
      // (按参数共享、永不销毁,不挂在纹理的生命期上);setSway 换图时跟着换成 samplerOf(新图)
      resources: {
        uRadiance: radiance.source,
        uRadianceSampler: samplerOf(radiance.source),
        uDepth: geo.depth.source,
        uDepthSampler: samplerOf(geo.depth.source),
        uUvMap: Texture.EMPTY.source,
        uUvMapSampler: samplerOf(Texture.EMPTY.source),
        uRadiancePlate: radiance.source,
        uRadiancePlateSampler: samplerOf(radiance.source),
        uDepthPlate: geo.depth.source,
        uDepthPlateSampler: samplerOf(geo.depth.source),
        litBg: {
          uSwayOn: { value: 0, type: 'i32' },
          uCal: { value: new Float32Array(geo.cal), type: 'vec3<f32>' },
          uDepthMap: { value: new Float32Array(geo.depthMapping), type: 'vec3<f32>' },
          uDepthTexSize: { value: new Float32Array(geo.depthSize), type: 'vec2<f32>' },
          uMRow1: { value: new Float32Array(mRow1), type: 'vec3<f32>' },
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
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });
    this.placeholders = { uvMap: Texture.EMPTY, radiancePlate: radiance, depthPlate: geo.depth };
  }

  /**
   * 接上 / 拆下草木摆动。拆下（`null`）会把三张槽位**先绑回占位**——位移图与扣掉植物的光照缓存
   * 都归别人销毁，BindGroup 见到已销毁的资源会自毁、下一帧渲染即抛（整局卡死）。
   * 所以所有者必须在销毁那几张图**之前**调 `setSway(null)`。
   */
  setSway(sw: { uvMap: Texture; radiancePlate: Texture; depthPlate: Texture } | null): void {
    if (this.destroyed) return;
    const r = this.shader.resources as Record<string, unknown> & { litBg: { uniforms: { uSwayOn: number } } };
    const use = sw ?? this.placeholders;
    r.uUvMap = use.uvMap.source;
    r.uUvMapSampler = samplerOf(use.uvMap.source);
    r.uRadiancePlate = use.radiancePlate.source;
    r.uRadiancePlateSampler = samplerOf(use.radiancePlate.source);
    r.uDepthPlate = use.depthPlate.source;
    r.uDepthPlateSampler = samplerOf(use.depthPlate.source);
    r.litBg.uniforms.uSwayOn = sw ? 1 : 0;
  }

  /** 写入雾与显示变换参数。逐帧可调，**不触发场景光照重算**。 */
  applyParams(def: SceneLightingDef): void {
    const u = this.shader.resources.litBg?.uniforms;
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
      // 全程 wu，不换算。σ 的量纲是 1/wu，两个高度是 wu。
      u.uFogSigma = f.sigma;
      u.uFogScaleH = f.scaleHeight;
      u.uFogBaseY = f.baseHeight;
      const c = resolveLightColor(f.color, f.kelvin);
      u.uFogColor.set([c[0] * f.scatter, c[1] * f.scatter, c[2] * f.scatter]);
    } else {
      u.uFogSigma = 0;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mesh.destroy();
  }
}
