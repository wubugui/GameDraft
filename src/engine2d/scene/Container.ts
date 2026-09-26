/**
 * 场景树节点(照 PixiJS v8.17 `Container` 的对外语义;实现参照 PixiJS,MIT)。
 *
 * 与 Pixi 的差别只在内部:没有 RenderGroup 的增量簿记。渲染核心每次 `render()` 从根往下走一遍,
 * 当场算出本次的世界变换 / 颜色 / 混合 / 可见性(写进 `groupTransform` 等字段),再把可画的东西交给收集器。
 * `worldTransform` / `toGlobal()` 任何时候读都与当前父链一致(按版本号缓存:本地或任一祖先变了才重算;
 * Pixi 的 worldTransform 要等下一次渲染才更新,这里不滞后)。
 *
 * **层级(照 Unity)**:每个节点同时是 GameObject 与 Transform——
 * - 激活:`setActive` / `activeSelf` / `activeInHierarchy`。未激活的子树不渲染、不参与命中、不计包围盒、
 *   上面的组件不跑;`visible` 仍是 Pixi 语义(只管画不画,相当于 Unity 的 Renderer.enabled)。
 * - 场景根:`isSceneRoot` 的节点是一个"场景"(Application 的 stage 就是);只有挂在场景根下的节点
 *   `activeInHierarchy` 才可能为真、组件才活着——摘下来(removeChild 而不 destroy)组件就停(onDisable),挂回去再 onEnable。
 * - 组件:`addComponent` / `getComponent` / `removeComponent`,生命期见 Component.ts;子树里没有组件时
 *   增删子节点、setActive 都是 O(1),不会给普通的 Pixi 式用法加开销。
 * - 变换:`localPosition` / `worldPosition` / `worldRotation` / `lossyScale` / `setParent(p, worldPositionStays)` /
 *   `siblingIndex` / `find` / `transformPoint` 等,名字照 Unity(角度用弧度,与 Pixi 的 rotation 一致)。
 */
import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import { Color, type ColorSource } from '../color/Color';
import { Matrix } from '../math/Matrix';
import { ObservablePoint } from '../math/ObservablePoint';
import { Point, type PointData } from '../math/Point';
import type { Rectangle } from '../math/Rectangle';
import { Bounds } from './Bounds';
import type { BlendMode } from '../core/blendModes';
import type { RenderCollector } from '../core/contracts';
import type { Filter } from '../filters/Filter';
import { callHook, syncComponentLiveness, type Component, type ComponentType } from './Component';
import { PlayerLoop } from './PlayerLoop';

/** 缺省遮罩选项:全体容器共享一份冻结对象(照 Pixi effectsMixin 挂在原型上),setMask 总是换新对象、从不就地改 */
const DEFAULT_MASK_OPTIONS: Readonly<{ inverse?: boolean; mask?: MaskInput | null }> = Object.freeze({ inverse: false });

export const RAD_TO_DEG = 180 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180;

/** 事件模式(照 Pixi 的 EventMode) */
export type EventMode = 'none' | 'passive' | 'auto' | 'static' | 'dynamic';
export type Cursor = string;

/** 命中区域:任何有 contains(x, y) 的形状 */
export interface IHitArea {
  contains(x: number, y: number): boolean;
}

export interface DestroyOptions {
  children?: boolean;
  texture?: boolean;
  textureSource?: boolean;
  context?: boolean;
  style?: boolean;
}

export interface ContainerOptions {
  label?: string;
  children?: Container[];
  parent?: Container;
  x?: number;
  y?: number;
  position?: PointData;
  scale?: PointData | number;
  pivot?: PointData | number;
  skew?: PointData;
  rotation?: number;
  angle?: number;
  alpha?: number;
  tint?: ColorSource;
  blendMode?: BlendMode;
  visible?: boolean;
  renderable?: boolean;
  zIndex?: number;
  sortableChildren?: boolean;
  eventMode?: EventMode;
  cursor?: Cursor;
  hitArea?: IHitArea | null;
  interactiveChildren?: boolean;
  cullable?: boolean;
  cullArea?: Rectangle | null;
  filters?: Filter | Filter[] | null;
  mask?: MaskInput | null;
  boundsArea?: Rectangle;
  isRenderGroup?: boolean;
  [key: string]: unknown;
}

/** 容器上的效果(遮罩 / 滤镜),按 priority 从外到内 */
export interface ContainerEffect {
  readonly kind: 'mask' | 'filters';
  priority: number;
  addBounds?(bounds: Bounds): void;
  addLocalBounds?(bounds: Bounds, localRoot: Container): void;
  containsPoint?(point: PointData, hitTestFn: (container: Container, point: Point) => boolean): boolean;
}

/**
 * 模板遮罩(照 Pixi `StencilMask`):任何不是 Sprite 的 Container(Graphics / Mesh / 普通容器)。
 * 遮罩体不进正常收集(includeInBuild = false)、不计父节点包围盒,由遮罩管线画进模板缓冲。
 */
export class StencilMask implements ContainerEffect {
  readonly kind = 'mask' as const;
  readonly pipe = 'stencilMask' as const;
  priority = 0;

  constructor(public mask: Container) {
    mask.includeInBuild = false;
    mask.measurable = false;
  }

  reset(): void {
    this.mask.measurable = true;
    this.mask.includeInBuild = true;
  }

  addBounds(bounds: Bounds): void {
    addMaskBounds(this.mask, bounds);
  }

  addLocalBounds(bounds: Bounds, localRoot: Container): void {
    addMaskLocalBounds(this.mask, bounds, localRoot);
  }

  containsPoint(point: PointData, hitTestFn: (container: Container, point: Point) => boolean): boolean {
    return hitTestFn(this.mask, point as Point);
  }

  static test(mask: unknown): boolean {
    return mask instanceof Container;
  }
}

/**
 * Alpha 遮罩(照 Pixi `AlphaMask`):Sprite 当遮罩时选它——按遮罩纹理的 alpha(× r 通道)逐像素乘到被遮罩内容上,
 * 经滤镜管线(MaskFilter)实现,见 FrameBuilder 的 alphaMask 段。
 * - Sprite 遮罩:精灵本身不画(renderable = false),但仍 includeInBuild(Pixi 原样;它的变换照常更新);
 * - 其它容器(只有手动 `new AlphaMask({ mask })` 再赋给 mask 才会走到):先把遮罩体画进一张临时纹理再当遮罩用。
 * `inverse` 在收集时从被遮罩容器的 `_maskOptions.inverse` 同步过来;反向时不收窄包围盒(addLocalBounds 照 Pixi 仍收窄)。
 */
export class AlphaMask implements ContainerEffect {
  readonly kind = 'mask' as const;
  readonly pipe = 'alphaMask' as const;
  priority = 0;
  inverse = false;
  mask!: Container;
  renderMaskToTexture = false;

  constructor(options?: { mask?: Container }) {
    if (options?.mask) this.init(options.mask);
  }

  init(mask: Container): void {
    this.mask = mask;
    this.renderMaskToTexture = !AlphaMask.test(mask);
    // 照 Pixi:这两项换 / 清遮罩时不还原(reset 只还原 measurable)
    this.mask.renderable = this.renderMaskToTexture;
    this.mask.includeInBuild = !this.renderMaskToTexture;
    this.mask.measurable = false;
  }

  reset(): void {
    if (!this.mask) return;
    this.mask.measurable = true;
  }

  addBounds(bounds: Bounds): void {
    if (!this.inverse) addMaskBounds(this.mask, bounds);
  }

  addLocalBounds(bounds: Bounds, localRoot: Container): void {
    addMaskLocalBounds(this.mask, bounds, localRoot);
  }

  containsPoint(point: PointData, hitTestFn: (container: Container, point: Point) => boolean): boolean {
    return hitTestFn(this.mask, point as Point);
  }

