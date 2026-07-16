import 'pixi.js/mesh';
import { BlurFilter, Container, Mesh, MeshGeometry, Shader, Texture, type TextureSource } from 'pixi.js';
import type { ResolvedLightEnv } from './lightEnv';
import type { ShadowProjectionField } from './shadowField';
import type { ShadowSource, ShadowSceneContext, IEntityShadow } from './entityShadowTypes';

const DEG2RAD = Math.PI / 180;

// 覆盖脚周包围盒的 quad(世界坐标);片元逐像素做 deferred 真实阴影。Pixi 自动注入 MVP。
const VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;
out vec2 vWorld;
void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vWorld = aPosition; // 接收面采样窗口:地面 XY(屏幕位置)
}
`;

// deferred:重建该屏幕点的真实 3D 表面 → 沿光向投射射线与角色 billboard 求交 → 命中剪影实处则在阴影。
const FRAG = /* glsl */ `
in vec2 vWorld;
out vec4 finalColor;

uniform sampler2D uDepthMap;
uniform sampler2D uSilhouette;

uniform vec2  uSceneSize;
uniform float uW2pX;
uniform float uW2pY;
uniform float uPpu;
uniform float uCx;
uniform float uCy;
uniform float uR00; uniform float uR01; uniform float uR02;
uniform float uR10; uniform float uR11; uniform float uR12;
uniform float uR20; uniform float uR21; uniform float uR22;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uFootX;
uniform float uFootY;
uniform float uHgtM;       // 角色 M-world 高
uniform float uWidM;       // 角色 M-world 宽
uniform float uFacing;     // +1 / -1
uniform float uBillboardMode; // 0=垂直于光, 1=朝相机(right)
uniform vec3  uL;          // 光来向(M-world,指向光源)
uniform float uDarkness;
uniform float uSoftSamples;
uniform float uSoftRadius;
uniform float uAOContact;
uniform float uAOContactRadius;
uniform vec4  uSilFrame;   // (u0,v0,du,dv) 剪影帧子矩形

vec3 reconstruct(vec2 worldXY, float depth) {
    float sx = worldXY.x * uW2pX;
    float sy = worldXY.y * uW2pY;
    float px = (sx - uCx) / uPpu;
    float py = (uCy - sy) / uPpu;
    vec3 right = vec3(uR00, uR10, uR20);
    vec3 up    = vec3(uR01, uR11, uR21);
    vec3 vd    = vec3(uR02, uR12, uR22);
    return right * px + up * py + vd * depth;
}

float hitSilhouette(vec3 P, vec3 F, vec3 Lj, vec3 worldUp, vec3 Haxis) {
    vec3 N = normalize(cross(Haxis, worldUp));
    float denom = dot(Lj, N);
    if (abs(denom) < 1e-5) return 0.0;            // 光平行 billboard → 不遮挡
    float t = dot(F - P, N) / denom;
    if (t <= 1e-4) return 0.0;                    // 交点须在 P 的光源侧
    vec3 rel = (P + Lj * t) - F;
    float vLocal = dot(rel, worldUp);
    float hLocal = dot(rel, Haxis);
    if (vLocal < 0.0 || vLocal > uHgtM) return 0.0;
    if (abs(hLocal) > uWidM * 0.5) return 0.0;
    float u = hLocal / uWidM + 0.5;
    if (uFacing < 0.0) u = 1.0 - u;
    float v = 1.0 - vLocal / uHgtM;
    vec2 suv = uSilFrame.xy + vec2(u, v) * uSilFrame.zw;
    return texture(uSilhouette, suv).a > 0.5 ? 1.0 : 0.0;
}

