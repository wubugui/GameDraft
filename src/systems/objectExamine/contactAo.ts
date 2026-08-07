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
import {
  OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM,
  OBJECT_EXAMINE_MAX_CRITTER_AO_RADIUS_CM,
} from './types';

/**
 * 接触 AO（SSAO 式单管线）：caster 轮廓 mask → 半分辨率高斯 → 一次合成。
 *
 * 老实现给物件 / ground crawler / body crawler 各挂一条「mask + 8 次模糊 + 合成」
 * 的 filter 链（每帧 ≈30 个全分辨率 draw）。现在合并为一条管线：
 *
 * **尺寸一律用物理长度（厘米）表达**，绝不用贴图像素：物件声明
 * `presentation.physicalWidthCm`，据此得到 pixelsPerCm；AO 半径、mask 采样密度、
 * cast 留边都从厘米换算。换一张更高分辨率的静帧，观感不变。
 *
 * 1. bake（Scene.update 中，每帧一次）：把 caster 容器（物件精灵 + 爬虫层）直接
 *    render 进两张降采样 RT（rtBody / rtCrit），alpha 即实心轮廓覆盖度。
 *    物件是 receiver 也是 caster，必须独立通道，否则「爬虫落在尸体上的影」会被
 *    尸体自身的覆盖抑制掉；
 * 2. apply（filter 挂在 objectRoot 上）：两张 RT 各自做一次 Pixi 双向高斯
 *    （降采样域内，像素量远小于全分辨率），半径两通道独立；
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

/**
 * mask 采样密度：每厘米几个 texel。**这是全套尺寸的唯一分辨率锚点**——
 * mask RT 大小、模糊半径都由它和「厘米」推出来，与静帧贴图的导出分辨率无关。
 * 调大 = 影子边缘更细腻但 RT 更大。
 */
const MASK_TEXELS_PER_CM = 4;
/** mask 相对设计空间的缩放上下限（texel / 设计像素）：不超采样源图，也不过分粗糙。 */
const MASK_SCALE_MAX = 0.5;
const MASK_SCALE_MIN = 0.05;
/** 高斯外溢按 3σ 估，用于 filter padding 与 cast 留边。 */
const BLUR_SPILL_SIGMAS = 3;
/** 物件影不透明度系数（指数映射里的整体乘数）。 */
const BODY_OPACITY = 1.15;
/** 爬虫影不透明度系数。 */
const CRITTER_OPACITY = 1.5;
/**
 * cast 区域外扩：给爬虫走出剪影的活动余量（相对物件尺寸）与影子外溢留边。
 * 留边取「比例余量」与「AO 半径上限的 3σ 外溢」的较大者，且不含实时半径——
 * 否则 F2 拖半径或爬虫影平滑跟随会让 mask RT 每帧重建。
 */
