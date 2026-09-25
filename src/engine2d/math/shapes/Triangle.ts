/**
 * 三角形。移植自 PixiJS v8.17(MIT):maths/shapes/Triangle。
 * 注:Pixi 的 strokeContains 第一条边用的是 (x, y)→(x2, y3)(源码如此),照搬以保持命中一致。
 */
import { Rectangle } from '../Rectangle';
import { squaredDistanceToLineSegment } from './squaredDistanceToLineSegment';
import type { ShapePrimitive } from './ShapePrimitive';

export class Triangle implements ShapePrimitive {
  readonly type = 'triangle' as const;
  x: number;
  y: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;

  constructor(x = 0, y = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0) {
    this.x = x;
    this.y = y;
    this.x2 = x2;
    this.y2 = y2;
    this.x3 = x3;
    this.y3 = y3;
  }

  contains(x: number, y: number): boolean {
    const s = (this.x - this.x3) * (y - this.y3) - (this.y - this.y3) * (x - this.x3);
    const t = (this.x2 - this.x) * (y - this.y) - (this.y2 - this.y) * (x - this.x);
    if (s < 0 !== t < 0 && s !== 0 && t !== 0) {
      return false;
    }
    const d = (this.x3 - this.x2) * (y - this.y2) - (this.y3 - this.y2) * (x - this.x2);
    return d === 0 || d < 0 === s + t <= 0;
  }

  strokeContains(pointX: number, pointY: number, strokeWidth: number, _alignment = 0.5): boolean {
    void _alignment;
    const halfStrokeWidth = strokeWidth / 2;
    const halfStrokeWidthSquared = halfStrokeWidth * halfStrokeWidth;
    const { x, x2, x3, y, y2, y3 } = this;
    if (squaredDistanceToLineSegment(pointX, pointY, x, y, x2, y3) <= halfStrokeWidthSquared
      || squaredDistanceToLineSegment(pointX, pointY, x2, y2, x3, y3) <= halfStrokeWidthSquared
      || squaredDistanceToLineSegment(pointX, pointY, x3, y3, x, y) <= halfStrokeWidthSquared) {
      return true;
    }
    return false;
  }

  clone(): Triangle {
    return new Triangle(this.x, this.y, this.x2, this.y2, this.x3, this.y3);
  }

  copyFrom(triangle: Triangle): this {
    this.x = triangle.x;
    this.y = triangle.y;
    this.x2 = triangle.x2;
    this.y2 = triangle.y2;
    this.x3 = triangle.x3;
    this.y3 = triangle.y3;
    return this;
  }

  copyTo(triangle: Triangle): Triangle {
    triangle.copyFrom(this);
    return triangle;
  }

  getBounds(out?: Rectangle): Rectangle {
    out ||= new Rectangle();
    const minX = Math.min(this.x, this.x2, this.x3);
    const maxX = Math.max(this.x, this.x2, this.x3);
    const minY = Math.min(this.y, this.y2, this.y3);
    const maxY = Math.max(this.y, this.y2, this.y3);
    out.x = minX;
    out.y = minY;
    out.width = maxX - minX;
    out.height = maxY - minY;
    return out;
  }
}
