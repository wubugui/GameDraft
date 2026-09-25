import { Filter, GlProgram, GpuProgram, Texture, type TextureSource } from '../engine2d';
import type { RgbColor, SceneDepthConfig } from '../data/types';
import type { ResolvedLightEnv } from './lightEnv';
import { samplerOf } from './legacy/gpuSampler';

/**
 * 既有 DepthOcclusionFilter 与新 EntityLightingFilter 的公共驱动接口。
 * 逐帧驱动循环（SceneDepthSystem / Game.tick）只依赖此接口，二者可互换。
 */
export interface IEntityShadingFilter extends Filter {
  _isDepthOcclusion: boolean;
  setSceneSize(w: number, h: number): void;
  setWorldToPixel(tx: number, ty: number): void;
  setProjectionScale(s: number): void;
  setWorldContainerPos(x: number, y: number): void;
  setEntityFootY(worldY: number): void;
  /** 仅 EntityLightingFilter 需要（probe 采样）；DepthOcclusionFilter 无此方法 */
  setEntityFootX?(worldX: number): void;
  setFloorOffset(v: number): void;
  setFloorOffsetExtra(v: number): void;
  setTolerance(v: number): void;
  setOcclusionBlendFactor(v: number): void;
  /**
   * 脚点行走面深度（`lighting/ground_d.png` 实测）。这是遮挡的**唯一**脚点来源：
   * floor_depth_A/B 拟合直线已废除（多层街巷可偏出 200+ 行地面）。
   * 传 null＝本场景没有行走面场 → **不做遮挡**，绝不退回旧模型悄悄顶上。
   */
  setFootDepthQ(v: number | null): void;
  /** 脚点遮挡偏置（实验室常数 0.045） */
  setFootBias(v: number): void;
  setDebug(on: boolean): void;
  /** 仅 EntityLightingFilter:色调融入强度(独立开关) */
  setTone?(v: number): void;
  /** 仅 EntityLightingFilter:sprite 空间 AO(按模式钳 contact) */
  setAO?(contact: number, form: number): void;
  /** 仅 EntityLightingFilter:key 光颜色/强度(供光环境曲线逐帧动画) */
  setKeyLight?(color: RgbColor, intensity: number): void;
  /** 仅 EntityLightingFilter:环境光颜色/强度(供光环境曲线逐帧动画) */
  setAmbient?(color: RgbColor, intensity: number): void;
}

const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vScreenPos;

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
    vScreenPos = aPosition * uOutputFrame.zw + uOutputFrame.xy;
}
`;

const FRAG = /* glsl */ `
in vec2 vTextureCoord;
in vec2 vScreenPos;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uDepthMap;
uniform sampler2D uProbe;

uniform vec2  uSceneSize;
uniform float uProjectionScale;
uniform float uWorldToPixelX;
uniform float uWorldToPixelY;
uniform vec2  uWorldContainerPos;
uniform float uEntityFootWorldX;
uniform float uEntityFootWorldY;
uniform float uSampleLiftWorld;

// 遮挡（与 DepthOcclusionFilter 一致；uDepthEnabled 关时整段跳过）
uniform float uDepthEnabled;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uDepthPerSy;
uniform float uFloorOffset;
uniform float uFloorOffsetExtra;
uniform float uTolerance;
uniform float uOcclusionBlendFactor;
uniform float uDebug;
uniform float uFootDepthQ;     // 脚点行走面深度（ground_d 场实测）
uniform float uHasFootDepth;   // 0=本帧没拿到脚深度 → 整段遮挡跳过
uniform float uFootBias;       // 实验室 0.045

