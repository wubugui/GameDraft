/**
 * 路径指令表(可复用、可变换)。移植自 PixiJS v8.17(MIT):scene/graphics/shared/path/GraphicsPath。
 * 与 Pixi 的差别:不支持用 SVG 路径字符串构造(游戏没用到;Pixi 依赖 parse-svg-path),传字符串会抛错。
 */
import type { Matrix } from '../../math/Matrix';
import { Point, type PointData } from '../../math/Point';
import type { Bounds } from '../../scene/Bounds';
import { uid } from '../../utils/uid';
import type { RoundedPoint } from './roundShape';
import { ShapePath } from './ShapePath';

export interface PathInstruction {
  action:
    | 'moveTo'
    | 'lineTo'
    | 'quadraticCurveTo'
    | 'bezierCurveTo'
    | 'arc'
    | 'closePath'
    | 'addPath'
    | 'arcTo'
    | 'ellipse'
    | 'rect'
    | 'roundRect'
    | 'arcToSvg'
    | 'poly'
    | 'circle'
    | 'regularPoly'
    | 'roundPoly'
    | 'roundShape'
    | 'filletRect'
    | 'chamferRect';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
}

export class GraphicsPath {
  instructions: PathInstruction[] = [];
  readonly uid = uid('graphicsPath');
  private _dirty = true;
  /** 为 true 时 addPath 会把被包含的多边形当洞 */
  checkForHoles: boolean;
  private _shapePath?: ShapePath;

  constructor(instructions?: string | PathInstruction[], signed = false) {
    this.checkForHoles = signed;
    if (typeof instructions === 'string') {
      throw new Error('[engine2d] GraphicsPath:不支持 SVG 路径字符串(游戏未用到,未移植 parseSVGPath)');
    } else {
      this.instructions = instructions?.slice() ?? [];
    }
  }

  get shapePath(): ShapePath {
    if (!this._shapePath) {
      this._shapePath = new ShapePath(this);
    }
    if (this._dirty) {
      this._dirty = false;
      this._shapePath.buildPath();
    }
    return this._shapePath;
  }

  addPath(path: GraphicsPath, transform?: Matrix): this {
    path = path.clone();
    this.instructions.push({ action: 'addPath', data: [path, transform] });
    this._dirty = true;
    return this;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): this;
  arc(...args: unknown[]): this {
    this.instructions.push({ action: 'arc', data: args });
    this._dirty = true;
    return this;
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this;
  arcTo(...args: unknown[]): this {
    this.instructions.push({ action: 'arcTo', data: args });
    this._dirty = true;
    return this;
  }

  arcToSvg(rx: number, ry: number, xAxisRotation: number, largeArcFlag: number, sweepFlag: number, x: number, y: number): this;
  arcToSvg(...args: unknown[]): this {
    this.instructions.push({ action: 'arcToSvg', data: args });
    this._dirty = true;
    return this;
  }

  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number, smoothness?: number): this;
  bezierCurveTo(...args: unknown[]): this {
    this.instructions.push({ action: 'bezierCurveTo', data: args });
    this._dirty = true;
    return this;
  }

  bezierCurveToShort(cp2x: number, cp2y: number, x: number, y: number, smoothness?: number): this {
    const last = this.instructions[this.instructions.length - 1];
    const lastPoint = this.getLastPoint(Point.shared);
    let cp1x = 0;
    let cp1y = 0;
    if (!last || last.action !== 'bezierCurveTo') {
      cp1x = lastPoint.x;
      cp1y = lastPoint.y;
    } else {
      cp1x = last.data[2];
      cp1y = last.data[3];
      const currentX = lastPoint.x;
      const currentY = lastPoint.y;
      cp1x = currentX + (currentX - cp1x);
      cp1y = currentY + (currentY - cp1y);
    }
    this.instructions.push({ action: 'bezierCurveTo', data: [cp1x, cp1y, cp2x, cp2y, x, y, smoothness] });
    this._dirty = true;
    return this;
  }

  closePath(): this {
    this.instructions.push({ action: 'closePath', data: [] });
    this._dirty = true;
    return this;
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number, transform?: Matrix): this;
  ellipse(...args: unknown[]): this {
    this.instructions.push({ action: 'ellipse', data: args });
    // TODO nail this!
    this._dirty = true;
    return this;
  }

  lineTo(x: number, y: number): this;
  lineTo(...args: unknown[]): this {
    this.instructions.push({ action: 'lineTo', data: args });
    this._dirty = true;
    return this;
  }

