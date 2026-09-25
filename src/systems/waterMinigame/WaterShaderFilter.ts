import { Filter, GlProgram, GpuProgram, Texture } from 'pixi.js';
import { samplerOf } from '../../rendering/legacy/gpuSampler';

const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uNormalMap;
uniform sampler2D uParams;

uniform float uTime;
uniform float uMurk;
uniform float uDarkness;
uniform float uRain;
uniform vec3 uSigma;
uniform float uMinAlpha;
uniform float uUseNormalMap;
/** 水域水底光学系数（>=0）：背景与物体像素路径均为 coefficient ×（垂直项或 RT.R），不设人为上限 */
uniform float uWaterBottomDepth;

void main(void) {
    vec2 uv = vTextureCoord;

    vec2 ripple = vec2(
        sin(uv.x * 48.0 + uTime * 1.7) * cos(uv.y * 31.0 - uTime * 1.1),
        cos(uv.y * 44.0 + uTime * 1.4) * sin(uv.x * 29.0 + uTime * 0.9)
    ) * 0.012 * (0.35 + uMurk);

    if (uUseNormalMap > 0.5) {
        vec3 n = texture(uNormalMap, uv * 2.5 + uTime * 0.03).rgb * 2.0 - 1.0;
        ripple += n.xy * 0.018;
    }

    vec2 suv = clamp(uv + ripple, vec2(0.001), vec2(0.999));
    vec4 col = texture(uTexture, suv);

    vec4 pm = texture(uParams, suv);
    float pMask = step(0.5, pm.b) * pm.a;
    float bgOpticalPath = max(uWaterBottomDepth * suv.y, 0.0001);
    float entityRelDepth = max(pm.r, 0.0);
    float entityOpticalPath = max(uWaterBottomDepth * entityRelDepth, 0.0001);
    float depthGrad = mix(bgOpticalPath, entityOpticalPath, pMask);

    vec3 absorb = exp(-uSigma * depthGrad * (1.2 + uMurk * 2.5));
    col.rgb *= absorb;

    col.rgb *= clamp(1.0 - uDarkness, 0.15, 1.0);

    float fog = uMurk * 0.35 + uRain * 0.08;
    col.rgb = mix(col.rgb, vec3(0.55, 0.62, 0.72), clamp(fog, 0.0, 0.85));

    float glowAmt = pMask * pm.g;
    col.rgb += vec3(0.82, 0.90, 1.0) * glowAmt * 0.48;

    float rainTint = uRain * 0.22;
    col.rgb = mix(col.rgb, vec3(0.72, 0.78, 0.88), rainTint);

    col.a = max(col.a, uMinAlpha);

    finalColor = col;
}
`;

/**
 * WebGPU 版(与上面 GLSL 逐行对应)。约定:
 * - `@group(0)` 是 Pixi 滤镜固定的 gfu / uTexture / uSampler;本滤镜自己的放 `@group(1)`,
 *   **变量名 = resources 的键名**(Pixi 按名字对槽位);
 * - `WaterUniforms` 成员顺序 = 下面 `waterUniforms` 的声明顺序(vec3 按 16 对齐,后面的 f32 紧贴其尾);
 * - 纹理各配一个 `<名>Sampler`,取该纹理自己的采样状态(法线图的 uv 越出 0..1,寻址模式要跟纹理走)。
 * 法线图那次采样在 `uUseNormalMap` 分支里:条件是 uniform,属一致控制流,textureSample 合法。
 */
const WGSL = /* wgsl */ `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

struct WaterUniforms {
  uTime: f32,
  uMurk: f32,
  uDarkness: f32,
  uRain: f32,
  uSigma: vec3<f32>,
  uMinAlpha: f32,
  uUseNormalMap: f32,
  uWaterBottomDepth: f32,
};
@group(1) @binding(0) var<uniform> waterUniforms: WaterUniforms;
@group(1) @binding(1) var uNormalMap: texture_2d<f32>;
@group(1) @binding(2) var uNormalMapSampler: sampler;
@group(1) @binding(3) var uParams: texture_2d<f32>;
@group(1) @binding(4) var uParamsSampler: sampler;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vTextureCoord: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