// 光照
uniform vec3  uKeyColor;
uniform float uKeyIntensity;
uniform vec3  uAmbientColor;
uniform float uAmbientIntensity;
uniform float uToneStrength;
uniform float uAOContact;
uniform float uAOForm;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a < 0.004) { discard; }

    float S = max(uProjectionScale, 1e-6);
    float wx = (vScreenPos.x - uWorldContainerPos.x) / S;
    float wy = (vScreenPos.y - uWorldContainerPos.y) / S;

    bool occluded = false;
    // ---------- 深度遮挡（需深度图 + 行走面脚点深度；缺一不做，绝不退回旧模型） ----------
    if (uDepthEnabled > 0.5 && uHasFootDepth > 0.5) {
        vec2 depthUV = vec2(wx / uSceneSize.x, wy / uSceneSize.y);
        if (depthUV.x >= 0.0 && depthUV.x <= 1.0 && depthUV.y >= 0.0 && depthUV.y <= 1.0) {
            vec4 depthSample = texture(uDepthMap, depthUV);
            float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
            float d_raw = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
            float sceneDepth = d_raw * uScale + uOffset;
            // 精灵深度代理：**立在伪世界里的直立 quad**（uDepthPerSy = tanθ/ppu 是它的
            // 深度梯度，往上越靠近相机）。脚点深度取行走面场实测值——floor 拟合直线
            // 在多层街巷可偏出 200+ 行地面，已废除，无场时干脆不遮挡（见 uHasFootDepth）。
            float syTexFoot = uEntityFootWorldY * uWorldToPixelY;
            float syTex = wy * uWorldToPixelY;
            float upright = uDepthPerSy * (syTex - syTexFoot);
            float spriteDepth = uFootDepthQ + upright + uFloorOffset + uFloorOffsetExtra - uFootBias;
            occluded = sceneDepth + uTolerance < spriteDepth;
        }
    }

    if (uDebug > 0.5) {
        finalColor = vec4(occluded ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), 0.7);
        return;
    }

    if (occluded) {
        if (uOcclusionBlendFactor < 1e-5) { discard; }
        finalColor = vec4(color.rgb * uOcclusionBlendFactor, color.a * uOcclusionBlendFactor);
        return;
    }

    vec3 rgb = color.rgb; // Pixi 预乘 alpha

    // ---------- 色调:probe 保亮度白平衡(光环境曲线管线) ----------
    if (uToneStrength > 1e-4) {
        float su = clamp(uEntityFootWorldX / max(uSceneSize.x, 1e-3), 0.0, 1.0);
        float sv = clamp((uEntityFootWorldY - uSampleLiftWorld) / max(uSceneSize.y, 1e-3), 0.0, 1.0);
        vec3 amb = texture(uProbe, vec2(su, sv)).rgb;
        vec3 net = amb * uAmbientIntensity + uKeyColor * (uKeyIntensity * 0.5);
        float l = max(luma(net), 0.04);
        vec3 wb = clamp(net / l, vec3(0.5), vec3(1.7));
        rgb *= mix(vec3(1.0), wb, uToneStrength);
    }

    // ---------- AO：sprite 空间纵向梯度（vTextureCoord.y: 0 顶 → 1 底） ----------
    float vy = clamp(vTextureCoord.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    float ao = clamp(1.0 - contact - form, 0.0, 1.0);
    rgb *= ao;

    // 预乘不变量 rgb <= a，杜绝发白/发亮
    rgb = min(rgb, vec3(color.a));
    finalColor = vec4(rgb, color.a);
}
`;

/**
 * WGSL 版(WebGPU 路径),与上面 VERT / FRAG 逐式对应;GLSL 一个字不动,WebGL(含 anim_preview 自建的 Pixi)仍跑它。
 * 组 0 是 Pixi 滤镜约定(gfu + uTexture + uSampler);自己的资源在组 1,变量名 = resources 的键名,
 * uniform 结构体成员顺序 = JS 里 lightUniforms 的声明顺序(Pixi 按声明顺序排偏移)。
 * 提前 return / discard 之后的取样用 textureSampleLevel(.., 0.0)(WGSL 只许在一致控制流里 textureSample;
 * 深度图、probe 都没有 mip,等价)。结构体里不写注释:Pixi 用正则解析结构体成员与 group 声明。
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

struct LightUniforms {
    uSceneSize: vec2<f32>,
    uProjectionScale: f32,
    uWorldToPixelX: f32,
    uWorldToPixelY: f32,
    uWorldContainerPos: vec2<f32>,
    uEntityFootWorldX: f32,
    uEntityFootWorldY: f32,
    uSampleLiftWorld: f32,
    uDepthEnabled: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uDepthPerSy: f32,
    uFloorOffset: f32,
    uFloorOffsetExtra: f32,
    uTolerance: f32,
    uOcclusionBlendFactor: f32,
    uDebug: f32,
    uFootDepthQ: f32,
    uHasFootDepth: f32,
    uFootBias: f32,
    uKeyColor: vec3<f32>,
    uKeyIntensity: f32,
    uAmbientColor: vec3<f32>,
    uAmbientIntensity: f32,
    uToneStrength: f32,
    uAOContact: f32,
    uAOForm: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> lightUniforms: LightUniforms;
@group(1) @binding(1) var uDepthMap: texture_2d<f32>;
@group(1) @binding(2) var uDepthMapSampler: sampler;
@group(1) @binding(3) var uProbe: texture_2d<f32>;
@group(1) @binding(4) var uProbeSampler: sampler;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
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
    var out: VSOutput;
    out.position = filterVertexPosition(aPosition);
    out.vTextureCoord = filterTextureCoord(aPosition);
    out.vScreenPos = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    return out;
}

fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

@fragment
fn mainFragment(
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let u = lightUniforms;
    let color = textureSample(uTexture, uSampler, vTextureCoord);
    if (color.a < 0.004) { discard; }

    let S = max(u.uProjectionScale, 1e-6);
    let wx = (vScreenPos.x - u.uWorldContainerPos.x) / S;
    let wy = (vScreenPos.y - u.uWorldContainerPos.y) / S;

    var occluded = false;
    // 深度遮挡(需深度图 + 行走面脚点深度;缺一不做,绝不退回旧模型)
    if (u.uDepthEnabled > 0.5 && u.uHasFootDepth > 0.5) {
        let depthUV = vec2<f32>(wx / u.uSceneSize.x, wy / u.uSceneSize.y);
        if (depthUV.x >= 0.0 && depthUV.x <= 1.0 && depthUV.y >= 0.0 && depthUV.y <= 1.0) {
            let depthSample = textureSampleLevel(uDepthMap, uDepthMapSampler, depthUV, 0.0);
            let rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
            var d_raw = rawDepth;
            if (u.uInvert > 0.5) { d_raw = 1.0 - rawDepth; }
            let sceneDepth = d_raw * u.uScale + u.uOffset;
            // 精灵深度代理:立在伪世界里的直立 quad(见 GLSL 注释)
            let syTexFoot = u.uEntityFootWorldY * u.uWorldToPixelY;
            let syTex = wy * u.uWorldToPixelY;
            let upright = u.uDepthPerSy * (syTex - syTexFoot);
            let spriteDepth = u.uFootDepthQ + upright + u.uFloorOffset + u.uFloorOffsetExtra - u.uFootBias;
            occluded = sceneDepth + u.uTolerance < spriteDepth;
        }
    }

    if (u.uDebug > 0.5) {
        if (occluded) { return vec4<f32>(1.0, 0.0, 0.0, 0.7); }
        return vec4<f32>(0.0, 0.0, 1.0, 0.7);
    }

    if (occluded) {
        if (u.uOcclusionBlendFactor < 1e-5) { discard; }
        return vec4<f32>(color.rgb * u.uOcclusionBlendFactor, color.a * u.uOcclusionBlendFactor);
    }

    var rgb = color.rgb;

    // 色调:probe 保亮度白平衡(光环境曲线管线)
    if (u.uToneStrength > 1e-4) {
        let su = clamp(u.uEntityFootWorldX / max(u.uSceneSize.x, 1e-3), 0.0, 1.0);
        let sv = clamp((u.uEntityFootWorldY - u.uSampleLiftWorld) / max(u.uSceneSize.y, 1e-3), 0.0, 1.0);
        let amb = textureSampleLevel(uProbe, uProbeSampler, vec2<f32>(su, sv), 0.0).rgb;
        let net = amb * u.uAmbientIntensity + u.uKeyColor * (u.uKeyIntensity * 0.5);
        let l = max(luma(net), 0.04);
        let wb = clamp(net / l, vec3<f32>(0.5), vec3<f32>(1.7));
        rgb *= mix(vec3<f32>(1.0), wb, u.uToneStrength);
    }

    // AO:sprite 空间纵向梯度(vTextureCoord.y 从 0 顶到 1 底)
    let vy = clamp(vTextureCoord.y, 0.0, 1.0);
    let contact = u.uAOContact * smoothstep(0.78, 1.0, vy);
    let form = u.uAOForm * vy;
    let ao = clamp(1.0 - contact - form, 0.0, 1.0);
    rgb *= ao;

    // 预乘不变量 rgb 不超过 a,杜绝发白 / 发亮
    rgb = min(rgb, vec3<f32>(color.a));
    return vec4<f32>(rgb, color.a);
}
`;

