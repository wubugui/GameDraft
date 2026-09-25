/**
 * 矢量图形节点。移植自 PixiJS v8.17(MIT):scene/graphics/shared/Graphics(+ GraphicsPipe 里按节点复制区段的部分)。
 * 绘制方法全部代理到 `context`(可被多个 Graphics 共享);包围盒 / 命中直接用 context 的。
 *
 * 渲染:`collectRenderables` 对 context 三角化结果的每个区段交出一个 BatchableGraphics(= BatchableElement),
 * 位置 / uv / 索引指向 context 那块整几何的对应段,变换 / 颜色 / 混合取本节点的 group 量(照 Pixi BatchableGraphics)。
 *
 * 与 Pixi 的差别:
 * - Pixi 对顶点数 ≥ 200 的 context(`GpuGraphicsContext.isBatchable === false`)不进合批,而是整块几何单独画、
 *   在着色器里乘 uTransformMatrix / uColor;这里一律交合批元素(CPU 变换、颜色按 BatchableGraphics.color 量化),
 *   节点有 tint / alpha 时颜色可能差 1 个 8 位量化级。是否本应合批见 `batched`。
 * - Pixi 在节点区段建好后不再更新 roundPixels;这里每次收集都取当前值。
 * - destroy 时摘掉挂在 context 上的监听(Pixi 留着,共享 context 会一直引用已销毁节点)。
 */
import type { ColorSource } from '../color/Color';
import type { RenderCollector } from '../core/contracts';
import type { Matrix } from '../math/Matrix';
import type { PointData } from '../math/Point';
import type { Bounds } from '../scene/Bounds';
import type { ContainerOptions, DestroyOptions } from '../scene/Container';
import { ViewContainer } from '../scene/ViewContainer';
import type { Texture } from '../textures/Texture';
import { getBatchableGraphics, returnBatchableGraphics, type BatchableGraphics } from './BatchableGraphics';
import type { FillInput, StrokeInput, StrokeStyle } from './FillTypes';
import { GraphicsContext } from './GraphicsContext';
import { GraphicsContextSystem, type GpuGraphicsContext } from './GraphicsContextSystem';
import type { GraphicsPath } from './path/GraphicsPath';
import type { RoundedPoint } from './path/roundShape';

export interface GraphicsOptions extends ContainerOptions {
  /** 共享的绘制上下文;不给就自建一个(随节点销毁) */
  context?: GraphicsContext;
  roundPixels?: boolean;
}

type ContextMethod = keyof GraphicsContext;

export class Graphics extends ViewContainer {
  override renderPipeId = 'graphics';
  /** 按 Pixi 规则这个 context 是否并进合批(顶点 < 200 且 batchMode 允许);只作信息,渲染一律走合批元素 */
  batched = false;
  /** 视图变了(context 更新 / 换 context),下次收集时重建本节点的区段 */
  didViewUpdate = true;
  private _context: GraphicsContext = null as unknown as GraphicsContext;
  private _ownedContext: GraphicsContext | null = null;
  /** 本节点的区段(照 Pixi GraphicsPipe 的 GraphicsGpuData.batches) */
  private _batches: BatchableGraphics[] = [];
  private _builtFrom: GpuGraphicsContext | null = null;

  constructor(options?: GraphicsOptions | GraphicsContext) {
    if (options instanceof GraphicsContext) {
      options = { context: options };
    }
    const { context, roundPixels, ...rest } = options || {};
    super({ label: 'Graphics', ...rest });
    if (!context) {
      this.context = this._ownedContext = new GraphicsContext();
      this.context.autoGarbageCollect = true;
    } else {
      this.context = context;
    }
    this.didViewUpdate = true;
    this.allowChildren = false;
    this.roundPixels = roundPixels ?? false;
  }

  set context(context: GraphicsContext) {
    if (context === this._context) return;
    if (this._context) {
      this._context.off('update', this.onViewUpdate, this);
      this._context.off('unload', this.unload, this);
    }
    this._context = context;
    this._context.on('update', this.onViewUpdate, this);
    this._context.on('unload', this.unload, this);
    this.onViewUpdate();
  }