const CAST_PAD_RATIO = 0.18;
const CAST_PAD_MIN_CM = 4;

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
  /** caster 活动范围（objectRoot 本地设计空间，未外扩）。 */
  private rawRect: CastRect = { x: 0, y: 0, w: 1, h: 1 };
  /** 外扩后的 mask 覆盖范围。 */
  private castRect: CastRect = { x: 0, y: 0, w: 1, h: 1 };
  /** 物理标尺：一厘米等于多少设计像素。 */
  private pixelsPerCm = 1;
  /** mask texel / 设计像素。 */
  private maskScale = MASK_SCALE_MAX;
  private strengthValue: number;
  private radiusCmValue: number;
  private critterStrengthValue = 0;
  private critterRadiusCmValue = 0;
  private failed = false;
  private warned = false;
  // bake 矩阵复用，避免每帧分配。
  private readonly tmpInvRoot = new Matrix();
  private readonly tmpCaster = new Matrix();
  private readonly tmpLocal = new Matrix();
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
    this.radiusCmValue = 0;
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
    this.setRadiusCm(0);
    this.setCritterShadow(0, 0);
  }

  /** 指定 caster：物件本体 + 参与接触影的爬虫层（ground/body；苍蝇层不要传）。 */
  setCasters(body: Container, critters: Container[]): void {
    this.bodyCaster = body;
    this.critterCasters = critters.filter(Boolean);
  }

  /**
   * 物理标尺：一厘米等于多少设计像素（= texW / 物件真实宽度）。
   * 半径类参数一律以厘米表达，靠它换算，因此换更高分辨率的静帧观感不变。
   */
  setPixelsPerCm(value: number): void {
    const next = Number.isFinite(value) && value > 0 ? value : 1;
    if (next === this.pixelsPerCm) return;
    this.pixelsPerCm = next;
    this.rebuildTargets();
    this.syncBlur();
  }

  /** caster 在 objectRoot 本地设计空间的活动范围（内部自动外扩）。 */
  setCastArea(x: number, y: number, w: number, h: number): void {
    this.rawRect = { x, y, w, h };
    this.rebuildTargets();
    this.syncBlur();
  }

  /** 依 rawRect + 物理标尺重算外扩范围与 mask RT 尺寸；尺寸没变则不动 RT。 */
  private rebuildTargets(): void {
    const { x, y, w, h } = this.rawRect;
    // 物件半径用实配值（离散，改动才重建）；爬虫半径每帧平滑跟随，用静态上限
    // 预留，否则 castRect 会逐帧微动、mask RT 每帧重建。
    const spillCm = Math.max(this.radiusCmValue, OBJECT_EXAMINE_MAX_CRITTER_AO_RADIUS_CM);
    const spillPx = spillCm * BLUR_SPILL_SIGMAS * this.pixelsPerCm;
    const pad = Math.ceil(
      Math.max(CAST_PAD_MIN_CM * this.pixelsPerCm, Math.max(w, h) * CAST_PAD_RATIO, spillPx),
    );
    this.castRect = { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
    // mask 分辨率由「每厘米几个 texel」定，不是由源图像素定。
    this.maskScale = Math.max(
      MASK_SCALE_MIN,
      Math.min(MASK_SCALE_MAX, MASK_TEXELS_PER_CM / this.pixelsPerCm),
    );
    const tw = Math.max(8, Math.ceil(this.castRect.w * this.maskScale));
    const th = Math.max(8, Math.ceil(this.castRect.h * this.maskScale));
    if (this.rtBody && this.rtBody.width === tw && this.rtBody.height === th) {
      return;
    }
    this.destroyTargets();
    this.rtBody = RenderTexture.create({ width: tw, height: th });
    this.rtBodyBlur = RenderTexture.create({ width: tw, height: th });
    this.rtCrit = RenderTexture.create({ width: tw, height: th });
    this.rtCritBlur = RenderTexture.create({ width: tw, height: th });
  }

  /** 厘米 → mask texel（BlurFilter.strength 的单位）。 */
  private cmToMaskTexels(cm: number): number {
    return Math.max(0, cm) * this.pixelsPerCm * this.maskScale;
  }

  private syncBlur(): void {
    // 半径 0 时也给个下限：BlurFilter 双向路径要求两轴 strength 非 0，
    // 且合成里 blur≈raw 会让 shadow 自然归零，不会凭空冒出硬边。
    this.blurBody.strength = Math.max(0.5, this.cmToMaskTexels(this.radiusCmValue));
    this.blurCrit.strength = Math.max(0.5, this.cmToMaskTexels(this.critterRadiusCmValue));
  }

  /**
   * 每帧在场景 render 前调用：把 caster 轮廓烘进半分辨率 RT，并更新
   * 「filter 全局坐标 → mask uv」矩阵。矩阵全部用上一帧的世界矩阵自洽推导，
   * objectRoot 内的相对关系精确，镜头运动最多滞后一帧（幅度可忽略）。
   */
  bake(renderer: PixiRenderer, objectRoot: Container): void {
    if (!this.enabled || !this.rtBody || !this.rtCrit || !this.bodyCaster) return;
    const r = this.castRect;
    const rootWorld = objectRoot.worldTransform;
    this.tmpInvRoot.copyFrom(rootWorld).invert();
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
    // filter padding 是屏幕像素，模糊外溢是设计像素——差一个 objectRoot 世界缩放。
    // 探近（distanceIndex 拉大）时缩放会 >1，不跟着放大就会把影子外圈裁掉。
    this.syncPadding(Math.hypot(rootWorld.a, rootWorld.b) || 1);
    // caster 烘焙变换：texel = S(maskScale) · T(-x,-y) · casterLocal(相对 objectRoot)
    this.tmpScale.set(this.maskScale, 0, 0, this.maskScale, 0, 0);
    try {
      // 必须 bind(target, clear) 而不是 renderer.clear({target})：WebGL 的
      // GlRenderTargetAdaptor.clear 忽略 target 参数，只对「当前已绑定的 FBO」
      // 发 gl.clear。用 renderer.clear({target: rtCrit}) 会把上一步刚烘好的
      // rtBody 抹成全 0（物件 AO 整条通道失效），而 rtCrit 自己从不被清空
      // （爬虫轮廓逐帧累积成拖影）。bind 会先绑 FBO+viewport 再清。
      renderer.renderTarget.bind(this.rtBody, true, [0, 0, 0, 0]);
      if (this.bodyCaster.visible) {
        this.casterTransform(this.bodyCaster, objectRoot);
        renderer.render({
          container: this.bodyCaster,
          target: this.rtBody,
          clear: false,
          transform: this.tmpCaster,
        });
      }
      renderer.renderTarget.bind(this.rtCrit, true, [0, 0, 0, 0]);
      for (const caster of this.critterCasters) {
        if (!caster.visible) continue;
        this.casterTransform(caster, objectRoot);
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

  /**
   * caster → objectRoot 的相对变换，**只走 localTransform 逐级相乘**。
   *
   * 不能用 `caster.worldTransform`：`renderer.render({ transform })` 会先
   * `enableRenderGroup()` 把 caster 提成 render group，再把它的 worldTransform
   * 写成本次烘焙矩阵且不还原。正常帧序里主渲染会重算回来，但只要出现一帧
   * 「bake 之后没有完整主渲染」（物件不可见、会话被面板挡住等），下一帧就会拿
   * 污染值再乘一遍，逐帧自乘缩小直到 mask 塌成空——AO 会毫无征兆地静默消失。
   * localTransform 由 position/scale/rotation/pivot 推出，不参与渲染簿记，安全。
   */
  private casterTransform(caster: Container, objectRoot: Container): void {
    this.tmpCaster.identity();
    let node: Container | null = caster;
    while (node && node !== objectRoot) {
      node.updateLocalTransform();
      this.tmpCaster.prepend(node.localTransform);
      node = node.parent;
    }
    if (!node) {
      // caster 不在 objectRoot 子树里：退回世界变换，至少不静默画错位置。
      this.tmpCaster.copyFrom(caster.worldTransform).prepend(this.tmpInvRoot);
    }
    this.tmpCaster.prepend(this.tmpTranslate).prepend(this.tmpScale);
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

  /** 物件接触影半径，单位厘米。 */
  setRadiusCm(cm: number): void {
    const next = Math.max(
      0,
      Math.min(OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM, Number.isFinite(cm) ? cm : 0),
    );
    if (next === this.radiusCmValue) return;
    this.radiusCmValue = next;
    // 半径参与 cast 留边，改了要重算 mask 覆盖范围（离散改动，不会每帧触发）。
    this.rebuildTargets();
    this.syncBlur();
  }

  /** 爬虫接触影：strength 无量纲强度、radiusCm 半径（厘米）。 */
  setCritterShadow(strength: number, radiusCm: number): void {
    this.critterStrengthValue = Math.max(0, Math.min(3, strength));
    this.critterRadiusCmValue = Math.max(
      0,
      Math.min(
        OBJECT_EXAMINE_MAX_CRITTER_AO_RADIUS_CM,
        Number.isFinite(radiusCm) ? radiusCm : 0,
      ),
    );
    this.compositePass.uniforms.uniforms.uCritStrength =
      this.critterStrengthValue * CRITTER_OPACITY;
    this.syncBlur();
    this.syncEnabled();
  }

  private syncEnabled(): void {
    this.enabled =
      !this.failed && (this.strengthValue > 0.001 || this.critterStrengthValue > 0.001);
  }

  /** @param worldScale objectRoot 的世界缩放（设计像素 → 屏幕像素）。 */
  private syncPadding(worldScale: number): void {
    const spillTexels = Math.max(this.blurBody.strength, this.blurCrit.strength);
    const spillDesignPx = (spillTexels / this.maskScale) * BLUR_SPILL_SIGMAS;
    this.padding = Math.ceil(spillDesignPx * worldScale + 4);
  }

  get strength(): number { return this.strengthValue; }
  get radiusCm(): number { return this.radiusCmValue; }

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
