import type { Container, RenderSurface } from 'pixi.js';
import {
  AlphaFilter,
  BlurFilter,
  Filter,
  GlProgram,
  GpuProgram,
  Matrix,
  RenderTexture,
  RendererType,
  Texture,
  UniformGroup,
  type FilterSystem,
  type Renderer as PixiRenderer,
} from 'pixi.js';

/**
 * 接触 AO（SSAO 式单管线）：caster 轮廓 mask → 半分辨率高斯 → 一次合成。
 *
 * 老实现给物件 / ground crawler / body crawler 各挂一条「mask + 8 次模糊 + 合成」
 * 的 filter 链（每帧 ≈30 个全分辨率 draw）。现在合并为一条管线：
 *
 * 1. bake（Scene.update 中，每帧一次）：把 caster 容器（物件精灵 + 爬虫层）直接
 *    render 进两张半分辨率 RT（rtBody / rtCrit），alpha 即实心轮廓覆盖度。
 *    物件是 receiver 也是 caster，必须独立通道，否则「爬虫落在尸体上的影」会被
 *    尸体自身的覆盖抑制掉；
 * 2. apply（filter 挂在 objectRoot 上）：两张 RT 各自做一次 Pixi 双向高斯
 *    （半分辨率，像素量是全分辨率的 1/4），半径两通道独立；
 * 3. 一个合成 pass 采样物件颜色 + 4 张 mask（两 raw 两 blur）：
 *    - 物件影只写透明区黑 alpha（压暗背景板），并被自身 raw 轮廓抑制；
 *    - 爬虫影对不透明区直接乘暗（落在尸体上），透明区同样写黑 alpha，
 *      并被爬虫 raw 轮廓抑制（虫体不吃自己的影）。
 *
 * mask RT 烘焙在 objectRoot 本地设计空间（固定外扩矩形），合成时通过
 * 「filter 全局坐标 → objectRoot 本地 → mask uv」矩阵采样，镜头晃动、
 * 距离缩放、旋正都不需要重烘 RT。
 *
 * airLayer（苍蝇）不参与；n 只爬虫只是 caster 容器里的子 sprite，不增加
 * filter / 模糊次数。
 */

/** mask RT 相对设计空间的分辨率（降采样比例）。 */
const MASK_RES = 0.5;
/** 物件通道模糊半径系数（沿用旧观感）。 */
const BODY_BLUR_SCALE = 3.2;
/** 爬虫通道模糊半径系数（沿用旧观感）。 */
const CRITTER_BLUR_SCALE = 2.4;
/** 物件影不透明度系数（指数映射里的整体乘数）。 */
const BODY_OPACITY = 1.15;
/** 爬虫影不透明度系数。 */
const CRITTER_OPACITY = 1.5;
/** cast 区域外扩比例（给轮廓外阴影与爬虫走位留边）。 */
const CAST_PAD_RATIO = 0.18;
const CAST_PAD_MIN = 32;

const GL_VERTEX = /* glsl */ `
in vec2 aPosition;
out highp vec2 vTextureCoord;
uniform highp vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void) {
    vec2 p = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    p.x = p.x * (2.0 / uOutputTexture.x) - 1.0;
    p.y = p.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(p, 0.0, 1.0);
}
vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}
void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

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
struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var p = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  p.x = p.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  p.y = p.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4(p, 0.0, 1.0);
}
fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}
@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}
`;