  get context(): GraphicsContext {
    return this._context;
  }

  override get bounds(): Bounds {
    return this._context.bounds;
  }

  protected updateBounds(): void {}

  override containsPoint(point: PointData): boolean {
    return this._context.containsPoint(point);
  }

  override onViewUpdate(): void {
    super.onViewUpdate();
    this.didViewUpdate = true;
  }

  /** context 丢了三角化缓存:本节点区段作废 */
  unload(): void {
    this._destroyBatches();
    this._builtFrom = null;
    this.onViewUpdate();
  }

  override collectRenderables(collector: RenderCollector): void {
    const context = this._context;
    if (!context) return;
    const gpuContext = GraphicsContextSystem.updateGpuContext(context);
    this.batched = gpuContext.isBatchable;
    if (!gpuContext.isBatchable) {
      // 照 Pixi:大图形不进合批,context 的区段按本地坐标画,节点变换 / 颜色走 localUniforms
      if (gpuContext.batches.length) collector.addUnbatched(this, gpuContext.batches);
      return;
    }
    if (this.didViewUpdate || this._builtFrom !== gpuContext) {
      this._rebuild(gpuContext);
    }
    const batches = this._batches;
    const roundPixels = this._roundPixels;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      batch.roundPixels = roundPixels;
      collector.addBatchable(batch);
    }
  }

  /** 照 Pixi GraphicsPipe._updateBatchesForRenderable:把 context 的区段复制一份挂到本节点 */
  private _rebuild(gpuContext: GpuGraphicsContext): void {
    this.didViewUpdate = false;
    this._destroyBatches();
    this._builtFrom = gpuContext;
    const roundPixels = this._roundPixels;
    this._batches = gpuContext.batches.map((batch) => {
      const batchClone = getBatchableGraphics();
      batch.copyTo(batchClone);
      batchClone.renderable = this;
      batchClone.roundPixels = roundPixels;
      return batchClone;
    });
  }

  private _destroyBatches(): void {
    for (let i = 0; i < this._batches.length; i++) returnBatchableGraphics(this._batches[i]);
    this._batches.length = 0;
  }

  override destroy(options?: DestroyOptions | boolean): void {
    if (this.destroyed) return;
    if (this._ownedContext && !options) {
      this._ownedContext.destroy(options);
    } else if (options === true || (options as DestroyOptions | undefined)?.context === true) {
      this._context.destroy(options);
    }
    if (this._context) {
      this._context.off('update', this.onViewUpdate, this);
      this._context.off('unload', this.unload, this);
    }
    this._destroyBatches();
    this._builtFrom = null;
    this._ownedContext = null;
    this._context = null as unknown as GraphicsContext;
    super.destroy(options);
  }

  private _callContextMethod(method: ContextMethod, args: unknown[]): this {
    (this.context as unknown as Record<ContextMethod, (...a: unknown[]) => unknown>)[method](...args);
    return this;
  }

  // --------------------------------------- GraphicsContext 代理 ---------------------------------------

  setFillStyle(style: FillInput): this {
    return this._callContextMethod('setFillStyle', [style]);
  }

  setStrokeStyle(style: StrokeInput): this {
    return this._callContextMethod('setStrokeStyle', [style]);
  }

  fill(style?: FillInput): this;
  /** @deprecated 照 Pixi 8.0:改用 fill({ color, alpha }) */
  fill(color: ColorSource, alpha?: number): this;
  fill(...args: unknown[]): this {
    return this._callContextMethod('fill', args);
  }

  stroke(style?: StrokeInput): this {
    return this._callContextMethod('stroke', [style]);
  }

  texture(texture: Texture): this;
  texture(texture: Texture, tint?: ColorSource, dx?: number, dy?: number, dw?: number, dh?: number): this;
  texture(...args: unknown[]): this {
    return this._callContextMethod('texture', args);
  }

  beginPath(): this {
    return this._callContextMethod('beginPath', []);
  }

  cut(): this {
    return this._callContextMethod('cut', []);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): this;
  arc(...args: unknown[]): this {
    return this._callContextMethod('arc', args);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this;
  arcTo(...args: unknown[]): this {
    return this._callContextMethod('arcTo', args);
  }

  arcToSvg(rx: number, ry: number, xAxisRotation: number, largeArcFlag: number, sweepFlag: number, x: number, y: number): this;
  arcToSvg(...args: unknown[]): this {
    return this._callContextMethod('arcToSvg', args);
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number, smoothness?: number): this;
  bezierCurveTo(...args: unknown[]): this {
    return this._callContextMethod('bezierCurveTo', args);
  }

  closePath(): this {
    return this._callContextMethod('closePath', []);
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number): this;
  ellipse(...args: unknown[]): this {
    return this._callContextMethod('ellipse', args);
  }

  circle(x: number, y: number, radius: number): this;
  circle(...args: unknown[]): this {
    return this._callContextMethod('circle', args);
  }

  path(path: GraphicsPath): this;
  path(...args: unknown[]): this {
    return this._callContextMethod('path', args);
  }

  lineTo(x: number, y: number): this;
  lineTo(...args: unknown[]): this {
    return this._callContextMethod('lineTo', args);
  }

  moveTo(x: number, y: number): this;
  moveTo(...args: unknown[]): this {
    return this._callContextMethod('moveTo', args);
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number, smoothness?: number): this;
  quadraticCurveTo(...args: unknown[]): this {
    return this._callContextMethod('quadraticCurveTo', args);
  }

  rect(x: number, y: number, w: number, h: number): this;
  rect(...args: unknown[]): this {
    return this._callContextMethod('rect', args);
  }

  roundRect(x: number, y: number, w: number, h: number, radius?: number): this;
  roundRect(...args: unknown[]): this {
    return this._callContextMethod('roundRect', args);
  }

  poly(points: number[] | PointData[], close?: boolean): this;
  poly(...args: unknown[]): this {
    return this._callContextMethod('poly', args);
  }

  regularPoly(x: number, y: number, radius: number, sides: number, rotation?: number, transform?: Matrix): this;
  regularPoly(...args: unknown[]): this {
    return this._callContextMethod('regularPoly', args);
  }

  roundPoly(x: number, y: number, radius: number, sides: number, corner: number, rotation?: number): this;
  roundPoly(...args: unknown[]): this {
    return this._callContextMethod('roundPoly', args);
  }

  roundShape(points: RoundedPoint[], radius: number, useQuadratic?: boolean, smoothness?: number): this;
  roundShape(...args: unknown[]): this {
    return this._callContextMethod('roundShape', args);
  }

  filletRect(x: number, y: number, width: number, height: number, fillet: number): this;
  filletRect(...args: unknown[]): this {
    return this._callContextMethod('filletRect', args);
  }

  chamferRect(x: number, y: number, width: number, height: number, chamfer: number, transform?: Matrix): this;
  chamferRect(...args: unknown[]): this {
    return this._callContextMethod('chamferRect', args);
  }

  star(x: number, y: number, points: number, radius: number, innerRadius?: number, rotation?: number): this;
  star(...args: unknown[]): this {
    return this._callContextMethod('star', args);
  }

  svg(svg: string): this;
  svg(...args: unknown[]): this {
    return this._callContextMethod('svg', args);
  }

  restore(): this;
  restore(...args: unknown[]): this {
    return this._callContextMethod('restore', args);
  }

  save(): this {
    return this._callContextMethod('save', []);
  }

  getTransform(): Matrix {
    return this.context.getTransform();
  }

  resetTransform(): this {
    return this._callContextMethod('resetTransform', []);
  }

  rotateTransform(angle: number): this;
  rotateTransform(...args: unknown[]): this {
    return this._callContextMethod('rotate', args);
  }

  scaleTransform(x: number, y?: number): this;
  scaleTransform(...args: unknown[]): this {
    return this._callContextMethod('scale', args);
  }

  setTransform(transform: Matrix): this;
  setTransform(a: number, b: number, c: number, d: number, dx: number, dy: number): this;
  setTransform(a: number | Matrix, b?: number, c?: number, d?: number, dx?: number, dy?: number): this;
  setTransform(...args: unknown[]): this {
    return this._callContextMethod('setTransform', args);
  }

  transform(transform: Matrix): this;
  transform(a: number, b: number, c: number, d: number, dx: number, dy: number): this;
  transform(a: number | Matrix, b?: number, c?: number, d?: number, dx?: number, dy?: number): this;
  transform(...args: unknown[]): this {
    return this._callContextMethod('transform', args);
  }

  translateTransform(x: number, y?: number): this;
  translateTransform(...args: unknown[]): this {
    return this._callContextMethod('translate', args);
  }

  clear(): this {
    return this._callContextMethod('clear', []);
  }

  get fillStyle(): GraphicsContext['fillStyle'] {
    return this._context.fillStyle;
  }
  set fillStyle(value: FillInput) {
    this._context.fillStyle = value;
  }

  get strokeStyle(): GraphicsContext['strokeStyle'] {
    return this._context.strokeStyle;
  }
  set strokeStyle(value: StrokeStyle) {
    this._context.strokeStyle = value;
  }

  /** deep = false:与本节点共享 context(照 Pixi:本节点随之不再"拥有"它);deep = true:复制一份 context */
  clone(deep = false): Graphics {
    if (deep) {
      return new Graphics(this._context.clone());
    }
    this._ownedContext = null;
    return new Graphics(this._context);
  }

  // -------- v7 弃用写法(照 Pixi 8 保留,不打日志) ---------

  /** @deprecated 改用 setStrokeStyle */
  lineStyle(width?: number, color?: ColorSource, alpha?: number): this {
    const strokeStyle: StrokeStyle = {};
    if (width) strokeStyle.width = width;
    if (color) strokeStyle.color = color;
    if (alpha) strokeStyle.alpha = alpha;
    this.context.strokeStyle = strokeStyle;
    return this;
  }

  /** @deprecated 改用 fill */
  beginFill(color: ColorSource, alpha?: number): this {
    const fillStyle: { color?: ColorSource; alpha?: number } = {};
    if (color !== undefined) fillStyle.color = color;
    if (alpha !== undefined) fillStyle.alpha = alpha;
    this.context.fillStyle = fillStyle;
    return this;
  }

  /** @deprecated 改用 fill */
  endFill(): this {
    this.context.fill();
    const strokeStyle = this.context.strokeStyle;
    if (strokeStyle.width !== GraphicsContext.defaultStrokeStyle.width
      || strokeStyle.color !== GraphicsContext.defaultStrokeStyle.color
      || strokeStyle.alpha !== GraphicsContext.defaultStrokeStyle.alpha) {
      this.context.stroke();
    }
    return this;
  }

  /** @deprecated 改名为 circle */
  drawCircle(x: number, y: number, radius: number): this {
    return this._callContextMethod('circle', [x, y, radius]);
  }

  /** @deprecated 改名为 ellipse */
  drawEllipse(x: number, y: number, radiusX: number, radiusY: number): this {
    return this._callContextMethod('ellipse', [x, y, radiusX, radiusY]);
  }

  /** @deprecated 改名为 poly */
  drawPolygon(points: number[] | PointData[], close?: boolean): this {
    return this._callContextMethod('poly', [points, close]);
  }

  /** @deprecated 改名为 rect */
  drawRect(x: number, y: number, w: number, h: number): this {
    return this._callContextMethod('rect', [x, y, w, h]);
  }

  /** @deprecated 改名为 roundRect */
  drawRoundedRect(x: number, y: number, w: number, h: number, radius?: number): this {
    return this._callContextMethod('roundRect', [x, y, w, h, radius]);
  }

  /** @deprecated 改名为 star */
  drawStar(x: number, y: number, points: number, radius: number, innerRadius?: number, rotation?: number): this {
    return this._callContextMethod('star', [x, y, points, radius, innerRadius, rotation]);
  }
}
