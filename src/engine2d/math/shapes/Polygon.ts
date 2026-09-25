/**
 * 多边形。移植自 PixiJS v8.17(MIT):maths/shapes/Polygon。
 * 构造接受:扁平数组 [x,y,…]、点数组、或逐个传入的点 / 数字(与 Pixi 相同)。
 */
import { Rectangle } from '../Rectangle';
import type { PointData } from '../Point';
import { squaredDistanceToLineSegment } from './squaredDistanceToLineSegment';
import type { ShapePrimitive } from './ShapePrimitive';

export class Polygon implements ShapePrimitive {
  readonly type = 'polygon' as const;
  /** 扁平点表 [x0, y0, x1, y1, …] */
  points: number[];
  /** 描边时是否闭合(Pixi 在 `poly(points)` 不传 close 时会把它留成 undefined——照搬) */
  closePath: boolean;

  constructor(points: PointData[] | number[]);
  constructor(...points: PointData[] | number[]);
  constructor(...points: (PointData[] | number[] | PointData | number)[]) {
    let flat = (Array.isArray(points[0]) ? points[0] : points) as (number | PointData)[];
    if (typeof flat[0] !== 'number') {
      const p: number[] = [];
      for (let i = 0, il = flat.length; i < il; i++) {
        p.push((flat[i] as PointData).x, (flat[i] as PointData).y);
      }
      flat = p;
    }
    this.points = flat as number[];
    this.closePath = true;
  }

  /** 顺时针(y 向下的屏幕坐标里)为 true */
  isClockwise(): boolean {
    let area = 0;
    const points = this.points;
    const length = points.length;
    for (let i = 0; i < length; i += 2) {
      const x1 = points[i];
      const y1 = points[i + 1];
      const x2 = points[(i + 2) % length];
      const y2 = points[(i + 3) % length];
      area += (x2 - x1) * (y2 + y1);
    }
    return area < 0;
  }

  containsPolygon(polygon: Polygon): boolean {
    const thisBounds = this.getBounds();
    const otherBounds = polygon.getBounds();
    if (!thisBounds.containsRect(otherBounds)) {
      return false;
    }
    const points = polygon.points;
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i];
      const y = points[i + 1];
      if (!this.contains(x, y)) {
        return false;
      }
    }
    return true;
  }

  clone(): Polygon {
    const points = this.points.slice();
    const polygon = new Polygon(points);
    polygon.closePath = this.closePath;
    return polygon;
  }

  contains(x: number, y: number): boolean {
    let inside = false;
    const length = this.points.length / 2;
    for (let i = 0, j = length - 1; i < length; j = i++) {
      const xi = this.points[i * 2];
      const yi = this.points[i * 2 + 1];
      const xj = this.points[j * 2];
      const yj = this.points[j * 2 + 1];
      const intersect = yi > y !== yj > y && x < (xj - xi) * ((y - yi) / (yj - yi)) + xi;
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  }

  strokeContains(x: number, y: number, strokeWidth: number, alignment = 0.5): boolean {
    const strokeWidthSquared = strokeWidth * strokeWidth;
    const rightWidthSquared = strokeWidthSquared * (1 - alignment);
    const leftWidthSquared = strokeWidthSquared - rightWidthSquared;
    const { points } = this;
    const iterationLength = points.length - (this.closePath ? 0 : 2);
    for (let i = 0; i < iterationLength; i += 2) {
      const x1 = points[i];
      const y1 = points[i + 1];
      const x2 = points[(i + 2) % points.length];
      const y2 = points[(i + 3) % points.length];
      const distanceSquared = squaredDistanceToLineSegment(x, y, x1, y1, x2, y2);
      const sign = Math.sign((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1));
      if (distanceSquared <= (sign < 0 ? leftWidthSquared : rightWidthSquared)) {
        return true;
      }
    }
    return false;
  }

  getBounds(out?: Rectangle): Rectangle {
    out ||= new Rectangle();
    const points = this.points;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0, n = points.length; i < n; i += 2) {
      const x = points[i];
      const y = points[i + 1];
      minX = x < minX ? x : minX;
      maxX = x > maxX ? x : maxX;
      minY = y < minY ? y : minY;
      maxY = y > maxY ? y : maxY;
    }
    out.x = minX;
    out.width = maxX - minX;
    out.y = minY;
    out.height = maxY - minY;
    return out;
  }

  copyFrom(polygon: Polygon): this {
    this.points = polygon.points.slice();
    this.closePath = polygon.closePath;
    return this;
  }

  copyTo(polygon: Polygon): Polygon {
    polygon.copyFrom(this);
    return polygon;
  }

  toString(): string {
    return `[engine2d:PolygoncloseStroke=${this.closePath}points=${this.points.reduce((d, p) => `${d}, ${p}`, '')}]`;
  }

  /** 最后一个点的 x */
  get lastX(): number {
    return this.points[this.points.length - 2];
  }

  /** 最后一个点的 y */
  get lastY(): number {
    return this.points[this.points.length - 1];
  }

  /** @deprecated Pixi 8.11 起改用 lastX(值相同:最后一个点;ShapePath 仍经它取上一图元的落点) */
  get x(): number {
    return this.points[this.points.length - 2];
  }

  /** @deprecated Pixi 8.11 起改用 lastY */
  get y(): number {
    return this.points[this.points.length - 1];
  }

  /** 第一个点的 x */
  get startX(): number {
    return this.points[0];
  }

  /** 第一个点的 y */
  get startY(): number {
    return this.points[1];
  }
}