// 合成：uTexture = objectRoot 颜色；4 张 mask 纹理 + 「全局坐标 → mask uv」矩阵。
// Pixi FilterSystem 里 uOutputFrame.xy = bounds（逻辑全局坐标），
// uOutputFrame.zw = input.frame 宽高（同样是逻辑像素，不是 device pixel）。
// 勿再除 resolution，Retina 上会把 gpos 缩到错误位置。
const GL_COMPOSITE = /* glsl */ `
in highp vec2 vTextureCoord;
out vec4 finalColor;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform sampler2D uTexture;
uniform sampler2D uBodyRaw;
uniform sampler2D uBodyBlur;
uniform sampler2D uCritRaw;
uniform sampler2D uCritBlur;
uniform vec4 uMaskX;
uniform vec4 uMaskY;
uniform float uBodyStrength;
uniform float uCritStrength;
void main(void) {
    vec4 base = texture(uTexture, vTextureCoord);
    vec2 aPos = vTextureCoord / (uOutputFrame.zw * uInputSize.zw);
    vec2 gpos = uOutputFrame.xy + aPos * uOutputFrame.zw;
    vec2 muv = vec2(
        dot(uMaskX.xyz, vec3(gpos, 1.0)),
        dot(uMaskY.xyz, vec3(gpos, 1.0))
    );
    float inArea = step(0.0, muv.x) * step(muv.x, 1.0)
                 * step(0.0, muv.y) * step(muv.y, 1.0);
    float bodyRaw = texture(uBodyRaw, muv).a * inArea;
    float bodyBlur = texture(uBodyBlur, muv).a * inArea;
    float critRaw = texture(uCritRaw, muv).a * inArea;
    float critBlur = texture(uCritBlur, muv).a * inArea;
    // 指数映射保持整段连续，避免高强度把高斯峰削成硬边黑带。
    float shBody = (1.0 - exp(-max(bodyBlur, 0.0) * uBodyStrength)) * (1.0 - bodyRaw);
    float shCrit = (1.0 - exp(-max(critBlur, 0.0) * uCritStrength)) * (1.0 - critRaw);
    // 不透明区：只有爬虫影直接乘暗（物件不吃自己的影）。
    vec3 rgb = base.rgb * (1.0 - shCrit);
    // 透明区：两通道都写黑 alpha，premultiplied 合成即 dst.rgb *= (1 - ao)。
    float aoA = max(shBody, shCrit) * (1.0 - base.a);
    finalColor = vec4(rgb, base.a + aoA);
}
`;

const WGSL_COMPOSITE = WGSL_HEAD + /* wgsl */ `
struct CompositeUniforms {
  uMaskX: vec4<f32>,
  uMaskY: vec4<f32>,
  uBodyStrength: f32,
  uCritStrength: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(1) @binding(0) var<uniform> cu: CompositeUniforms;
@group(1) @binding(1) var uBodyRaw: texture_2d<f32>;
@group(1) @binding(2) var uBodyRawSampler: sampler;
@group(1) @binding(3) var uBodyBlur: texture_2d<f32>;
@group(1) @binding(4) var uBodyBlurSampler: sampler;
@group(1) @binding(5) var uCritRaw: texture_2d<f32>;
@group(1) @binding(6) var uCritRawSampler: sampler;
@group(1) @binding(7) var uCritBlur: texture_2d<f32>;
@group(1) @binding(8) var uCritBlurSampler: sampler;
@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let base = textureSample(uTexture, uSampler, uv);
  let aPos = uv / (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  let gpos = gfu.uOutputFrame.xy + aPos * gfu.uOutputFrame.zw;
  let muv = vec2<f32>(
      dot(cu.uMaskX.xyz, vec3<f32>(gpos, 1.0)),
      dot(cu.uMaskY.xyz, vec3<f32>(gpos, 1.0))
  );
  let inArea = step(0.0, muv.x) * step(muv.x, 1.0)
             * step(0.0, muv.y) * step(muv.y, 1.0);
  let bodyRaw = textureSample(uBodyRaw, uBodyRawSampler, muv).a * inArea;
  let bodyBlur = textureSample(uBodyBlur, uBodyBlurSampler, muv).a * inArea;
  let critRaw = textureSample(uCritRaw, uCritRawSampler, muv).a * inArea;
  let critBlur = textureSample(uCritBlur, uCritBlurSampler, muv).a * inArea;
  let shBody = (1.0 - exp(-max(bodyBlur, 0.0) * cu.uBodyStrength)) * (1.0 - bodyRaw);
  let shCrit = (1.0 - exp(-max(critBlur, 0.0) * cu.uCritStrength)) * (1.0 - critRaw);
  let rgb = base.rgb * (1.0 - shCrit);
  let aoA = max(shBody, shCrit) * (1.0 - base.a);
  return vec4<f32>(rgb, base.a + aoA);
}
`;

