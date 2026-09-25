/**
 * 燃烧系统的渲染侧：每个**在场、烧过**的可燃实例一张燃烧场纹理，按宿主的渲染管线接两种方式：
 *
 * - **滤镜宿主**（热点展示图：一张 Sprite + 滤镜链 `[密度, 燃烧材质, 深度 + 受光, 燃烧自发光]`）：两道燃烧滤镜挂上去，
 *   片元的场景坐标经"场景 → 图 uv"仿射得到 uv（`BurnFilters`）；
 * - **纹理宿主**（NPC、手上的挂件：画面由角色逐像素光照 mesh 出图，滤镜挂不进去）：在**图像空间**里每帧把
 *   "模板图 × 燃烧材质"画进一张颜色图、"燃烧自发光"画进一张自发光图，宿主拿颜色图顶替它的颜色纹理（照常受光）、
 *   自发光图叠加在上面（不受光，被同一个容器的深度遮挡一起挡住）。
 *
 * 着色数学只在 `burnShade.glsl`（两种接法与燃烧工作台拼的是同一份）；WebGPU 渲染器跑它的逐句译本 `burnShade.wgsl`。
 *
 * 资源有主：纹理 / 滤镜 / 渲染纹理都归本类；宿主只持有引用。拆的顺序（pixi-v8-traps / teardown-ordering）：
 * **先从宿主上摘 → 再销毁滤镜 / mesh → 最后销毁纹理**。本类不 import 实体层（渲染层不许往上依赖），只认最小接口。
 */
import {
  Mesh,
  MeshGeometry,
  RenderTexture,
  Shader,
  type Filter,
  type Renderer,
  type Texture,
} from 'pixi.js';
import {
  BURN_SHADE_GLSL,
  BURN_SHADE_WGSL,
  BurnFieldTexture,
  BurnGlowFilter,
  BurnMaterialFilter,
  type BurnShadeParams,
} from './BurnFilters';

/** 能挂燃烧滤镜的宿主（热点展示图） */
export interface BurnFilterHost {
  setBurnFilters(material: Filter | null, glow: Filter | null): void;
}

/** 能换燃烧纹理的宿主（NPC / 手上挂件：颜色纹理被逐像素光照 mesh 采样） */
export interface BurnTextureHost {
  /** 宿主此刻显示的模板图（还没装到 = null，下一帧再试） */
  burnBaseTexture(): Texture | null;
  /** 换上烧过的颜色图 + 叠加自发光（`null, null` = 还原成模板图、摘掉自发光） */
  setBurnTextures(albedo: Texture | null, emissive: Texture | null): void;
}

export type BurnRenderHost =
  | { kind: 'filters'; host: BurnFilterHost }
  | { kind: 'texture'; host: BurnTextureHost };

/** 燃烧场纹理最多每秒上传几次（着色器按时刻插值火线，纹理只在"新排上了哪些格"时变） */
export const BURN_FIELD_UPLOAD_HZ = 20;
/**
 * 图像空间渲染纹理的长边上限（像素）。**必须 ≥ 模板图本身**：挂件宿主直接把贴图换成颜色图，尺寸不同几何就变了
 * （支点 / 起火点 / 站位全按贴图像素算）。运行时贴图闸就是 2048，超了的模板图本来就装不上。
 */
export const BURN_TEXTURE_MAX_SIDE = 2048;

interface FilterEntry {
  kind: 'filters';
  host: BurnFilterHost;
  field: BurnFieldTexture;
  material: BurnMaterialFilter;
  glow: BurnGlowFilter;
  pending: boolean;
  lastUploadMs: number;
}

interface TextureEntry {
  kind: 'texture';
  host: BurnTextureHost;
  field: BurnFieldTexture;
  pending: boolean;
  lastUploadMs: number;
  /** 着色参数（每帧 setShade 推；画 RT 时读） */
  shade: BurnShadeParams | null;
  /** 下面这些在模板图装到之后才建 */
  base: Texture | null;
  albedo: RenderTexture | null;
  emissive: RenderTexture | null;
  geometry: MeshGeometry | null;
  materialShader: Shader | null;
  glowShader: Shader | null;
  materialMesh: Mesh<MeshGeometry, Shader> | null;
  glowMesh: Mesh<MeshGeometry, Shader> | null;
  handedOver: boolean;
}

type Entry = FilterEntry | TextureEntry;

const IMG_VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUv;
void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

const IMG_COMMON = /* glsl */ `
uniform sampler2D uBaseTex;
uniform vec4 uBaseFrame;
${BURN_SHADE_GLSL}
vec4 burnBaseSample(vec2 uv) {
    return texture(uBaseTex, mix(uBaseFrame.xy, uBaseFrame.zw, uv));
}
`;