@fragment
fn mainFragment(@location(0) vTextureCoord: vec2<f32>) -> @location(0) vec4<f32> {
  let uv = vTextureCoord;
  let uTime = waterUniforms.uTime;
  let uMurk = waterUniforms.uMurk;

  var ripple = vec2<f32>(
    sin(uv.x * 48.0 + uTime * 1.7) * cos(uv.y * 31.0 - uTime * 1.1),
    cos(uv.y * 44.0 + uTime * 1.4) * sin(uv.x * 29.0 + uTime * 0.9)
  ) * 0.012 * (0.35 + uMurk);

  if (waterUniforms.uUseNormalMap > 0.5) {
    let n = textureSample(uNormalMap, uNormalMapSampler, uv * 2.5 + uTime * 0.03).rgb * 2.0 - 1.0;
    ripple += n.xy * 0.018;
  }

  let suv = clamp(uv + ripple, vec2<f32>(0.001), vec2<f32>(0.999));
  let col = textureSample(uTexture, uSampler, suv);

  let pm = textureSample(uParams, uParamsSampler, suv);
  let pMask = step(0.5, pm.b) * pm.a;
  let bgOpticalPath = max(waterUniforms.uWaterBottomDepth * suv.y, 0.0001);
  let entityRelDepth = max(pm.r, 0.0);
  let entityOpticalPath = max(waterUniforms.uWaterBottomDepth * entityRelDepth, 0.0001);
  let depthGrad = mix(bgOpticalPath, entityOpticalPath, pMask);

  let absorb = exp(-waterUniforms.uSigma * depthGrad * (1.2 + uMurk * 2.5));
  var rgb = col.rgb * absorb;

  rgb *= clamp(1.0 - waterUniforms.uDarkness, 0.15, 1.0);

  let fog = uMurk * 0.35 + waterUniforms.uRain * 0.08;
  rgb = mix(rgb, vec3<f32>(0.55, 0.62, 0.72), clamp(fog, 0.0, 0.85));

  let glowAmt = pMask * pm.g;
  rgb += vec3<f32>(0.82, 0.90, 1.0) * glowAmt * 0.48;

  let rainTint = waterUniforms.uRain * 0.22;
  rgb = mix(rgb, vec3<f32>(0.72, 0.78, 0.88), rainTint);

  return vec4<f32>(rgb, max(col.a, waterUniforms.uMinAlpha));
}
`;

let sharedProgram: GlProgram | null = null;
let sharedGpuProgram: GpuProgram | null = null;

function program(): GlProgram {
  if (!sharedProgram) sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return sharedProgram;
}

function gpuProgram(): GpuProgram {
  if (!sharedGpuProgram) {
    sharedGpuProgram = GpuProgram.from({
      name: 'water-surface-filter',
      vertex: { source: WGSL, entryPoint: 'mainVertex' },
      fragment: { source: WGSL, entryPoint: 'mainFragment' },
    });
  }
  return sharedGpuProgram;
}

export class WaterShaderFilter extends Filter {
  constructor() {
    const ph = Texture.WHITE;
    super({
      glProgram: program(),
      gpuProgram: gpuProgram(),
      resources: {
        waterUniforms: {
          uTime: { value: 0, type: 'f32' },
          uMurk: { value: 0.35, type: 'f32' },
          uDarkness: { value: 0, type: 'f32' },
          uRain: { value: 0, type: 'f32' },
          uSigma: { value: new Float32Array([0.9, 1.35, 1.85]), type: 'vec3<f32>' },
          uMinAlpha: { value: 0.12, type: 'f32' },
          uUseNormalMap: { value: 0, type: 'f32' },
          uWaterBottomDepth: { value: 1.0, type: 'f32' },
        },
        uNormalMap: ph.source,
        uNormalMapSampler: samplerOf(ph.source),
        uParams: ph.source,
        uParamsSampler: samplerOf(ph.source),
      },
    });
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms?: Record<string, unknown> }>)['waterUniforms']?.uniforms;
  }

  setTime(t: number): void {
    const u = this._u;
    if (u) u['uTime'] = t;
  }

  applySurface(
    time: 'morning' | 'day' | 'night',
    weather: 'clear' | 'rain' | 'fog',
  ): void {
    const u = this._u;
    if (!u) return;

    let murk = 0.32;
    let rain = 0;
    let darkness = 0;
    if (weather === 'rain') {
      murk = 0.62;
      rain = 1;
    } else if (weather === 'fog') {
      murk = 0.88;
    }
    if (time === 'night') darkness = 0.38;
    else if (time === 'morning') darkness = 0.08;

    u['uMurk'] = murk;
    u['uRain'] = rain;
    u['uDarkness'] = darkness;

    const sig = u['uSigma'] as Float32Array;
    sig[0] = 0.85;
    sig[1] = 1.25;
    sig[2] = 1.75;
    u['uMinAlpha'] = weather === 'fog' ? 0.18 : 0.1;
  }

  setNormalTexture(tex: Texture | null): void {
    const src = tex?.source ?? Texture.WHITE.source;
    (this.resources as Record<string, unknown>)['uNormalMap'] = src;
    (this.resources as Record<string, unknown>)['uNormalMapSampler'] = samplerOf(src);
    const u = this._u;
    if (u) u['uUseNormalMap'] = tex ? 1 : 0;
  }

  setParamsTexture(tex: Texture | null): void {
    const src = tex?.source ?? Texture.WHITE.source;
    (this.resources as Record<string, unknown>)['uParams'] = src;
    (this.resources as Record<string, unknown>)['uParamsSampler'] = samplerOf(src);
  }

  /** 水域水底光学系数（>=0）；缺省 1。与背景 suv.y、参数 RT 的 R 相乘后进入贝尔定律，不做 1 上限 */
  setWaterBottomDepth(depth: number): void {
    const u = this._u;
    if (!u || !Number.isFinite(depth)) return;
    u['uWaterBottomDepth'] = Math.max(0, depth);
  }

  getDebugUniformState(): Record<string, unknown> {
    const u = this._u;
    return {
      time: u?.['uTime'],
      murk: u?.['uMurk'],
      darkness: u?.['uDarkness'],
      rain: u?.['uRain'],
      sigma: Array.from((u?.['uSigma'] as Float32Array | undefined) ?? []),
      minAlpha: u?.['uMinAlpha'],
      waterBottomDepth: u?.['uWaterBottomDepth'],
    };
  }
}
