/**
 * CharacterLitSprite —— 角色烘焙照明的 **sprite 网格着色**承载。
 *
 * 为什么存在(2026-07-25,替换 filter 的法线反推路径):
 * filter 只能拿到"sprite 已渲染进临时 RT"的结果,图集 UV 在 Pixi 画 sprite 时用完即弃,
 * 于是旧路径被迫**从世界坐标反推法线 UV**(uFootQ/uCharW 每帧驱动)。任何一帧驱动缺席
 * (实测:非 Exploring 态整段驱动被跳过),ul 就整体越界、被 clamp 死在 0/1 —— 全身反复
 * 采同一列边缘像素:通体单色、镜像后换一列(绿↔黄)、随 uniform 跳变闪烁。
 *
 * 现在:一个与 sprite 完全同 quad 的 Mesh 子节点,用**顶点自带的图集 UV** 同时采
 * color 与 normal(两图集布局逐 texel 对齐,天然同步);镜像由变换行列式判定
 * (det<0 = 镜像,几何自身的事实);脚点/世界坐标由顶点变换直接给出。
 * **没有任何逐实体逐帧 CPU 驱动** —— 这类错位在结构上不再存在。
 *
 * 照明数学(probe/体素/RT/SH/着色核心)与 filter 共用 CHAR_LIGHT_COMMON_GLSL,
 * 同一份字符串,零漂移。深度遮挡仍走 DepthOcclusionFilter(那是 filter 的正当用途)。
 */
import {
  type Buffer,
  GlProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  type TextureSource,
  UniformGroup,
} from 'pixi.js';

import { CHAR_LIGHT_COMMON_GLSL } from './CharacterShadingFilter';

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;   // sprite 局部坐标(帧像素空间,锚点已含)
in vec2 aUV;         // 图集 UV —— 与 color 帧同一套(法线采样直接用它)
in vec2 aLocal;      // 帧内局部 [0,1]²(左上为原点;AO 用)

uniform mat3 uProjectionMatrix;        // Pixi global group(自动绑)
uniform mat3 uWorldTransformMatrix;    // Pixi global group
uniform mat3 uTransformMatrix;         // Pixi local group:mesh 世界变换
uniform vec4 uColor;                   // Pixi local group:world alpha/tint(预乘)
uniform vec2  uWCPos;                  // worldContainer 屏幕位置(共享帧组)
uniform float uWCScale;                // projectionScale(共享帧组)

out vec2 vUV;
out vec2 vLocal;
out vec2 vWorld;       // 像素的场景世界坐标
out vec2 vFootWorld;   // 脚点(local 原点)的场景世界坐标
out float vMirror;     // 1 = 几何被镜像(scale.x<0),由行列式判定
out vec4 vColor;

void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vLocal = aLocal;
    float S = max(uWCScale, 1e-6);
    vWorld = (screen - uWCPos) / S;
    vec2 footScreen = (model * vec3(0.0, 0.0, 1.0)).xy;   // 锚点(0.5,1) → local 原点=脚底
    vFootWorld = (footScreen - uWCPos) / S;
    // 镜像判定:2x2 行列式。model 不含投影,画到屏幕还是 RT 都不影响符号;
    // sprite.scale.x<0 → det<0。翻转朝向连一个 uniform 都不需要。
    float det = model[0][0] * model[1][1] - model[0][1] * model[1][0];
    vMirror = det < 0.0 ? 1.0 : 0.0;
    vColor = uColor;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
in vec2 vLocal;
in vec2 vWorld;
in vec2 vFootWorld;
in float vMirror;
in vec4 vColor;
out vec4 finalColor;

uniform sampler2D uColorTex;   // 动画图集(与 sprite 同一张)
uniform sampler2D uGround;     // ground_d.png(RG16:行走面深度场)
uniform vec2 uGroundRange;     // ground_d min/max
uniform vec2 uSceneWorld;      // 场景世界尺寸(ground uv 归一化)

