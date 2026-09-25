/**
 * 场景树节点(照 PixiJS v8.17 `Container` 的对外语义;实现参照 PixiJS,MIT)。
 *
 * 与 Pixi 的差别只在内部:没有 RenderGroup 的增量簿记。渲染核心每次 `render()` 从根往下走一遍,
 * 当场算出本次的世界变换 / 颜色 / 混合 / 可见性(写进 `groupTransform` 等字段),再把可画的东西交给收集器。
 * `worldTransform` / `getBounds()` / `toGlobal()` 任何时候读都是按当前父链现算的(Pixi 的 worldTransform
 * 要等下一次渲染才更新;这里不滞后)。
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
  mask?: Container | null;
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

export class MaskEffect implements ContainerEffect {
  readonly kind = 'mask' as const;
  priority = 0;
  inverse = false;

  constructor(public mask: Container) {
    mask.includeInBuild = false;
    mask.measurable = false;
  }

  reset(): void {
    this.mask.measurable = true;
    this.mask.includeInBuild = true;
  }

  addBounds(bounds: Bounds): void {
    const m = new Bounds();
    this.mask.measurable = true;
    getGlobalBounds(this.mask, false, m);
    this.mask.measurable = false;
    bounds.addBoundsMask(m);
  }

  addLocalBounds(bounds: Bounds, localRoot: Container): void {
    const m = new Bounds();
    this.mask.measurable = true;
    const rel = matrixRelativeTo(this.mask, localRoot, new Matrix());
    getLocalBounds(this.mask, m, rel);
    this.mask.measurable = false;
    bounds.addBoundsMask(m);
  }

  containsPoint(point: PointData, hitTestFn: (container: Container, point: Point) => boolean): boolean {
    return hitTestFn(this.mask, point as Point);
  }
}

export class FilterEffect implements ContainerEffect {
  readonly kind = 'filters' as const;
  priority = 0;
  filters: readonly Filter[] | null = null;
  filterArea?: Rectangle;
}

let renderTick = 0;
const chainScratch: Container[] = [];
const tempAppend = new Matrix();

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
      return child;
    }
    child.parent?.removeChild(child);
    this.children.push(child);
    if (this.sortableChildren) this.sortDirty = true;
    child.parent = this;
    this.emit('childAdded', child, this, this.children.length - 1);
    child.emit('added', this);
    this._didViewChangeTick++;
    if (child._zIndex !== 0) child.depthOfChildModified();
    return child;
  }

  removeChild<U extends Container[]>(...children: U): U[0] {
    if (children.length > 1) {
      for (const c of children) this.removeChild(c);
      return children[0];
    }
    const child = children[0];
    const index = this.children.indexOf(child);
    if (index > -1) {
      this._didViewChangeTick++;
      this.children.splice(index, 1);
      child.parent = null;
      this.emit('childRemoved', child, this, index);
      child.emit('removed', this);
    }
    return child;
  }

  addChildAt<U extends Container>(child: U, index: number): U {
    const { children } = this;
    if (index < 0 || index > children.length) {
      throw new Error(`${String(child)}addChildAt: The index ${index} supplied is out of bounds ${children.length}`);
    }
    const sameParent = child.parent === this;
    if (child.parent) {
      const currentIndex = child.parent.children.indexOf(child);
      if (sameParent) {
        if (currentIndex === index) return child;
        child.parent.children.splice(currentIndex, 1);
      } else child.removeFromParent();
    }
    if (index === children.length) children.push(child);
    else children.splice(index, 0, child);
    child.parent = this;
    if (this.sortableChildren) this.sortDirty = true;
    this._didViewChangeTick++;
    if (sameParent) return child;
    this.emit('childAdded', child, this, index);
    child.emit('added', this);
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
      this.children.splice(beginIndex, range);
      for (let i = 0; i < removed.length; ++i) {
        this.emit('childRemoved', removed[i], this, i);
        removed[i].emit('removed', this);
      }
      if (removed.length > 0) this._didViewChangeTick++;
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

  /** 当前父链下的世界变换(现算) */
  get worldTransform(): Matrix {
    return this.getGlobalTransform((this._worldTransform ??= new Matrix()), false);
  }

  getGlobalTransform(matrix: Matrix = new Matrix(), skipUpdate = false): Matrix {
    void skipUpdate;
    // 自顶向下逐级 append(与 Pixi 的 updateTransformBackwards 同一乘法顺序),不分配临时对象
    const chain = chainScratch;
    let n = 0;
    for (let c: Container | null = this; c; c = c.parent) chain[n++] = c;
    matrix.identity();
    for (let i = n - 1; i >= 0; i--) {
      const c = chain[i];
      c.updateLocalTransform();
      if (i === 0) matrix.copyFrom(tempAppend.appendFrom(c.localTransform, matrix));
      else matrix.append(c.localTransform);
      chain[i] = null as unknown as Container;
    }
    return matrix;
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
    return this.getGlobalTransform(new Matrix(), skipUpdate).apply(position, point);
  }

  toLocal<P extends PointData = Point>(position: PointData, from?: Container, point?: P, skipUpdate?: boolean): P {
    if (from) position = from.toGlobal(position, point, skipUpdate);
    return this.getGlobalTransform(new Matrix(), skipUpdate).applyInverse(position, point);
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

  get mask(): Container | null {
    return this._maskEffect?.mask ?? null;
  }
  set mask(value: Container | null | undefined) {
    const effect = this._maskEffect;
    if (effect?.mask === value) return;
    if (effect) {
      this.removeEffect(effect);
      effect.reset();
      this._maskEffect = null;
    }
    if (value === null || value === undefined) return;
    this._maskEffect = new MaskEffect(value);
    this.addEffect(this._maskEffect);
  }

  setMask(options: { mask?: Container | null; inverse?: boolean }): void {
    if (options.mask !== undefined) this.mask = options.mask;
    if (this._maskEffect && options.inverse !== undefined) this._maskEffect.inverse = options.inverse;
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
    this.destroyed = true;
    let oldChildren: Container[] | undefined;
    if (this.children.length) oldChildren = this.removeChildren(0, this.children.length);
    this.removeFromParent();
    this.parent = null;
    if (this._maskEffect) {
      this._maskEffect.reset();
      this._maskEffect = null;
    }
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
    if (!target.visible || !target.measurable) return;
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
  if (!target.visible || !target.measurable) return;
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
