/**
 * 可燃物（热点展示图）的两道燃烧滤镜，挂在展示图 Sprite 的滤镜链里：
 *
 * ```
 * [密度模糊] → 燃烧材质（烤黄 / 焦黑 / 成灰 / 烧没）→ [深度遮挡 + 受光] → 燃烧自发光（火线 / 余烬）
 * ```
 *
 * - **材质在受光之前**：焦黑、成灰是反照率变了，要吃场景的光（黑屋里烧过的纸不会自己亮）；
 * - **自发光在受光之后**：火线自己发光，不吃漫反射着色；乘着上一步输出的覆盖度加，
 *   被前景挡住（深度遮挡丢掉的片元）的火线也就一起挡住。
 *
 * 着色数学只在 `burnShade.wgsl`（燃烧工作台经游戏同一个渲染器用的也是这份；像素对照 `tools/render_parity/cases/50_burn.ts`）。
 * 片元的场景坐标由屏幕位置 − 世界容器位置 ÷ 投影缩放得到（与角色着色滤镜同一条），再乘"场景 → 图 uv"仿射——
 * 热点的镜像 / 缩放 / 旋转都在仿射里。
 *
 * 资源有主：燃烧场纹理归 `BurnFieldTexture`（BurnSystem 的渲染侧持有）；滤镜只引用。卸载顺序 = 先从链上摘滤镜、
 * 再销毁滤镜、最后销毁纹理（pixi-v8-traps：BindGroup 见死即自毁）。
 */
import { BufferImageSource, Filter, GpuProgram, Texture } from '../../engine2d';
import BURN_SHADE_WGSL_SRC from './burnShade.wgsl?raw';
import type { BurnShadeParams } from './burnShadeParams';
import { samplerOf } from '../legacy/gpuSampler';

export type { BurnShadeParams } from './burnShadeParams';

/** 燃烧场着色（整份都是函数；拼它的程序要声明 `burnUniforms` / `uBurnField` / `uBurnFieldSampler`） */
export const BURN_SHADE_WGSL: string = BURN_SHADE_WGSL_SRC;

// ───────────── WGSL
// 滤镜约定：第 0 组 = Pixi 的 gfu / uTexture / uSampler；本滤镜的资源在第 1 组，变量名 = resources 的键名。
// BurnFilterUniforms 的成员顺序必须与 uniformsFor() 的声明顺序一致（Pixi 按声明顺序、WGSL 对齐规则排偏移）。
const WGSL_HEAD = /* wgsl */ `
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

struct BurnFilterUniforms {
  uWorldContainerPos: vec2<f32>,
  uProjectionScale: f32,
  uUvAffine: vec4<f32>,
  uUvOffset: vec2<f32>,
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
@group(1) @binding(0) var<uniform> burnUniforms: BurnFilterUniforms;
@group(1) @binding(1) var uBurnField: texture_2d<f32>;
@group(1) @binding(2) var uBurnFieldSampler: sampler;

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
  return VSOutput(
    filterVertexPosition(aPosition),
    filterTextureCoord(aPosition),
    aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy
  );
}
${BURN_SHADE_WGSL}
fn burnUvOfFragment(screenPos: vec2<f32>) -> vec2<f32> {
  let S = max(burnUniforms.uProjectionScale, 1e-6);
  let w = (screenPos - burnUniforms.uWorldContainerPos) / S;
  return vec2<f32>(burnUniforms.uUvAffine.x * w.x + burnUniforms.uUvAffine.y * w.y + burnUniforms.uUvOffset.x,
                   burnUniforms.uUvAffine.z * w.x + burnUniforms.uUvAffine.w * w.y + burnUniforms.uUvOffset.y);
}
`;

const WGSL_MATERIAL = WGSL_HEAD + /* wgsl */ `
@fragment
fn mainFragment(@location(0) vTextureCoord: vec2<f32>, @location(1) vScreenPos: vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, vTextureCoord);
  if (c.a < 1e-4) { return c; }
  var emit: vec3<f32>;
  let b = burnSample(burnUvOfFragment(vScreenPos), &emit);
  let m = burnMaterial(c.rgb / c.a, c.a, b);
  return vec4<f32>(m.rgb * m.a, m.a);
}
`;