  /** 照 Pixi:moveTo 不置脏 */
  moveTo(x: number, y: number): this;
  moveTo(...args: unknown[]): this {
    this.instructions.push({ action: 'moveTo', data: args });
    return this;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number, smoothness?: number): this;
  quadraticCurveTo(...args: unknown[]): this {
    this.instructions.push({ action: 'quadraticCurveTo', data: args });
    this._dirty = true;
    return this;
  }

  quadraticCurveToShort(x: number, y: number, smoothness?: number): this {
    const last = this.instructions[this.instructions.length - 1];
    const lastPoint = this.getLastPoint(Point.shared);
    let cpx1 = 0;
    let cpy1 = 0;
    if (!last || last.action !== 'quadraticCurveTo') {
      cpx1 = lastPoint.x;
      cpy1 = lastPoint.y;
    } else {
      cpx1 = last.data[0];
      cpy1 = last.data[1];
      const currentX = lastPoint.x;
      const currentY = lastPoint.y;
      cpx1 = currentX + (currentX - cpx1);
      cpy1 = currentY + (currentY - cpy1);
    }
    this.instructions.push({ action: 'quadraticCurveTo', data: [cpx1, cpy1, x, y, smoothness] });
    this._dirty = true;
    return this;
  }

  rect(x: number, y: number, w: number, h: number, transform?: Matrix): this {
    this.instructions.push({ action: 'rect', data: [x, y, w, h, transform] });
    this._dirty = true;
    return this;
  }

  circle(x: number, y: number, radius: number, transform?: Matrix): this {
    this.instructions.push({ action: 'circle', data: [x, y, radius, transform] });
    this._dirty = true;
    return this;
  }

  roundRect(x: number, y: number, w: number, h: number, radius?: number, transform?: Matrix): this;
  roundRect(...args: unknown[]): this {
    this.instructions.push({ action: 'roundRect', data: args });
    this._dirty = true;
    return this;
  }

  poly(points: number[] | PointData[], close?: boolean, transform?: Matrix): this;
  poly(...args: unknown[]): this {
    this.instructions.push({ action: 'poly', data: args });
    this._dirty = true;
    return this;
  }

  regularPoly(x: number, y: number, radius: number, sides: number, rotation?: number, transform?: Matrix): this;
  regularPoly(...args: unknown[]): this {
    this.instructions.push({ action: 'regularPoly', data: args });
    this._dirty = true;
    return this;
  }

  roundPoly(x: number, y: number, radius: number, sides: number, corner: number, rotation?: number, smoothness?: number): this;
  roundPoly(...args: unknown[]): this {
    this.instructions.push({ action: 'roundPoly', data: args });
    this._dirty = true;
    return this;
  }

  roundShape(points: RoundedPoint[], radius: number, useQuadratic?: boolean, smoothness?: number): this;
  roundShape(...args: unknown[]): this {
    this.instructions.push({ action: 'roundShape', data: args });
    this._dirty = true;
    return this;
  }

  filletRect(x: number, y: number, width: number, height: number, fillet: number): this;
  filletRect(...args: unknown[]): this {
    this.instructions.push({ action: 'filletRect', data: args });
    this._dirty = true;
    return this;
  }

  chamferRect(x: number, y: number, width: number, height: number, chamfer: number, transform?: Matrix): this;
  chamferRect(...args: unknown[]): this {
    this.instructions.push({ action: 'chamferRect', data: args });
    this._dirty = true;
    return this;
  }

  star(x: number, y: number, points: number, radius: number, innerRadius?: number, rotation?: number, transform?: Matrix): this {
    innerRadius ||= radius / 2;
    const startAngle = -1 * Math.PI / 2 + (rotation as number);
    const len = points * 2;
    const delta = Math.PI * 2 / len;
    const polygon: number[] = [];
    for (let i = 0; i < len; i++) {
      const r = i % 2 ? innerRadius : radius;
      const angle = i * delta + startAngle;
      polygon.push(x + r * Math.cos(angle), y + r * Math.sin(angle));
    }
    this.poly(polygon, true, transform);
    return this;
  }

  clone(deep = false): GraphicsPath {
    const newGraphicsPath2D = new GraphicsPath();
    newGraphicsPath2D.checkForHoles = this.checkForHoles;
    if (!deep) {
      newGraphicsPath2D.instructions = this.instructions.slice();
    } else {
      for (let i = 0; i < this.instructions.length; i++) {
        const instruction = this.instructions[i];
        newGraphicsPath2D.instructions.push({ action: instruction.action, data: instruction.data.slice() });
      }
    }
    return newGraphicsPath2D;
  }