class ContactCompositePass extends Filter {
  readonly uniforms: UniformGroup;

  constructor() {
    const uniforms = new UniformGroup({
      uMaskX: { value: new Float32Array([1, 0, 0, 0]), type: 'vec4<f32>' },
      uMaskY: { value: new Float32Array([0, 1, 0, 0]), type: 'vec4<f32>' },
      uBodyStrength: { value: 0, type: 'f32' },
      uCritStrength: { value: 0, type: 'f32' },
    });
    super({
      glProgram: GlProgram.from({
        name: 'object-examine-contact-composite',
        vertex: GL_VERTEX,
        fragment: GL_COMPOSITE,
      }),
      gpuProgram: GpuProgram.from({
        name: 'object-examine-contact-composite',
        vertex: { source: WGSL_COMPOSITE, entryPoint: 'mainVertex' },
        fragment: { source: WGSL_COMPOSITE, entryPoint: 'mainFragment' },
      }),
      resources: {
        compositeUniforms: uniforms,
        uBodyRaw: Texture.WHITE.source,
        uBodyRawSampler: Texture.WHITE.source.style,
        uBodyBlur: Texture.WHITE.source,
        uBodyBlurSampler: Texture.WHITE.source.style,
        uCritRaw: Texture.WHITE.source,
        uCritRawSampler: Texture.WHITE.source.style,
        uCritBlur: Texture.WHITE.source,
        uCritBlurSampler: Texture.WHITE.source.style,
      },
      antialias: 'off',
    });
    this.uniforms = uniforms;
  }
}

interface CastRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ObjectExamineContactAoFilter extends Filter {
  private readonly blurBody: BlurFilter;
  private readonly blurCrit: BlurFilter;
  private readonly compositePass: ContactCompositePass;
  private readonly passthrough = new AlphaFilter({ alpha: 1 });
  private bodyCaster: Container | null = null;
  private critterCasters: Container[] = [];
  private rtBody: RenderTexture | null = null;
  private rtBodyBlur: RenderTexture | null = null;
  private rtCrit: RenderTexture | null = null;
  private rtCritBlur: RenderTexture | null = null;
  private castRect: CastRect = { x: 0, y: 0, w: 1, h: 1 };
  private strengthValue: number;
  private radiusValue: number;
  private critterStrengthValue = 0;
  private critterRadiusValue = 1;
  private failed = false;
  private warned = false;
  // bake 矩阵复用，避免每帧分配。
  private readonly tmpInvRoot = new Matrix();
  private readonly tmpCaster = new Matrix();
  private readonly tmpShader = new Matrix();
  private readonly tmpTranslate = new Matrix();
  private readonly tmpScale = new Matrix();

  constructor() {
    super({
      compatibleRenderers: RendererType.BOTH,
      resources: {},
      resolution: 'inherit',
      antialias: 'off',
      clipToViewport: false,
      padding: 24,
    });
    this.strengthValue = 1;
    this.radiusValue = 1;
    // legacy 模式把目标半径均匀分给各 pass；不会像单 pass 那样把 9 个 tap
    // 随半径稀疏拉开，因而大半径下也不会出现偏移轮廓副本。半分辨率下
    // quality 2 已足够平滑。
    this.blurBody = new BlurFilter({
      strength: 1,
      quality: 2,
      kernelSize: 9,
      legacy: true,
      resolution: 'inherit',
    });
    this.blurCrit = new BlurFilter({
      strength: 1,
      quality: 2,
      kernelSize: 9,
      legacy: true,
      resolution: 'inherit',
    });
    this.compositePass = new ContactCompositePass();
    this.setStrength(1);
    this.setRadius(1);
    this.setCritterShadow(0, 1);
  }

