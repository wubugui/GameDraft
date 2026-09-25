/**
 * 椭圆。移植自 PixiJS v8.17(MIT):maths/shapes/Ellipse。
 */
import { Rectangle } from '../Rectangle';
import type { ShapePrimitive } from './ShapePrimitive';

export class Ellipse implements ShapePrimitive {
  readonly type = 'ellipse' as const;
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;

  constructor(x = 0, y = 0, halfWidth = 0, halfHeight = 0) {
    this.x = x;
    this.y = y;
    this.halfWidth = halfWidth;
    this.halfHeight = halfHeight;
  }

  clone(): Ellipse {
    return new Ellipse(this.x, this.y, this.halfWidth, this.halfHeight);
  }

  contains(x: number, y: number): boolean {
    if (this.halfWidth <= 0 || this.halfHeight <= 0) {
      return false;
    }
    let normx = (x - this.x) / this.halfWidth;
    let normy = (y - this.y) / this.halfHeight;
    normx *= normx;
    normy *= normy;
    return normx + normy <= 1;
  }

  strokeContains(x: number, y: number, strokeWidth: number, alignment = 0.5): boolean {
    const { halfWidth, halfHeight } = this;
    if (halfWidth <= 0 || halfHeight <= 0) {
      return false;
    }
    const strokeOuterWidth = strokeWidth * (1 - alignment);
    const strokeInnerWidth = strokeWidth - strokeOuterWidth;
    const innerHorizontal = halfWidth - strokeInnerWidth;
    const innerVertical = halfHeight - strokeInnerWidth;
    const outerHorizontal = halfWidth + strokeOuterWidth;
    const outerVertical = halfHeight + strokeOuterWidth;
    const normalizedX = x - this.x;
    const normalizedY = y - this.y;
    const innerEllipse = normalizedX * normalizedX / (innerHorizontal * innerHorizontal)
      + normalizedY * normalizedY / (innerVertical * innerVertical);
    const outerEllipse = normalizedX * normalizedX / (outerHorizontal * outerHorizontal)
      + normalizedY * normalizedY / (outerVertical * outerVertical);
    return innerEllipse > 1 && outerEllipse <= 1;
  }

  getBounds(out?: Rectangle): Rectangle {
    out ||= new Rectangle();
    out.x = this.x - this.halfWidth;
    out.y = this.y - this.halfHeight;
    out.width = this.halfWidth * 2;
    out.height = this.halfHeight * 2;
    return out;
  }

  copyFrom(ellipse: Ellipse): this {
    this.x = ellipse.x;
    this.y = ellipse.y;
    this.halfWidth = ellipse.halfWidth;
    this.halfHeight = ellipse.halfHeight;
    return this;
  }

  copyTo(ellipse: Ellipse): Ellipse {
    ellipse.copyFrom(this);
    return ellipse;
  }

  toString(): string {
    return `[engine2d:Ellipse x=${this.x} y=${this.y} halfWidth=${this.halfWidth} halfHeight=${this.halfHeight}]`;
  }
}
