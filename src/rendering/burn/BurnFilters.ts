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
 * 着色数学只在 `burnShade.glsl`（燃烧工作台拼的是同一份）。片元的场景坐标由屏幕位置 − 世界容器位置
 * ÷ 投影缩放得到（与角色着色滤镜同一条），再乘"场景 → 图 uv"仿射——热点的镜像 / 缩放 / 旋转都在仿射里。
 *
 * 资源有主：燃烧场纹理归 `BurnFieldTexture`（BurnSystem 的渲染侧持有）；滤镜只引用。卸载顺序 = 先从链上摘滤镜、
 * 再销毁滤镜、最后销毁纹理（pixi-v8-traps：BindGroup 见死即自毁）。
 */
import { BufferImageSource, Filter, GlProgram, Texture } from 'pixi.js';
import BURN_SHADE_SRC from './burnShade.glsl?raw';
import type { BurnShadeParams } from './burnShadeParams';

export type { BurnShadeParams } from './burnShadeParams';

function sliceGlsl(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[BurnFilters] GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

export const BURN_SHADE_GLSL = sliceGlsl(BURN_SHADE_SRC, 'BURN_SHADE');

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

const COMMON = /* glsl */ `
uniform sampler2D uTexture;
uniform vec2  uWorldContainerPos;
uniform float uProjectionScale;
uniform vec4  uUvAffine;
uniform vec2  uUvOffset;
${BURN_SHADE_GLSL}
vec2 burnUvOfFragment() {
    float S = max(uProjectionScale, 1e-6);
    vec2 w = (vScreenPos - uWorldContainerPos) / S;
    return vec2(uUvAffine.x * w.x + uUvAffine.y * w.y + uUvOffset.x,
                uUvAffine.z * w.x + uUvAffine.w * w.y + uUvOffset.y);
}
`;

const FRAG_MATERIAL = /* glsl */ `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vScreenPos;
out vec4 finalColor;
${COMMON}
void main(void) {
    vec4 c = texture(uTexture, vTextureCoord);
    if (c.a < 1e-4) { finalColor = c; return; }
    vec3 emit;
    vec4 b = burnSample(burnUvOfFragment(), emit);
    vec4 m = burnMaterial(c.rgb / c.a, c.a, b);
    finalColor = vec4(m.rgb * m.a, m.a);
}
`;

const FRAG_GLOW = /* glsl */ `#version 300 es
precision highp float;
in vec2 vTextureCoord;
in vec2 vScreenPos;
out vec4 finalColor;
${COMMON}
void main(void) {
    vec4 c = texture(uTexture, vTextureCoord);
    if (c.a < 1e-4) { finalColor = c; return; }
    vec3 emit;
    burnSample(burnUvOfFragment(), emit);
    // 加在覆盖度上（输入已是显示域的预乘色）
    vec3 add = burnGlowAdd(emit);
    finalColor = vec4(min(c.rgb + add * c.a, vec3(c.a * 4.0)), c.a);
}
`;

let materialProgram: GlProgram | null = null;
let glowProgram: GlProgram | null = null;

function getMaterialProgram(): GlProgram {
  if (!materialProgram) materialProgram = new GlProgram({ vertex: VERT, fragment: FRAG_MATERIAL });
  return materialProgram;
}

function getGlowProgram(): GlProgram {
  if (!glowProgram) glowProgram = new GlProgram({ vertex: VERT, fragment: FRAG_GLOW });
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
  protected constructor(program: GlProgram, field: BurnFieldTexture) {
    super({
      glProgram: program,
      resources: {
        burnUniforms: uniformsFor(field),
        uBurnField: field.source,
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