  /** 指定 caster：物件本体 + 参与接触影的爬虫层（ground/body；苍蝇层不要传）。 */
  setCasters(body: Container, critters: Container[]): void {
    this.bodyCaster = body;
    this.critterCasters = critters.filter(Boolean);
  }

  /** caster 在 objectRoot 本地设计空间的活动范围（内部自动外扩）。 */
  setCastArea(x: number, y: number, w: number, h: number): void {
    const pad = Math.max(CAST_PAD_MIN, Math.ceil(Math.max(w, h) * CAST_PAD_RATIO));
    this.castRect = { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
    const tw = Math.max(8, Math.ceil(this.castRect.w * MASK_RES));
    const th = Math.max(8, Math.ceil(this.castRect.h * MASK_RES));
    if (
      this.rtBody &&
      this.rtBody.width === tw &&
      this.rtBody.height === th
    ) {
      return;
    }
    this.destroyTargets();
    this.rtBody = RenderTexture.create({ width: tw, height: th });
    this.rtBodyBlur = RenderTexture.create({ width: tw, height: th });
    this.rtCrit = RenderTexture.create({ width: tw, height: th });
    this.rtCritBlur = RenderTexture.create({ width: tw, height: th });
  }

  /**
   * 每帧在场景 render 前调用：把 caster 轮廓烘进半分辨率 RT，并更新
   * 「filter 全局坐标 → mask uv」矩阵。矩阵全部用上一帧的世界矩阵自洽推导，
   * objectRoot 内的相对关系精确，镜头运动最多滞后一帧（幅度可忽略）。
   */
  bake(renderer: PixiRenderer, objectRoot: Container): void {
    if (!this.enabled || !this.rtBody || !this.rtCrit || !this.bodyCaster) return;
    const r = this.castRect;
    this.tmpInvRoot.copyFrom(objectRoot.worldTransform).invert();
    // 合成采样矩阵：uv = S(1/w,1/h) · T(-x,-y) · invWorld · global
    // Pixi append 是右乘；要用 prepend 才能得到注释里的左乘顺序。
    this.tmpTranslate.set(1, 0, 0, 1, -r.x, -r.y);
    this.tmpScale.set(1 / r.w, 0, 0, 1 / r.h, 0, 0);
    this.tmpShader
      .copyFrom(this.tmpInvRoot)
      .prepend(this.tmpTranslate)
      .prepend(this.tmpScale);
    const m = this.tmpShader;
    this.compositePass.uniforms.uniforms.uMaskX = new Float32Array([m.a, m.c, m.tx, 0]);
    this.compositePass.uniforms.uniforms.uMaskY = new Float32Array([m.b, m.d, m.ty, 0]);
    // caster 烘焙变换：texel = S(MASK_RES) · T(-x,-y) · invWorld · casterWorld
    this.tmpScale.set(MASK_RES, 0, 0, MASK_RES, 0, 0);
    try {
      renderer.clear({ target: this.rtBody, clearColor: [0, 0, 0, 0] });
      if (this.bodyCaster.visible) {
        this.casterTransform(this.bodyCaster);
        renderer.render({
          container: this.bodyCaster,
          target: this.rtBody,
          clear: false,
          transform: this.tmpCaster,
        });
      }
      renderer.clear({ target: this.rtCrit, clearColor: [0, 0, 0, 0] });
      for (const caster of this.critterCasters) {
        if (!caster.visible) continue;
        this.casterTransform(caster);
        renderer.render({
          container: caster,
          target: this.rtCrit,
          clear: false,
          transform: this.tmpCaster,
        });
      }
    } catch (e) {
      this.failed = true;
      this.enabled = false;
      if (!this.warned) {
        this.warned = true;
        console.warn('objectExamine: contact AO mask bake failed; disabling this pass', e);
      }
    }
  }

  private casterTransform(caster: Container): void {
    this.tmpCaster
      .copyFrom(caster.worldTransform)
      .prepend(this.tmpInvRoot)
      .prepend(this.tmpTranslate)
      .prepend(this.tmpScale);
  }

  override apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ): void {
    if (!this.rtBody || !this.rtBodyBlur || !this.rtCrit || !this.rtCritBlur) {
      this.passthrough.apply(filterManager, input, output, clearMode);
      return;
    }
    try {
      this.blurBody.apply(filterManager, this.rtBody, this.rtBodyBlur, true);
      this.blurCrit.apply(filterManager, this.rtCrit, this.rtCritBlur, true);
      this.compositePass.resources.uBodyRaw = this.rtBody.source;
      this.compositePass.resources.uBodyRawSampler = this.rtBody.source.style;
      this.compositePass.resources.uBodyBlur = this.rtBodyBlur.source;
      this.compositePass.resources.uBodyBlurSampler = this.rtBodyBlur.source.style;
      this.compositePass.resources.uCritRaw = this.rtCrit.source;
      this.compositePass.resources.uCritRawSampler = this.rtCrit.source.style;
      this.compositePass.resources.uCritBlur = this.rtCritBlur.source;
      this.compositePass.resources.uCritBlurSampler = this.rtCritBlur.source.style;
      this.compositePass.apply(filterManager, input, output, clearMode);
    } catch (e) {
      this.failed = true;
      this.enabled = false;
      if (!this.warned) {
        this.warned = true;
        console.warn('objectExamine: contact AO render failed; disabling this pass', e);
      }
      this.passthrough.apply(filterManager, input, output, clearMode);
    }
  }

