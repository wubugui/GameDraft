import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';

const defaultMatrix = new Matrix();

/** 轴对齐包围盒(照 Pixi `Bounds`):`matrix` 是后续 add* 默认使用的变换 */
export class Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  matrix: Matrix = defaultMatrix;
  private _rectangle?: Rectangle;

  constructor(minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity) {
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  isEmpty(): boolean {
    return this.minX > this.maxX || this.minY > this.maxY;
  }

  get rectangle(): Rectangle {
    const r = (this._rectangle ??= new Rectangle());
    if (this.minX > this.maxX || this.minY > this.maxY) {
      r.x = 0;
      r.y = 0;
      r.width = 0;
      r.height = 0;
    } else r.copyFromBounds(this);
    return r;
  }

  clear(): this {
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
    this.matrix = defaultMatrix;
    return this;
  }

  set(x0: number, y0: number, x1: number, y1: number): void {
    this.minX = x0;
    this.minY = y0;
    this.maxX = x1;
    this.maxY = y1;
  }

  addFrame(x0: number, y0: number, x1: number, y1: number, matrix?: Matrix): void {
    matrix ||= this.matrix;
    const { a, b, c, d, tx, ty } = matrix;
    let { minX, minY, maxX, maxY } = this;
    let x = a * x0 + c * y0 + tx;
    let y = b * x0 + d * y0 + ty;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    x = a * x1 + c * y0 + tx;
    y = b * x1 + d * y0 + ty;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    x = a * x0 + c * y1 + tx;
    y = b * x0 + d * y1 + ty;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    x = a * x1 + c * y1 + tx;
    y = b * x1 + d * y1 + ty;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  addRect(rect: Rectangle, matrix?: Matrix): void {
    this.addFrame(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, matrix);
  }

  addBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, matrix?: Matrix): void {
    this.addFrame(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, matrix);
  }

  addBoundsMask(mask: Bounds): void {
    this.minX = this.minX > mask.minX ? this.minX : mask.minX;
    this.minY = this.minY > mask.minY ? this.minY : mask.minY;
    this.maxX = this.maxX < mask.maxX ? this.maxX : mask.maxX;
    this.maxY = this.maxY < mask.maxY ? this.maxY : mask.maxY;
  }

  applyMatrix(matrix: Matrix): void {
    const { minX, minY, maxX, maxY } = this;
    const { a, b, c, d, tx, ty } = matrix;
    let x = a * minX + c * minY + tx;
    let y = b * minX + d * minY + ty;
    this.minX = x;
    this.minY = y;
    this.maxX = x;
    this.maxY = y;
    const add = (px: number, py: number): void => {
      x = a * px + c * py + tx;
      y = b * px + d * py + ty;
      this.minX = x < this.minX ? x : this.minX;
      this.minY = y < this.minY ? y : this.minY;
      this.maxX = x > this.maxX ? x : this.maxX;
      this.maxY = y > this.maxY ? y : this.maxY;
    };
    add(maxX, minY);
    add(minX, maxY);
    add(maxX, maxY);
  }

  fit(rect: Rectangle): this {
    if (this.minX < rect.left) this.minX = rect.left;
    if (this.maxX > rect.right) this.maxX = rect.right;
    if (this.minY < rect.top) this.minY = rect.top;
    if (this.maxY > rect.bottom) this.maxY = rect.bottom;
    return this;
  }

  fitBounds(left: number, right: number, top: number, bottom: number): this {
    if (this.minX < left) this.minX = left;
    if (this.maxX > right) this.maxX = right;
    if (this.minY < top) this.minY = top;
    if (this.maxY > bottom) this.maxY = bottom;
    return this;
  }

  pad(paddingX: number, paddingY = paddingX): this {
    this.minX -= paddingX;
    this.maxX += paddingX;
    this.minY -= paddingY;
    this.maxY += paddingY;
    return this;
  }

  ceil(): this {
    this.minX = Math.floor(this.minX);
    this.minY = Math.floor(this.minY);
    this.maxX = Math.ceil(this.maxX);
    this.maxY = Math.ceil(this.maxY);
    return this;
  }

  clone(): Bounds {
    return new Bounds(this.minX, this.minY, this.maxX, this.maxY);
  }

  scale(x: number, y = x): this {
    this.minX *= x;
    this.minY *= y;
    this.maxX *= x;
    this.maxY *= y;
    return this;
  }

  get x(): number { return this.minX; }
  set x(v: number) { const w = this.maxX - this.minX; this.minX = v; this.maxX = v + w; }
  get y(): number { return this.minY; }
  set y(v: number) { const h = this.maxY - this.minY; this.minY = v; this.maxY = v + h; }
  get width(): number { return this.maxX - this.minX; }
  set width(v: number) { this.maxX = this.minX + v; }
  get height(): number { return this.maxY - this.minY; }
  set height(v: number) { this.maxY = this.minY + v; }
  get left(): number { return this.minX; }
  get right(): number { return this.maxX; }
  get top(): number { return this.minY; }
  get bottom(): number { return this.maxY; }
  get isPositive(): boolean { return this.maxX - this.minX > 0 && this.maxY - this.minY > 0; }
  get isValid(): boolean { return this.minX + this.minY !== Infinity; }

  addVertexData(vertexData: ArrayLike<number>, beginOffset: number, endOffset: number, matrix?: Matrix): void {
    let { minX, minY, maxX, maxY } = this;
    matrix ||= this.matrix;
    const { a, b, c, d, tx, ty } = matrix;
    for (let i = beginOffset; i < endOffset; i += 2) {
      const lx = vertexData[i];
      const ly = vertexData[i + 1];
      const x = a * lx + c * ly + tx;
      const y = b * lx + d * ly + ty;
      minX = x < minX ? x : minX;
      minY = y < minY ? y : minY;
      maxX = x > maxX ? x : maxX;
      maxY = y > maxY ? y : maxY;
    }
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  containsPoint(x: number, y: number): boolean {
    return this.minX <= x && this.minY <= y && this.maxX >= x && this.maxY >= y;
  }

  copyFrom(b: Bounds): this {
    this.minX = b.minX;
    this.minY = b.minY;
    this.maxX = b.maxX;
    this.maxY = b.maxY;
    return this;
  }

  toString(): string {
    return `[Bounds minX=${this.minX} minY=${this.minY} maxX=${this.maxX} maxY=${this.maxY}]`;
  }
}
