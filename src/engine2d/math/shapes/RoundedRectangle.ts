/**
 * 圆角矩形。移植自 PixiJS v8.17(MIT):maths/shapes/RoundedRectangle。
 */
import { Rectangle } from '../Rectangle';
import type { ShapePrimitive } from './ShapePrimitive';

const isCornerWithinStroke = (
  pX: number,
  pY: number,
  cornerX: number,
  cornerY: number,
  radius: number,
  strokeWidthInner: number,
  strokeWidthOuter: number,
): boolean => {
  const dx = pX - cornerX;
  const dy = pY - cornerY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance >= radius - strokeWidthInner && distance <= radius + strokeWidthOuter;
};

export class RoundedRectangle implements ShapePrimitive {
  readonly type = 'roundedRectangle' as const;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;

  constructor(x = 0, y = 0, width = 0, height = 0, radius = 20) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.radius = radius;
  }

  getBounds(out?: Rectangle): Rectangle {
    out ||= new Rectangle();
    out.x = this.x;
    out.y = this.y;
    out.width = this.width;
    out.height = this.height;
    return out;
  }

  clone(): RoundedRectangle {
    return new RoundedRectangle(this.x, this.y, this.width, this.height, this.radius);
  }

  /** 照 Pixi:只拷 x / y / width / height,不拷 radius */
  copyFrom(rectangle: RoundedRectangle): this {
    this.x = rectangle.x;
    this.y = rectangle.y;
    this.width = rectangle.width;
    this.height = rectangle.height;
    return this;
  }

  copyTo(rectangle: RoundedRectangle): RoundedRectangle {
    rectangle.copyFrom(this);
    return rectangle;
  }

  contains(x: number, y: number): boolean {
    if (this.width <= 0 || this.height <= 0) {
      return false;
    }
    if (x >= this.x && x <= this.x + this.width) {
      if (y >= this.y && y <= this.y + this.height) {
        const radius = Math.max(0, Math.min(this.radius, Math.min(this.width, this.height) / 2));
        if ((y >= this.y + radius && y <= this.y + this.height - radius) || (x >= this.x + radius && x <= this.x + this.width - radius)) {
          return true;
        }
        let dx = x - (this.x + radius);
        let dy = y - (this.y + radius);
        const radius2 = radius * radius;
        if (dx * dx + dy * dy <= radius2) {
          return true;
        }
        dx = x - (this.x + this.width - radius);
        if (dx * dx + dy * dy <= radius2) {
          return true;
        }
        dy = y - (this.y + this.height - radius);
        if (dx * dx + dy * dy <= radius2) {
          return true;
        }
        dx = x - (this.x + radius);
        if (dx * dx + dy * dy <= radius2) {
          return true;
        }
      }
    }
    return false;
  }

  strokeContains(pX: number, pY: number, strokeWidth: number, alignment = 0.5): boolean {
    const { x, y, width, height, radius } = this;
    const strokeWidthOuter = strokeWidth * (1 - alignment);
    const strokeWidthInner = strokeWidth - strokeWidthOuter;
    const innerX = x + radius;
    const innerY = y + radius;
    const innerWidth = width - radius * 2;
    const innerHeight = height - radius * 2;
    const rightBound = x + width;
    const bottomBound = y + height;
    if (((pX >= x - strokeWidthOuter && pX <= x + strokeWidthInner) || (pX >= rightBound - strokeWidthInner && pX <= rightBound + strokeWidthOuter))
      && pY >= innerY && pY <= innerY + innerHeight) {
      return true;
    }
    if (((pY >= y - strokeWidthOuter && pY <= y + strokeWidthInner) || (pY >= bottomBound - strokeWidthInner && pY <= bottomBound + strokeWidthOuter))
      && pX >= innerX && pX <= innerX + innerWidth) {
      return true;
    }
    return (
      (pX < innerX && pY < innerY && isCornerWithinStroke(pX, pY, innerX, innerY, radius, strokeWidthInner, strokeWidthOuter))
      || (pX > rightBound - radius && pY < innerY
        && isCornerWithinStroke(pX, pY, rightBound - radius, innerY, radius, strokeWidthInner, strokeWidthOuter))
      || (pX > rightBound - radius && pY > bottomBound - radius
        && isCornerWithinStroke(pX, pY, rightBound - radius, bottomBound - radius, radius, strokeWidthInner, strokeWidthOuter))
      || (pX < innerX && pY > bottomBound - radius
        && isCornerWithinStroke(pX, pY, innerX, bottomBound - radius, radius, strokeWidthInner, strokeWidthOuter))
    );
  }

  toString(): string {
    return `[engine2d:RoundedRectangle x=${this.x} y=${this.y}width=${this.width} height=${this.height} radius=${this.radius}]`;
  }
}