  /** 照 Pixi `mask instanceof Sprite`(Sprite 类在 sprite 模块加载时登记进来,避免 Container ↔ Sprite 循环依赖) */
  static test(mask: unknown): boolean {
    return spriteClass !== null && mask instanceof spriteClass;
  }
}

/**
 * 颜色遮罩(照 Pixi `ColorMask`):数字当遮罩 = 颜色写掩码,与外层的逐层按位与(Pixi WebGL 位序:8 = R、4 = G、2 = B、1 = A)。
 * 不影响包围盒与命中。
 */
export class ColorMask implements ContainerEffect {
  readonly kind = 'mask' as const;
  readonly pipe = 'colorMask' as const;
  priority = 0;

  constructor(public mask: number) {}

  static test(mask: unknown): boolean {
    return typeof mask === 'number';
  }
}

/** 容器上的遮罩效果 */
export type MaskEffect = StencilMask | AlphaMask | ColorMask;
/** 可以赋给 `container.mask` 的东西(照 Pixi `Mask`):容器、数字,或直接给一个遮罩效果 */
export type MaskInput = Container | number | MaskEffect;

let spriteClass: (abstract new (...args: never[]) => Container) | null = null;

/** @internal Sprite 模块加载时调用:登记 Sprite 类给 AlphaMask.test 用 */
export function _registerSpriteClassForMasks(cls: abstract new (...args: never[]) => Container): void {
  spriteClass = cls;
}

/**
 * 照 Pixi `MaskEffectManager.getMaskEffect`:按 AlphaMask → ColorMask → StencilMask 的顺序(rendering/init 的注册序)
 * 找第一个 test 通过的类;都不通过就把传入值本身当效果(直接给了一个遮罩效果)。
 */
function getMaskEffect(item: MaskInput): MaskEffect {
  if (AlphaMask.test(item)) return new AlphaMask({ mask: item as Container });
  if (ColorMask.test(item)) return new ColorMask(item as number);
  if (StencilMask.test(item)) return new StencilMask(item as Container);
  return item as MaskEffect;
}

function addMaskBounds(mask: Container, bounds: Bounds): void {
  const m = new Bounds();
  mask.measurable = true;
  getGlobalBounds(mask, false, m);
  mask.measurable = false;
  bounds.addBoundsMask(m);
}

function addMaskLocalBounds(mask: Container, bounds: Bounds, localRoot: Container): void {
  const m = new Bounds();
  mask.measurable = true;
  const rel = matrixRelativeTo(mask, localRoot, new Matrix());
  getLocalBounds(mask, m, rel);
  mask.measurable = false;
  bounds.addBoundsMask(m);
}

export class FilterEffect implements ContainerEffect {
  readonly kind = 'filters' as const;
  /** 照 Pixi FilterEffect(1):遮罩(0)总在滤镜外层,与赋值先后无关 */
  priority = 1;
  filters: readonly Filter[] | null = null;
  filterArea?: Rectangle;
}

let renderTick = 0;
const chainScratch: Container[] = [];
const tempAppend = new Matrix();
const tempMatrix = new Matrix();
const tempPoint = new Point();

function matrixEquals(a: Matrix, b: Matrix): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.tx === b.tx && a.ty === b.ty;
}

/** 子树里的组件(先序:先本节点,再按子节点顺序;没有组件的子树不下探) */
function forEachComponentInSubtree(node: Container, fn: (c: Component) => void): void {
  const own = node.components;
  for (let i = 0; i < own.length; i++) fn(own[i]);
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    if (children[i]._subtreeComponents > 0) forEachComponentInSubtree(children[i], fn);
  }
}

/** 子节点的直接父节点变了:组件计数搬家、组件存活重算、发父节点变化 / 子节点变化通知 */
function hierarchyChanged(child: Container, oldParent: Container | null, newParent: Container | null): void {
  const n = child._subtreeComponents;
  if (n > 0) {
    for (let p = oldParent; p; p = p.parent) p._subtreeComponents -= n;
    for (let p = newParent; p; p = p.parent) p._subtreeComponents += n;
    forEachComponentInSubtree(child, syncComponentLiveness);
    forEachComponentInSubtree(child, (c) => { if (c.gameObject && !c._destroyed) callHook(c, 'onTransformParentChanged'); });
  }
  if (oldParent) notifyChildrenChanged(oldParent);
  if (newParent) notifyChildrenChanged(newParent);
}

function notifyChildrenChanged(parent: Container): void {
  const own = parent.components;
  for (let i = 0; i < own.length; i++) callHook(own[i], 'onTransformChildrenChanged');
}

const NO_COMPONENTS: readonly Component[] = Object.freeze([]) as readonly Component[];

export class Container extends EventEmitter {
  readonly uid = uid('renderable');
  label: string | null = null;
  readonly children: Container[] = [];
  parent: Container | null = null;
  destroyed = false;

  /** 本节点(不含子节点)能画的东西的本地包围盒;纯容器没有 */
  renderPipeId?: string;
  /** 为 false 时不进渲染收集(做遮罩的对象会被置 false) */
  includeInBuild = true;
  /** 为 false 时不计入父节点的包围盒 */
  measurable = true;
  allowChildren = true;

  // 变换
  readonly localTransform = new Matrix();
  private readonly _position = new ObservablePoint(this, 0, 0);
  private _scale: ObservablePoint | null = null;
  private _pivot: ObservablePoint | null = null;
  private _origin: ObservablePoint | null = null;
  private _skew: ObservablePoint | null = null;
  private _rotation = 0;
  private _cx = 1;
  private _sx = 0;
  private _cy = 0;
  private _sy = 1;
  /** 变换改动计数(本地变换按它懒更新) */
  _didContainerChangeTick = 0;
  /** 内容 / 结构改动计数(本地包围盒缓存按它失效) */
  _didViewChangeTick = 0;
  private _didLocalTransformChangeId = -1;
  private _worldTransform: Matrix | null = null;

  // 外观
  localColor = 0xffffff; // BGR
  localAlpha = 1;
  localBlendMode: BlendMode = 'inherit';
  /** bit0 renderable, bit1 visible, bit2 未被剔除 */
  localDisplayStatus = 7;

  // 渲染核心每次 render 时写入(本次渲染的世界量)
  groupTransform = new Matrix();
  groupColor = 0xffffff;
  groupAlpha = 1;
  groupColorAlpha = 0xffffffff;
  groupBlendMode: BlendMode = 'normal';
  globalDisplayStatus = 7;
  /** 最近一次被渲染的 tick(Culler / 纹理回收之类可据此判断) */
  _renderTick = -1;

  // 排序
  private _zIndex = 0;
  sortDirty = false;
  sortableChildren = false;

  // 效果
  effects: ContainerEffect[] = [];
  _maskEffect: MaskEffect | null = null;
  /** 遮罩选项(照 Pixi `_maskOptions`):挂在容器上而不是遮罩效果上,先设 inverse 再给遮罩、换遮罩都保留 */
  _maskOptions: Readonly<{ inverse?: boolean; mask?: MaskInput | null }> = DEFAULT_MASK_OPTIONS;
  _filterEffect: FilterEffect | null = null;
  boundsArea?: Rectangle;

  // 剔除
  cullable = false;
  cullableChildren = true;
  cullArea: Rectangle | null = null;

  // 事件(交互的判定与分发在 events 模块;这里只存属性)
  eventMode: EventMode = 'passive';
  cursor?: Cursor | null;
  hitArea: IHitArea | null = null;
  interactiveChildren = true;

  private _onRender: ((renderer: unknown) => void) | null = null;
  private _localBoundsCache: { tick: string; bounds: Bounds } | null = null;

