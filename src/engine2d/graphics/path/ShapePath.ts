/**
 * 路径 → 形状图元表(矩形 / 圆 / 多边形…,折线与曲线细分进多边形)。移植自 PixiJS v8.17(MIT):
 * scene/graphics/shared/path/ShapePath。
 */
import { Bounds } from '../../scene/Bounds';
import type { Matrix } from '../../math/Matrix';
import { Rectangle } from '../../math/Rectangle';
import { Circle } from '../../math/shapes/Circle';
import { Ellipse } from '../../math/shapes/Ellipse';
import { Polygon } from '../../math/shapes/Polygon';
import { RoundedRectangle } from '../../math/shapes/RoundedRectangle';
import type { ShapePrimitive } from '../../math/shapes/ShapePrimitive';
import type { PointData } from '../../math/Point';
import { buildAdaptiveBezier } from '../buildCommands/buildAdaptiveBezier';
import { buildAdaptiveQuadratic } from '../buildCommands/buildAdaptiveQuadratic';
import { buildArc } from '../buildCommands/buildArc';
import { buildArcTo } from '../buildCommands/buildArcTo';
import { buildArcToSvg } from '../buildCommands/buildArcToSvg';
import type { GraphicsPath } from './GraphicsPath';
import { roundedShapeArc, roundedShapeQuadraticCurve, type RoundedPoint } from './roundShape';

/** 一个形状图元 + 它的变换 + 洞 */
export interface ShapePrimitiveWithHoles {
  shape: ShapePrimitive;
  transform?: Matrix;
  holes?: ShapePrimitiveWithHoles[];
}

const tempRectangle = new Rectangle();

type Dispatch = Record<string, (...args: unknown[]) => unknown>;

export class ShapePath {
  shapePrimitives: ShapePrimitiveWithHoles[] = [];
  private _currentPoly: Polygon | null = null;
  private readonly _graphicsPath2D: GraphicsPath;
  private readonly _bounds = new Bounds();
  readonly signed: boolean;

  constructor(graphicsPath2D: GraphicsPath) {
    this._graphicsPath2D = graphicsPath2D;
    this.signed = graphicsPath2D.checkForHoles;
  }

  moveTo(x: number, y: number): this {
    this.startPoly(x, y);
    return this;
  }

