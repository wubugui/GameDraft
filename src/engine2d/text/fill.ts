/**
 * 文字样式里的填充 / 描边规范化。移植自 PixiJS v8.17(MIT):
 * `scene/graphics/shared/utils/convertFillInputToFillStyle.mjs`、`GraphicsContext.defaultFillStyle / defaultStrokeStyle`、
 * `scene/graphics/shared/FillTypes.d.ts`,以及文字路径要用到的 `Color` 行为(`isColorLike` / `toNumber` / `toHex` /
 * `toHexa` / `toRgbaString`,按 Pixi 的取整与夹取规则)。
 *
 * engine2d 的 graphics 模块(FillGradient / FillPattern / GraphicsContext)不在本模块里:这里对渐变 / 图案按
 * 结构识别(`isFillGradient` / `isFillPattern`),Pixi 的这两个类以及 graphics 模块移植后的同名类都满足。
 */
import { Color, type ColorSource } from '../color/Color';
import type { Matrix } from '../math/Matrix';
import type { PointData } from '../math/Point';
import { Texture } from '../textures/Texture';

export type TextureSpace = 'local' | 'global';
export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'round' | 'bevel' | 'miter';

/** Pixi `FillGradient` 的结构(文字路径用到的字段) */
export interface FillGradientLike {
  readonly uid: number;
  readonly type: 'linear' | 'radial';
  texture: Texture;
  transform: Matrix;
  colorStops: Array<{ offset: number; color: string }>;
  textureSpace: TextureSpace;
  start: PointData;
  end: PointData;
  center: PointData;
  outerCenter: PointData;
  innerRadius: number;
  outerRadius: number;
  readonly styleKey: string;
  addColorStop(offset: number, color: ColorSource): unknown;
  buildGradient(): void;
}

/** Pixi `FillPattern` 的结构 */
export interface FillPatternLike {
  readonly uid: number;
  texture: Texture;
  transform: Matrix;
  readonly styleKey: string;
  setTransform(transform?: Matrix): void;
}

export interface FillStyle {
  color?: ColorSource;
  alpha?: number;
  texture?: Texture | null;
  matrix?: Matrix | null;
  fill?: FillPatternLike | FillGradientLike | null;
  textureSpace?: TextureSpace;
}

export interface StrokeAttributes {
  width?: number;
  alignment?: number;
  cap?: LineCap;
  join?: LineJoin;
  miterLimit?: number;
  pixelLine?: boolean;
}

export interface StrokeStyle extends FillStyle, StrokeAttributes {}

export type FillInput = ColorSource | FillGradientLike | FillPatternLike | FillStyle | Texture;
export type StrokeInput = ColorSource | FillGradientLike | FillPatternLike | StrokeStyle;

export type ConvertedFillStyle = Omit<Required<FillStyle>, 'color'> & { color: number };
export type ConvertedStrokeStyle = ConvertedFillStyle & Required<StrokeAttributes>;

/** 同 Pixi `GraphicsContext.defaultFillStyle` */
export const defaultFillStyle: ConvertedFillStyle = {
  color: 0xffffff,
  alpha: 1,
  texture: Texture.WHITE,
  matrix: null,
  fill: null,
  textureSpace: 'local',
};

/** 同 Pixi `GraphicsContext.defaultStrokeStyle` */
export const defaultStrokeStyle: ConvertedStrokeStyle = {
  width: 1,
  color: 0xffffff,
  alpha: 1,
  alignment: 0.5,
  miterLimit: 10,
  cap: 'butt',
  join: 'miter',
  texture: Texture.WHITE,
  matrix: null,
  fill: null,
  textureSpace: 'local',
  pixelLine: false,
};

// ───────────────────────── Pixi Color 行为(文字路径用到的部分)