  // 层级(Unity 语义)
  /** @internal 读用 activeSelf,写用 setActive */
  _activeSelf = true;
  private _isSceneRoot = false;
  private _components: Component[] | null = null;
  /** @internal 本节点及子孙上挂的组件总数(为 0 时层级变化不用下探) */
  _subtreeComponents = 0;
  // 世界矩阵缓存:按(本地变换改动号, 父节点, 父世界版本)判断是否要重算;值真的变了才升版本
  private _worldLocalTick = -1;
  private _worldParent: Container | null = null;
  private _worldParentVersion = -1;
  /** @internal 世界矩阵版本(值变了才加一) */
  _worldVersion = 0;
  private _hasChangedAck = -1;

  constructor(options: ContainerOptions = {}) {
    super();
    const { children, parent, ...rest } = options;
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      (this as unknown as Record<string, unknown>)[k] = v;
    }
    children?.forEach((c) => this.addChild(c));
    parent?.addChild(this);
  }

  // ───────────────────────── 子节点

  addChild<U extends Container[]>(...children: U): U[0] {
    if (children.length > 1) {
      for (const c of children) this.addChild(c);
      return children[0];
    }
    const child = children[0];
    if (child.parent === this) {
      this.children.splice(this.children.indexOf(child), 1);
      this.children.push(child);
      this._didViewChangeTick++;
      notifyChildrenChanged(this);
      return child;
    }
    const oldParent = child.parent;
    oldParent?._removeChildQuiet(child);
    this.children.push(child);
    if (this.sortableChildren) this.sortDirty = true;
    child.parent = this;
    this.emit('childAdded', child, this, this.children.length - 1);
    child.emit('added', this);
    this._didViewChangeTick++;
    if (child._zIndex !== 0) child.depthOfChildModified();
    hierarchyChanged(child, oldParent, this);
    return child;
  }

  removeChild<U extends Container[]>(...children: U): U[0] {
    if (children.length > 1) {
      for (const c of children) this.removeChild(c);
      return children[0];
    }
    const child = children[0];
    if (this._removeChildQuiet(child)) hierarchyChanged(child, this, null);
    return child;
  }

  /** @internal 摘下子节点但不做层级通知(移动到别的父节点时由新父节点统一通知一次) */
  _removeChildQuiet(child: Container): boolean {
    const index = this.children.indexOf(child);
    if (index < 0) return false;
    this._didViewChangeTick++;
    this.children.splice(index, 1);
    child.parent = null;
    this.emit('childRemoved', child, this, index);
    child.emit('removed', this);
    return true;
  }

  addChildAt<U extends Container>(child: U, index: number): U {
    const { children } = this;
    if (index < 0 || index > children.length) {
      throw new Error(`${String(child)}addChildAt: The index ${index} supplied is out of bounds ${children.length}`);
    }
    const sameParent = child.parent === this;
    const oldParent = child.parent;
    if (child.parent) {
      const currentIndex = child.parent.children.indexOf(child);
      if (sameParent) {
        if (currentIndex === index) return child;
        child.parent.children.splice(currentIndex, 1);
      } else child.parent._removeChildQuiet(child);
    }
    if (index === children.length) children.push(child);
    else children.splice(index, 0, child);
    child.parent = this;
    if (this.sortableChildren) this.sortDirty = true;
    this._didViewChangeTick++;
    if (sameParent) {
      notifyChildrenChanged(this);
      return child;
    }
    this.emit('childAdded', child, this, index);
    child.emit('added', this);
    hierarchyChanged(child, oldParent, this);
    return child;
  }

  removeChildren(beginIndex = 0, endIndex?: number): Container[] {
    const end = endIndex ?? this.children.length;
    const range = end - beginIndex;
    const removed: Container[] = [];
    if (range > 0 && range <= end) {
      for (let i = end - 1; i >= beginIndex; i--) {
        const child = this.children[i];
        if (!child) continue;
        removed.push(child);
        child.parent = null;
      }
      // 照 Pixi 8.17 的 removeItems(children, begin, end):第三参是「个数」,摘掉 end 个(splice 自会夹到数组尾)。
      // begin > 0 时比 [begin, end) 多摘,多出的几个离开 children 但 parent 仍是本容器、不发事件——与 Pixi 逐位一致,不修。
      this.children.splice(beginIndex, end);
      for (let i = 0; i < removed.length; ++i) {
        this.emit('childRemoved', removed[i], this, i);
        removed[i].emit('removed', this);
      }
      if (removed.length > 0) this._didViewChangeTick++;
      for (const r of removed) hierarchyChanged(r, this, null);
      return removed;
    } else if (range === 0 && this.children.length === 0) {
      return removed;
    }
    throw new RangeError('removeChildren: numeric values are outside the acceptable range.');
  }

  removeChildAt<U extends Container>(index: number): U {
    return this.removeChild(this.getChildAt(index)) as U;
  }

  getChildAt<U extends Container>(index: number): U {
    if (index < 0 || index >= this.children.length) throw new Error(`getChildAt: Index (${index}) does not exist.`);
    return this.children[index] as U;
  }

  setChildIndex(child: Container, index: number): void {
    if (index < 0 || index >= this.children.length) {
      throw new Error(`The index ${index} supplied is out of bounds ${this.children.length}`);
    }
    this.getChildIndex(child);
    this.addChildAt(child, index);
  }

  getChildIndex(child: Container): number {
    const index = this.children.indexOf(child);
    if (index === -1) throw new Error('The supplied Container must be a child of the caller');
    return index;
  }

  swapChildren(child: Container, child2: Container): void {
    if (child === child2) return;
    const i1 = this.getChildIndex(child);
    const i2 = this.getChildIndex(child2);
    this.children[i1] = child2;
    this.children[i2] = child;
    this._didViewChangeTick++;
    notifyChildrenChanged(this);
  }

  removeFromParent(): void {
    this.parent?.removeChild(this);
  }

  reparentChild<U extends Container[]>(...child: U): U[0] {
    for (const c of child) this.reparentChildAt(c, this.children.length);
    return child[0];
  }

  reparentChildAt<U extends Container>(child: U, index: number): U {
    if (child.parent === this) {
      this.setChildIndex(child, index);
      return child;
    }
    const childMat = child.worldTransform.clone();
    child.removeFromParent();
    this.addChildAt(child, index);
    const newMatrix = this.worldTransform.clone();
    newMatrix.invert();
    childMat.prepend(newMatrix);
    child.setFromMatrix(childMat);
    return child;
  }

  getChildByLabel(label: string | RegExp, deep = false): Container | null {
    for (const child of this.children) {
      if (child.label === label || (label instanceof RegExp && child.label !== null && label.test(child.label))) return child;
    }
    if (deep) {
      for (const child of this.children) {
        const found = child.getChildByLabel(label, true);
        if (found) return found;
      }
    }
    return null;
  }

  getChildrenByLabel(label: string | RegExp, deep = false, out: Container[] = []): Container[] {
    for (const child of this.children) {
      if (child.label === label || (label instanceof RegExp && child.label !== null && label.test(child.label))) out.push(child);
    }
    if (deep) for (const child of this.children) child.getChildrenByLabel(label, true, out);
    return out;
  }

  // ───────────────────────── 层级:GameObject(照 Unity)

  /** Unity 的 name(= Pixi 的 label;Pixi v8 的 name 也是 label 的别名) */
  get name(): string {
    return this.label ?? '';
  }
  set name(value: string) {
    this.label = value;
  }

  /** 本节点自己的激活开关(Unity 的 activeSelf) */
  get activeSelf(): boolean {
    return this._activeSelf;
  }

  /**
   * 激活 / 停用本节点(Unity 的 SetActive)。停用的子树不渲染、不参与命中与包围盒、组件 onDisable 且不再 update;
   * 重新激活时组件 onEnable(第一次激活还会先 awake)。与 `visible` 独立:visible 只管画不画。
   */
  setActive(value: boolean): void {
    if (this._activeSelf === value) return;
    this._activeSelf = value;
    this._onUpdate();
    this._didViewChangeTick++;
    if (this._subtreeComponents > 0) forEachComponentInSubtree(this, syncComponentLiveness);
    this.emit('activeChanged', value);
  }

  /** 这是一个场景的根(Application 的 stage 是)。组件只在场景根下的节点上活着 */
  get isSceneRoot(): boolean {
    return this._isSceneRoot;
  }
  set isSceneRoot(value: boolean) {
    if (this._isSceneRoot === value) return;
    this._isSceneRoot = value;
    if (this._subtreeComponents > 0) forEachComponentInSubtree(this, syncComponentLiveness);
  }

  /** 挂在某个场景根下(含自己就是场景根) */
  get inScene(): boolean {
    let c: Container = this;
    while (c.parent) c = c.parent;
    return c._isSceneRoot;
  }

  /** 本节点与全部祖先都激活,且在场景里(Unity 的 activeInHierarchy) */
  get activeInHierarchy(): boolean {
    let c: Container = this;
    for (;;) {
      if (!c._activeSelf) return false;
      if (!c.parent) return c._isSceneRoot;
      c = c.parent;
    }
  }

  /** 本节点与全部祖先都激活(不管在不在场景里;渲染 / 命中按这个剪枝) */
  get activeInTree(): boolean {
    for (let c: Container | null = this; c; c = c.parent) if (!c._activeSelf) return false;
    return true;
  }

  // ───────────────────────── 层级:组件

  /** 本节点上的组件(只读视图) */
  get components(): readonly Component[] {
    return this._components ?? NO_COMPONENTS;
  }

  /** 挂一个组件(传类型就 new 一个)。节点此时层级中激活就立刻 awake + onEnable */
  addComponent<T extends Component>(componentOrType: T | (new () => T)): T {
    const c = typeof componentOrType === 'function' ? new componentOrType() : componentOrType;
    if (c._destroyed) throw new Error(`[engine2d] 组件 ${c.constructor.name} 已销毁,不能再挂`);
    if (c.gameObject) throw new Error(`[engine2d] 组件 ${c.constructor.name} 已挂在别的节点上`);
    c.gameObject = this;
    (this._components ??= []).push(c);
    for (let p: Container | null = this; p; p = p.parent) p._subtreeComponents++;
    syncComponentLiveness(c);
    return c;
  }

  /** 移除组件:活着就先 onDisable,awake 过就 onDestroy(照 Unity 的 Destroy(component)) */
  removeComponent(c: Component): boolean {
    const list = this._components;
    const i = list ? list.indexOf(c) : -1;
    if (!list || i < 0) return false;
    if (c._live) {
      c._live = false;
      PlayerLoop.shared._unregister(c);
      callHook(c, 'onDisable');
    }
    c._destroyed = true;
    if (c._awoken) callHook(c, 'onDestroy');
    const j = list.indexOf(c);
    if (j >= 0) list.splice(j, 1);
    for (let p: Container | null = this; p; p = p.parent) p._subtreeComponents--;
    c.gameObject = null;
    return true;
  }

  getComponent<T extends Component>(type: ComponentType<T>): T | null {
    const list = this._components;
    if (list) for (const c of list) if (c instanceof type) return c;
    return null;
  }

  getComponents<T extends Component>(type: ComponentType<T>, out: T[] = []): T[] {
    const list = this._components;
    if (list) for (const c of list) if (c instanceof type) out.push(c);
    return out;
  }

  /** 本节点及子孙里的第一个(先序);缺省跳过未激活的子树 */
  getComponentInChildren<T extends Component>(type: ComponentType<T>, includeInactive = false): T | null {
    if (!includeInactive && !this._activeSelf) return null;
    const own = this.getComponent(type);
    if (own) return own;
    for (const child of this.children) {
      if (child._subtreeComponents === 0) continue;
      const found = child.getComponentInChildren(type, includeInactive);
      if (found) return found;
    }
    return null;
  }

  getComponentsInChildren<T extends Component>(type: ComponentType<T>, includeInactive = false, out: T[] = []): T[] {
    if (!includeInactive && !this._activeSelf) return out;
    this.getComponents(type, out);
    for (const child of this.children) {
      if (child._subtreeComponents > 0) child.getComponentsInChildren(type, includeInactive, out);
    }
    return out;
  }

  /** 本节点及祖先里的第一个(由近及远);缺省只看激活的节点 */
  getComponentInParent<T extends Component>(type: ComponentType<T>, includeInactive = false): T | null {
    for (let c: Container | null = this; c; c = c.parent) {
      if (!includeInactive && !c._activeSelf) continue;
      const found = c.getComponent(type);
      if (found) return found;
    }
    return null;
  }

  // ───────────────────────── 层级:Transform(照 Unity;角度为弧度)

  /** 父节点空间里的位置(= position) */
  get localPosition(): ObservablePoint {
    return this.position;
  }
  set localPosition(value: PointData) {
    this.position = value;
  }

  /** 父节点空间里的旋转(弧度,= rotation) */
  get localRotation(): number {
    return this.rotation;
  }
  set localRotation(value: number) {
    this.rotation = value;
  }

  /** 本地缩放(= scale) */
  get localScale(): ObservablePoint {
    return this.scale;
  }
  set localScale(value: PointData | number) {
    this.scale = value;
  }

  /** 世界空间位置(本节点 position 所在点;Unity 的 transform.position) */
  get worldPosition(): Point {
    return this.getGlobalPosition(new Point());
  }
  set worldPosition(value: PointData) {
    if (this.parent) this.parent._ensureWorld().applyInverse(value, tempPoint);
    else tempPoint.set(value.x, value.y);
    this.position.set(tempPoint.x, tempPoint.y);
  }

  /** 世界空间旋转(弧度;世界矩阵 x 轴的方向) */
  get worldRotation(): number {
    const m = this._ensureWorld();
    return Math.atan2(m.b, m.a);
  }
  set worldRotation(value: number) {
    const delta = value - this.worldRotation;
    if (delta === 0) return;
    // 绕本节点的世界位置转 delta,再换回父空间(保留缩放符号与 pivot)
    const w = this._ensureWorld();
    const p = this.worldPosition;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const rotated = tempMatrix.set(
      w.a * cos - w.b * sin, w.a * sin + w.b * cos,
      w.c * cos - w.d * sin, w.c * sin + w.d * cos,
      (w.tx - p.x) * cos - (w.ty - p.y) * sin + p.x, (w.tx - p.x) * sin + (w.ty - p.y) * cos + p.y,
    );
    this._setWorldMatrix(rotated.clone());
  }

  /** 世界空间下的缩放(近似:有旋转 / 非等比的祖先时只是量级;镜像记在 x 上) */
  get lossyScale(): Point {
    const m = this._ensureWorld();
    const det = m.a * m.d - m.b * m.c;
    return new Point((det < 0 ? -1 : 1) * Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
  }

  /** 本地 → 世界(Unity 的 localToWorldMatrix;返回副本) */
  get localToWorldMatrix(): Matrix {
    return this._ensureWorld().clone();
  }

  /** 世界 → 本地(返回新矩阵) */
  get worldToLocalMatrix(): Matrix {
    return this._ensureWorld().clone().invert();
  }

  /** 自上次置 false 以来本节点的世界变换(含祖先带来的)是否变过。初始为 true(同 Unity) */
  get hasChanged(): boolean {
    this._ensureWorld();
    return this._hasChangedAck !== this._worldVersion;
  }
  set hasChanged(value: boolean) {
    if (value) {
      this._hasChangedAck = -1;
    } else {
      this._ensureWorld();
      this._hasChangedAck = this._worldVersion;
    }
  }

  /**
   * 换父节点(Unity 的 SetParent)。worldPositionStays = true 时保持世界变换不变(重新算本地位置 / 旋转 / 缩放,
   * 保留原来的缩放符号、pivot 与 origin);false 时保留本地变换。null = 摘下成为根。
   */
  setParent(parent: Container | null, worldPositionStays = true): void {
    if (parent === this.parent) return;
    if (parent && (parent === this || parent.isChildOf(this))) {
      throw new Error('[engine2d] setParent:不能挂到自己或自己的子孙下');
    }
    const world = worldPositionStays ? this._ensureWorld().clone() : null;
    if (parent) parent.addChild(this);
    else this.removeFromParent();
    if (world) this._setWorldMatrix(world);
  }

  /** @internal 让世界矩阵等于 world:换算到父空间后按保号分解写回本地变换 */
  _setWorldMatrix(world: Matrix): void {
    const local = this.parent ? new Matrix().appendFrom(world, this.parent._ensureWorld().clone().invert()) : world;
    this._setLocalMatrix(local);
  }

  /**
   * @internal 把本地变换设成 m(精确):保留当前 pivot / origin 与缩放符号(镜像的节点仍是 scale.x < 0,不会像
   * Pixi 的 decompose 那样变成 180° 斜切);m 带切变(非等比缩放的祖先下常见)时放进 skew.x,skew.y 置 0。
   */
  _setLocalMatrix(m: Matrix): void {
    const det = m.a * m.d - m.b * m.c;
    const oldSx = this._scale ? this._scale._x : 1;
    const oldSy = this._scale ? this._scale._y : 1;
    let signX = 1;
    let signY = 1;
    if (det < 0) {
      if (oldSy < 0 && oldSx >= 0) signY = -1;
      else signX = -1;
    } else if (oldSx < 0 && oldSy < 0) {
      signX = -1;
      signY = -1;
    }
    const sx = signX * Math.hypot(m.a, m.b);
    const sy = signY * Math.hypot(m.c, m.d);
    // Pixi 的参数化:a = cos(r + skY)·sx, b = sin(r + skY)·sx, c = −sin(r − skX)·sy, d = cos(r − skX)·sy;取 skY = 0
    const r = sx !== 0 ? Math.atan2(m.b / sx, m.a / sx) : this._rotation;
    const theta = sy !== 0 ? Math.atan2(-m.c / sy, m.d / sy) : r;
    let skX = r - theta;
    skX = Math.atan2(Math.sin(skX), Math.cos(skX));
    if (Math.abs(skX) < 1e-12) skX = 0;
    if (skX !== 0 || (this._skew && (this._skew._x !== 0 || this._skew._y !== 0))) this.skew.set(skX, 0);
    this.rotation = r;
    this.scale.set(sx, sy);
    // 位置:由 updateLocalTransform 的 tx / ty 公式反解(pivot、origin 不动)
    const px = this._pivot ? this._pivot._x : 0;
    const py = this._pivot ? this._pivot._y : 0;
    const ox = this._origin ? -this._origin._x : 0;
    const oy = this._origin ? -this._origin._y : 0;
    this.updateLocalTransform();
    const lt = this.localTransform;
    this.position.set(
      m.tx + (px * lt.a + py * lt.c) - (ox * lt.a + oy * lt.c) + ox,
      m.ty + (px * lt.b + py * lt.d) - (ox * lt.b + oy * lt.d) + oy,
    );
  }

  /** 兄弟中的序号(= 渲染先后;开了 sortableChildren 时按 zIndex 另排) */
  get siblingIndex(): number {
    return this.parent ? this.parent.children.indexOf(this) : 0;
  }
  set siblingIndex(index: number) {
    const p = this.parent;
    if (!p) return;
    p.setChildIndex(this, Math.max(0, Math.min(p.children.length - 1, Math.trunc(index))));
  }

  setAsFirstSibling(): void {
    this.siblingIndex = 0;
  }

  setAsLastSibling(): void {
    if (this.parent) this.siblingIndex = this.parent.children.length - 1;
  }

  get childCount(): number {
    return this.children.length;
  }

  getChild<U extends Container = Container>(index: number): U {
    return this.getChildAt<U>(index);
  }

  /** 最顶上的祖先(没有父节点就是自己) */
  get root(): Container {
    let c: Container = this;
    while (c.parent) c = c.parent;
    return c;
  }

  /** 自己就是 ancestor,或在它的子树里(同 Unity 的 IsChildOf) */
  isChildOf(ancestor: Container): boolean {
    for (let c: Container | null = this; c; c = c.parent) if (c === ancestor) return true;
    return false;
  }

  /**
   * 按路径找子孙(Unity 的 Transform.Find):`'a/b/c'` 逐级按名字匹配直接子节点;不含未激活过滤(与 Unity 相同)。
   * 路径段 `..` 表示父节点。找不到返回 null。
   */
  find(path: string): Container | null {
    let cur: Container | null = this;
    for (const seg of path.split('/')) {
      if (!cur) return null;
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        cur = cur.parent;
        continue;
      }
      let next: Container | null = null;
      for (const child of cur.children) {
        if (child.label === seg) {
          next = child;
          break;
        }
      }
      cur = next;
    }
    return cur;
  }

  /** 从根开始的名字路径(调试 / 层级面板用;没名字的段用 `#uid`) */
  get hierarchyPath(): string {
    const parts: string[] = [];
    for (let c: Container | null = this; c; c = c.parent) parts.push(c.label || `#${c.uid}`);
    return parts.reverse().join('/');
  }

  /** 本地点 → 世界点 */
  transformPoint(point: PointData, out: Point = new Point()): Point {
    return this._ensureWorld().apply(point, out);
  }

  /** 世界点 → 本地点 */
  inverseTransformPoint(point: PointData, out: Point = new Point()): Point {
    return this._ensureWorld().applyInverse(point, out);
  }

  /** 本地向量 → 世界向量(吃旋转与缩放,不吃平移) */
  transformVector(v: PointData, out: Point = new Point()): Point {
    const m = this._ensureWorld();
    out.set(m.a * v.x + m.c * v.y, m.b * v.x + m.d * v.y);
    return out;
  }

  /** 世界向量 → 本地向量 */
  inverseTransformVector(v: PointData, out: Point = new Point()): Point {
    const m = this._ensureWorld();
    const id = 1 / (m.a * m.d - m.b * m.c);
    out.set((m.d * v.x - m.c * v.y) * id, (-m.b * v.x + m.a * v.y) * id);
    return out;
  }

  /** 本地方向 → 世界方向(只吃世界旋转,长度不变) */
  transformDirection(v: PointData, out: Point = new Point()): Point {
    const r = this.worldRotation;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    out.set(v.x * cos - v.y * sin, v.x * sin + v.y * cos);
    return out;
  }

  /** 世界方向 → 本地方向 */
  inverseTransformDirection(v: PointData, out: Point = new Point()): Point {
    const r = -this.worldRotation;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    out.set(v.x * cos - v.y * sin, v.x * sin + v.y * cos);
    return out;
  }

  /** 平移(Unity 的 Translate):'self' 沿自身朝向(只吃旋转),'world' 按世界轴 */
  translate(dx: number, dy: number, space: 'self' | 'world' = 'self'): void {
    const d = space === 'self' ? this.transformDirection({ x: dx, y: dy }, tempPoint) : tempPoint.set(dx, dy);
    const wp = this.worldPosition;
    this.worldPosition = { x: wp.x + d.x, y: wp.y + d.y };
  }

  /** 旋转(Unity 的 Rotate,2D):本地旋转加 radians */
  rotate(radians: number): void {
    this.rotation += radians;
  }

  // ───────────────────────── 排序

  get zIndex(): number {
    return this._zIndex;
  }
  set zIndex(value: number) {
    if (this._zIndex === value) return;
    this._zIndex = value;
    this.depthOfChildModified();
  }

  depthOfChildModified(): void {
    if (this.parent) {
      this.parent.sortableChildren = true;
      this.parent.sortDirty = true;
    }
  }

  sortChildren(): void {
    if (!this.sortDirty) return;
    this.sortDirty = false;
    this.children.sort((a, b) => a._zIndex - b._zIndex);
  }

  // ───────────────────────── 变换

  /** @internal ObservablePoint 回调 */
  _onUpdate(point?: ObservablePoint): void {
    if (point && point === this._skew) this._updateSkew();
    this._didContainerChangeTick++;
  }

  get x(): number { return this._position.x; }
  set x(v: number) { this._position.x = v; }
  get y(): number { return this._position.y; }
  set y(v: number) { this._position.y = v; }

  get position(): ObservablePoint {
    return this._position;
  }
  set position(value: PointData) {
    this._position.copyFrom(value);
  }

  get rotation(): number {
    return this._rotation;
  }
  set rotation(value: number) {
    if (this._rotation !== value) {
      this._rotation = value;
      this._updateSkew();
      this._onUpdate();
    }
  }

  get angle(): number {
    return this.rotation * RAD_TO_DEG;
  }
  set angle(value: number) {
    this.rotation = value * DEG_TO_RAD;
  }

  get pivot(): ObservablePoint {
    return (this._pivot ??= new ObservablePoint(this, 0, 0));
  }
  set pivot(value: PointData | number) {
    const p = (this._pivot ??= new ObservablePoint(this, 0, 0));
    typeof value === 'number' ? p.set(value) : p.copyFrom(value);
  }

  get skew(): ObservablePoint {
    return (this._skew ??= new ObservablePoint(this, 0, 0));
  }
  set skew(value: PointData) {
    (this._skew ??= new ObservablePoint(this, 0, 0)).copyFrom(value);
  }

  get scale(): ObservablePoint {
    return (this._scale ??= new ObservablePoint(this, 1, 1));
  }
  set scale(value: PointData | number | string) {
    const s = (this._scale ??= new ObservablePoint(this, 1, 1));
    if (typeof value === 'string') value = parseFloat(value);
    typeof value === 'number' ? s.set(value) : s.copyFrom(value);
  }

  get origin(): ObservablePoint {
    return (this._origin ??= new ObservablePoint(this, 0, 0));
  }
  set origin(value: PointData | number) {
    const o = (this._origin ??= new ObservablePoint(this, 0, 0));
    typeof value === 'number' ? o.set(value) : o.copyFrom(value);
  }

  get width(): number {
    return Math.abs(this.scale.x * this.getLocalBounds().width);
  }
  set width(value: number) {
    this._setWidth(value, this.getLocalBounds().width);
  }

  get height(): number {
    return Math.abs(this.scale.y * this.getLocalBounds().height);
  }
  set height(value: number) {
    this._setHeight(value, this.getLocalBounds().height);
  }

  getSize(out: { width: number; height: number } = { width: 0, height: 0 }): { width: number; height: number } {
    const b = this.getLocalBounds();
    out.width = Math.abs(this.scale.x * b.width);
    out.height = Math.abs(this.scale.y * b.height);
    return out;
  }

  setSize(value: number | { width: number; height?: number }, height?: number): void {
    const size = this.getLocalBounds();
    let w: number | undefined;
    if (typeof value === 'object') {
      height = value.height ?? value.width;
      w = value.width;
    } else {
      w = value;
      height ??= value;
    }
    if (w !== undefined) this._setWidth(w, size.width);
    if (height !== undefined) this._setHeight(height, size.height);
  }

  protected _setWidth(value: number, localWidth: number): void {
    const sign = Math.sign(this.scale.x) || 1;
    this.scale.x = localWidth !== 0 ? (value / localWidth) * sign : sign;
  }

  protected _setHeight(value: number, localHeight: number): void {
    const sign = Math.sign(this.scale.y) || 1;
    this.scale.y = localHeight !== 0 ? (value / localHeight) * sign : sign;
  }

  private _updateSkew(): void {
    const r = this._rotation;
    const sk = this._skew;
    const skx = sk ? sk._x : 0;
    const sky = sk ? sk._y : 0;
    this._cx = Math.cos(r + sky);
    this._sx = Math.sin(r + sky);
    this._cy = -Math.sin(r - skx);
    this._sy = Math.cos(r - skx);
  }

  updateTransform(opts: {
    x?: number; y?: number; scaleX?: number; scaleY?: number; rotation?: number;
    skewX?: number; skewY?: number; pivotX?: number; pivotY?: number; originX?: number; originY?: number;
  }): this {
    this.position.set(typeof opts.x === 'number' ? opts.x : this.position.x, typeof opts.y === 'number' ? opts.y : this.position.y);
    this.scale.set(typeof opts.scaleX === 'number' ? opts.scaleX || 1 : this.scale.x, typeof opts.scaleY === 'number' ? opts.scaleY || 1 : this.scale.y);
    this.rotation = typeof opts.rotation === 'number' ? opts.rotation : this.rotation;
    this.skew.set(typeof opts.skewX === 'number' ? opts.skewX : this.skew.x, typeof opts.skewY === 'number' ? opts.skewY : this.skew.y);
    this.pivot.set(typeof opts.pivotX === 'number' ? opts.pivotX : this.pivot.x, typeof opts.pivotY === 'number' ? opts.pivotY : this.pivot.y);
    this.origin.set(typeof opts.originX === 'number' ? opts.originX : this.origin.x, typeof opts.originY === 'number' ? opts.originY : this.origin.y);
    return this;
  }

  setFromMatrix(matrix: Matrix): void {
    matrix.decompose(this as unknown as Parameters<Matrix['decompose']>[0]);
  }

  updateLocalTransform(): void {
    const tick = this._didContainerChangeTick;
    if (this._didLocalTransformChangeId === tick) return;
    this._didLocalTransformChangeId = tick;
    const lt = this.localTransform;
    const sx = this._scale ? this._scale._x : 1;
    const sy = this._scale ? this._scale._y : 1;
    const px = this._pivot ? this._pivot._x : 0;
    const py = this._pivot ? this._pivot._y : 0;
    const ox = this._origin ? -this._origin._x : 0;
    const oy = this._origin ? -this._origin._y : 0;
    const pos = this._position;
    lt.a = this._cx * sx;
    lt.b = this._sx * sx;
    lt.c = this._cy * sy;
    lt.d = this._sy * sy;
    lt.tx = pos._x - (px * lt.a + py * lt.c) + (ox * lt.a + oy * lt.c) - ox;
    lt.ty = pos._y - (px * lt.b + py * lt.d) + (ox * lt.b + oy * lt.d) - oy;
  }

  /** 当前父链下的世界变换(缓存,见 _ensureWorld;别改它) */
  get worldTransform(): Matrix {
    return this._ensureWorld();
  }

  getGlobalTransform(matrix: Matrix = new Matrix(), skipUpdate = false): Matrix {
    void skipUpdate;
    return matrix.copyFrom(this._ensureWorld());
  }

  /**
   * @internal 世界矩阵:自顶向下沿父链检查,本地变换改动号 / 父节点 / 父世界版本有一样变了才重算这一级
   * (乘法与 Pixi 的 updateTransformBackwards 同一顺序,结果逐位相同);算出来的值真的变了才升版本,
   * 所以只改了 alpha 之类不会让子孙白算。干净时只做 O(深度) 次比较、不做乘法、不分配。
   */
  _ensureWorld(): Matrix {
    const chain = chainScratch;
    let n = 0;
    for (let c: Container | null = this; c; c = c.parent) chain[n++] = c;
    let parent: Container | null = null;
    for (let i = n - 1; i >= 0; i--) {
      const c = chain[i];
      chain[i] = null as unknown as Container;
      c.updateLocalTransform();
      const world = (c._worldTransform ??= new Matrix());
      const parentVersion = parent ? parent._worldVersion : -1;
      if (c._worldLocalTick !== c._didContainerChangeTick || c._worldParent !== parent || c._worldParentVersion !== parentVersion) {
        c._worldLocalTick = c._didContainerChangeTick;
        c._worldParent = parent;
        c._worldParentVersion = parentVersion;
        if (parent) tempAppend.appendFrom(c.localTransform, parent._worldTransform!);
        else tempAppend.copyFrom(c.localTransform);
        if (c._worldVersion === 0 || !matrixEquals(world, tempAppend)) {
          world.copyFrom(tempAppend);
          c._worldVersion++;
        }
      }
      parent = c;
    }
    return this._worldTransform!;
  }

  getGlobalPosition(point: Point = new Point(), skipUpdate = false): Point {
    if (this.parent) this.parent.toGlobal(this._position, point, skipUpdate);
    else {
      point.x = this._position.x;
      point.y = this._position.y;
    }
    return point;
  }

  toGlobal<P extends PointData = Point>(position: PointData, point?: P, skipUpdate = false): P {
    void skipUpdate;
    return this._ensureWorld().apply(position, point);
  }

  toLocal<P extends PointData = Point>(position: PointData, from?: Container, point?: P, skipUpdate?: boolean): P {
    if (from) position = from.toGlobal(position, point, skipUpdate);
    return this._ensureWorld().applyInverse(position, point);
  }

  getGlobalAlpha(skipUpdate = false): number {
    void skipUpdate;
    let alpha = this.alpha;
    let cur = this.parent;
    while (cur) {
      alpha *= cur.alpha;
      cur = cur.parent;
    }
    return alpha;
  }

  getGlobalTint(skipUpdate = false): number {
    void skipUpdate;
    let color = this.localColor;
    let p = this.parent;
    while (p) {
      color = multiplyColors(color, p.localColor);
      p = p.parent;
    }
    return bgr2rgb(color);
  }

  // ───────────────────────── 外观

  get alpha(): number {
    return this.localAlpha;
  }
  set alpha(value: number) {
    if (value === this.localAlpha) return;
    this.localAlpha = value;
    this._onUpdate();
  }

  get tint(): number {
    return bgr2rgb(this.localColor);
  }
  set tint(value: ColorSource) {
    const bgr = Color.shared.setValue(value ?? 0xffffff).toBgrNumber();
    if (bgr === this.localColor) return;
    this.localColor = bgr;
    this._onUpdate();
  }

  get blendMode(): BlendMode {
    return this.localBlendMode;
  }
  set blendMode(value: BlendMode) {
    if (this.localBlendMode === value) return;
    this.localBlendMode = value;
    this._onUpdate();
  }

  get visible(): boolean {
    return !!(this.localDisplayStatus & 2);
  }
  set visible(value: boolean) {
    const v = value ? 2 : 0;
    if ((this.localDisplayStatus & 2) === v) return;
    this.localDisplayStatus ^= 2;
    this._onUpdate();
    this._didViewChangeTick++;
    this.emit('visibleChanged', value);
  }

  get culled(): boolean {
    return !(this.localDisplayStatus & 4);
  }
  set culled(value: boolean) {
    const v = value ? 0 : 4;
    if ((this.localDisplayStatus & 4) === v) return;
    this.localDisplayStatus ^= 4;
    this._onUpdate();
  }

  get renderable(): boolean {
    return !!(this.localDisplayStatus & 1);
  }
  set renderable(value: boolean) {
    const v = value ? 1 : 0;
    if ((this.localDisplayStatus & 1) === v) return;
    this.localDisplayStatus ^= 1;
    this._onUpdate();
  }

  get isRenderable(): boolean {
    return this.localDisplayStatus === 7 && this.groupAlpha > 0;
  }

  /** Pixi 的渲染组开关:这里只是记号(渲染每次都整棵树走一遍,不需要分组) */
  isRenderGroup = false;
  enableRenderGroup(): void {
    this.isRenderGroup = true;
  }
  disableRenderGroup(): void {
    this.isRenderGroup = false;
  }

  get onRender(): ((renderer: unknown) => void) | null {
    return this._onRender;
  }
  set onRender(fn: ((renderer: unknown) => void) | null | undefined) {
    this._onRender = fn ?? null;
  }

  // ───────────────────────── 效果

  /** 遮罩体(数字遮罩时是那个数字);照 Pixi 按值选遮罩类型:Sprite → AlphaMask、数字 → ColorMask、其它容器 → StencilMask */
  get mask(): Container | number | null {
    return this._maskEffect?.mask ?? null;
  }
  set mask(value: MaskInput | null | undefined) {
    const effect = this._maskEffect;
    if (effect?.mask === value) return;
    if (effect) {
      this.removeEffect(effect);
      (effect as { reset?(): void }).reset?.();
      this._maskEffect = null;
    }
    if (value === null || value === undefined) return;
    this._maskEffect = getMaskEffect(value);
    this.addEffect(this._maskEffect);
  }

  /** 照 Pixi `setMask`:选项并进 `_maskOptions`;只有给了(真值)mask 才换遮罩 */
  setMask(options: { mask?: MaskInput | null; inverse?: boolean }): void {
    this._maskOptions = { ...this._maskOptions, ...options };
    if (options.mask) this.mask = options.mask;
  }

  get filters(): readonly Filter[] | null {
    return this._filterEffect?.filters ?? null;
  }
  set filters(value: Filter | readonly Filter[] | null | undefined) {
    let list: readonly Filter[] | null = value == null ? null : Array.isArray(value) ? (value as Filter[]).slice(0) : [value as Filter];
    const effect = (this._filterEffect ??= new FilterEffect());
    const has = !!list && list.length > 0;
    const had = !!effect.filters && effect.filters.length > 0;
    if (list) list = Object.freeze(list);
    effect.filters = list;
    if (has !== had) {
      if (has) this.addEffect(effect);
      else this.removeEffect(effect);
    }
  }

  get filterArea(): Rectangle | undefined {
    return this._filterEffect?.filterArea;
  }
  set filterArea(value: Rectangle | undefined) {
    (this._filterEffect ??= new FilterEffect()).filterArea = value;
  }

  addEffect(effect: ContainerEffect): void {
    if (this.effects.includes(effect)) return;
    this.effects.push(effect);
    this.effects.sort((a, b) => a.priority - b.priority);
    this._didViewChangeTick++;
  }

  removeEffect(effect: ContainerEffect): void {
    const i = this.effects.indexOf(effect);
    if (i === -1) return;
    this.effects.splice(i, 1);
    this._didViewChangeTick++;
  }

  // ───────────────────────── 事件属性

  get interactive(): boolean {
    return this.eventMode === 'dynamic' || this.eventMode === 'static';
  }
  set interactive(value: boolean) {
    this.eventMode = value ? 'static' : 'passive';
  }

  isInteractive(): boolean {
    return this.eventMode === 'static' || this.eventMode === 'dynamic';
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | ((e: never) => void), options?: boolean | AddEventListenerOptions): void {
    const capture = (typeof options === 'boolean' && options) || (typeof options === 'object' && options.capture);
    const signal = typeof options === 'object' ? options.signal : undefined;
    const once = typeof options === 'object' ? options.once === true : false;
    const context = typeof listener === 'function' ? undefined : listener;
    const evt = capture ? `${type}capture` : type;
    const fn = (typeof listener === 'function' ? listener : (listener as EventListenerObject).handleEvent) as (...a: unknown[]) => void;
    signal?.addEventListener('abort', () => this.off(evt, fn, context));
    if (once) this.once(evt, fn, context);
    else this.on(evt, fn, context);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | ((e: never) => void), options?: boolean | EventListenerOptions): void {
    const capture = (typeof options === 'boolean' && options) || (typeof options === 'object' && options.capture);
    const context = typeof listener === 'function' ? undefined : listener;
    const evt = capture ? `${type}capture` : type;
    const fn = (typeof listener === 'function' ? listener : (listener as EventListenerObject).handleEvent) as (...a: unknown[]) => void;
    this.off(evt, fn, context);
  }

  /** 由 events 模块注入实际分发(避免 scene 依赖 events) */
  dispatchEvent(e: { target?: unknown; defaultPrevented?: boolean; path?: unknown; manager?: { dispatchEvent(e: unknown): void } }): boolean {
    if (!e.manager) throw new Error('Container cannot propagate events outside of the Federated Events API');
    e.defaultPrevented = false;
    e.path = null;
    e.target = this;
    e.manager.dispatchEvent(e);
    return !e.defaultPrevented;
  }

  // ───────────────────────── 包围盒

  /** 本节点自身可画内容的本地包围盒(视图类覆盖) */
  get bounds(): Bounds | undefined {
    return undefined;
  }

  getLocalBounds(): Bounds {
    const key = localBoundsKey(this);
    if (this._localBoundsCache?.tick === key) return this._localBoundsCache.bounds;
    const b = this._localBoundsCache?.bounds ?? new Bounds();
    getLocalBounds(this, b, new Matrix());
    this._localBoundsCache = { tick: key, bounds: b };
    return b;
  }

  getBounds(skipUpdate = false, bounds?: Bounds): Bounds {
    return getGlobalBounds(this, skipUpdate, bounds ?? new Bounds());
  }

  /** 本节点(不含子)在本地坐标里是否包含点;视图类覆盖 */
  containsPoint(_point: PointData): boolean {
    return false;
  }

  // ───────────────────────── 渲染

  /**
   * 渲染核心在收集阶段对每个可画节点调用:把自己要画的东西交给收集器。纯容器什么都不画。
   * 调用前 `groupTransform` / `groupColorAlpha` / `groupBlendMode` 已按本次渲染算好。
   */
  collectRenderables(_collector: RenderCollector): void {}

  /** @internal 渲染核心用 */
  static _nextRenderTick(): number {
    return ++renderTick;
  }

  destroy(options: boolean | DestroyOptions = false): void {
    if (this.destroyed) return;
    // 组件先走完 onDisable / onDestroy(照 Unity:销毁节点即销毁其上组件)
    if (this._components) for (const c of [...this._components]) this.removeComponent(c);
    this.destroyed = true;
    let oldChildren: Container[] | undefined;
    if (this.children.length) oldChildren = this.removeChildren(0, this.children.length);
    this.removeFromParent();
    this.parent = null;
    // 照 Pixi:只断开遮罩效果,不 reset —— 遮罩体仍是 includeInBuild / measurable = false(不画、不计包围盒)
    this._maskEffect = null;
    this._filterEffect = null;
    this.effects = [];
    this.emit('destroyed', this);
    this.removeAllListeners();
    const destroyChildren = typeof options === 'boolean' ? options : options?.children;
    if (destroyChildren && oldChildren) for (const c of oldChildren) c.destroy(options);
  }
}

