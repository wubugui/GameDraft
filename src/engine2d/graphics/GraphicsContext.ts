/**
 * 矢量绘制上下文(指令表 + 当前路径 / 样式 / 变换栈)。移植自 PixiJS v8.17(MIT):scene/graphics/shared/GraphicsContext。
 * 可被多个 Graphics 共享;内容变了发 'update'。三角化在 GraphicsContextSystem 里按需(脏了才)做。
 *
 * 与 Pixi 的差别:`svg()` 未移植(游戏未用),调用会抛错;弃用写法 `fill(color, alpha)` 行为相同但不打弃用日志。
 */
import { Color, type ColorSource } from '../color/Color';
import { Matrix } from '../math/Matrix';
import { Point, type PointData } from '../math/Point';
import { Bounds } from '../scene/Bounds';
import type { Shader } from '../shader/Shader';
import { Texture } from '../textures/Texture';
import { uid } from '../utils/uid';
import { EventEmitter } from '../utils/EventEmitter';
import type { ConvertedFillStyle, ConvertedStrokeStyle, FillInput, StrokeInput } from './FillTypes';
import type { GpuGraphicsContext } from './GraphicsContextSystem';
import { GraphicsPath } from './path/GraphicsPath';
import type { RoundedPoint } from './path/roundShape';
import { toFillStyle, toStrokeStyle } from './utils/convertFillInputToFillStyle';
import { getMaxMiterRatio } from './utils/getMaxMiterRatio';
import { pixiColorNumber } from './utils/pixiColor';

export type BatchMode = 'auto' | 'batch' | 'no-batch';

export interface FillInstruction {
  action: 'fill' | 'cut';
  data: { style: ConvertedFillStyle; path: GraphicsPath; hole?: GraphicsPath };
}

export interface StrokeInstruction {
  action: 'stroke';
  data: { style: ConvertedStrokeStyle; path: GraphicsPath; hole?: GraphicsPath };
}

export interface TextureInstruction {
  action: 'texture';
  data: {
    image: Texture;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
    transform: Matrix;
    alpha: number;
    /** 0xRRGGBB tint */
    style: number;
  };
}

export type GraphicsInstructions = FillInstruction | StrokeInstruction | TextureInstruction;

/** 销毁选项(照 Pixi TypeOrBool<TextureDestroyOptions>) */
export interface TextureDestroyOptions {
  texture?: boolean;
  textureSource?: boolean;
  context?: boolean;
  children?: boolean;
  style?: boolean;
}

interface GraphicsState {
  transform: Matrix;
  fillStyle: ConvertedFillStyle;
  strokeStyle: ConvertedStrokeStyle;
}

const tmpPoint = new Point();
const tempMatrix = new Matrix();