/** 同 Pixi `Color.isColorLike`:只看类型 / 字段,不解析 */
export function isColorLike(value: unknown): value is ColorSource {
  if (typeof value === 'number' || typeof value === 'string' || value instanceof Number || value instanceof Color) return true;
  if (Array.isArray(value) || value instanceof Uint8Array || value instanceof Uint8ClampedArray || value instanceof Float32Array) return true;
  const v = value as Record<string, unknown>;
  return (v.r !== undefined && v.g !== undefined && v.b !== undefined)
    || (v.h !== undefined && v.s !== undefined && v.l !== undefined)
    || (v.h !== undefined && v.s !== undefined && v.v !== undefined);
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

const colordRound = (n: number, digits = 0): number => {
  const base = Math.pow(10, digits);
  return Math.round(base * n) / base;
};

const HEX_WITH_ALPHA = /^(#|0x)?([a-f0-9]{4}|[a-f0-9]{8})$/i;

/**
 * Pixi `Color` 的内部分量:解析后夹到 0..1。
 * 字符串 / 对象在 Pixi 里经 colord 解析:rgb 取整到 0..255,alpha 保留 3 位小数(带 alpha 的十六进制先保留 2 位),
 * 这里照做,保证 `'#ff000080'` 之类得到与 Pixi 相同的 alpha(0.5 而不是 128/255)。
 */
export function colorComponents(value: ColorSource): [number, number, number, number] {
  if (value === null || value === undefined) throw new Error('Cannot set Color#value to null');
  let [r, g, b, a] = Color.normalize(value);
  const viaColord = typeof value === 'string'
    || (typeof value === 'object' && !(value instanceof Color) && !Array.isArray(value) && !ArrayBuffer.isView(value));
  if (viaColord) {
    if (typeof value === 'string' && HEX_WITH_ALPHA.test(value.trim())) a = colordRound(a, 2);
    r = colordRound(r * 255) / 255;
    g = colordRound(g * 255) / 255;
    b = colordRound(b * 255) / 255;
    a = colordRound(a, 3);
  }
  // Pixi 的分量存在 Float32Array 里
  return [Math.fround(clamp01(r)), Math.fround(clamp01(g)), Math.fround(clamp01(b)), Math.fround(clamp01(a))];
}

/** 同 Pixi `Color#toNumber`(`_int`:各分量 ×255 后截断,不是四舍五入) */
export function pixiColorToNumber(value: ColorSource): number {
  const [r, g, b] = colorComponents(value);
  return ((r * 255) << 16) + ((g * 255) << 8) + ((b * 255) | 0);
}

function hexOf(int: number): string {
  const hexString = int.toString(16);
  return `#${'000000'.substring(0, 6 - hexString.length) + hexString}`;
}

/** 同 Pixi `Color.shared.setValue(value).toHex()` */
export function pixiColorToHex(value: ColorSource): string {
  return hexOf(pixiColorToNumber(value));
}

/** 同 Pixi `Color.shared.setValue(value).setAlpha(alpha).toHexa()`;alpha 省略 = 颜色自身的 alpha */
export function pixiColorToHexa(value: ColorSource, alpha?: number): string {
  const c = colorComponents(value);
  const a = alpha === undefined ? c[3] : Math.fround(clamp01(alpha));
  const alphaString = Math.round(a * 255).toString(16);
  return hexOf(((c[0] * 255) << 16) + ((c[1] * 255) << 8) + ((c[2] * 255) | 0)) + '00'.substring(0, 2 - alphaString.length) + alphaString;
}

/** 同 Pixi `Color.shared.setValue(value).setAlpha(alpha).toRgbaString()` */
export function pixiColorToRgbaString(value: ColorSource, alpha?: number): string {
  const c = colorComponents(value);
  const a = alpha === undefined ? c[3] : Math.fround(clamp01(alpha));
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

// ───────────────────────── 渐变 / 图案识别

export function isFillGradient(value: unknown): value is FillGradientLike {
  const v = value as Partial<FillGradientLike> | null | undefined;
  return !!v && typeof v === 'object' && Array.isArray(v.colorStops)
    && typeof v.addColorStop === 'function' && typeof v.buildGradient === 'function';
}

export function isFillPattern(value: unknown): value is FillPatternLike {
  const v = value as Partial<FillPatternLike> | null | undefined;
  return !!v && typeof v === 'object' && !isFillGradient(v) && typeof v.setTransform === 'function'
    && 'texture' in v && 'transform' in v;
}

function isTexture(value: unknown): value is Texture {
  return value instanceof Texture;
}

// ───────────────────────── toFillStyle / toStrokeStyle(逐行照 Pixi)

type Loose = Record<string, unknown>;

function handleColorLike(fill: Loose, value: ColorSource, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  const temp = colorComponents(value ?? 0);
  fill.color = ((temp[0] * 255) << 16) + ((temp[1] * 255) << 8) + ((temp[2] * 255) | 0);
  fill.alpha = temp[3] === 1 ? defaultStyle.alpha : temp[3];
  fill.texture = Texture.WHITE;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleTexture(fill: Loose, value: Texture, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  fill.texture = value;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleFillPattern(fill: Loose, value: FillPatternLike, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  fill.fill = value;
  fill.color = 0xffffff;
  fill.texture = value.texture;
  fill.matrix = value.transform;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleFillGradient(fill: Loose, value: FillGradientLike, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  value.buildGradient();
  fill.fill = value;
  fill.color = 0xffffff;
  fill.texture = value.texture;
  fill.matrix = value.transform;
  fill.textureSpace = value.textureSpace;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleFillObject(value: FillStyle, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  const style = { ...defaultStyle, ...value } as Loose;
  const color = colorComponents(style.color as ColorSource);
  style.alpha = (style.alpha as number) * color[3];
  style.color = ((color[0] * 255) << 16) + ((color[1] * 255) << 8) + ((color[2] * 255) | 0);
  return style as ConvertedFillStyle;
}

export function toFillStyle<T extends FillInput>(value: T, defaultStyle: ConvertedFillStyle): ConvertedFillStyle | null {
  if (value === undefined || value === null) return null;
  const fill: Loose = {};
  const objectStyle = value as FillStyle;
  if (isColorLike(value)) return handleColorLike(fill, value, defaultStyle);
  else if (isTexture(value)) return handleTexture(fill, value, defaultStyle);
  else if (isFillPattern(value)) return handleFillPattern(fill, value, defaultStyle);
  else if (isFillGradient(value)) return handleFillGradient(fill, value, defaultStyle);
  else if (objectStyle.fill && isFillPattern(objectStyle.fill)) return handleFillPattern(objectStyle as Loose, objectStyle.fill, defaultStyle);
  else if (objectStyle.fill && isFillGradient(objectStyle.fill)) return handleFillGradient(objectStyle as Loose, objectStyle.fill, defaultStyle);
  return handleFillObject(objectStyle, defaultStyle);
}

export function toStrokeStyle(value: StrokeInput, defaultStyle: ConvertedStrokeStyle): ConvertedStrokeStyle | null {
  const { width, alignment, miterLimit, cap, join, pixelLine, ...rest } = defaultStyle;
  const fill = toFillStyle(value, rest);
  if (!fill) return null;
  return { width, alignment, miterLimit, cap, join, pixelLine, ...fill } as ConvertedStrokeStyle;
}