  clear(): this {
    this.instructions.length = 0;
    this._dirty = true;
    return this;
  }

  transform(matrix: Matrix): this {
    if (matrix.isIdentity()) return this;
    const a = matrix.a;
    const b = matrix.b;
    const c = matrix.c;
    const d = matrix.d;
    const tx = matrix.tx;
    const ty = matrix.ty;
    let x = 0;
    let y = 0;
    let cpx1 = 0;
    let cpy1 = 0;
    let cpx2 = 0;
    let cpy2 = 0;
    let rx = 0;
    let ry = 0;
    for (let i = 0; i < this.instructions.length; i++) {
      const instruction = this.instructions[i];
      const data = instruction.data;
      switch (instruction.action) {
        case 'moveTo':
        case 'lineTo':
          x = data[0];
          y = data[1];
          data[0] = a * x + c * y + tx;
          data[1] = b * x + d * y + ty;
          break;
        case 'bezierCurveTo':
          cpx1 = data[0];
          cpy1 = data[1];
          cpx2 = data[2];
          cpy2 = data[3];
          x = data[4];
          y = data[5];
          data[0] = a * cpx1 + c * cpy1 + tx;
          data[1] = b * cpx1 + d * cpy1 + ty;
          data[2] = a * cpx2 + c * cpy2 + tx;
          data[3] = b * cpx2 + d * cpy2 + ty;
          data[4] = a * x + c * y + tx;
          data[5] = b * x + d * y + ty;
          break;
        case 'quadraticCurveTo':
          cpx1 = data[0];
          cpy1 = data[1];
          x = data[2];
          y = data[3];
          data[0] = a * cpx1 + c * cpy1 + tx;
          data[1] = b * cpx1 + d * cpy1 + ty;
          data[2] = a * x + c * y + tx;
          data[3] = b * x + d * y + ty;
          break;
        case 'arcToSvg':
          x = data[5];
          y = data[6];
          rx = data[0];
          ry = data[1];
          data[0] = a * rx + c * ry;
          data[1] = b * rx + d * ry;
          data[5] = a * x + c * y + tx;
          data[6] = b * x + d * y + ty;
          break;
        case 'circle':
          // 照 Pixi 源码:circle 的 transform 在 data[3],这里写的是 data[4]
          data[4] = adjustTransform(data[3], matrix);
          break;
        case 'rect':
          data[4] = adjustTransform(data[4], matrix);
          break;
        case 'ellipse':
          data[8] = adjustTransform(data[8], matrix);
          break;
        case 'roundRect':
          data[5] = adjustTransform(data[5], matrix);
          break;
        case 'addPath':
          data[0].transform(matrix);
          break;
        case 'poly':
          data[2] = adjustTransform(data[2], matrix);
          break;
        default:
          console.warn('[engine2d] unknown transform action', instruction.action);
          break;
      }
    }
    this._dirty = true;
    return this;
  }

  get bounds(): Bounds {
    return this.shapePath.bounds;
  }

  getLastPoint(out: Point): Point {
    let index = this.instructions.length - 1;
    let lastInstruction = this.instructions[index];
    if (!lastInstruction) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    while (lastInstruction.action === 'closePath') {
      index--;
      if (index < 0) {
        out.x = 0;
        out.y = 0;
        return out;
      }
      lastInstruction = this.instructions[index];
    }
    switch (lastInstruction.action) {
      case 'moveTo':
      case 'lineTo':
        out.x = lastInstruction.data[0];
        out.y = lastInstruction.data[1];
        break;
      case 'quadraticCurveTo':
        out.x = lastInstruction.data[2];
        out.y = lastInstruction.data[3];
        break;
      case 'bezierCurveTo':
        out.x = lastInstruction.data[4];
        out.y = lastInstruction.data[5];
        break;
      case 'arc':
      case 'arcToSvg':
        out.x = lastInstruction.data[5];
        out.y = lastInstruction.data[6];
        break;
      case 'addPath':
        lastInstruction.data[0].getLastPoint(out);
        break;
    }
    return out;
  }
}

function adjustTransform(currentMatrix: Matrix | undefined, transform: Matrix): Matrix {
  if (currentMatrix) {
    return currentMatrix.prepend(transform);
  }
  return transform.clone();
}
