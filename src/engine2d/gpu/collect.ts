/**
 * 每次 render 的前两步:
 * 1. prepareTree:跑 onRender 回调,再从根往下算本次的相对变换 / 颜色 / 透明度 / 混合 / 可见性
 *    (照 Pixi 的 updateRenderGroupTransforms:根自己的变换与颜色走全局 uniform,子节点按相对根的量算);
 * 2. Collector:深度优先收集可画内容,产出指令表(合批记录、自定义绘制、滤镜 / 遮罩进出)。
 */
import { Matrix } from '../math/Matrix';
import { bgr2rgb, multiplyColors, type Container, type FilterEffect, type MaskEffect } from '../scene/Container';
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
  | { readonly t: 'popMaskEnd' };

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

/** 算本次渲染的相对根变换与外观。返回本次的 tick(遮罩等据此判断节点是否在本次算过) */
export function prepareTree(root: Container, renderer: unknown, tick: number): void {
  runOnRender(root, renderer);
  preparedRoundPixels = (renderer as { roundPixels?: boolean } | null)?.roundPixels ? 1 : 0;
  root.updateLocalTransform();
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
  const children = root.children;
  for (let i = 0; i < children.length; i++) updateChild(children[i], null, tick);
}

function updateChild(c: Container, parent: Container | null, tick: number): void {
  if (!c._activeSelf) {
    // 未激活:整棵子树不算、不画(收集器见 globalDisplayStatus < 7 即跳过,不会再往下看)
    c.globalDisplayStatus = 0;
    c._renderTick = tick;
    return;
  }
  c.updateLocalTransform();
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
  const children = c.children;
  for (let i = 0; i < children.length; i++) updateChild(children[i], c, tick);
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
  private readonly maskRanges = new Map<MaskEffect, [number, number]>();
  private root!: Container;
  private tick = 0;

  constructor(
    readonly batcher: Batcher,
    public resolution: number,
  ) {}

  begin(root: Container, tick: number, resolution: number, roundPixels: number = preparedRoundPixels): void {
    this.instructions.length = 0;
    this.roundPixels = roundPixels;
    this.maskRanges.clear();
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
    this.collectWithEffects(c);
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

  popMask(container: Container, effect: MaskEffect): void {
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
