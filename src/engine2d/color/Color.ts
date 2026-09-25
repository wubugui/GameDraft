/**
 * 颜色(照 Pixi `Color` 的必要子集)。接受:0xRRGGBB 数字、'#rgb' / '#rgba' / '#rrggbb' / '#rrggbbaa' / '0x…' 字符串、
 * 'rgb()/rgba()' 字符串、CSS 颜色名、[r,g,b(,a)] 0..1 数组 / Float32Array、{r,g,b,a?}(0..255)对象、Color 本身。
 * 内部存 0..1 的 r g b a。
 */
export type ColorSource =
  | number
  | string
  | number[]
  | Float32Array
  | Uint8Array
  | Uint8ClampedArray
  | { r: number; g: number; b: number; a?: number }
  | Color
  | null
  | undefined;

const NAMED: Record<string, number> = {
  black: 0x000000, white: 0xffffff, red: 0xff0000, green: 0x008000, lime: 0x00ff00, blue: 0x0000ff,
  yellow: 0xffff00, cyan: 0x00ffff, aqua: 0x00ffff, magenta: 0xff00ff, fuchsia: 0xff00ff, gray: 0x808080,
  grey: 0x808080, silver: 0xc0c0c0, maroon: 0x800000, olive: 0x808000, purple: 0x800080, teal: 0x008080,
  navy: 0x000080, orange: 0xffa500, pink: 0xffc0cb, brown: 0xa52a2a, gold: 0xffd700, transparent: 0x000000,
  darkgray: 0xa9a9a9, darkgrey: 0xa9a9a9, lightgray: 0xd3d3d3, lightgrey: 0xd3d3d3, dimgray: 0x696969,
  whitesmoke: 0xf5f5f5, gainsboro: 0xdcdcdc, beige: 0xf5f5dc, ivory: 0xfffff0, khaki: 0xf0e68c,
  crimson: 0xdc143c, coral: 0xff7f50, tomato: 0xff6347, salmon: 0xfa8072, tan: 0xd2b48c, wheat: 0xf5deb3,
  skyblue: 0x87ceeb, steelblue: 0x4682b4, royalblue: 0x4169e1, indigo: 0x4b0082, violet: 0xee82ee,
  orchid: 0xda70d6, plum: 0xdda0dd, chocolate: 0xd2691e, sienna: 0xa0522d, peru: 0xcd853f,
  darkred: 0x8b0000, darkgreen: 0x006400, darkblue: 0x00008b, lightblue: 0xadd8e6, lightgreen: 0x90ee90,
  lightyellow: 0xffffe0, darkorange: 0xff8c00, forestgreen: 0x228b22, seagreen: 0x2e8b57,
};

let parseCanvas: CanvasRenderingContext2D | null | undefined;

function parseCss(value: string): [number, number, number, number] | null {
  if (parseCanvas === undefined) {
    try {
      parseCanvas = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      parseCanvas = null;
    }
  }
  if (!parseCanvas) return null;
  parseCanvas.fillStyle = '#010203';
  parseCanvas.fillStyle = value;
  const out = String(parseCanvas.fillStyle);
  if (out === '#010203' && value.replace(/\s/g, '').toLowerCase() !== '#010203') return null;
  return parseString(out, false);
}

function parseString(raw: string, allowCss = true): [number, number, number, number] | null {
  const s = raw.trim().toLowerCase();
  if (s in NAMED) {
    const n = NAMED[s];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, s === 'transparent' ? 0 : 1];
  }
  let hex: string | null = null;
  if (s.startsWith('#')) hex = s.slice(1);
  else if (s.startsWith('0x')) hex = s.slice(2);
  else if (/^[0-9a-f]{6}$|^[0-9a-f]{8}$|^[0-9a-f]{3}$/.test(s)) hex = s;
  if (hex !== null) {
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 6) hex += 'ff';
    if (/^[0-9a-f]{8}$/.test(hex)) {
      const v = parseInt(hex, 16) >>> 0;
      return [((v >>> 24) & 255) / 255, ((v >>> 16) & 255) / 255, ((v >>> 8) & 255) / 255, (v & 255) / 255];
    }
    return null;
  }
  const m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const ch = (p: string): number => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
      const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      return [ch(parts[0]), ch(parts[1]), ch(parts[2]), a];
    }
  }
  return allowCss ? parseCss(raw) : null;
}

export class Color {
  static readonly shared = new Color();
  private static readonly _temp = new Color();

  /** 分量存 float32(与 Pixi 相同;依赖分量做运算的地方 —— 颜色矩阵、渐变 —— 才与 master 逐数一致) */
  private readonly _components = new Float32Array([1, 1, 1, 1]);
  private _int = 0xffffff;
  private _value: ColorSource = 0xffffff;
  private _arrayRgb: number[] | undefined;
  private _arrayRgba: number[] | undefined;

  constructor(value: ColorSource = 0xffffff) {
    this.setValue(value);
  }

  get red(): number { return this._components[0]; }
  get green(): number { return this._components[1]; }
  get blue(): number { return this._components[2]; }
  get alpha(): number { return this._components[3]; }
  get value(): ColorSource { return this._value; }
  set value(v: ColorSource) { this.setValue(v); }

  setValue(value: ColorSource): this {
    if (value instanceof Color) {
      this._value = value._value;
      this._components.set(value._components);
      this._int = value._int;
      return this;
    }
    this._value = value;
    this._components.set(Color.normalize(value));
    this._refreshInt();
    return this;
  }