export class GraphicsContext extends EventEmitter<{
  update: GraphicsContext;
  destroy: GraphicsContext;
  unload: GraphicsContext;
}> {
  static defaultFillStyle: ConvertedFillStyle = {
    color: 0xffffff,
    alpha: 1,
    texture: Texture.WHITE,
    matrix: null,
    fill: null,
    textureSpace: 'local',
  };

  static defaultStrokeStyle: ConvertedStrokeStyle = {
    width: 1,
    color: 0xffffff,
    alpha: 1,
    alignment: 0.5,
    miterLimit: 10,
    cap: 'butt',
    join: 'miter',
    texture: Texture.WHITE,
    matrix: null,
    fill: null,
    textureSpace: 'local',
    pixelLine: false,
  };

  /** @internal 三角化缓存(GraphicsContextSystem 维护;Pixi 的 `_gpuData[renderer.uid]`) */
  _gpuContext: GpuGraphicsContext | null = null;
  autoGarbageCollect = true;
  _gcLastUsed = -1;
  readonly uid = uid('graphicsContext');
  /** 指令改了、几何要重建 */
  dirty = true;
  batchMode: BatchMode = 'auto';
  instructions: GraphicsInstructions[] = [];
  /** Pixi 用它换掉非合批路径的着色器;这里只参与合批判定 */
  customShader?: Shader;
  destroyed = false;
  private _activePath = new GraphicsPath();
  private _transform = new Matrix();
  private _fillStyle: ConvertedFillStyle = { ...GraphicsContext.defaultFillStyle };
  private _strokeStyle: ConvertedStrokeStyle = { ...GraphicsContext.defaultStrokeStyle };
  private _stateStack: GraphicsState[] = [];
  private _tick = 0;
  private _bounds = new Bounds();
  private _boundsDirty = true;

  clone(): GraphicsContext {
    const clone = new GraphicsContext();
    clone.batchMode = this.batchMode;
    clone.instructions = this.instructions.slice();
    clone._activePath = this._activePath.clone();
    clone._transform = this._transform.clone();
    clone._fillStyle = { ...this._fillStyle };
    clone._strokeStyle = { ...this._strokeStyle };
    clone._stateStack = this._stateStack.slice();
    clone._bounds = this._bounds.clone();
    clone._boundsDirty = true;
    return clone;
  }

  get fillStyle(): ConvertedFillStyle {
    return this._fillStyle;
  }
  set fillStyle(value: FillInput) {
    this._fillStyle = toFillStyle(value, GraphicsContext.defaultFillStyle);
  }

  get strokeStyle(): ConvertedStrokeStyle {
    return this._strokeStyle;
  }
  set strokeStyle(value: FillInput) {
    this._strokeStyle = toStrokeStyle(value as StrokeInput, GraphicsContext.defaultStrokeStyle);
  }

  setFillStyle(style: FillInput): this {
    this._fillStyle = toFillStyle(style, GraphicsContext.defaultFillStyle);
    return this;
  }

  /** 照 Pixi 源码:这里用的是 toFillStyle(以描边缺省为底),不是 toStrokeStyle */
  setStrokeStyle(style: StrokeInput): this {
    this._strokeStyle = toFillStyle(style as FillInput, GraphicsContext.defaultStrokeStyle) as ConvertedStrokeStyle;
    return this;
  }

  texture(texture: Texture): this;
  texture(texture: Texture, tint?: ColorSource, dx?: number, dy?: number, dw?: number, dh?: number): this;
  texture(texture: Texture, tint?: ColorSource, dx?: number, dy?: number, dw?: number, dh?: number): this {
    this.instructions.push({
      action: 'texture',
      data: {
        image: texture,
        dx: dx || 0,
        dy: dy || 0,
        dw: dw || texture.frame.width,
        dh: dh || texture.frame.height,
        transform: this._transform.clone(),
        alpha: this._fillStyle.alpha,
        style: tint || tint === 0 ? pixiColorNumber(Color.shared.setValue(tint)) : 0xffffff,
      },
    });
    this.onUpdate();
    return this;
  }

  beginPath(): this {
    this._activePath = new GraphicsPath();
    return this;
  }

  fill(style?: FillInput): this;
  /** @deprecated 照 Pixi 8.0:改用 fill({ color, alpha }) */
  fill(color: ColorSource, alpha: number): this;
  fill(style?: FillInput, alpha?: number): this {
    let path: GraphicsPath;
    const lastInstruction = this.instructions[this.instructions.length - 1];
    if (this._tick === 0 && lastInstruction?.action === 'stroke') {
      path = lastInstruction.data.path;
    } else {
      path = this._activePath.clone();
    }
    if (!path) return this;
    if (style != null) {
      if (alpha !== undefined && typeof style === 'number') {
        style = { color: style, alpha };
      }
      this._fillStyle = toFillStyle(style, GraphicsContext.defaultFillStyle);
    }
    this.instructions.push({
      action: 'fill',
      // TODO copy fill style!(Pixi 原注释:样式对象按引用存)
      data: { style: this.fillStyle, path },
    });
    this.onUpdate();
    this._initNextPathLocation();
    this._tick = 0;
    return this;
  }

  private _initNextPathLocation(): void {
    const { x, y } = this._activePath.getLastPoint(Point.shared);
    this._activePath.clear();
    this._activePath.moveTo(x, y);
  }

  stroke(style?: StrokeInput): this {
    let path: GraphicsPath;
    const lastInstruction = this.instructions[this.instructions.length - 1];
    if (this._tick === 0 && lastInstruction?.action === 'fill') {
      path = lastInstruction.data.path;
    } else {
      path = this._activePath.clone();
    }
    if (!path) return this;
    if (style != null) {
      this._strokeStyle = toStrokeStyle(style, GraphicsContext.defaultStrokeStyle);
    }
    this.instructions.push({
      action: 'stroke',
      // TODO copy fill style!
      data: { style: this.strokeStyle, path },
    });
    this.onUpdate();
    this._initNextPathLocation();
    this._tick = 0;
    return this;
  }

  cut(): this {
    for (let i = 0; i < 2; i++) {
      const lastInstruction = this.instructions[this.instructions.length - 1 - i];
      const holePath = this._activePath.clone();
      if (lastInstruction) {
        if (lastInstruction.action === 'stroke' || lastInstruction.action === 'fill') {
          if (lastInstruction.data.hole) {
            lastInstruction.data.hole.addPath(holePath);
          } else {
            lastInstruction.data.hole = holePath;
            break;
          }
        }
      }
    }
    this._initNextPathLocation();
    return this;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): this {
    this._tick++;
    const t = this._transform;
    this._activePath.arc(
      t.a * x + t.c * y + t.tx,
      t.b * x + t.d * y + t.ty,
      radius,
      startAngle,
      endAngle,
      counterclockwise,
    );
    return this;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this {
    this._tick++;
    const t = this._transform;
    this._activePath.arcTo(
      t.a * x1 + t.c * y1 + t.tx,
      t.b * x1 + t.d * y1 + t.ty,
      t.a * x2 + t.c * y2 + t.tx,
      t.b * x2 + t.d * y2 + t.ty,
      radius,
    );
    return this;
  }

  arcToSvg(rx: number, ry: number, xAxisRotation: number, largeArcFlag: number, sweepFlag: number, x: number, y: number): this {
    this._tick++;
    const t = this._transform;
    this._activePath.arcToSvg(
      rx,
      ry,
      xAxisRotation, // should we rotate this with transform??
      largeArcFlag,
      sweepFlag,
      t.a * x + t.c * y + t.tx,
      t.b * x + t.d * y + t.ty,
    );
    return this;
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number, smoothness?: number): this {
    this._tick++;
    const t = this._transform;
    this._activePath.bezierCurveTo(
      t.a * cp1x + t.c * cp1y + t.tx,
      t.b * cp1x + t.d * cp1y + t.ty,
      t.a * cp2x + t.c * cp2y + t.tx,
      t.b * cp2x + t.d * cp2y + t.ty,
      t.a * x + t.c * y + t.tx,
      t.b * x + t.d * y + t.ty,
      smoothness,
    );
    return this;
  }

  closePath(): this {
    this._tick++;
    this._activePath?.closePath();
    return this;
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number): this {
    this._tick++;
    this._activePath.ellipse(x, y, radiusX, radiusY, this._transform.clone());
    return this;
  }

  circle(x: number, y: number, radius: number): this {
    this._tick++;
    this._activePath.circle(x, y, radius, this._transform.clone());
    return this;
  }

  path(path: GraphicsPath): this {
    this._tick++;
    this._activePath.addPath(path, this._transform.clone());
    return this;
  }

  lineTo(x: number, y: number): this {
    this._tick++;
    const t = this._transform;
    this._activePath.lineTo(t.a * x + t.c * y + t.tx, t.b * x + t.d * y + t.ty);
    return this;
  }

  moveTo(x: number, y: number): this {
    this._tick++;
    const t = this._transform;
    const instructions = this._activePath.instructions;
    const transformedX = t.a * x + t.c * y + t.tx;
    const transformedY = t.b * x + t.d * y + t.ty;
    if (instructions.length === 1 && instructions[0].action === 'moveTo') {
      instructions[0].data[0] = transformedX;
      instructions[0].data[1] = transformedY;
      return this;
    }
    this._activePath.moveTo(transformedX, transformedY);
    return this;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number, smoothness?: number): this {
    this._tick++;
    const t = this._transform;
    this._activePath.quadraticCurveTo(
      t.a * cpx + t.c * cpy + t.tx,
      t.b * cpx + t.d * cpy + t.ty,
      t.a * x + t.c * y + t.tx,
      t.b * x + t.d * y + t.ty,
      smoothness,
    );
    return this;
  }

  rect(x: number, y: number, w: number, h: number): this {
    this._tick++;
    this._activePath.rect(x, y, w, h, this._transform.clone());
    return this;
  }

  roundRect(x: number, y: number, w: number, h: number, radius?: number): this {
    this._tick++;
    this._activePath.roundRect(x, y, w, h, radius, this._transform.clone());
    return this;
  }

  poly(points: number[] | PointData[], close?: boolean): this {
    this._tick++;
    this._activePath.poly(points, close, this._transform.clone());
    return this;
  }

  /** 照 Pixi:regularPoly / roundPoly / roundShape / filletRect / chamferRect 不套当前变换 */
  regularPoly(x: number, y: number, radius: number, sides: number, rotation = 0, transform?: Matrix): this {
    this._tick++;
    this._activePath.regularPoly(x, y, radius, sides, rotation, transform);
    return this;
  }

  roundPoly(x: number, y: number, radius: number, sides: number, corner: number, rotation?: number): this {
    this._tick++;
    this._activePath.roundPoly(x, y, radius, sides, corner, rotation);
    return this;
  }

  roundShape(points: RoundedPoint[], radius: number, useQuadratic?: boolean, smoothness?: number): this {
    this._tick++;
    this._activePath.roundShape(points, radius, useQuadratic, smoothness);
    return this;
  }

  filletRect(x: number, y: number, width: number, height: number, fillet: number): this {
    this._tick++;
    this._activePath.filletRect(x, y, width, height, fillet);
    return this;
  }

  chamferRect(x: number, y: number, width: number, height: number, chamfer: number, transform?: Matrix): this {
    this._tick++;
    this._activePath.chamferRect(x, y, width, height, chamfer, transform);
    return this;
  }

  star(x: number, y: number, points: number, radius: number, innerRadius = 0, rotation = 0): this {
    this._tick++;
    this._activePath.star(x, y, points, radius, innerRadius, rotation, this._transform.clone());
    return this;
  }

  /** 未移植(Pixi 的 SVGParser;游戏未用) */
  svg(_svg: string): this {
    void _svg;
    throw new Error('[engine2d] GraphicsContext.svg:未移植(游戏未用到)');
  }

  restore(): this {
    const state = this._stateStack.pop();
    if (state) {
      this._transform = state.transform;
      this._fillStyle = state.fillStyle;
      this._strokeStyle = state.strokeStyle;
    }
    return this;
  }

  save(): this {
    this._stateStack.push({
      transform: this._transform.clone(),
      fillStyle: { ...this._fillStyle },
      strokeStyle: { ...this._strokeStyle },
    });
    return this;
  }

  getTransform(): Matrix {
    return this._transform;
  }

  resetTransform(): this {
    this._transform.identity();
    return this;
  }

  rotate(angle: number): this {
    this._transform.rotate(angle);
    return this;
  }

  scale(x: number, y = x): this {
    this._transform.scale(x, y);
    return this;
  }

  setTransform(transform: Matrix): this;
  setTransform(a: number, b: number, c: number, d: number, dx: number, dy: number): this;
  setTransform(a: number | Matrix, b?: number, c?: number, d?: number, dx?: number, dy?: number): this;
  setTransform(a: number | Matrix, b?: number, c?: number, d?: number, dx?: number, dy?: number): this {
    if (a instanceof Matrix) {
      this._transform.set(a.a, a.b, a.c, a.d, a.tx, a.ty);
      return this;
    }
    this._transform.set(a, b as number, c as number, d as number, dx as number, dy as number);
    return this;
  }

  transform(transform: Matrix): this;
  transform(a: number, b: number, c: number, d: number, dx: number, dy: number): this;
  transform(a: number | Matrix, b?: number, c?: number, d?: number, dx?: number, dy?: number): this;
  transform(a: number | Matrix, b?: number, c?: number, d?: number, dx?: number, dy?: number): this {
    if (a instanceof Matrix) {
      this._transform.append(a);
      return this;
    }
    tempMatrix.set(a, b as number, c as number, d as number, dx as number, dy as number);
    this._transform.append(tempMatrix);
    return this;
  }

  translate(x: number, y = x): this {
    this._transform.translate(x, y);
    return this;
  }

  clear(): this {
    this._activePath.clear();
    this.instructions.length = 0;
    this.resetTransform();
    this.onUpdate();
    return this;
  }

  protected onUpdate(): void {
    this._boundsDirty = true;
    this.dirty = true;
    this.emit('update', this, 16);
  }

  /** 本地包围盒:填充取路径包围盒;描边按 (1 - alignment)·width 外扩(miter 拐角再乘最大斜接比) */
  get bounds(): Bounds {
    if (!this._boundsDirty) return this._bounds;
    this._boundsDirty = false;
    const bounds = this._bounds;
    bounds.clear();
    for (let i = 0; i < this.instructions.length; i++) {
      const instruction = this.instructions[i];
      const action = instruction.action;
      if (action === 'fill') {
        const data = instruction.data;
        bounds.addBounds(data.path.bounds);
      } else if (action === 'texture') {
        const data = instruction.data;
        bounds.addFrame(data.dx, data.dy, data.dx + data.dw, data.dy + data.dh, data.transform);
      }
      if (action === 'stroke') {
        const data = instruction.data;
        const alignment = data.style.alignment;
        let outerPadding = data.style.width * (1 - alignment);
        if (data.style.join === 'miter') {
          outerPadding *= getMaxMiterRatio(data.path, data.style.miterLimit);
        }
        const _bounds = data.path.bounds;
        bounds.addFrame(
          _bounds.minX - outerPadding,
          _bounds.minY - outerPadding,
          _bounds.maxX + outerPadding,
          _bounds.maxY + outerPadding,
        );
      }
    }
    if (!bounds.isValid) {
      bounds.set(0, 0, 0, 0);
    }
    return bounds;
  }

  /** 本地点是否落在任何填充 / 描边上(洞里不算) */
  containsPoint(point: PointData): boolean {
    if (!this.bounds.containsPoint(point.x, point.y)) return false;
    const instructions = this.instructions;
    let hasHit = false;
    for (let k = 0; k < instructions.length; k++) {
      const instruction = instructions[k];
      const data = instruction.data as FillInstruction['data'] & StrokeInstruction['data'];
      const path = data.path;
      if (!instruction.action || !path) continue;
      const style = data.style;
      const shapes = path.shapePath.shapePrimitives;
      for (let i = 0; i < shapes.length; i++) {
        const shape = shapes[i].shape;
        if (!style || !shape) continue;
        const transform = shapes[i].transform;
        const transformedPoint = transform ? transform.applyInverse(point, tmpPoint) : point;
        if (instruction.action === 'fill') {
          hasHit = shape.contains(transformedPoint.x, transformedPoint.y);
        } else {
          const strokeStyle = style;
          hasHit = shape.strokeContains(transformedPoint.x, transformedPoint.y, strokeStyle.width, strokeStyle.alignment);
        }
        const holes = data.hole;
        if (holes) {
          const holeShapes = holes.shapePath?.shapePrimitives;
          if (holeShapes) {
            for (let j = 0; j < holeShapes.length; j++) {
              if (holeShapes[j].shape.contains(transformedPoint.x, transformedPoint.y)) {
                hasHit = false;
              }
            }
          }
        }
        if (hasHit) {
          return true;
        }
      }
    }
    return hasHit;
  }

  /** 丢掉三角化缓存(下次渲染重建) */
  unload(): void {
    this.emit('unload', this);
    this._gpuContext?.destroy();
    this._gpuContext = null;
  }

  destroy(options: boolean | TextureDestroyOptions = false): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stateStack.length = 0;
    this._transform = null as unknown as Matrix;
    this.unload();
    this.emit('destroy', this);
    this.removeAllListeners();
    const destroyTexture = typeof options === 'boolean' ? options : options?.texture;
    if (destroyTexture) {
      const destroyTextureSource = typeof options === 'boolean' ? options : options?.textureSource;
      if (this._fillStyle.texture) {
        if (this._fillStyle.fill && 'uid' in this._fillStyle.fill) this._fillStyle.fill.destroy();
        else this._fillStyle.texture.destroy(destroyTextureSource);
      }
      if (this._strokeStyle.texture) {
        if (this._strokeStyle.fill && 'uid' in this._strokeStyle.fill) this._strokeStyle.fill.destroy();
        else this._strokeStyle.texture.destroy(destroyTextureSource);
      }
    }
    this._fillStyle = null as unknown as ConvertedFillStyle;
    this._strokeStyle = null as unknown as ConvertedStrokeStyle;
    this.instructions = null as unknown as GraphicsInstructions[];
    this._activePath = null as unknown as GraphicsPath;
    this._bounds = null as unknown as Bounds;
    this._stateStack = null as unknown as GraphicsState[];
    this.customShader = undefined;
    this._transform = null as unknown as Matrix;
  }
}
