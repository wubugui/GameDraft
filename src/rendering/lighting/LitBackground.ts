import { Mesh, MeshGeometry, Shader, type Renderer, type Texture } from 'pixi.js';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import type { SceneLightingGeometry } from './SceneLightingPass';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

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
    vec3 lin = texture(uRadiance, vUv).rgb;

    if (uFogSigma > 0.0) {
        // 该像素的伪世界位置 → 世界 Y 与视距（正交相机 ⇒ 视线方向恒定，积分有闭式解）
        vec2 px = vUv * uDepthTexSize;
        float d = wrDecodeSceneDepth(texture(uDepth, vUv), uDepthMap.x, uDepthMap.y, uDepthMap.z);
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

export class LitBackground {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly shader: Shader;
  private destroyed = false;

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
      resources: {
        uRadiance: radiance.source,
        uDepth: geo.depth.source,
        litBg: {
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
