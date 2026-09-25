/**
 * 2D 仿射矩阵 | a c tx | / | b d ty |。语义与 PixiJS v8.17 的 Matrix 逐字相同(实现移植自 PixiJS,MIT)——
 * 世界变换、包围盒、事件命中都依赖它,与 master 的数值必须逐位一致。
 */
import { Point, type PointData } from './Point';

const PI_2 = Math.PI * 2;

export interface TransformableObject {
  position: PointData;
  scale: PointData;
  pivot: PointData;
  skew: PointData;
  rotation: number;
}

export class Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  array: Float32Array | null = null;

  constructor(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.tx = tx;
    this.ty = ty;
  }

  fromArray(array: ArrayLike<number>): void {
    this.a = array[0];
    this.b = array[1];
    this.c = array[3];
    this.d = array[4];
    this.tx = array[2];
    this.ty = array[5];
  }

  set(a: number, b: number, c: number, d: number, tx: number, ty: number): this {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.tx = tx;
    this.ty = ty;
    return this;
  }

  toArray(transpose?: boolean, out?: Float32Array): Float32Array {
    if (!this.array) this.array = new Float32Array(9);
    const array = out || this.array;
    if (transpose) {
      array[0] = this.a; array[1] = this.b; array[2] = 0;
      array[3] = this.c; array[4] = this.d; array[5] = 0;
      array[6] = this.tx; array[7] = this.ty; array[8] = 1;
    } else {
      array[0] = this.a; array[1] = this.c; array[2] = this.tx;
      array[3] = this.b; array[4] = this.d; array[5] = this.ty;
      array[6] = 0; array[7] = 0; array[8] = 1;
    }
    return array;
  }

  apply<P extends PointData = Point>(pos: PointData, newPos?: P): P {
    const out = (newPos || new Point()) as P;
    const x = pos.x;
    const y = pos.y;
    out.x = this.a * x + this.c * y + this.tx;
    out.y = this.b * x + this.d * y + this.ty;
    return out;
  }

  applyInverse<P extends PointData = Point>(pos: PointData, newPos?: P): P {
    const out = (newPos || new Point()) as P;
    const { a, b, c, d, tx, ty } = this;
    const id = 1 / (a * d + c * -b);
    const x = pos.x;
    const y = pos.y;
    out.x = d * id * x + -c * id * y + (ty * c - tx * d) * id;
    out.y = a * id * y + -b * id * x + (-ty * a + tx * b) * id;
    return out;
  }

  translate(x: number, y: number): this {
    this.tx += x;
    this.ty += y;
    return this;
  }

  scale(x: number, y: number): this {
    this.a *= x;
    this.d *= y;
    this.c *= x;
    this.b *= y;
    this.tx *= x;
    this.ty *= y;
    return this;
  }

  rotate(angle: number): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const a1 = this.a;
    const c1 = this.c;
    const tx1 = this.tx;
    this.a = a1 * cos - this.b * sin;
    this.b = a1 * sin + this.b * cos;
    this.c = c1 * cos - this.d * sin;
    this.d = c1 * sin + this.d * cos;
    this.tx = tx1 * cos - this.ty * sin;
    this.ty = tx1 * sin + this.ty * cos;
    return this;
  }

  append(matrix: Matrix): this {
    const a1 = this.a;
    const b1 = this.b;
    const c1 = this.c;
    const d1 = this.d;
    this.a = matrix.a * a1 + matrix.b * c1;
    this.b = matrix.a * b1 + matrix.b * d1;
    this.c = matrix.c * a1 + matrix.d * c1;
    this.d = matrix.c * b1 + matrix.d * d1;
    this.tx = matrix.tx * a1 + matrix.ty * c1 + this.tx;
    this.ty = matrix.tx * b1 + matrix.ty * d1 + this.ty;
    return this;
  }

  /** this = a × b(先 a 后 b 的语义与 Pixi 相同:结果把点先过 a 再过 b) */
  appendFrom(a: Matrix, b: Matrix): this {
    const a1 = a.a;
    const b1 = a.b;
    const c1 = a.c;
    const d1 = a.d;
    const tx = a.tx;
    const ty = a.ty;
    const a2 = b.a;
    const b2 = b.b;
    const c2 = b.c;
    const d2 = b.d;
    this.a = a1 * a2 + b1 * c2;
    this.b = a1 * b2 + b1 * d2;
    this.c = c1 * a2 + d1 * c2;
    this.d = c1 * b2 + d1 * d2;
    this.tx = tx * a2 + ty * c2 + b.tx;
    this.ty = tx * b2 + ty * d2 + b.ty;
    return this;
  }

  setTransform(x: number, y: number, pivotX: number, pivotY: number, scaleX: number, scaleY: number, rotation: number, skewX: number, skewY: number): this {
    this.a = Math.cos(rotation + skewY) * scaleX;
    this.b = Math.sin(rotation + skewY) * scaleX;
    this.c = -Math.sin(rotation - skewX) * scaleY;
    this.d = Math.cos(rotation - skewX) * scaleY;
    this.tx = x - (pivotX * this.a + pivotY * this.c);
    this.ty = y - (pivotX * this.b + pivotY * this.d);
    return this;
  }

  prepend(matrix: Matrix): this {
    const tx1 = this.tx;
    if (matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1) {
      const a1 = this.a;
      const c1 = this.c;
      this.a = a1 * matrix.a + this.b * matrix.c;
      this.b = a1 * matrix.b + this.b * matrix.d;
      this.c = c1 * matrix.a + this.d * matrix.c;
      this.d = c1 * matrix.b + this.d * matrix.d;
    }
    this.tx = tx1 * matrix.a + this.ty * matrix.c + matrix.tx;
    this.ty = tx1 * matrix.b + this.ty * matrix.d + matrix.ty;
    return this;
  }

  decompose<T extends TransformableObject>(transform: T): T {
    const { a, b, c, d } = this;
    const pivot = transform.pivot;
    const skewX = -Math.atan2(-c, d);
    const skewY = Math.atan2(b, a);
    const delta = Math.abs(skewX + skewY);
    if (delta < 1e-5 || Math.abs(PI_2 - delta) < 1e-5) {
      transform.rotation = skewY;
      transform.skew.x = transform.skew.y = 0;
    } else {
      transform.rotation = 0;
      transform.skew.x = skewX;
      transform.skew.y = skewY;
    }
    transform.scale.x = Math.sqrt(a * a + b * b);
    transform.scale.y = Math.sqrt(c * c + d * d);
    transform.position.x = this.tx + (pivot.x * a + pivot.y * c);
    transform.position.y = this.ty + (pivot.x * b + pivot.y * d);
    return transform;
  }

  invert(): this {
    const a1 = this.a;
    const b1 = this.b;
    const c1 = this.c;
    const d1 = this.d;
    const tx1 = this.tx;
    const n = a1 * d1 - b1 * c1;
    this.a = d1 / n;
    this.b = -b1 / n;
    this.c = -c1 / n;
    this.d = a1 / n;
    this.tx = (c1 * this.ty - d1 * tx1) / n;
    this.ty = -(a1 * this.ty - b1 * tx1) / n;
    return this;
  }

  isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.tx === 0 && this.ty === 0;
  }

  identity(): this {
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.tx = 0;
    this.ty = 0;
    return this;
  }

  clone(): Matrix {
    return new Matrix(this.a, this.b, this.c, this.d, this.tx, this.ty);
  }

  copyTo(matrix: Matrix): Matrix {
    matrix.a = this.a;
    matrix.b = this.b;
    matrix.c = this.c;
    matrix.d = this.d;
    matrix.tx = this.tx;
    matrix.ty = this.ty;
    return matrix;
  }

  copyFrom(matrix: Matrix): this {
    this.a = matrix.a;
    this.b = matrix.b;
    this.c = matrix.c;
    this.d = matrix.d;
    this.tx = matrix.tx;
    this.ty = matrix.ty;
    return this;
  }

  equals(matrix: Matrix): boolean {
    return matrix.a === this.a && matrix.b === this.b && matrix.c === this.c && matrix.d === this.d && matrix.tx === this.tx && matrix.ty === this.ty;
  }

  toString(): string {
    return `[engine2d:Matrix a=${this.a} b=${this.b} c=${this.c} d=${this.d} tx=${this.tx} ty=${this.ty}]`;
  }

  static get IDENTITY(): Matrix {
    return identityMatrix.identity();
  }

  static get shared(): Matrix {
    return tempMatrix.identity();
  }
}

const tempMatrix = new Matrix();
const identityMatrix = new Matrix();
