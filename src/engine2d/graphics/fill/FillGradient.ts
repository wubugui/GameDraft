/**
 * 线性 / 径向渐变填充。移植自 PixiJS v8.17(MIT):scene/graphics/shared/fill/FillGradient。
 * 渐变在一张 canvas 上用 2D 上下文画出(与 Pixi 相同的 createLinearGradient / createRadialGradient 调用序列),
 * 包成纹理;`transform` 把纹理映射回形状空间。
 *
 * 与 Pixi 的差别:
 * - Pixi 用 `DOMAdapter.get().createCanvas` 取画布、`ImageSource` 包画布;这里用可替换的
 *   `FillGradient.createCanvas`(node 单测里换成假画布)和 `CanvasSource`(engine2d 的画布源,上传语义相同)。
 *   源照 Pixi 的 ImageSource 设 `autoGarbageCollect`:游戏 destroy 图形不会销毁渐变,丢掉的渐变纹理靠空闲回收放掉。
 */
import { Color, type ColorSource } from '../../color/Color';
import { Matrix } from '../../math/Matrix';
import type { PointData } from '../../math/Point';
import { Texture } from '../../textures/Texture';
import { CanvasSource } from '../../textures/TextureSource';
import type { WRAP_MODE } from '../../textures/TextureStyle';
import { uid } from '../../utils/uid';
import type { TextureSpace } from '../FillTypes';
import { pixiColorHexa } from '../utils/pixiColor';

export type GradientType = 'linear' | 'radial';

export interface BaseGradientOptions {
  type?: GradientType;
  colorStops?: { offset: number; color: ColorSource }[];
  textureSpace?: TextureSpace;
  textureSize?: number;
  wrapMode?: WRAP_MODE;
}

export interface LinearGradientOptions extends BaseGradientOptions {
  type?: 'linear';
  start?: PointData;
  end?: PointData;
}

export interface RadialGradientOptions extends BaseGradientOptions {
  type?: 'radial';
  center?: PointData;
  innerRadius?: number;
  outerCenter?: PointData;
  outerRadius?: number;
  scale?: number;
  rotation?: number;
}

export type GradientOptions = LinearGradientOptions | RadialGradientOptions;

/** 渐变用的画布(浏览器里是 HTMLCanvasElement;单测可给只实现这几个成员的假对象) */
export interface GradientCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
}

const emptyColorStops = [{ offset: 0, color: 'white' }, { offset: 1, color: 'black' }];

/** 合并缺省值后的选项(线性与径向字段的并集) */
interface AllGradientOptions extends Omit<LinearGradientOptions, 'type'>, Omit<RadialGradientOptions, 'type'> {
  type: GradientType;
  textureSize: number;
  wrapMode: WRAP_MODE;
  textureSpace: TextureSpace;
  colorStops: { offset: number; color: ColorSource }[];
}

export class FillGradient {
  static readonly defaultLinearOptions: LinearGradientOptions = {
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
    colorStops: [],
    textureSpace: 'local',
    type: 'linear',
    textureSize: 256,
    wrapMode: 'clamp-to-edge',
  };

  static readonly defaultRadialOptions: RadialGradientOptions = {
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0,
    outerRadius: 0.5,
    colorStops: [],
    scale: 1,
    textureSpace: 'local',
    type: 'radial',
    textureSize: 256,
    wrapMode: 'clamp-to-edge',
  };