// ───────────────────────── 工具函数(照 Pixi)

export function bgr2rgb(color: number): number {
  return ((color & 255) << 16) + (color & 65280) + ((color >> 16) & 255);
}

export function multiplyHexColors(c1: number, c2: number): number {
  if (c1 === 0xffffff || !c2) return c2;
  if (c2 === 0xffffff || !c1) return c1;
  const r = (((c1 >> 16) & 255) * ((c2 >> 16) & 255)) / 255 | 0;
  const g = (((c1 >> 8) & 255) * ((c2 >> 8) & 255)) / 255 | 0;
  const b = ((c1 & 255) * (c2 & 255)) / 255 | 0;
  return (r << 16) + (g << 8) + b;
}

export function multiplyColors(localBgr: number, parentBgr: number): number {
  if (localBgr === 0xffffff) return parentBgr;
  if (parentBgr === 0xffffff) return localBgr;
  return multiplyHexColors(localBgr, parentBgr);
}

export function updateTransformBackwards(target: Container, parentTransform: Matrix): Matrix {
  const parent = target.parent;
  if (parent) {
    updateTransformBackwards(parent, parentTransform);
    parent.updateLocalTransform();
    parentTransform.append(parent.localTransform);
  }
  return parentTransform;
}

function matrixRelativeTo(target: Container | null, root: Container, matrix: Matrix): Matrix {
  if (!target) return matrix;
  if (target !== root) {
    matrixRelativeTo(target.parent, root, matrix);
    target.updateLocalTransform();
    matrix.append(target.localTransform);
  }
  return matrix;
}