let sharedProgram: GlProgram | null = null;
function getSharedProgram(): GlProgram {
  if (!sharedProgram) {
    sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  }
  return sharedProgram;
}

let sharedGpuProgram: GpuProgram | null = null;
function getSharedGpuProgram(): GpuProgram {
  if (!sharedGpuProgram) {
    sharedGpuProgram = GpuProgram.from({
      vertex: { source: WGSL, entryPoint: 'mainVertex' },
      fragment: { source: WGSL, entryPoint: 'mainFragment' },
    });
  }
  return sharedGpuProgram;
}

export interface EntityLightingFilterOptions {
  /** 场景深度图（有 depthConfig 时）；为 null 则不做遮挡 */
  depthTexture: Texture | null;
  cfg: SceneDepthConfig | null;
  /** 辐照度探针纹理源；为 null 时色调融入退化为恒等 */
  probeSource: TextureSource | null;
  lightEnv: ResolvedLightEnv;
  /** 在脚部之上多少世界单位处采样 probe（≈ 0.4 × 角色高度），让 sprite 取身体处环境色 */
  sampleLiftWorld: number;
}

export class EntityLightingFilter extends Filter implements IEntityShadingFilter {
  readonly _isDepthOcclusion = true;

  private constructor(opts: EntityLightingFilterOptions) {
    const program = getSharedProgram();
    const { cfg, depthTexture, probeSource, lightEnv, sampleLiftWorld } = opts;
    const depthOn = !!(cfg && depthTexture);
    const dm = cfg?.depth_mapping;
    const sh = cfg?.shader;

    const depthSrc = depthTexture?.source ?? Texture.WHITE.source;
    const probeSrc = probeSource ?? Texture.WHITE.source;

    super({
      glProgram: program,
      gpuProgram: getSharedGpuProgram(),
      resources: {
        lightUniforms: {
          uSceneSize: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uProjectionScale: { value: 1, type: 'f32' },
          uWorldToPixelX: { value: 1, type: 'f32' },
          uWorldToPixelY: { value: 1, type: 'f32' },
          uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uEntityFootWorldX: { value: 0, type: 'f32' },
          uEntityFootWorldY: { value: 0, type: 'f32' },
          uSampleLiftWorld: { value: sampleLiftWorld, type: 'f32' },

          uDepthEnabled: { value: depthOn ? 1 : 0, type: 'f32' },
          uInvert: { value: dm?.invert ? 1.0 : 0.0, type: 'f32' },
          uScale: { value: dm?.scale ?? 1, type: 'f32' },
          uOffset: { value: dm?.offset ?? 0, type: 'f32' },
          uDepthPerSy: { value: sh?.depth_per_sy ?? 0, type: 'f32' },
          uFloorOffset: { value: cfg?.floor_offset ?? 0, type: 'f32' },
          uFloorOffsetExtra: { value: 0, type: 'f32' },
          uTolerance: { value: cfg?.depth_tolerance ?? 0, type: 'f32' },
          uOcclusionBlendFactor: { value: 0, type: 'f32' },
          uDebug: { value: 0, type: 'f32' },
          uFootDepthQ: { value: 0, type: 'f32' },
          uHasFootDepth: { value: 0, type: 'f32' },
          uFootBias: { value: 0.045, type: 'f32' },

          uKeyColor: { value: new Float32Array(lightEnv.key.color), type: 'vec3<f32>' },
          uKeyIntensity: { value: lightEnv.key.intensity, type: 'f32' },
          uAmbientColor: { value: new Float32Array(lightEnv.ambient.color), type: 'vec3<f32>' },
          uAmbientIntensity: { value: lightEnv.ambient.intensity, type: 'f32' },
          uToneStrength: { value: probeSource ? lightEnv.toneStrength : 0, type: 'f32' },
          uAOContact: { value: lightEnv.ao.contact, type: 'f32' },
          uAOForm: { value: lightEnv.ao.form, type: 'f32' },
        },
        uDepthMap: depthSrc,
        // WGSL 的采样器:各用纹理自己的 style(WebGL 用纹理自带采样状态,不认这些键)
        uDepthMapSampler: samplerOf(depthSrc),
        uProbe: probeSrc,
        uProbeSampler: samplerOf(probeSrc),
      },
    });
  }