void main(void) {
    vec2 uvD = vec2(vWorld.x / uSceneSize.x, vWorld.y / uSceneSize.y);
    if (uvD.x < 0.0 || uvD.x > 1.0 || uvD.y < 0.0 || uvD.y > 1.0) { discard; }

    vec4 ds = texture(uDepthMap, uvD);
    float rawD = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
    float dRaw = uInvert > 0.5 ? 1.0 - rawD : rawD;
    float sceneDepth = dRaw * uScale + uOffset;

    // 真实可见表面 3D 点
    vec3 P = reconstruct(vWorld, sceneDepth);
    // 脚点锚到地面：与 P 同源采样深度图（消除 floor 线性模型与深度图的系统性偏移，
    // 否则 F 与脚下像素的 P 不在同一深度，t=0 边界偏离脚点 → 阴影退化成远处细片）
    vec2 uvF = vec2(uFootX / uSceneSize.x, uFootY / uSceneSize.y);
    vec4 dsF = texture(uDepthMap, uvF);
    float rawF = (dsF.r * 255.0 * 256.0 + dsF.g * 255.0) / 65535.0;
    float dRawF = uInvert > 0.5 ? 1.0 - rawF : rawF;
    float footDepth = dRawF * uScale + uOffset;
    vec3 F = reconstruct(vec2(uFootX, uFootY), footDepth);

    vec3 worldUp = vec3(0.0, 1.0, 0.0);
    vec3 L = normalize(uL);
    vec3 Haxis;
    if (uBillboardMode > 0.5) {
        Haxis = normalize(vec3(uR00, uR10, uR20)); // 朝相机:billboard 水平=right
    } else {
        vec3 h = cross(worldUp, L);                // 垂直于光的水平轴
        Haxis = length(h) > 1e-4 ? normalize(h) : normalize(vec3(uR00, uR10, uR20));
    }

    // 软阴影:绕 L 在锥内多采样
    float occ = 0.0;
    int n = int(uSoftSamples);
    if (n <= 1) {
        occ = hitSilhouette(P, F, L, worldUp, Haxis);
    } else {
        vec3 T1 = Haxis;
        vec3 T2 = normalize(cross(L, T1));
        float cnt = 0.0;
        for (int i = 0; i < 8; i++) {
            if (i >= n) break;
            float ang = 6.2831853 * float(i) / float(n);
            vec3 Lj = normalize(L + uSoftRadius * (cos(ang) * T1 + sin(ang) * T2));
            occ += hitSilhouette(P, F, Lj, worldUp, Haxis);
            cnt += 1.0;
        }
        occ = cnt > 0.0 ? occ / cnt : 0.0;
    }

    // 接触 AO:脚周一圈,与阴影取大(不双压)
    float dist = length(vWorld - vec2(uFootX, uFootY));
    float aoC = uAOContact * (1.0 - smoothstep(0.0, max(uAOContactRadius, 1e-3), dist));

    float darken = max(occ * uDarkness, aoC);
    if (darken < 0.01) { discard; }
    finalColor = vec4(0.0, 0.0, 0.0, darken);
}
`;

function f32(value: number) {
  return { value, type: 'f32' as const };
}

/**
 * real 模式:逐像素 deferred 真实阴影 + 真实接触 AO。
 * 每角色一个覆盖脚周世界 XY 包围盒的 quad(shadowLayer);片元用深度重建真实落点、与角色 billboard 求交。
 * 天然:贴真实表面(攀升)、被前景遮挡处不出现(只测可见表面)、任意角度不退化。
 */
export class DeferredEntityShadow implements IEntityShadow {
  private readonly ctx: ShadowSceneContext;
  private readonly mesh: Mesh;
  private readonly shader: Shader;
  private readonly positions: Float32Array;
  private readonly geometry: MeshGeometry;
  private blur: BlurFilter | null = null;
  private lastSoftness = -1;
  private boundSilhouette: TextureSource | null = null;

  constructor(layer: Container, ctx: ShadowSceneContext) {
    this.ctx = ctx;
    this.positions = new Float32Array(8);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    this.geometry = new MeshGeometry({ positions: this.positions, uvs, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });

    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      resources: {
        defUniforms: {
          uSceneSize: { value: new Float32Array([ctx.sceneW, ctx.sceneH]), type: 'vec2<f32>' },
          uW2pX: f32(ctx.worldToPixelX),
          uW2pY: f32(ctx.worldToPixelY),
          uPpu: f32(ctx.ppu),
          uCx: f32(ctx.cx),
          uCy: f32(ctx.cy),
          uR00: f32(ctx.r00), uR01: f32(ctx.r01), uR02: f32(ctx.r02),
          uR10: f32(ctx.r10), uR11: f32(ctx.r11), uR12: f32(ctx.r12),
          uR20: f32(ctx.r20), uR21: f32(ctx.r21), uR22: f32(ctx.r22),
          uInvert: f32(ctx.invert),
          uScale: f32(ctx.scale),
          uOffset: f32(ctx.offset),
          uFootX: f32(0),
          uFootY: f32(0),
          uHgtM: f32(1),
          uWidM: f32(1),
          uFacing: f32(1),
          uBillboardMode: f32(0),
          uL: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
          uDarkness: f32(0.4),
          uSoftSamples: f32(1),
          uSoftRadius: f32(0.05),
          uAOContact: f32(0),
          uAOContactRadius: f32(1),
          uSilFrame: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
        },
        uDepthMap: ctx.depthTexture.source,
        uSilhouette: Texture.WHITE.source,
      },
    });

    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader, texture: Texture.WHITE }) as Mesh;
    this.mesh.visible = false;
    layer.addChild(this.mesh);
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.shader.resources as Record<string, { uniforms?: Record<string, unknown> }>)['defUniforms']?.uniforms;
  }

  update(src: ShadowSource, env: ResolvedLightEnv, _field?: ShadowProjectionField | null): void {
    void _field; // real 模式光向取自 env.key(世界约定);场暂不用于 deferred
    const tex = src.getTexture();
    if (!tex || !src.isVisible() || !env.shadow.enabled || (env.shadow.darkness <= 0 && env.shadow.contact <= 0)) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    const fx = src.getFootX();
    const fy = src.getFootY();
    const w = Math.max(1, src.getWorldWidth());
    const H = Math.max(1, src.getWorldHeight());

    // 剪影来源 + 子帧
    const source = tex.source;
    if (source !== this.boundSilhouette) {
      (this.shader.resources as Record<string, unknown>)['uSilhouette'] = source;
      this.mesh.texture = tex;
      this.boundSilhouette = source;
    }
    const fr = tex.frame;
    const sw = source.width || 1;
    const sh = source.height || 1;

    // 包围盒 quad(脚周,覆盖阴影可能落到的世界 XY)
    const reach = H * env.shadow.length;
    const half = reach + w * 1.5;
    const x0 = fx - half, x1 = fx + half, y0 = fy - half, y1 = fy + half;
    const p = this.positions;
    p[0] = x0; p[1] = y0; p[2] = x1; p[3] = y0; p[4] = x1; p[5] = y1; p[6] = x0; p[7] = y1;
    this.geometry.getBuffer('aPosition').update();

    // 光向(世界约定 az=0=+X,绕 Y 逆时针,elev 从地面)
    const az = env.key.azimuthDeg * DEG2RAD;
    const el = env.key.elevationDeg * DEG2RAD;
    const ce = Math.cos(el);
    const u = this._u;
    if (u) {
      const L = u['uL'] as Float32Array;
      L[0] = ce * Math.cos(az); L[1] = Math.sin(el); L[2] = ce * Math.sin(az);
      u['uFootX'] = fx;
      u['uFootY'] = fy;
      // M-world 高/宽:屏幕纹素跨度 / (ppu·up.y) 还原（up 向量 y 分量=r11，补正投影）
      const upY = Math.abs(this.ctx.r11) > 1e-3 ? Math.abs(this.ctx.r11) : 1;
      u['uHgtM'] = H * this.ctx.worldToPixelY / (Math.max(this.ctx.ppu, 1e-6) * upY);
      u['uWidM'] = w * this.ctx.worldToPixelX / Math.max(this.ctx.ppu, 1e-6);
      u['uFacing'] = src.getFacing();
      u['uBillboardMode'] = env.shadow.billboard === 'camera' ? 1 : 0;
      u['uDarkness'] = Math.max(0, Math.min(1, env.shadow.darkness));
      u['uSoftSamples'] = Math.max(1, Math.min(8, Math.round(env.shadow.softSamples)));
      u['uSoftRadius'] = env.shadow.softRadius;
      u['uAOContact'] = Math.max(0, Math.min(1, env.shadow.contact));
      u['uAOContactRadius'] = w * Math.max(0.1, env.shadow.contactSize) * 0.65;
      const f = u['uSilFrame'] as Float32Array;
      f[0] = fr.x / sw; f[1] = fr.y / sh; f[2] = fr.width / sw; f[3] = fr.height / sh;
    }

    // 边缘柔化(模糊),由 softness 控制
    const softness = env.shadow.softness;
    if (softness > 0) {
      const strength = Math.max(0.5, softness * 4);
      if (!this.blur) {
        this.blur = new BlurFilter({ strength, quality: 2 });
        this.mesh.filters = [this.blur];
        this.lastSoftness = softness;
      } else if (Math.abs(softness - this.lastSoftness) > 1e-3) {
        this.blur.strength = strength;
        this.lastSoftness = softness;
      }
    } else if (this.blur) {
      this.mesh.filters = [];
      this.blur.destroy();
      this.blur = null;
      this.lastSoftness = -1;
    }
  }

  destroy(): void {
    if (this.blur) {
      this.blur.destroy();
      this.blur = null;
    }
    this.mesh.destroy();
    this.shader.destroy();
    this.geometry.destroy();
  }
}
