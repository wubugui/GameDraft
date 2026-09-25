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
  | { readonly t: 'popMaskEnd'; inverse: boolean };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function runOnRender(c: Container, renderer: unknown): void {
  const fn = c.onRender;
  if (fn) fn.call(c, renderer);
  const children = c.children;
  for (let i = 0; i < children.length; i++) runOnRender(children[i], renderer);
}

/** 算本次渲染的相对根变换与外观。返回本次的 tick(遮罩等据此判断节点是否在本次算过) */
export function prepareTree(root: Container, renderer: unknown, tick: number): void {
  runOnRender(root, renderer);
  root.updateLocalTransform();
  root.groupTransform.identity();
  root.groupColor = 0xffffff;
  root.groupAlpha = 1;
  root.groupColorAlpha = 0xffffffff;
  root.groupBlendMode = root.localBlendMode === 'inherit' ? 'normal' : root.localBlendMode;
  root.globalDisplayStatus = root.localDisplayStatus;
  root._renderTick = tick;
  const children = root.children;
  for (let i = 0; i < children.length; i++) updateChild(children[i], null, tick);
}

function updateChild(c: Container, parent: Container | null, tick: number): void {
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
  private readonly batches: BatchRecord[] = [];
  private readonly maskRanges = new Map<MaskEffect, [number, number]>();
  private root!: Container;
  private tick = 0;

  constructor(
    readonly batcher: Batcher,
    public resolution: number,
  ) {}

  begin(root: Container, tick: number, resolution: number): void {
    this.instructions.length = 0;
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

  pushMask(_container: Container, effect: MaskEffect): void {
    this.flush();
    this.instructions.push({ t: 'pushMaskBegin', inverse: effect.inverse });
    const start = this.instructions.length;
    const mask = effect.mask;
    prepareDetached(mask, this.root, this.tick);
    mask.includeInBuild = true;
    this.collect(mask);
    mask.includeInBuild = false;
    this.flush();
    const end = this.instructions.length;
    this.instructions.push({ t: 'pushMaskEnd', inverse: effect.inverse });
    this.maskRanges.set(effect, [start, end]);
  }

  popMask(_container: Container, effect: MaskEffect): void {
    this.flush();
    this.instructions.push({ t: 'popMaskBegin', inverse: effect.inverse });
    const range = this.maskRanges.get(effect);
    if (range) for (let i = range[0]; i < range[1]; i++) this.instructions.push(this.instructions[i]);
    this.instructions.push({ t: 'popMaskEnd', inverse: effect.inverse });
  }

  private flush(): void {
    this.batches.length = 0;
    this.batcher.break(this.batches);
    for (const b of this.batches) this.instructions.push(b);
  }
}

export type { BlendMode };
