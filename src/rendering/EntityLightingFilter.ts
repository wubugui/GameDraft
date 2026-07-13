import { Filter, GlProgram, Texture, type TextureSource } from 'pixi.js';
import type { RgbColor, SceneDepthConfig } from '../data/types';
import type { ResolvedLightEnv } from './lightEnv';

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
  setDebug(on: boolean): void;
  setCollisionTexture(tex: Texture): void;
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
uniform float uFloorA;
uniform float uFloorB;
uniform float uFloorOffset;
uniform float uFloorOffsetExtra;
uniform float uTolerance;
uniform float uOcclusionBlendFactor;
uniform float uDebug;

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
    // ---------- 深度遮挡（gated） ----------
    if (uDepthEnabled > 0.5) {
        vec2 depthUV = vec2(wx / uSceneSize.x, wy / uSceneSize.y);
        if (depthUV.x >= 0.0 && depthUV.x <= 1.0 && depthUV.y >= 0.0 && depthUV.y <= 1.0) {
            vec4 depthSample = texture(uDepthMap, depthUV);
            float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
            float d_raw = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
            float sceneDepth = d_raw * uScale + uOffset;
            float syTexFoot = uEntityFootWorldY * uWorldToPixelY;
            float syTex = wy * uWorldToPixelY;
            float d_base = uFloorA * syTexFoot + uFloorB + uFloorOffset + uFloorOffsetExtra;
            float spriteDepth = d_base + uDepthPerSy * (syTex - syTexFoot);
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

    // ---------- 色调融入：脚部(略抬高)采样 probe → 保亮度白平衡 ----------
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

let sharedProgram: GlProgram | null = null;
function getSharedProgram(): GlProgram {
  if (!sharedProgram) {
    sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  }
  return sharedProgram;
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

    super({
      glProgram: program,
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
          uFloorA: { value: sh?.floor_depth_A ?? 0, type: 'f32' },
          uFloorB: { value: sh?.floor_depth_B ?? 0, type: 'f32' },
          uFloorOffset: { value: cfg?.floor_offset ?? 0, type: 'f32' },
          uFloorOffsetExtra: { value: 0, type: 'f32' },
          uTolerance: { value: cfg?.depth_tolerance ?? 0, type: 'f32' },
          uOcclusionBlendFactor: { value: 0, type: 'f32' },
          uDebug: { value: 0, type: 'f32' },

          uKeyColor: { value: new Float32Array(lightEnv.key.color), type: 'vec3<f32>' },
          uKeyIntensity: { value: lightEnv.key.intensity, type: 'f32' },
          uAmbientColor: { value: new Float32Array(lightEnv.ambient.color), type: 'vec3<f32>' },
          uAmbientIntensity: { value: lightEnv.ambient.intensity, type: 'f32' },
          uToneStrength: { value: probeSource ? lightEnv.toneStrength : 0, type: 'f32' },
          uAOContact: { value: lightEnv.ao.contact, type: 'f32' },
          uAOForm: { value: lightEnv.ao.form, type: 'f32' },
        },
        uDepthMap: depthTexture?.source ?? Texture.WHITE.source,
        uProbe: probeSource ?? Texture.WHITE.source,
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

  /** EntityLightingFilter 不使用碰撞贴图，保留接口兼容 */
  setCollisionTexture(_tex: Texture): void {
    /* no-op */
  }
}