  static createForEntity(opts: EntityLightingFilterOptions): EntityLightingFilter {
    return new EntityLightingFilter(opts);
  }

  private get _lu(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['lightUniforms']
      ?.uniforms;
  }

  setSceneSize(w: number, h: number): void {
    const u = this._lu;
    if (u) {
      const a = u['uSceneSize'] as Float32Array;
      a[0] = w; a[1] = h;
    }
  }

  setWorldToPixel(tx: number, ty: number): void {
    const u = this._lu;
    if (u) {
      u['uWorldToPixelX'] = tx;
      u['uWorldToPixelY'] = ty;
    }
  }

  setProjectionScale(s: number): void {
    const u = this._lu;
    if (u) u['uProjectionScale'] = s;
  }

  setWorldContainerPos(x: number, y: number): void {
    const u = this._lu;
    if (u) {
      const a = u['uWorldContainerPos'] as Float32Array;
      a[0] = x; a[1] = y;
    }
  }

  setEntityFootY(worldY: number): void {
    const u = this._lu;
    if (u) u['uEntityFootWorldY'] = worldY;
  }

  setEntityFootX(worldX: number): void {
    const u = this._lu;
    if (u) u['uEntityFootWorldX'] = worldX;
  }

  setFloorOffset(v: number): void {
    const u = this._lu;
    if (u) u['uFloorOffset'] = v;
  }