const IMG_FRAG_MATERIAL = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${IMG_COMMON}
void main(void) {
    vec4 c = burnBaseSample(vUv);
    if (c.a < 1e-4) { fragColor = vec4(0.0); return; }
    vec3 emit;
    vec4 b = burnSample(vUv, emit);
    vec4 m = burnMaterial(c.rgb / c.a, c.a, b);
    fragColor = vec4(m.rgb * m.a, m.a);
}
`;

const IMG_FRAG_GLOW = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${IMG_COMMON}
void main(void) {
    vec4 c = burnBaseSample(vUv);
    if (c.a < 1e-4) { fragColor = vec4(0.0); return; }
    vec3 emit;
    vec4 b = burnSample(vUv, emit);
    // 叠加用：颜色 = 发光 × 烧过之后的覆盖度；alpha 0（加法混合不改底下的覆盖度）
    fragColor = vec4(burnGlowAdd(emit) * c.a * b.w, 0.0);
}
`;

// ───────────── WGSL（Pixi WebGPU 渲染器）：与上面的 GLSL 逐句对应
// 网格约定：第 0 组 globalUniforms、第 1 组 localUniforms（Pixi 自动绑），本程序的资源在第 2 组，变量名 = resources 的键名。
// BurnImageUniforms 的成员顺序必须与 imageUniforms() 的声明顺序一致（Pixi 按声明顺序、WGSL 对齐规则排偏移）。
const IMG_WGSL_HEAD = /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
};
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
};
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct BurnImageUniforms {
  uBaseFrame: vec4<f32>,
  uBurnGrid: vec2<f32>,
  uBurnNow: f32,
  uBurnStep: f32,
  uBurnFlame: f32,
  uBurnEmber: f32,
  uBurnScorch: f32,
  uBurnAshFade: f32,
  uBurnEdgeNoise: f32,
  uBurnScorchColor: vec3<f32>,
  uBurnCharColor: vec3<f32>,
  uBurnAshColor: vec3<f32>,
  uBurnAshAlpha: f32,
  uBurnGlow: vec3<f32>,
  uBurnEmberGlow: vec3<f32>,
};
@group(2) @binding(0) var<uniform> burnUniforms: BurnImageUniforms;
@group(2) @binding(1) var uBaseTex: texture_2d<f32>;
@group(2) @binding(2) var uBaseTexSampler: sampler;
@group(2) @binding(3) var uBurnField: texture_2d<f32>;
@group(2) @binding(4) var uBurnFieldSampler: sampler;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return VSOutput(vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0), aUV);
}
${BURN_SHADE_WGSL}
// 一致控制流里调（片元入口第一句），与 GLSL texture() 同样按导数选级
fn burnBaseSample(uv: vec2<f32>) -> vec4<f32> {
  return textureSample(uBaseTex, uBaseTexSampler, mix(burnUniforms.uBaseFrame.xy, burnUniforms.uBaseFrame.zw, uv));
}
`;

const IMG_WGSL_MATERIAL = IMG_WGSL_HEAD + /* wgsl */ `
@fragment
fn mainFragment(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {
  let c = burnBaseSample(vUv);
  if (c.a < 1e-4) { return vec4<f32>(0.0); }
  var emit: vec3<f32>;
  let b = burnSample(vUv, &emit);
  let m = burnMaterial(c.rgb / c.a, c.a, b);
  return vec4<f32>(m.rgb * m.a, m.a);
}
`;

const IMG_WGSL_GLOW = IMG_WGSL_HEAD + /* wgsl */ `
@fragment
fn mainFragment(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {
  let c = burnBaseSample(vUv);
  if (c.a < 1e-4) { return vec4<f32>(0.0); }
  var emit: vec3<f32>;
  let b = burnSample(vUv, &emit);
  // 叠加用：颜色 = 发光 × 烧过之后的覆盖度；alpha 0（加法混合不改底下的覆盖度）
  return vec4<f32>(burnGlowAdd(emit) * c.a * b.w, 0.0);
}
`;

function imageUniforms(field: BurnFieldTexture): Record<string, { value: unknown; type: string }> {
  return {
    uBaseFrame: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
    uBurnGrid: { value: new Float32Array([field.width, field.height]), type: 'vec2<f32>' },
    uBurnNow: { value: -1e6, type: 'f32' },
    uBurnStep: { value: 1 / 16, type: 'f32' },
    uBurnFlame: { value: 1, type: 'f32' },
    uBurnEmber: { value: 1, type: 'f32' },
    uBurnScorch: { value: 1, type: 'f32' },
    uBurnAshFade: { value: 1, type: 'f32' },
    uBurnEdgeNoise: { value: 0, type: 'f32' },
    uBurnScorchColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uBurnCharColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uBurnAshColor: { value: new Float32Array([0.4, 0.4, 0.4]), type: 'vec3<f32>' },
    uBurnAshAlpha: { value: 0, type: 'f32' },
    uBurnGlow: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uBurnEmberGlow: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
  };
}

function writeShade(u: Record<string, unknown>, p: BurnShadeParams): void {
  (u['uBurnGrid'] as Float32Array)[0] = p.gridW;
  (u['uBurnGrid'] as Float32Array)[1] = p.gridH;
  u['uBurnNow'] = p.now;
  u['uBurnStep'] = p.timeStep;
  u['uBurnFlame'] = p.flameSeconds;
  u['uBurnEmber'] = p.emberSeconds;
  u['uBurnScorch'] = p.scorchSeconds;
  u['uBurnAshFade'] = p.ashFadeSeconds;
  u['uBurnEdgeNoise'] = p.edgeNoise;
  (u['uBurnScorchColor'] as Float32Array).set(p.scorchColor);
  (u['uBurnCharColor'] as Float32Array).set(p.charColor);
  (u['uBurnAshColor'] as Float32Array).set(p.ashColor);
  u['uBurnAshAlpha'] = p.ashAlpha;
  (u['uBurnGlow'] as Float32Array).set(p.glow);
  (u['uBurnEmberGlow'] as Float32Array).set(p.emberGlow);
}

export class BurnRenderer {
  private readonly entries = new Map<string, Entry>();
  private pixi: (() => Renderer | null | undefined) | null = null;

  /**
   * 纹理宿主要在图像空间里画 RT：组装层给**取**渲染器的入口（组装期 Pixi 应用可能还没初始化，每帧现取）。
   * 没给 / 取不到 = 纹理宿主这一帧不画燃烧，宿主显示原模板图。
   */
  setPixiRenderer(get: (() => Renderer | null | undefined) | null): void {
    this.pixi = get;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 挂上（已挂同一宿主同尺寸 = 什么都不做；换了宿主 / 尺寸 = 先拆再挂） */
  attach(key: string, render: BurnRenderHost, gridW: number, gridH: number): void {
    const cur = this.entries.get(key);
    if (cur && cur.kind === render.kind && cur.host === render.host && cur.field.width === gridW && cur.field.height === gridH) return;
    if (cur) this.detach(key);
    const field = new BurnFieldTexture(gridW, gridH);
    if (render.kind === 'filters') {
      const material = new BurnMaterialFilter(field);
      const glow = new BurnGlowFilter(field);
      render.host.setBurnFilters(material, glow);
      this.entries.set(key, { kind: 'filters', host: render.host, field, material, glow, pending: false, lastUploadMs: -Infinity });
      return;
    }
    this.entries.set(key, {
      kind: 'texture', host: render.host, field, pending: false, lastUploadMs: -Infinity, shade: null,
      base: null, albedo: null, emissive: null, geometry: null, materialShader: null, glowShader: null,
      materialMesh: null, glowMesh: null, handedOver: false,
    });
  }

  detach(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    if (e.kind === 'filters') {
      e.host.setBurnFilters(null, null);
      e.material.destroy();
      e.glow.destroy();
    } else {
      if (e.handedOver) e.host.setBurnTextures(null, null);
      this.disposeTextureResources(e);
    }
    e.field.destroy();
  }

  /** 燃烧场字节（模拟直接编码进来）；没挂 = null */
  fieldData(key: string): Uint8Array | null {
    return this.entries.get(key)?.field.data ?? null;
  }

  /** 字节改过了：限速上传（`force` = 立刻，比如刚挂上的第一份） */
  markDirty(key: string, nowMs: number, force = false): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.pending = true;
    this.flush(e, nowMs, force);
  }

  /** 着色参数；滤镜宿主还要"场景 → 图 uv"仿射（纹理宿主在图像空间里画，不要它） */
  setShade(key: string, params: BurnShadeParams, uvAffine: readonly number[] | null): void {
    const e = this.entries.get(key);
    if (!e) return;
    if (e.kind === 'filters') {
      e.material.setShade(params);
      e.glow.setShade(params);
      if (uvAffine) {
        e.material.setUvAffine(uvAffine);
        e.glow.setUvAffine(uvAffine);
      }
    } else {
      e.shade = params;
    }
  }

  /** 每帧（相机定稿之后）：没轮到的待上传补上；滤镜宿主推相机；纹理宿主在图像空间里画一遍 */
  update(nowMs: number, camera: { x: number; y: number; scale: number }): void {
    for (const e of this.entries.values()) {
      if (e.pending) this.flush(e, nowMs, false);
      if (e.kind === 'filters') {
        e.material.setCamera(camera.x, camera.y, camera.scale);
        e.glow.setCamera(camera.x, camera.y, camera.scale);
      } else {
        this.renderTextureEntry(e);
      }
    }
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.detach(key);
  }

  private flush(e: Entry, nowMs: number, force: boolean): void {
    if (!force && nowMs - e.lastUploadMs < 1000 / BURN_FIELD_UPLOAD_HZ) return;
    e.field.upload();
    e.lastUploadMs = nowMs;
    e.pending = false;
  }

  private renderTextureEntry(e: TextureEntry): void {
    const r = this.pixi?.() ?? null;
    if (!r || !e.shade) return;
    const base = e.host.burnBaseTexture();
    if (!base || !base.source) return;
    if (e.base !== base) {
      // 模板图换了（或第一次）：按它的尺寸重建 RT 与 mesh
      if (e.handedOver) { e.host.setBurnTextures(null, null); e.handedOver = false; }
      this.disposeTextureResources(e);
      this.buildTextureResources(e, base);
    }
    if (!e.materialMesh || !e.glowMesh || !e.albedo || !e.emissive) return;
    const mu = (e.materialShader!.resources as Record<string, { uniforms: Record<string, unknown> }>)['burnUniforms'].uniforms;
    const gu = (e.glowShader!.resources as Record<string, { uniforms: Record<string, unknown> }>)['burnUniforms'].uniforms;
    writeShade(mu, e.shade);
    writeShade(gu, e.shade);
    // ⚠ Pixi 坑：渲离屏 RT 必须显式 clear，否则串到上一次的内容
    r.render({ container: e.materialMesh, target: e.albedo, clear: true, clearColor: [0, 0, 0, 0] });
    r.render({ container: e.glowMesh, target: e.emissive, clear: true, clearColor: [0, 0, 0, 0] });
    if (!e.handedOver) {
      e.host.setBurnTextures(e.albedo, e.emissive);
      e.handedOver = true;
    }
  }

  private buildTextureResources(e: TextureEntry, base: Texture): void {
    const fw = Math.max(1, base.frame.width);
    const fh = Math.max(1, base.frame.height);
    const k = Math.min(1, BURN_TEXTURE_MAX_SIDE / Math.max(fw, fh));
    const w = Math.max(1, Math.round(fw * k));
    const h = Math.max(1, Math.round(fh * k));
    e.base = base;
    e.albedo = RenderTexture.create({ width: w, height: h, antialias: false, scaleMode: 'linear' });
    e.emissive = RenderTexture.create({ width: w, height: h, antialias: false, scaleMode: 'linear' });
    e.geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const src = base.source;
    const frame = new Float32Array([
      base.frame.x / src.width, base.frame.y / src.height,
      (base.frame.x + base.frame.width) / src.width, (base.frame.y + base.frame.height) / src.height,
    ]);
    const mk = (fragment: string, wgsl: string): Shader => {
      // 键名 = WGSL 变量名（burnShade.wgsl 按 burnUniforms 取 uniform）；GLSL 侧按 uniform 名逐个对，与键名无关
      const burnUniforms = imageUniforms(e.field);
      (burnUniforms.uBaseFrame.value as Float32Array).set(frame);
      return Shader.from({
        gl: { vertex: IMG_VERT, fragment },
        gpu: {
          vertex: { source: wgsl, entryPoint: 'mainVertex' },
          fragment: { source: wgsl, entryPoint: 'mainFragment' },
        },
        resources: {
          burnUniforms,
          uBaseTex: src,
          // 两个 *Sampler 只有 WGSL 用（WebGPU 纹理与采样器分开绑）；GLSL 侧 Pixi 忽略这两个名字
          uBaseTexSampler: src.style,
          uBurnField: e.field.source,
          uBurnFieldSampler: e.field.source.style,
        },
      });
    };
    e.materialShader = mk(IMG_FRAG_MATERIAL, IMG_WGSL_MATERIAL);
    e.glowShader = mk(IMG_FRAG_GLOW, IMG_WGSL_GLOW);
    e.materialMesh = new Mesh({ geometry: e.geometry, shader: e.materialShader });
    e.glowMesh = new Mesh({ geometry: e.geometry, shader: e.glowShader });
  }

  private disposeTextureResources(e: TextureEntry): void {
    e.materialMesh?.destroy();
    e.glowMesh?.destroy();
    e.materialShader?.destroy();
    e.glowShader?.destroy();
    e.geometry?.destroy();
    e.albedo?.destroy(true);
    e.emissive?.destroy(true);
    e.materialMesh = null;
    e.glowMesh = null;
    e.materialShader = null;
    e.glowShader = null;
    e.geometry = null;
    e.albedo = null;
    e.emissive = null;
    e.base = null;
  }
}