  /** 物件接触影强度（0 = 关）。 */
  setStrength(value: number): void {
    this.strengthValue = Math.max(0, Math.min(3, value));
    this.compositePass.uniforms.uniforms.uBodyStrength = this.strengthValue * BODY_OPACITY;
    this.syncEnabled();
  }

  /** 物件接触影半径（设计空间乘数）。 */
  setRadius(value: number): void {
    this.radiusValue = Math.max(0.3, Math.min(2.5, value));
    this.blurBody.strength = Math.max(0.5, this.radiusValue * BODY_BLUR_SCALE * MASK_RES);
    this.syncPadding();
  }

  /** 爬虫接触影：strength 强度、radius 半径（设计空间乘数）。 */
  setCritterShadow(strength: number, radius: number): void {
    this.critterStrengthValue = Math.max(0, Math.min(3, strength));
    this.critterRadiusValue = Math.max(0.3, Math.min(2.5, radius));
    this.compositePass.uniforms.uniforms.uCritStrength =
      this.critterStrengthValue * CRITTER_OPACITY;
    this.blurCrit.strength = Math.max(
      0.5,
      this.critterRadiusValue * CRITTER_BLUR_SCALE * MASK_RES,
    );
    this.syncEnabled();
    this.syncPadding();
  }

  private syncEnabled(): void {
    this.enabled =
      !this.failed && (this.strengthValue > 0.001 || this.critterStrengthValue > 0.001);
  }

  private syncPadding(): void {
    const bodySpill = (this.blurBody.strength / MASK_RES) * 2;
    const critSpill = (this.blurCrit.strength / MASK_RES) * 2;
    this.padding = Math.ceil(Math.max(bodySpill, critSpill) + 4);
  }

  get strength(): number { return this.strengthValue; }
  get radius(): number { return this.radiusValue; }

  private destroyTargets(): void {
    this.rtBody?.destroy();
    this.rtBodyBlur?.destroy();
    this.rtCrit?.destroy();
    this.rtCritBlur?.destroy();
    this.rtBody = this.rtBodyBlur = this.rtCrit = this.rtCritBlur = null;
  }

  override destroy(_destroyPrograms = false): void {
    this.destroyTargets();
    this.blurBody.blurXFilter.destroy(false);
    this.blurBody.blurYFilter.destroy(false);
    this.blurBody.destroy(false);
    this.blurCrit.blurXFilter.destroy(false);
    this.blurCrit.blurYFilter.destroy(false);
    this.blurCrit.destroy(false);
    this.compositePass.destroy(false);
    this.passthrough.destroy(false);
    super.destroy(false);
  }
}