/** 子树里任何变换 / 内容变化都会改变这个键 */
function localBoundsKey(c: Container): string {
  let key = `${c._didViewChangeTick}`;
  const walk = (n: Container): void => {
    for (const ch of n.children) {
      key += `|${ch.uid}:${ch._didViewChangeTick}:${ch._didContainerChangeTick}`;
      if (ch.children.length) walk(ch);
    }
  };
  walk(c);
  return key;
}

export function getLocalBounds(target: Container, bounds: Bounds, relativeMatrix?: Matrix): Bounds {
  bounds.clear();
  _getLocalBounds(target, bounds, relativeMatrix ?? Matrix.IDENTITY, target, true);
  if (!bounds.isValid) bounds.set(0, 0, 0, 0);
  return bounds;
}

function _getLocalBounds(target: Container, bounds: Bounds, parentTransform: Matrix, root: Container, isRoot: boolean): void {
  let rel: Matrix;
  if (!isRoot) {
    if (!target._activeSelf || !target.visible || !target.measurable) return;
    target.updateLocalTransform();
    rel = new Matrix().appendFrom(target.localTransform, parentTransform);
  } else rel = parentTransform.clone();
  const parentBounds = bounds;
  const preserve = target.effects.length > 0;
  if (preserve) bounds = new Bounds();
  if (target.boundsArea) bounds.addRect(target.boundsArea, rel);
  else {
    const own = target.bounds;
    if (target.renderPipeId && own) {
      bounds.matrix = rel;
      bounds.addBounds(own);
    }
    for (const child of target.children) _getLocalBounds(child, bounds, rel, root, false);
  }
  if (preserve) {
    for (const e of target.effects) e.addLocalBounds?.(bounds, root);
    parentBounds.addBounds(bounds, Matrix.IDENTITY);
  }
}