// 与公共块同名的采样器/开关(公共块内函数引用;filter 侧另有同名声明)
uniform sampler2D uNrm;
uniform sampler2D uPL1;
uniform sampler2D uPL2;
uniform sampler2D uPBin;
uniform sampler2D uValid;
uniform sampler2D uVolRad;
uniform sampler2D uVolEmit;
uniform float uHasNrm;
${CHAR_LIGHT_COMMON_GLSL}
void main(void) {
    vec4 color = texture(uColorTex, vUV);
    if (color.a < 0.03) { discard; }

    // ---------- 脚点 q(几何直出 + ground 场采样,零 CPU 驱动) ----------
    float ppu = uCal.x;
    vec2 fw = vFootWorld * uWorldToWork;               // 脚点 → work px
    float qxF = (fw.x - uCal.z) / ppu;
    float qyF = (uCal.w - fw.y) / ppu;
    vec2 guv = clamp(vFootWorld / max(uSceneWorld, vec2(1e-5)), 0.0, 1.0);
    vec4 gs = texture(uGround, guv);
    float footD = uGroundRange.x
      + ((gs.r * 255.0 * 256.0 + gs.g * 255.0) / 65535.0) * (uGroundRange.y - uGroundRange.x);

    // ---------- 像素高度(世界 → 直立 quad) ----------
    vec2 pw = vWorld * uWorldToWork;
    float h = max((fw.y - pw.y) / max(uCosT * ppu, 1e-6), 0.0);
    float qx = (pw.x - uCal.z) / ppu;

    // ---------- 法线:与 color **同一个 vUV** 采样,镜像只翻方向分量 ----------
    vec4 ne = vec4(0.5, 0.5, 1.0, 0.35);
    if (uHasNrm > 0.5) { ne = texture(uNrm, vUV); }
    vec3 n = normalize(vec3(-(ne.r*2.-1.), -(ne.g*2.-1.), -max(ne.b,.05)));
    if (vMirror > 0.5) n.x = -n.x;
    n = normalize(mix(n, vec3(0.,0.,-1.), uFlatten));

    vec3 q = vec3(qx, qyF + h * uCosT, footD - h * uSinT - ne.a * uBulge);

    if (uShowN > 0.5) { finalColor = vec4((n*.5+.5) * color.a, color.a) * vColor; return; }

    // ---------- E:RT gather 或 probe 图集(公共块) ----------
    vec3 E = (uMode < 0.5) ? gatherRT(q + n*0.02, n) : probeE(q, n);
    if (uSunOn > 0.5) {
        E += uSunColor * max(dot(n, uSunDirQ), 0.0);
    }
    vec3 alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    vec3 outRgb = clamp(lin2srgb(shadeCharacterLinear(alb, E, uEChroma, uBeta)), 0.0, 1.0);

    float vy = clamp(vLocal.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    outRgb *= clamp(1.0 - contact - form, 0.0, 1.0);

    finalColor = vec4(outRgb * color.a, color.a) * vColor;
}
`;

let litProgram: GlProgram | null = null;
function getLitProgram(): GlProgram {
  if (!litProgram) litProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return litProgram;
}

/** 共享帧组(uWCPos/uWCScale + 全部照明参数):CharacterLightingSystem 每帧更新一次。 */
export function createFrameLitUniforms(): UniformGroup {
  return new UniformGroup({
    uWCPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uWCScale: { value: 1, type: 'f32' },
    uMode: { value: 2, type: 'f32' },
    uSpp: { value: 64, type: 'f32' },
    uMSteps: { value: 160, type: 'f32' },
    uFold: { value: 1, type: 'f32' },
    uMissMode: { value: 0, type: 'f32' },
    uNEE: { value: 0, type: 'f32' },
    uStep: { value: 0.9, type: 'f32' },
    uBeta: { value: 1, type: 'f32' },
    uAmbStrength: { value: 1, type: 'f32' },
    uBulge: { value: 0.22, type: 'f32' },
    uFlatten: { value: 0, type: 'f32' },
    uShowN: { value: 0, type: 'f32' },
    uSunOn: { value: 0, type: 'f32' },
    uSunDirQ: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
    uSunColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uEChroma: { value: 0, type: 'f32' },
    uAOContact: { value: 0, type: 'f32' },
    uAOForm: { value: 0, type: 'f32' },
  });
}

/** 场景静态组的输入(与 filter 的 CharShadingSceneResources 字段同源)。 */
export interface LitSceneStatics {
  worldToWorkX: number;
  worldToWorkY: number;
  cal: { ppu: number; cx: number; cy: number; theta: number };
  vol: {
    nx: number; ny: number; nz: number; tilesX: number; tilesY: number;
    qMin: [number, number, number]; qMax: [number, number, number];
  };
  mCol: Float32Array;
  wMin: [number, number, number];
  wScale: [number, number, number];
  pn: [number, number, number];
  ambSH: Float32Array;
  lightsQ: Float32Array;
  lightsE: Float32Array;
  lightCount: number;
  groundMin: number;
  groundMax: number;
  sceneWorldW: number;
  sceneWorldH: number;
  workW: number;
  workH: number;
}

export function createSceneLitUniforms(s: LitSceneStatics): UniformGroup {
  return new UniformGroup({
    uWorkSize: { value: new Float32Array([s.workW, s.workH]), type: 'vec2<f32>' },
    uWorldToWork: { value: new Float32Array([s.worldToWorkX, s.worldToWorkY]), type: 'vec2<f32>' },
    uCal: { value: new Float32Array([s.cal.ppu, 0, s.cal.cx, s.cal.cy]), type: 'vec4<f32>' },
    uCosT: { value: Math.cos(s.cal.theta), type: 'f32' },
    uSinT: { value: Math.sin(s.cal.theta), type: 'f32' },
    uQMin: { value: new Float32Array(s.vol.qMin), type: 'vec3<f32>' },
    uQMax: { value: new Float32Array(s.vol.qMax), type: 'vec3<f32>' },
    uVolN: { value: new Float32Array([s.vol.nx, s.vol.ny, s.vol.nz]), type: 'vec3<f32>' },
    uVolTiles: { value: new Float32Array([s.vol.tilesX, s.vol.tilesY]), type: 'vec2<f32>' },
    uM: { value: s.mCol, type: 'mat3x3<f32>' },
    uWMin: { value: new Float32Array(s.wMin), type: 'vec3<f32>' },
    uWScale: { value: new Float32Array(s.wScale), type: 'vec3<f32>' },
    uPN: { value: new Float32Array(s.pn), type: 'vec3<f32>' },
    uAmbSH: { value: s.ambSH, type: 'vec3<f32>', size: 9 },
    uLightQ: { value: s.lightsQ, type: 'vec4<f32>', size: 48 },
    uLightE: { value: s.lightsE, type: 'vec4<f32>', size: 48 },
    uLightCount: { value: s.lightCount, type: 'f32' },
    uGroundRange: { value: new Float32Array([s.groundMin, s.groundMax]), type: 'vec2<f32>' },
    uSceneWorld: { value: new Float32Array([s.sceneWorldW, s.sceneWorldH]), type: 'vec2<f32>' },
  });
}

export interface LitShaderTextures {
  colorTex: TextureSource;
  nrm: TextureSource | null;      // null = 无法线图集 → 平面法线兜底
  ground: TextureSource;
  atlasL1: TextureSource;
  atlasL2: TextureSource;
  atlasBin: TextureSource;
  valid: TextureSource;
  volRad: TextureSource;
  volEmit: TextureSource;
}

export function createLitShader(
  sceneGroup: UniformGroup,
  frameGroup: UniformGroup,
  tex: LitShaderTextures,
): Shader {
  return new Shader({
    glProgram: getLitProgram(),
    resources: {
      sceneShade: sceneGroup,
      frameShade: frameGroup,
      entityShade: new UniformGroup({
        uHasNrm: { value: tex.nrm ? 1 : 0, type: 'f32' },
      }),
      uColorTex: tex.colorTex,
      uNrm: tex.nrm ?? Texture.WHITE.source,
      uGround: tex.ground,
      uPL1: tex.atlasL1,
      uPL2: tex.atlasL2,
      uPBin: tex.atlasBin,
      uValid: tex.valid,
      uVolRad: tex.volRad,
      uVolEmit: tex.volEmit,
    },
  });
}

/** 换法线/图集源(图集热替换、体素卷加载时用);同源短路。 */
export function setLitShaderTexture(sh: Shader, key: string, src: TextureSource | null): void {
  const res = sh.resources as Record<string, unknown>;
  const next = src ?? Texture.WHITE.source;
  if (res[key] === next) return;
  res[key] = next;
  if (key === 'uNrm') {
    (res['entityShade'] as UniformGroup).uniforms['uHasNrm'] = src ? 1 : 0;
  }
}

/**
 * 与 sprite 同 quad 的网格。作为 sprite 的**子节点**挂载:继承 sprite 的全部变换
 * (含镜像与透视缩放),几何与帧 UV 在换帧时由 SpriteEntity 同步(那是本就存在的
 * 换帧代码路径,任何游戏状态下都在跑 —— 不是新增的"驱动")。
 */
export class LitSpriteQuad {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly geometry: MeshGeometry;
  private readonly pos = new Float32Array(8);
  private readonly uv = new Float32Array(8);
  private readonly posBuf: Buffer;
  private readonly uvBuf: Buffer;

  constructor(shader: Shader) {
    this.geometry = new MeshGeometry({
      positions: this.pos,
      uvs: this.uv,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.geometry.addAttribute('aLocal', {
      buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),   // TL TR BR BL
      format: 'float32x2',
    });
    // MeshGeometry 用我们传入的数组建 Buffer(data 同引用):留 buffer 句柄,写完 update()
    this.posBuf = this.geometry.getAttribute('aPosition').buffer as Buffer;
    this.uvBuf = this.geometry.getAttribute('aUV').buffer as Buffer;
    this.mesh = new Mesh({ geometry: this.geometry, shader });
  }

  /** 换帧同步:帧像素尺寸 + 锚点 → 顶点;texture.uvs → 图集 UV(与 color 同源)。 */
  sync(tex: Texture, frameW: number, frameH: number, anchorX: number, anchorY: number): void {
    const p = this.pos;
    const x0 = -anchorX * frameW, x1 = (1 - anchorX) * frameW;
    const y0 = -anchorY * frameH, y1 = (1 - anchorY) * frameH;
    p[0] = x0; p[1] = y0;   // TL
    p[2] = x1; p[3] = y0;   // TR
    p[4] = x1; p[5] = y1;   // BR
    p[6] = x0; p[7] = y1;   // BL
    this.posBuf.update();
    const u = this.uv;
    const uvs = tex.uvs as { x0: number; y0: number; x1: number; y1: number;
      x2: number; y2: number; x3: number; y3: number };
    u[0] = uvs.x0; u[1] = uvs.y0; u[2] = uvs.x1; u[3] = uvs.y1;
    u[4] = uvs.x2; u[5] = uvs.y2; u[6] = uvs.x3; u[7] = uvs.y3;
    this.uvBuf.update();
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.destroy();            // 含 geometry;shader 由所有者(照明系统)回收
  }
}
