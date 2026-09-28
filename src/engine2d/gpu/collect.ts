/**
 * 每次 render 的前两步:
 * 1. prepareTree:跑 onRender 回调,再从根往下算本次的相对变换 / 颜色 / 透明度 / 混合 / 可见性
 *    (照 Pixi 的 updateRenderGroupTransforms:根自己的变换与颜色走全局 uniform,子节点按相对根的量算);
 * 2. Collector:深度优先收集可画内容,产出指令表(合批记录、自定义绘制、滤镜 / 遮罩进出)。
 */
import { Matrix } from '../math/Matrix';
import { bgr2rgb, multiplyColors, type AlphaMask, type ColorMask, type Container, type FilterEffect, type MaskEffect, type StencilMask } from '../scene/Container';
import type { BatchableElement, CustomDrawable, RenderCollector, UnbatchedGraphics } from '../core/contracts';
import type { BlendMode } from '../core/blendModes';
import { Batcher, type BatchRecord } from './Batcher';

export type Instruction =
  | BatchRecord
  | { readonly t: 'custom'; drawable: CustomDrawable }
  | { readonly t: 'unbatched'; item: UnbatchedGraphics; batches: BatchRecord[] }
  | { readonly t: 'pushFilter'; container: Container; effect: FilterEffect }
  | { readonly t: 'popFilter' }
  | { readonly t: 'pushMaskBegin'; inverse: boolean }
  | { readonly t: 'pushMaskEnd'; inverse: boolean }
  | { readonly t: 'popMaskBegin'; inverse: boolean }
  // 照 Pixi StencilMaskPipe.pop:popMaskEnd 不带 inverse,执行时总恢复 MASK_ACTIVE
  | { readonly t: 'popMaskEnd' }
  // 照 Pixi AlphaMaskPipe:遮罩(按需先画进临时纹理)→ 以 MaskFilter 滤镜包住被遮罩内容
  | { readonly t: 'pushAlphaMaskBegin'; mask: AlphaMask; container: Container; inverse: boolean }
  | { readonly t: 'pushAlphaMaskEnd'; mask: AlphaMask; container: Container; inverse: boolean }
  | { readonly t: 'popAlphaMaskEnd'; mask: AlphaMask }
  // 照 Pixi ColorMaskPipe:颜色写掩码变了才发一条
  | { readonly t: 'colorMask'; colorMask: number };

/**
 * 最近一次 prepareTree 的渲染器级 roundPixels(0 / 1)。WebGPURenderer 每次 render 都是 prepareTree 紧接 collector.begin,
 * begin 不另给时取它(嵌套 render 发生在 prepareTree 的 onRender 回调里,早于这里赋值,不会串)
 */
let preparedRoundPixels = 0;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function runOnRender(c: Container, renderer: unknown): void {
  if (!c._activeSelf) return; // 未激活的子树不回调(照 Unity)
  const fn = c.onRender;
  if (fn) fn.call(c, renderer);
  const children = c.children;
  for (let i = 0; i < children.length; i++) runOnRender(children[i], renderer);
}

function validateRenderGroups(c: Container, rendererKey: object | undefined): void {
  c._validateRenderGroup(rendererKey);
  for (const child of c.children) validateRenderGroups(child, rendererKey);
}

/** 算本次渲染的相对根变换与外观。返回本次的 tick(遮罩等据此判断节点是否在本次算过) */
export function prepareTree(root: Container, renderer: unknown, tick: number, transform?: Matrix): void {
  // 照 AbstractRenderer:单独 render 过的子树永久成为一个组,之后整树渲染仍保留这个边界。
  root.enableRenderGroup();
  runOnRender(root, renderer);
  const rendererKey = renderer !== null && typeof renderer === 'object' ? renderer : undefined;
  validateRenderGroups(root, rendererKey);
  preparedRoundPixels = (renderer as { roundPixels?: boolean } | null)?.roundPixels ? 1 : 0;
  root.updateLocalTransform();
  // 与本次 global uniforms 使用同一矩阵;显式离屏 transform 也必须进入 Culler 历史。
  root._renderedGroupWorldTransform!.copyFrom(transform ?? root.localTransform);
  root.groupTransform.identity();
  root.groupColor = 0xffffff;
  root.groupAlpha = 1;
  root.groupColorAlpha = 0xffffffff;
  // 照 Pixi:渲染根不经过 updateColorBlendVisibility,根自己的可画内容按 'normal' 混合、白色顶点色(根的 tint / alpha
  // 只经全局 uniform 的 worldColor 施加一次)。Pixi 里根若曾作为别的树的子节点被算过,会沿用那次留下的 groupBlendMode /
  // groupColorAlpha(与历史有关的旧缓存,颜色还会与 worldColor 叠乘两次);这个怪癖不复刻,一律取无历史时的确定值
  root.groupBlendMode = 'normal';
  root.globalDisplayStatus = root.localDisplayStatus;
  root._renderTick = tick;
  root._prepareRenderGroup(rendererKey, root.globalDisplayStatus === 7);
  const children = root.children;
  for (let i = 0; i < children.length; i++) updateChild(children[i], null, tick, root, rendererKey);
}