export function getGlobalBounds(target: Container, skipUpdateTransform: boolean, bounds: Bounds): Bounds {
  bounds.clear();
  const parentTransform = target.parent ? updateTransformBackwards(target, new Matrix()) : Matrix.IDENTITY;
  void skipUpdateTransform;
  _getGlobalBounds(target, bounds, parentTransform);
  if (!bounds.isValid) bounds.set(0, 0, 0, 0);
  return bounds;
}

function _getGlobalBounds(target: Container, bounds: Bounds, parentTransform: Matrix): void {
  if (!target._activeSelf || !target.visible || !target.measurable) return;
  target.updateLocalTransform();
  const world = new Matrix().appendFrom(target.localTransform, parentTransform);
  const parentBounds = bounds;
  const preserve = target.effects.length > 0;
  if (preserve) bounds = new Bounds();
  if (target.boundsArea) bounds.addRect(target.boundsArea, world);
  else {
    const own = target.bounds;
    if (own && !own.isEmpty()) {
      bounds.matrix = world;
      bounds.addBounds(own);
    }
    for (const child of target.children) _getGlobalBounds(child, bounds, world);
  }
  if (preserve) {
    for (const e of target.effects) e.addBounds?.(bounds);
    parentBounds.addBounds(bounds, Matrix.IDENTITY);
  }
}