  setFloorOffsetExtra(v: number): void {
    const u = this._lu;
    if (u) u['uFloorOffsetExtra'] = v;
  }

  setTolerance(v: number): void {
    const u = this._lu;
    if (u) u['uTolerance'] = v;
  }

  setOcclusionBlendFactor(v: number): void {
    const u = this._lu;
    if (u) u['uOcclusionBlendFactor'] = Math.min(1, Math.max(0, v));
  }

  setFootDepthQ(v: number | null): void {
    const u = this._lu;
    if (!u) return;
    if (v === null || !Number.isFinite(v)) { u['uHasFootDepth'] = 0; return; }
    u['uFootDepthQ'] = v;
    u['uHasFootDepth'] = 1;
  }

  setFootBias(v: number): void {
    const u = this._lu;
    if (u) u['uFootBias'] = Math.max(0, v);
  }

  /** 色调融入强度（与阴影模式解耦的独立开关：关时传 0） */
  setTone(v: number): void {
    const u = this._lu;
    if (u) u['uToneStrength'] = Math.max(0, Math.min(1, v));
  }

  /** AO（sprite 空间 contact/form）；按阴影模式钳零 contact 避免与地面接触斑双压 */
  setAO(contact: number, form: number): void {
    const u = this._lu;
    if (u) {
      u['uAOContact'] = Math.max(0, Math.min(1, contact));
      u['uAOForm'] = Math.max(0, Math.min(1, form));
    }
  }

  /** key 光颜色/强度（构造时已设；光环境曲线运行时逐帧覆盖） */
  setKeyLight(color: RgbColor, intensity: number): void {
    const u = this._lu;
    if (u) {
      const a = u['uKeyColor'] as Float32Array;
      a[0] = color[0]; a[1] = color[1]; a[2] = color[2];
      u['uKeyIntensity'] = intensity;
    }
  }

  /** 环境光颜色/强度（构造时已设；光环境曲线运行时逐帧覆盖） */
  setAmbient(color: RgbColor, intensity: number): void {
    const u = this._lu;
    if (u) {
      const a = u['uAmbientColor'] as Float32Array;
      a[0] = color[0]; a[1] = color[1]; a[2] = color[2];
      u['uAmbientIntensity'] = intensity;
    }
  }

  setDebug(on: boolean): void {
    const u = this._lu;
    if (u) u['uDebug'] = on ? 1 : 0;
  }

}