  /**
   * 取一张画布(对应 Pixi 的 `DOMAdapter.get().createCanvas`)。node 单测里直接替换这个静态函数注入假画布。
   */
  static createCanvas: (width: number, height: number) => GradientCanvas = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };

  readonly uid = uid('fillGradient');
  _tick = 0;
  readonly type: GradientType = 'linear';
  texture!: Texture;
  transform!: Matrix;
  colorStops: Array<{ offset: number; color: string }> = [];
  textureSpace: TextureSpace;
  private readonly _textureSize: number;
  private readonly _wrapMode: WRAP_MODE;
  start!: PointData;
  end!: PointData;
  center!: PointData;
  outerCenter!: PointData;
  innerRadius!: number;
  outerRadius!: number;
  scale!: number;
  rotation!: number;

  constructor(options: GradientOptions);
  /** @deprecated 照 Pixi 8.5.2:改用选项对象 */
  constructor(x0?: number, y0?: number, x1?: number, y1?: number, textureSpace?: TextureSpace, textureSize?: number);
  constructor(...args: unknown[]) {
    const options = ensureGradientOptions(args);
    const defaults = options.type === 'radial' ? FillGradient.defaultRadialOptions : FillGradient.defaultLinearOptions;
    const o = { ...defaults, ...definedProps(options) } as AllGradientOptions;
    this._textureSize = o.textureSize;
    this._wrapMode = o.wrapMode;
    if (o.type === 'radial') {
      this.center = o.center!;
      this.outerCenter = o.outerCenter ?? this.center;
      this.innerRadius = o.innerRadius!;
      this.outerRadius = o.outerRadius!;
      this.scale = o.scale!;
      this.rotation = o.rotation!;
    } else {
      this.start = o.start!;
      this.end = o.end!;
    }
    this.textureSpace = o.textureSpace;
    this.type = o.type;
    o.colorStops.forEach((stop) => {
      this.addColorStop(stop.offset, stop.color);
    });
  }

  addColorStop(offset: number, color: ColorSource): this {
    this.colorStops.push({ offset, color: pixiColorHexa(Color.shared.setValue(color)) });
    return this;
  }

  buildLinearGradient(): void {
    if (this.texture) return;
    let { x: x0, y: y0 } = this.start;
    let { x: x1, y: y1 } = this.end;
    let dx = x1 - x0;
    let dy = y1 - y0;
    const flip = dx < 0 || dy < 0;
    if (this._wrapMode === 'clamp-to-edge') {
      if (dx < 0) {
        const temp = x0;
        x0 = x1;
        x1 = temp;
        dx *= -1;
      }
      if (dy < 0) {
        const temp = y0;
        y0 = y1;
        y1 = temp;
        dy *= -1;
      }
    }
    const colorStops = this.colorStops.length ? this.colorStops : emptyColorStops;
    const defaultSize = this._textureSize;
    const { canvas, context } = getCanvas(defaultSize, 1);
    const gradient = !flip
      ? context.createLinearGradient(0, 0, this._textureSize, 0)
      : context.createLinearGradient(this._textureSize, 0, 0, 0);
    addColorStops(gradient, colorStops);
    context.fillStyle = gradient;
    context.fillRect(0, 0, defaultSize, 1);
    this.texture = new Texture({
      source: new CanvasSource({
        resource: canvas as HTMLCanvasElement,
        addressMode: this._wrapMode,
        autoGarbageCollect: true,
      }),
    });
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    const m = new Matrix();
    m.scale(dist / defaultSize, 1);
    m.rotate(angle);
    m.translate(x0, y0);
    if (this.textureSpace === 'local') {
      m.scale(defaultSize, defaultSize);
    }
    this.transform = m;
  }

  buildGradient(): void {
    if (!this.texture) this._tick++;
    if (this.type === 'linear') {
      this.buildLinearGradient();
    } else {
      this.buildRadialGradient();
    }
  }

  buildRadialGradient(): void {
    if (this.texture) return;
    const colorStops = this.colorStops.length ? this.colorStops : emptyColorStops;
    const defaultSize = this._textureSize;
    const { canvas, context } = getCanvas(defaultSize, defaultSize);
    const { x: x0, y: y0 } = this.center;
    const { x: x1, y: y1 } = this.outerCenter;
    const r0 = this.innerRadius;
    const r1 = this.outerRadius;
    const ox = x1 - r1;
    const oy = y1 - r1;
    const scale = defaultSize / (r1 * 2);
    const cx = (x0 - ox) * scale;
    const cy = (y0 - oy) * scale;
    const gradient = context.createRadialGradient(
      cx,
      cy,
      r0 * scale,
      (x1 - ox) * scale,
      (y1 - oy) * scale,
      r1 * scale,
    );
    addColorStops(gradient, colorStops);
    context.fillStyle = colorStops[colorStops.length - 1].color;
    context.fillRect(0, 0, defaultSize, defaultSize);
    context.fillStyle = gradient;
    context.translate(cx, cy);
    context.rotate(this.rotation);
    context.scale(1, this.scale);
    context.translate(-cx, -cy);
    context.fillRect(0, 0, defaultSize, defaultSize);
    this.texture = new Texture({
      source: new CanvasSource({
        resource: canvas as HTMLCanvasElement,
        addressMode: this._wrapMode,
        autoGarbageCollect: true,
      }),
    });
    const m = new Matrix();
    m.scale(1 / scale, 1 / scale);
    m.translate(ox, oy);
    if (this.textureSpace === 'local') {
      m.scale(defaultSize, defaultSize);
    }
    this.transform = m;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.texture = null as unknown as Texture;
    this.transform = null as unknown as Matrix;
    this.colorStops = [];
    this.start = null as unknown as PointData;
    this.end = null as unknown as PointData;
    this.center = null as unknown as PointData;
    this.outerCenter = null as unknown as PointData;
  }

  get styleKey(): string {
    return `fill-gradient-${this.uid}-${this._tick}`;
  }
}

function addColorStops(gradient: CanvasGradient, colorStops: { offset: number; color: string }[]): void {
  for (let i = 0; i < colorStops.length; i++) {
    const stop = colorStops[i];
    gradient.addColorStop(stop.offset, stop.color);
  }
}

function getCanvas(width: number, height: number): { canvas: GradientCanvas; context: CanvasRenderingContext2D } {
  const canvas = FillGradient.createCanvas(width, height);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  return { canvas, context };
}

function ensureGradientOptions(args: unknown[]): GradientOptions {
  let options = (args[0] ?? {}) as GradientOptions | number;
  if (typeof options === 'number' || args[1]) {
    options = {
      type: 'linear',
      start: { x: args[0] as number, y: args[1] as number },
      end: { x: args[2] as number, y: args[3] as number },
      textureSpace: args[4] as TextureSpace,
      textureSize: (args[5] as number | undefined) ?? FillGradient.defaultLinearOptions.textureSize,
    };
  }
  return options;
}

/** 去掉值为 undefined 的键(照 Pixi `definedProps`) */
function definedProps<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