  setAlpha(alpha: number): this {
    this._components[3] = clamp(alpha);
    this._value = null;
    return this;
  }

  /** 0xRRGGBB(各分量 ×255 截断,与 Pixi 相同) */
  toNumber(): number {
    return this._int;
  }

  /** 0xBBGGRR(各分量 ×255 四舍五入,与 Pixi 相同;tint 用它) */
  toBgrNumber(): number {
    const [r, g, b] = this.toUint8RgbArray();
    return (b << 16) + (g << 8) + r;
  }

  toLittleEndianNumber(): number {
    const v = this._int;
    return (v >> 16) + (v & 0xff00) + ((v & 0xff) << 16);
  }

  toUint8RgbArray<T extends number[] | Uint8Array | Uint8ClampedArray>(out?: T): T {
    const o = (out ?? (this._arrayRgb ??= [])) as number[];
    const [r, g, b] = this._components;
    o[0] = Math.round(r * 255);
    o[1] = Math.round(g * 255);
    o[2] = Math.round(b * 255);
    return o as T;
  }

  toArray<T extends number[] | Float32Array>(out?: T): T {
    const o = (out ?? (this._arrayRgba ??= [])) as number[];
    const [r, g, b, a] = this._components;
    o[0] = r;
    o[1] = g;
    o[2] = b;
    o[3] = a;
    return o as T;
  }

  toRgbArray<T extends number[] | Float32Array>(out?: T): T {
    const o = (out ?? (this._arrayRgb ??= [])) as number[];
    const [r, g, b] = this._components;
    o[0] = r;
    o[1] = g;
    o[2] = b;
    return o as T;
  }

  toRgba(): { r: number; g: number; b: number; a: number } {
    const [r, g, b, a] = this._components;
    return { r, g, b, a };
  }

  toRgb(): { r: number; g: number; b: number } {
    const [r, g, b] = this._components;
    return { r, g, b };
  }

  toRgbaString(): string {
    const [r, g, b] = this.toUint8RgbArray();
    return `rgba(${r},${g},${b},${this.alpha})`;
  }

  toHex(): string {
    const hex = this._int.toString(16);
    return `#${'000000'.substring(0, 6 - hex.length) + hex}`;
  }

  toHexa(): string {
    const a = Math.round(this._components[3] * 255).toString(16);
    return this.toHex() + '00'.substring(0, 2 - a.length) + a;
  }

  multiply(value: ColorSource): this {
    const [r, g, b, a] = Color._temp.setValue(value)._components;
    this._components[0] *= r;
    this._components[1] *= g;
    this._components[2] *= b;
    this._components[3] *= a;
    this._refreshInt();
    this._value = null;
    return this;
  }

  premultiply(alpha: number, applyToRGB = true): this {
    if (applyToRGB) {
      this._components[0] *= alpha;
      this._components[1] *= alpha;
      this._components[2] *= alpha;
    }
    this._components[3] = alpha;
    this._refreshInt();
    this._value = null;
    return this;
  }

  toPremultiplied(alpha: number, applyToRGB = true): number {
    if (alpha === 1) return (255 << 24) + this._int;
    if (alpha === 0) return applyToRGB ? 0 : this._int;
    let r = (this._int >> 16) & 255;
    let g = (this._int >> 8) & 255;
    let b = this._int & 255;
    if (applyToRGB) {
      r = (r * alpha + 0.5) | 0;
      g = (g * alpha + 0.5) | 0;
      b = (b * alpha + 0.5) | 0;
    }
    return ((alpha * 255) << 24) + (r << 16) + (g << 8) + b;
  }

  private _refreshInt(): void {
    const c = this._components;
    for (let i = 0; i < 4; i++) c[i] = clamp(c[i]);
    const [r, g, b] = c;
    this._int = ((r * 255) << 16) + ((g * 255) << 8) + ((b * 255) | 0);
  }

  static isColorLike(value: unknown): value is ColorSource {
    try {
      Color.normalize(value as ColorSource);
      return true;
    } catch {
      return false;
    }
  }

  /** 解析成 0..1 的 [r, g, b, a](超出范围的会被 _refreshInt 夹到 0..1) */
  static normalize(value: ColorSource): [number, number, number, number] {
    if (value === null || value === undefined) throw new Error('[engine2d] Color: 空值');
    if (value instanceof Color) return [value.red, value.green, value.blue, value.alpha];
    if (typeof value === 'number') {
      const v = value >>> 0;
      return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
    }
    if (typeof value === 'string') {
      const c = parseString(value);
      if (!c) throw new Error(`[engine2d] Color: 解析不了「${value}」`);
      return c;
    }
    if (Array.isArray(value) || value instanceof Float32Array) {
      return [clamp(value[0] ?? 0), clamp(value[1] ?? 0), clamp(value[2] ?? 0), clamp(value[3] ?? 1)];
    }
    if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
      return [value[0] / 255, value[1] / 255, value[2] / 255, (value[3] ?? 255) / 255];
    }
    if (typeof value === 'object' && 'r' in value) {
      return [value.r / 255, value.g / 255, value.b / 255, value.a ?? 1];
    }
    throw new Error(`[engine2d] Color: 不认识的颜色值 ${String(value)}`);
  }
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.min(Math.max(v, min), max);
}
