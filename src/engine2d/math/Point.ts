/**
 * 点。语义与 PixiJS v8.17 的 Point 相同(实现移植自 PixiJS,MIT)。
 */
export interface PointData {
  x: number;
  y: number;
}

export interface PointLike extends PointData {
  copyFrom(p: PointData): this;
  copyTo<T extends PointLike>(p: T): T;
  equals(p: PointData): boolean;
  set(x?: number, y?: number): void;
}

export class Point implements PointLike {
  x = 0;
  y = 0;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  clone(): Point {
    return new Point(this.x, this.y);
  }

  copyFrom(p: PointData): this {
    this.set(p.x, p.y);
    return this;
  }

  copyTo<T extends PointLike>(p: T): T {
    p.set(this.x, this.y);
    return p;
  }

  equals(p: PointData): boolean {
    return p.x === this.x && p.y === this.y;
  }

  set(x = 0, y = x): this {
    this.x = x;
    this.y = y;
    return this;
  }

  toString(): string {
    return `[engine2d:Point x=${this.x} y=${this.y}]`;
  }

  static get shared(): Point {
    tempPoint.x = 0;
    tempPoint.y = 0;
    return tempPoint;
  }
}

const tempPoint = new Point();