/** 与绘制相对根矩阵分开保存历史,嵌套组重新开始算组内矩阵。prepareDetached 不调用它。 */
function updateRenderedTransform(c: Container, parent: Container | null, group: Container): Container {
  const relative = c._renderedRelativeTransform ??= new Matrix();
  if (parent && parent !== group) relative.appendFrom(c.localTransform, parent._renderedRelativeTransform!);
  else relative.copyFrom(c.localTransform);
  if (c._renderedGroupWorldTransform) {
    c._renderedGroupWorldTransform.appendFrom(relative, group._renderedGroupWorldTransform!);
    return c;
  }
  return group;
}

function updateChild(c: Container, parent: Container | null, tick: number, historyGroup?: Container, rendererKey?: object): void {
  if (!c._activeSelf) {
    // 未激活:整棵子树不画(收集器见 globalDisplayStatus < 7 即跳过,不会再往下看),外观不算。
    // 变换照算:master 用 visible=false 藏 NPC / 热点,Pixi 渲染时照样更新隐藏节点的变换,Culler 缺省读的
    // "上次渲染时的变换"对它们也是最新的;这里不算的话,藏着时挪过、这一帧才露面的节点会按旧位置判剔除
    c.globalDisplayStatus = 0;
    c._renderTick = tick;
    updateTransformsOnly(c, parent, historyGroup, rendererKey);
    return;
  }
  c.updateLocalTransform();
  const childHistoryGroup = historyGroup && updateRenderedTransform(c, parent, historyGroup);
  if (!parent) {
    // 根的直接子节点:父按"白色、不透明、normal、全可见"算(Pixi 用 tempContainer)
    c.groupTransform.copyFrom(c.localTransform);
    c.groupColor = c.localColor;
    c.groupAlpha = clamp01(c.localAlpha);
    c.groupBlendMode = c.localBlendMode === 'inherit' ? 'normal' : c.localBlendMode;
    c.globalDisplayStatus = c.localDisplayStatus;
  } else {
    c.groupTransform.appendFrom(c.localTransform, parent.groupTransform);
    c.groupColor = multiplyColors(c.localColor, parent.groupColor);
    c.groupAlpha = clamp01(c.localAlpha * parent.groupAlpha);
    c.groupBlendMode = c.localBlendMode === 'inherit' ? parent.groupBlendMode : c.localBlendMode;
    c.globalDisplayStatus = c.localDisplayStatus & parent.globalDisplayStatus;
  }
  c.groupColorAlpha = c.groupColor + (((c.groupAlpha * 255) | 0) << 24);
  c._renderTick = tick;
  if (historyGroup && c.isRenderGroup) c._prepareRenderGroup(rendererKey, c.globalDisplayStatus === 7);
  const children = c.children;
  for (let i = 0; i < children.length; i++) updateChild(children[i], c, tick, childHistoryGroup, rendererKey);
}

/** 未激活子树:只算相对根的变换(同 Pixi updateTransformAndChildren 的变换那一半;外观、tick 不动) */
function updateTransformsOnly(c: Container, parent: Container | null, historyGroup?: Container, rendererKey?: object): void {
  c.updateLocalTransform();
  const childHistoryGroup = historyGroup && updateRenderedTransform(c, parent, historyGroup);
  if (parent) c.groupTransform.appendFrom(c.localTransform, parent.groupTransform);
  else c.groupTransform.copyFrom(c.localTransform);
  if (historyGroup && c.isRenderGroup) c._prepareRenderGroup(rendererKey, false);
  const children = c.children;
  for (let i = 0; i < children.length; i++) updateTransformsOnly(children[i], c, childHistoryGroup, rendererKey);
}

/**
 * 不在本次渲染子树里的节点(例如遮罩体是被遮罩容器的兄弟、而渲染的是子树):沿父链算它相对根的变换与外观。
 * 根不是它的祖先时,用"世界变换 ← 根世界变换的逆"近似(Pixi 此时用的是上次渲染留下的旧值)。
 */
