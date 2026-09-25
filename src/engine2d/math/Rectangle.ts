/**
 * 矩形。语义与 PixiJS v8.17 的 Rectangle 逐字相同(实现移植自 PixiJS,MIT)。
 */
import type { Matrix } from './Matrix';
import { Point } from './Point';

const tempPoints = [new Point(), new Point(), new Point(), new Point()];

export interface BoundsLike {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Rectangle {
  readonly type = 'rectangle' as const;
  x: number;
  y: number;
  width: number;
  height: number;

  constructor(x: number | string = 0, y: number | string = 0, width: number | string = 0, height: number | string = 0) {
    this.x = Number(x);
    this.y = Number(y);
    this.width = Number(width);
    this.height = Number(height);
  }

  get left(): number { return this.x; }
  get right(): number { return this.x + this.width; }
  get top(): number { return this.y; }
  get bottom(): number { return this.y + this.height; }

  isEmpty(): boolean {
    return this.left === this.right || this.top === this.bottom;
  }

  static get EMPTY(): Rectangle {
    return new Rectangle(0, 0, 0, 0);
  }

  clone(): Rectangle {
    return new Rectangle(this.x, this.y, this.width, this.height);
  }

  copyFromBounds(bounds: BoundsLike): this {
    this.x = bounds.minX;
    this.y = bounds.minY;
    this.width = bounds.maxX - bounds.minX;
    this.height = bounds.maxY - bounds.minY;
    return this;
  }

  copyFrom(rectangle: Rectangle): this {
    this.x = rectangle.x;
    this.y = rectangle.y;
    this.width = rectangle.width;
    this.height = rectangle.height;
    return this;
  }

  copyTo(rectangle: Rectangle): Rectangle {
    rectangle.copyFrom(this);
    return rectangle;
  }

  contains(x: number, y: number): boolean {
    if (this.width <= 0 || this.height <= 0) return false;
    if (x >= this.x && x < this.x + this.width) {
      if (y >= this.y && y < this.y + this.height) return true;
    }
    return false;
  }

  strokeContains(x: number, y: number, strokeWidth: number, alignment = 0.5): boolean {
    const { width, height } = this;
    if (width <= 0 || height <= 0) return false;
    const _x = this.x;
    const _y = this.y;
    const strokeWidthOuter = strokeWidth * (1 - alignment);
    const strokeWidthInner = strokeWidth - strokeWidthOuter;
    const outerLeft = _x - strokeWidthOuter;
    const outerRight = _x + width + strokeWidthOuter;
    const outerTop = _y - strokeWidthOuter;
    const outerBottom = _y + height + strokeWidthOuter;
    const innerLeft = _x + strokeWidthInner;
    const innerRight = _x + width - strokeWidthInner;
    const innerTop = _y + strokeWidthInner;
    const innerBottom = _y + height - strokeWidthInner;
    return x >= outerLeft && x <= outerRight && y >= outerTop && y <= outerBottom
      && !(x > innerLeft && x < innerRight && y > innerTop && y < innerBottom);
  }