const WGSL_GLOW = WGSL_HEAD + /* wgsl */ `
@fragment
fn mainFragment(@location(0) vTextureCoord: vec2<f32>, @location(1) vScreenPos: vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, vTextureCoord);
  if (c.a < 1e-4) { return c; }
  var emit: vec3<f32>;
  _ = burnSample(burnUvOfFragment(vScreenPos), &emit);
  // 加在覆盖度上（输入已是显示域的预乘色）
  let add = burnGlowAdd(emit);
  return vec4<f32>(min(c.rgb + add * c.a, vec3<f32>(c.a * 4.0)), c.a);
}
`;

let materialProgram: GpuProgram | null = null;
let glowProgram: GpuProgram | null = null;

function programOf(wgsl: string, name: string): GpuProgram {
  return GpuProgram.from({
    name,
    vertex: { source: wgsl, entryPoint: 'mainVertex' },
    fragment: { source: wgsl, entryPoint: 'mainFragment' },
  });
}

function getMaterialProgram(): GpuProgram {
  if (!materialProgram) materialProgram = programOf(WGSL_MATERIAL, 'burn-material-filter');
  return materialProgram;
}

function getGlowProgram(): GpuProgram {
  if (!glowProgram) glowProgram = programOf(WGSL_GLOW, 'burn-glow-filter');
  return glowProgram;
}

/** 燃烧场纹理（RGBA8、网格尺寸、NEAREST）。字节由模拟直接编码进 `data`，`upload()` 推上显卡 */
export class BurnFieldTexture {
  readonly data: Uint8Array;
  readonly source: BufferImageSource;
  readonly texture: Texture;
  private destroyed = false;

  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(Math.max(1, width * height) * 4);
    // 初值：全部"不会点着"（RG=65535）、无燃料（B=0）——模拟第一次编码之前不画任何燃烧
    for (let i = 0; i < this.data.length; i += 4) { this.data[i] = 255; this.data[i + 1] = 255; }
    this.source = new BufferImageSource({
      resource: this.data, width: Math.max(1, width), height: Math.max(1, height),
      format: 'rgba8unorm', scaleMode: 'nearest', alphaMode: 'no-premultiply-alpha',
    });
    this.texture = new Texture({ source: this.source });
  }

  upload(): void {
    if (this.destroyed) return;
    this.source.update();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.texture.destroy(false);
    this.source.destroy();
  }
}

function uniformsFor(field: BurnFieldTexture): Record<string, { value: unknown; type: string }> {
  return {
    uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uProjectionScale: { value: 1, type: 'f32' },
    uUvAffine: { value: new Float32Array([1, 0, 0, 1]), type: 'vec4<f32>' },
    uUvOffset: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
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

abstract class BurnFilterBase extends Filter {
  protected constructor(program: GpuProgram, field: BurnFieldTexture) {
    super({
      gpuProgram: program,
      resources: {
        burnUniforms: uniformsFor(field),
        uBurnField: field.source,
        // WebGPU 的纹理与采样器分开绑
        uBurnFieldSampler: samplerOf(field.source),
      },
    });
  }

  private get u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['burnUniforms']?.uniforms;
  }

  /** 相机：世界容器在屏幕上的位置 + 投影缩放（每帧） */
  setCamera(containerX: number, containerY: number, projectionScale: number): void {
    const u = this.u;
    if (!u) return;
    const a = u['uWorldContainerPos'] as Float32Array;
    a[0] = containerX; a[1] = containerY;
    u['uProjectionScale'] = projectionScale;
  }

  /** 场景 → 图 uv 的仿射 `[a, b, c, d, tx, ty]`（`burnSceneToUvAffine`） */
  setUvAffine(m: readonly number[]): void {
    const u = this.u;
    if (!u) return;
    const a = u['uUvAffine'] as Float32Array;
    a[0] = m[0]; a[1] = m[1]; a[2] = m[2]; a[3] = m[3];
    const o = u['uUvOffset'] as Float32Array;
    o[0] = m[4]; o[1] = m[5];
  }

  setShade(p: BurnShadeParams): void {
    const u = this.u;
    if (!u) return;
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
}

/** 受光之前：烤黄 / 焦黑 / 成灰 / 烧没 */
export class BurnMaterialFilter extends BurnFilterBase {
  constructor(field: BurnFieldTexture) {
    super(getMaterialProgram(), field);
  }
}

/** 受光之后：火线与余烬的自发光 */
export class BurnGlowFilter extends BurnFilterBase {
  constructor(field: BurnFieldTexture) {
    super(getGlowProgram(), field);
  }
}
