/**
 * 圆。移植自 PixiJS v8.17(MIT):maths/shapes/Circle。游戏把它当 hitArea 用,命中判定与 Pixi 逐字相同。
 */
import { Rectangle } from '../Rectangle';
import type { ShapePrimitive } from './ShapePrimitive';

export class Circle implements ShapePrimitive {
  readonly type = 'circle' as const;
  x: number;
  y: number;
  radius: number;

  constructor(x = 0, y = 0, radius = 0) {
    this.x = x;
    this.y = y;
    this.radius = radius;
  }

  clone(): Circle {
    return new Circle(this.x, this.y, this.radius);
  }

  contains(x: number, y: number): boolean {
    if (this.radius <= 0) return false;
    const r2 = this.radius * this.radius;
    let dx = this.x - x;
    let dy = this.y - y;
    dx *= dx;
    dy *= dy;
    return dx + dy <= r2;
  }

  strokeContains(x: number, y: number, width: number, alignment = 0.5): boolean {
    if (this.radius === 0) return false;
    const dx = this.x - x;
    const dy = this.y - y;
    const radius = this.radius;
    const outerWidth = (1 - alignment) * width;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance <= radius + outerWidth && distance > radius - (width - outerWidth);
  }

  getBounds(out?: Rectangle): Rectangle {
    out ||= new Rectangle();
    out.x = this.x - this.radius;
    out.y = this.y - this.radius;
    out.width = this.radius * 2;
    out.height = this.radius * 2;
    return out;
  }

  copyFrom(circle: Circle): this {
    this.x = circle.x;
    this.y = circle.y;
    this.radius = circle.radius;
    return this;
  }

  copyTo(circle: Circle): Circle {
    circle.copyFrom(this);
    return circle;
  }

  toString(): string {
    return `[engine2d:Circle x=${this.x} y=${this.y} radius=${this.radius}]`;
  }
}