  intersects(other: Rectangle, transform?: Matrix): boolean {
    if (!transform) {
      const x02 = this.x < other.x ? other.x : this.x;
      const x12 = this.right > other.right ? other.right : this.right;
      if (x12 <= x02) return false;
      const y02 = this.y < other.y ? other.y : this.y;
      const y12 = this.bottom > other.bottom ? other.bottom : this.bottom;
      return y12 > y02;
    }
    const x0 = this.left;
    const x1 = this.right;
    const y0 = this.top;
    const y1 = this.bottom;
    if (x1 <= x0 || y1 <= y0) return false;
    const lt = tempPoints[0].set(other.left, other.top);
    const lb = tempPoints[1].set(other.left, other.bottom);
    const rt = tempPoints[2].set(other.right, other.top);
    const rb = tempPoints[3].set(other.right, other.bottom);
    if (rt.x <= lt.x || lb.y <= lt.y) return false;
    const s = Math.sign(transform.a * transform.d - transform.b * transform.c);
    if (s === 0) return false;
    transform.apply(lt, lt);
    transform.apply(lb, lb);
    transform.apply(rt, rt);
    transform.apply(rb, rb);
    if (Math.max(lt.x, lb.x, rt.x, rb.x) <= x0 || Math.min(lt.x, lb.x, rt.x, rb.x) >= x1
      || Math.max(lt.y, lb.y, rt.y, rb.y) <= y0 || Math.min(lt.y, lb.y, rt.y, rb.y) >= y1) return false;
    const nx = s * (lb.y - lt.y);
    const ny = s * (lt.x - lb.x);
    const n00 = nx * x0 + ny * y0;
    const n10 = nx * x1 + ny * y0;
    const n01 = nx * x0 + ny * y1;
    const n11 = nx * x1 + ny * y1;
    if (Math.max(n00, n10, n01, n11) <= nx * lt.x + ny * lt.y || Math.min(n00, n10, n01, n11) >= nx * rb.x + ny * rb.y) return false;
    const mx = s * (lt.y - rt.y);
    const my = s * (rt.x - lt.x);
    const m00 = mx * x0 + my * y0;
    const m10 = mx * x1 + my * y0;
    const m01 = mx * x0 + my * y1;
    const m11 = mx * x1 + my * y1;
    if (Math.max(m00, m10, m01, m11) <= mx * lt.x + my * lt.y || Math.min(m00, m10, m01, m11) >= mx * rb.x + my * rb.y) return false;
    return true;
  }

  pad(paddingX = 0, paddingY = paddingX): this {
    this.x -= paddingX;
    this.y -= paddingY;
    this.width += paddingX * 2;
    this.height += paddingY * 2;
    return this;
  }

  fit(rectangle: Rectangle): this {
    const x1 = Math.max(this.x, rectangle.x);
    const x2 = Math.min(this.x + this.width, rectangle.x + rectangle.width);
    const y1 = Math.max(this.y, rectangle.y);
    const y2 = Math.min(this.y + this.height, rectangle.y + rectangle.height);
    this.x = x1;
    this.width = Math.max(x2 - x1, 0);
    this.y = y1;
    this.height = Math.max(y2 - y1, 0);
    return this;
  }

  ceil(resolution = 1, eps = 1e-3): this {
    const x2 = Math.ceil((this.x + this.width - eps) * resolution) / resolution;
    const y2 = Math.ceil((this.y + this.height - eps) * resolution) / resolution;
    this.x = Math.floor((this.x + eps) * resolution) / resolution;
    this.y = Math.floor((this.y + eps) * resolution) / resolution;
    this.width = x2 - this.x;
    this.height = y2 - this.y;
    return this;
  }

  scale(x: number, y = x): this {
    this.x *= x;
    this.y *= y;
    this.width *= x;
    this.height *= y;
    return this;
  }

  enlarge(rectangle: Rectangle): this {
    const x1 = Math.min(this.x, rectangle.x);
    const x2 = Math.max(this.x + this.width, rectangle.x + rectangle.width);
    const y1 = Math.min(this.y, rectangle.y);
    const y2 = Math.max(this.y + this.height, rectangle.y + rectangle.height);
    this.x = x1;
    this.width = x2 - x1;
    this.y = y1;
    this.height = y2 - y1;
    return this;
  }

  getBounds(out?: Rectangle): Rectangle {
    const r = out || new Rectangle();
    r.copyFrom(this);
    return r;
  }

  containsRect(other: Rectangle): boolean {
    if (this.width <= 0 || this.height <= 0) return false;
    const x1 = other.x;
    const y1 = other.y;
    const x2 = other.x + other.width;
    const y2 = other.y + other.height;
    return x1 >= this.x && x1 < this.x + this.width && y1 >= this.y && y1 < this.y + this.height
      && x2 >= this.x && x2 < this.x + this.width && y2 >= this.y && y2 < this.y + this.height;
  }

  set(x: number, y: number, width: number, height: number): this {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    return this;
  }

  toString(): string {
    return `[engine2d:Rectangle x=${this.x} y=${this.y} width=${this.width} height=${this.height}]`;
  }
}