export function prepareDetached(node: Container, root: Container, tick: number): void {
  if (node._renderTick === tick) return;
  const chain: Container[] = [];
  let p: Container | null = node;
  while (p && p !== root) {
    chain.push(p);
    p = p.parent;
  }
  if (p === root) {
    chain.reverse();
    let parent: Container | null = null;
    for (const c of chain) {
      if (c._renderTick !== tick) updateSingle(c, parent);
      parent = c;
    }
  } else {
    const rel = new Matrix();
    const rootWorld = root.worldTransform.clone().invert();
    rel.appendFrom(node.worldTransform, rootWorld);
    node.updateLocalTransform();
    node.groupTransform.copyFrom(rel);
    node.groupColor = bgr2rgb(node.getGlobalTint());
    node.groupAlpha = clamp01(node.getGlobalAlpha());
    node.groupBlendMode = node.localBlendMode === 'inherit' ? 'normal' : node.localBlendMode;
    node.globalDisplayStatus = node.localDisplayStatus;
    node.groupColorAlpha = node.groupColor + (((node.groupAlpha * 255) | 0) << 24);
  }
  node._renderTick = tick;
  const children = node.children;
  for (let i = 0; i < children.length; i++) updateChild(children[i], node, tick);
}

function updateSingle(c: Container, parent: Container | null): void {
  c.updateLocalTransform();
  if (!parent) {
    c.groupTransform.copyFrom(c.localTransform);
    c.groupColor = c.localColor;
    c.groupAlpha = clamp01(c.localAlpha);
    c.groupBlendMode = c.localBlendMode === 'inherit' ? 'normal' : c.localBlendMode;
    c.globalDisplayStatus = c.localDisplayStatus;
  } else {
    c.groupTransform.appendFrom(c.localTransform, parent.groupTransform);
    c.groupColor = multiplyColors(c.localColor, parent.groupColor);
    c.groupAlpha = clamp01(c.localAlpha * parent.groupAlpha);
    c.groupBlendMode = c.localBlendMode === 'inherit' ? parent.groupBlendMode : c.localBlendMode;
    c.globalDisplayStatus = c.localDisplayStatus & parent.globalDisplayStatus;
  }
  c.groupColorAlpha = c.groupColor + (((c.groupAlpha * 255) | 0) << 24);
}

export class Collector implements RenderCollector {
  readonly instructions: Instruction[] = [];
  /** 渲染器级 roundPixels(见 RenderCollector.roundPixels) */
  roundPixels = 0;
  private readonly batches: BatchRecord[] = [];
  private readonly maskRanges = new Map<StencilMask, [number, number]>();
  // 颜色遮罩栈(照 Pixi ColorMaskPipe:buildStart 置 [15])
  private readonly colorStack: number[] = [15];
  private colorStackIndex = 1;
  private currentColor = 15;
  private root!: Container;
  private tick = 0;

  constructor(
    readonly batcher: Batcher,
    public resolution: number,
    readonly rendererKey: object = batcher,
  ) {}

  begin(root: Container, tick: number, resolution: number, roundPixels: number = preparedRoundPixels): void {
    this.instructions.length = 0;
    this.roundPixels = roundPixels;
    this.maskRanges.clear();
    this.colorStack[0] = 15;
    this.colorStackIndex = 1;
    this.currentColor = 15;
    this.batcher.begin();
    this.root = root;
    this.tick = tick;
    this.resolution = resolution;
  }

  /** 根:不查根自己的可见性标志(与 Pixi 的 collectRenderablesWithEffects 相同) */
  collectRoot(root: Container): void {
    if (root.sortableChildren) root.sortChildren();
    this.collectWithEffects(root);
    this.flush();
  }

  collect(c: Container): void {
    if (c.globalDisplayStatus < 7 || !c.includeInBuild) return;
    if (c.sortableChildren) c.sortChildren();
    // 与 Pixi RenderGroupPipe 一样在组边界断批;仍画相对本次根的矩阵,不另建组指令。
    if (c.isRenderGroup) this.flush();
    this.collectWithEffects(c);
    if (c.isRenderGroup) this.flush();
  }