  lineTo(x: number, y: number): this {
    this._ensurePoly();
    const points = this._currentPoly!.points;
    const fromX = points[points.length - 2];
    const fromY = points[points.length - 1];
    if (fromX !== x || fromY !== y) {
      points.push(x, y);
    }
    return this;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): this {
    this._ensurePoly(false);
    const points = this._currentPoly!.points;
    buildArc(points, x, y, radius, startAngle, endAngle, counterclockwise);
    return this;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this {
    this._ensurePoly();
    const points = this._currentPoly!.points;
    buildArcTo(points, x1, y1, x2, y2, radius);
    return this;
  }

  arcToSvg(rx: number, ry: number, xAxisRotation: number, largeArcFlag: number, sweepFlag: number, x: number, y: number): this {
    // 照 Pixi:这里不 _ensurePoly(没有当前多边形时 Pixi 同样会抛)
    const points = this._currentPoly!.points;
    buildArcToSvg(points, this._currentPoly!.lastX, this._currentPoly!.lastY, x, y, rx, ry, xAxisRotation, largeArcFlag, sweepFlag);
    return this;
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number, smoothness?: number): this {
    this._ensurePoly();
    const currentPoly = this._currentPoly!;
    buildAdaptiveBezier(currentPoly.points, currentPoly.lastX, currentPoly.lastY, cp1x, cp1y, cp2x, cp2y, x, y, smoothness);
    return this;
  }

  quadraticCurveTo(cp1x: number, cp1y: number, x: number, y: number, smoothing?: number): this {
    this._ensurePoly();
    const currentPoly = this._currentPoly!;
    buildAdaptiveQuadratic(currentPoly.points, currentPoly.lastX, currentPoly.lastY, cp1x, cp1y, x, y, smoothing);
    return this;
  }

  closePath(): this {
    this.endPoly(true);
    return this;
  }

  addPath(path: GraphicsPath, transform?: Matrix): this {
    this.endPoly();
    if (transform && !transform.isIdentity()) {
      path = path.clone(true);
      path.transform(transform);
    }
    const shapePrimitives = this.shapePrimitives;
    const start = shapePrimitives.length;
    for (let i = 0; i < path.instructions.length; i++) {
      const instruction = path.instructions[i];
      (this as unknown as Dispatch)[instruction.action](...instruction.data);
    }
    if (path.checkForHoles && shapePrimitives.length - start > 1) {
      let mainShape: ShapePrimitiveWithHoles | null = null;
      for (let i = start; i < shapePrimitives.length; i++) {
        const shapePrimitive = shapePrimitives[i];
        if (shapePrimitive.shape.type === 'polygon') {
          const polygon = shapePrimitive.shape as Polygon;
          const mainPolygon = mainShape?.shape as Polygon | undefined;
          if (mainPolygon && mainPolygon.containsPolygon(polygon)) {
            mainShape!.holes ||= [];
            mainShape!.holes.push(shapePrimitive);
            shapePrimitives.copyWithin(i, i + 1);
            shapePrimitives.length--;
            i--;
          } else {
            mainShape = shapePrimitive;
          }
        }
      }
    }
    return this;
  }

  finish(closePath = false): void {
    this.endPoly(closePath);
  }

  rect(x: number, y: number, w: number, h: number, transform?: Matrix): this {
    this.drawShape(new Rectangle(x, y, w, h), transform);
    return this;
  }

  circle(x: number, y: number, radius: number, transform?: Matrix): this {
    this.drawShape(new Circle(x, y, radius), transform);
    return this;
  }

  poly(points: number[] | PointData[], close?: boolean, transform?: Matrix): this {
    const polygon = new Polygon(points);
    // 照 Pixi:不传 close 时留 undefined(描边按闭合画,命中按不闭合判)
    polygon.closePath = close as boolean;
    this.drawShape(polygon, transform);
    return this;
  }

  regularPoly(x: number, y: number, radius: number, sides: number, rotation = 0, transform?: Matrix): this {
    sides = Math.max(sides | 0, 3);
    const startAngle = -1 * Math.PI / 2 + rotation;
    const delta = Math.PI * 2 / sides;
    const polygon: number[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = startAngle - i * delta;
      polygon.push(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
    }
    this.poly(polygon, true, transform);
    return this;
  }

  roundPoly(x: number, y: number, radius: number, sides: number, corner: number, rotation = 0, smoothness?: number): this {
    sides = Math.max(sides | 0, 3);
    if (corner <= 0) {
      return this.regularPoly(x, y, radius, sides, rotation);
    }
    const sideLength = radius * Math.sin(Math.PI / sides) - 1e-3;
    corner = Math.min(corner, sideLength);
    const startAngle = -1 * Math.PI / 2 + rotation;
    const delta = Math.PI * 2 / sides;
    const internalAngle = (sides - 2) * Math.PI / sides / 2;
    for (let i = 0; i < sides; i++) {
      const angle = i * delta + startAngle;
      const x0 = x + radius * Math.cos(angle);
      const y0 = y + radius * Math.sin(angle);
      const a1 = angle + Math.PI + internalAngle;
      const a2 = angle - Math.PI - internalAngle;
      const x1 = x0 + corner * Math.cos(a1);
      const y1 = y0 + corner * Math.sin(a1);
      const x3 = x0 + corner * Math.cos(a2);
      const y3 = y0 + corner * Math.sin(a2);
      if (i === 0) {
        this.moveTo(x1, y1);
      } else {
        this.lineTo(x1, y1);
      }
      this.quadraticCurveTo(x0, y0, x3, y3, smoothness);
    }
    return this.closePath();
  }

  roundShape(points: RoundedPoint[], radius: number, useQuadratic = false, smoothness?: number): this {
    if (points.length < 3) {
      return this;
    }
    if (useQuadratic) {
      roundedShapeQuadraticCurve(this, points, radius, smoothness);
    } else {
      roundedShapeArc(this, points, radius);
    }
    return this.closePath();
  }

  filletRect(x: number, y: number, width: number, height: number, fillet: number): this {
    if (fillet === 0) {
      return this.rect(x, y, width, height);
    }
    const maxFillet = Math.min(width, height) / 2;
    const inset = Math.min(maxFillet, Math.max(-maxFillet, fillet));
    const right = x + width;
    const bottom = y + height;
    const dir = inset < 0 ? -inset : 0;
    const size = Math.abs(inset);
    return this
      .moveTo(x, y + size)
      .arcTo(x + dir, y + dir, x + size, y, size)
      .lineTo(right - size, y)
      .arcTo(right - dir, y + dir, right, y + size, size)
      .lineTo(right, bottom - size)
      .arcTo(right - dir, bottom - dir, x + width - size, bottom, size)
      .lineTo(x + size, bottom)
      .arcTo(x + dir, bottom - dir, x, bottom - size, size)
      .closePath();
  }

  chamferRect(x: number, y: number, width: number, height: number, chamfer: number, transform?: Matrix): this {
    if (chamfer <= 0) {
      return this.rect(x, y, width, height);
    }
    const inset = Math.min(chamfer, Math.min(width, height) / 2);
    const right = x + width;
    const bottom = y + height;
    const points = [
      x + inset, y,
      right - inset, y,
      right, y + inset,
      right, bottom - inset,
      right - inset, bottom,
      x + inset, bottom,
      x, bottom - inset,
      x, y + inset,
    ];
    for (let i = points.length - 1; i >= 2; i -= 2) {
      if (points[i] === points[i - 2] && points[i - 1] === points[i - 3]) {
        points.splice(i - 1, 2);
      }
    }
    return this.poly(points, true, transform);
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number, transform?: Matrix): this {
    this.drawShape(new Ellipse(x, y, radiusX, radiusY), transform);
    return this;
  }

  roundRect(x: number, y: number, w: number, h: number, radius?: number, transform?: Matrix): this {
    this.drawShape(new RoundedRectangle(x, y, w, h, radius), transform);
    return this;
  }

  drawShape(shape: ShapePrimitive, matrix?: Matrix): this {
    this.endPoly();
    this.shapePrimitives.push({ shape, transform: matrix });
    return this;
  }

  startPoly(x: number, y: number): this {
    let currentPoly = this._currentPoly;
    if (currentPoly) {
      this.endPoly();
    }
    currentPoly = new Polygon();
    currentPoly.points.push(x, y);
    this._currentPoly = currentPoly;
    return this;
  }

  endPoly(closePath = false): this {
    const shape = this._currentPoly;
    if (shape && shape.points.length > 2) {
      shape.closePath = closePath;
      this.shapePrimitives.push({ shape });
    }
    this._currentPoly = null;
    return this;
  }

  private _ensurePoly(start = true): void {
    if (this._currentPoly) return;
    this._currentPoly = new Polygon();
    if (start) {
      const lastShape = this.shapePrimitives[this.shapePrimitives.length - 1];
      if (lastShape) {
        let lx = lastShape.shape.x;
        let ly = lastShape.shape.y;
        if (lastShape.transform && !lastShape.transform.isIdentity()) {
          const t = lastShape.transform;
          const tempX = lx;
          lx = t.a * lx + t.c * ly + t.tx;
          ly = t.b * tempX + t.d * ly + t.ty;
        }
        this._currentPoly.points.push(lx, ly);
      } else {
        this._currentPoly.points.push(0, 0);
      }
    }
  }

  buildPath(): void {
    const path = this._graphicsPath2D;
    this.shapePrimitives.length = 0;
    this._currentPoly = null;
    for (let i = 0; i < path.instructions.length; i++) {
      const instruction = path.instructions[i];
      (this as unknown as Dispatch)[instruction.action](...instruction.data);
    }
    this.finish();
  }

  get bounds(): Bounds {
    const bounds = this._bounds;
    bounds.clear();
    const shapePrimitives = this.shapePrimitives;
    for (let i = 0; i < shapePrimitives.length; i++) {
      const shapePrimitive = shapePrimitives[i];
      const boundsRect = shapePrimitive.shape.getBounds(tempRectangle);
      if (shapePrimitive.transform) {
        bounds.addRect(boundsRect, shapePrimitive.transform);
      } else {
        bounds.addRect(boundsRect);
      }
    }
    return bounds;
  }
}