  private collectWithEffects(c: Container): void {
    const effects = c.effects;
    for (let i = 0; i < effects.length; i++) {
      const e = effects[i];
      if (e.kind === 'mask') this.pushMask(c, e as MaskEffect);
      else this.pushFilter(c, e as FilterEffect);
    }
    c.collectRenderables(this);
    const children = c.children;
    for (let i = 0; i < children.length; i++) this.collect(children[i]);
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      if (e.kind === 'mask') this.popMask(c, e as MaskEffect);
      else this.popFilter();
    }
  }

  addBatchable(element: BatchableElement): void {
    this.batcher.add(element);
  }

  addCustom(drawable: CustomDrawable): void {
    this.flush();
    this.instructions.push({ t: 'custom', drawable });
  }

  addUnbatched(item: UnbatchedGraphics, elements: readonly BatchableElement[]): void {
    this.flush();
    for (const el of elements) this.batcher.add(el);
    const batches: BatchRecord[] = [];
    this.batcher.break(batches);
    if (batches.length) this.instructions.push({ t: 'unbatched', item, batches });
  }

  pushFilter(container: Container, effect: FilterEffect): void {
    this.flush();
    this.instructions.push({ t: 'pushFilter', container, effect });
  }

  popFilter(): void {
    this.flush();
    this.instructions.push({ t: 'popFilter' });
  }

  pushMask(container: Container, effect: MaskEffect): void {
    if (effect.pipe === 'alphaMask') this.pushAlphaMask(container, effect);
    else if (effect.pipe === 'colorMask') this.pushColorMask(effect);
    else this.pushStencilMask(container, effect);
  }

  popMask(container: Container, effect: MaskEffect): void {
    if (effect.pipe === 'alphaMask') this.popAlphaMask(effect);
    else if (effect.pipe === 'colorMask') this.popColorMask();
    else this.popStencilMask(container, effect);
  }

  /** 照 Pixi AlphaMaskPipe.push */
  private pushAlphaMask(container: Container, mask: AlphaMask): void {
    this.flush();
    const inverse = !!container._maskOptions.inverse;
    this.instructions.push({ t: 'pushAlphaMaskBegin', mask, container, inverse });
    mask.inverse = inverse;
    const maskContainer = mask.mask;
    // 遮罩体要本次渲染的变换:画进临时纹理的要画它,Sprite 遮罩要拿它的变换算 MaskFilter 的映射
    prepareDetached(maskContainer, this.root, this.tick);
    if (mask.renderMaskToTexture) {
      maskContainer.includeInBuild = true;
      this.collect(maskContainer);
      maskContainer.includeInBuild = false;
    }
    this.flush();
    this.instructions.push({ t: 'pushAlphaMaskEnd', mask, container, inverse });
  }

  /** 照 Pixi AlphaMaskPipe.pop */
  private popAlphaMask(mask: AlphaMask): void {
    this.flush();
    this.instructions.push({ t: 'popAlphaMaskEnd', mask });
  }

  /** 照 Pixi ColorMaskPipe.push:与外层按位与,变了才发指令 */
  private pushColorMask(mask: ColorMask): void {
    this.flush();
    const colorStack = this.colorStack;
    colorStack[this.colorStackIndex] = colorStack[this.colorStackIndex - 1] & mask.mask;
    const currentColor = colorStack[this.colorStackIndex];
    if (currentColor !== this.currentColor) {
      this.currentColor = currentColor;
      this.instructions.push({ t: 'colorMask', colorMask: currentColor });
    }
    this.colorStackIndex++;
  }

  /** 照 Pixi ColorMaskPipe.pop */
  private popColorMask(): void {
    this.flush();
    this.colorStackIndex--;
    const currentColor = this.colorStack[this.colorStackIndex - 1];
    if (currentColor !== this.currentColor) {
      this.currentColor = currentColor;
      this.instructions.push({ t: 'colorMask', colorMask: currentColor });
    }
  }

  private pushStencilMask(container: Container, effect: StencilMask): void {
    this.flush();
    const inverse = !!container._maskOptions.inverse;
    this.instructions.push({ t: 'pushMaskBegin', inverse });
    const start = this.instructions.length;
    const mask = effect.mask;
    prepareDetached(mask, this.root, this.tick);
    mask.includeInBuild = true;
    this.collect(mask);
    mask.includeInBuild = false;
    this.flush();
    const end = this.instructions.length;
    this.instructions.push({ t: 'pushMaskEnd', inverse });
    this.maskRanges.set(effect, [start, end]);
  }

  private popStencilMask(container: Container, effect: StencilMask): void {
    this.flush();
    this.instructions.push({ t: 'popMaskBegin', inverse: !!container._maskOptions.inverse });
    const range = this.maskRanges.get(effect);
    if (range) for (let i = range[0]; i < range[1]; i++) this.instructions.push(this.instructions[i]);
    this.instructions.push({ t: 'popMaskEnd' });
  }

  private flush(): void {
    this.batches.length = 0;
    this.batcher.break(this.batches);
    for (const b of this.batches) this.instructions.push(b);
  }
}

export type { BlendMode };
