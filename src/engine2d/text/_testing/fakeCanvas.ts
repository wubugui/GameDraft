/**
 * 单测用的假画布 / 2D 上下文(node 没有 canvas)。度量可预测:按字号与字符类别给宽度,
 * actualBoundingBox 有非零的左右 / 上下伸出;所有绘制调用与属性赋值按顺序记进 `calls`,
 * 供「engine2d 与 pixi.js 同输入、调用序列逐条相同」的对照测试用。
 *
 * 另外按矩形近似记录「画到哪儿了」,让 style.trim(getImageData 扫非透明像素)也能对照。
 */

export type Call = [string, ...unknown[]];

const NARROW: Record<string, number> = {
  ' ': 0.28, i: 0.28, l: 0.28, j: 0.3, '.': 0.3, ',': 0.3, '!': 0.32, "'": 0.2, '-': 0.36,
  m: 0.85, w: 0.8, M: 0.85, W: 0.95,
};

export function parseFont(font: string): { size: number; bold: boolean; italic: boolean } {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return {
    size: m ? parseFloat(m[1]) : 10,
    bold: /\bbold(er)?\b|\b[6-9]00\b/.test(font),
    italic: /\bitalic\b|\boblique\b/.test(font),
  };
}

function charWidth(ch: string, size: number, bold: boolean): number {
  const cp = ch.codePointAt(0)!;
  let w: number;
  if (cp > 0xffff) w = 1.25; // emoji 等
  else if (cp >= 0x2e80) w = 1.0; // CJK / 全角
  else w = NARROW[ch] ?? 0.55;
  return w * size * (bold ? 1.1 : 1);
}

export class FakeGradient {
  stops: Array<[number, string]> = [];
  constructor(public kind: string, public args: number[]) {}
  addColorStop(offset: number, color: string): void {
    this.stops.push([offset, color]);
  }
}

export class FakePattern {
  transform: unknown = null;
  constructor(public source: string, public repetition: string) {}
  setTransform(m: unknown): void {
    this.transform = m ? { ...(m as object) } : null;
  }
}

interface Rect { minX: number; minY: number; maxX: number; maxY: number }

const RECORDED_PROPS = [
  'font', 'fillStyle', 'strokeStyle', 'lineWidth', 'miterLimit', 'lineJoin', 'lineCap', 'textBaseline',
  'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'letterSpacing', 'textLetterSpacing',
  'globalCompositeOperation', 'globalAlpha',
] as const;

export class FakeContext2D {
  calls: Call[] = [];
  /** 画过的区域(画布像素) */
  painted: Rect | null = null;
  private _props: Record<string, unknown> = {
    font: '10px sans-serif', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, miterLimit: 10,
    lineJoin: 'miter', lineCap: 'butt', textBaseline: 'alphabetic', shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0,
    shadowOffsetX: 0, shadowOffsetY: 0, letterSpacing: '0px', textLetterSpacing: '0px',
    globalCompositeOperation: 'source-over', globalAlpha: 1,
  };
  private _sx = 1;
  private _sy = 1;

  constructor(public canvas: FakeCanvas, public settings?: unknown) {}

  private _metrics(text: string): { width: number; left: number; right: number; ascent: number; descent: number } {
    const { size, bold, italic } = parseFont(this._props.font as string);
    let width = 0;
    let count = 0;
    for (const ch of text) {
      width += charWidth(ch, size, bold);
      count++;
    }
    const ls = parseFloat(String(this._props.letterSpacing)) || 0;
    width += ls * count;
    if (!text) return { width: 0, left: 0, right: 0, ascent: 0, descent: 0 };
    return {
      width,
      left: size * 0.03,
      right: width - size * 0.05 + (italic ? size * 0.12 : 0),
      ascent: size * 0.78 + (/[ÉÅ]/.test(text) ? size * 0.12 : 0),
      descent: /[qjgpy]/.test(text) ? size * 0.22 : size * 0.02,
    };
  }

  measureText(text: string): TextMetrics {
    this.calls.push(['measureText', text]);
    const m = this._metrics(text);
    return {
      width: m.width,
      actualBoundingBoxLeft: m.left,
      actualBoundingBoxRight: m.right,
      actualBoundingBoxAscent: m.ascent,
      actualBoundingBoxDescent: m.descent,
    } as TextMetrics;
  }

  private _paintText(text: string, x: number, y: number): void {
    const m = this._metrics(text);
    if (!text) return;
    const r: Rect = {
      minX: (x - m.left) * this._sx,
      minY: (y - m.ascent) * this._sy,
      maxX: (x + m.right) * this._sx,
      maxY: (y + m.descent) * this._sy,
    };
    this._paintRect(r);
    const shadow = String(this._props.shadowColor);
    if (!/rgba\(0,\s*0,\s*0,\s*0\)/.test(shadow)) {
      const ox = this._props.shadowOffsetX as number;
      const oy = this._props.shadowOffsetY as number;
      const b = this._props.shadowBlur as number;
      this._paintRect({ minX: r.minX + ox - b, minY: r.minY + oy - b, maxX: r.maxX + ox + b, maxY: r.maxY + oy + b });
    }
  }

  private _paintRect(r: Rect): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const c: Rect = {
      minX: Math.max(0, r.minX), minY: Math.max(0, r.minY), maxX: Math.min(w, r.maxX), maxY: Math.min(h, r.maxY),
    };
    if (c.minX >= c.maxX || c.minY >= c.maxY) return;
    const p = this.painted;
    this.painted = p
      ? { minX: Math.min(p.minX, c.minX), minY: Math.min(p.minY, c.minY), maxX: Math.max(p.maxX, c.maxX), maxY: Math.max(p.maxY, c.maxY) }
      : c;
  }

  fillText(text: string, x: number, y: number): void {
    this.calls.push(['fillText', text, x, y]);
    this._paintText(text, x, y);
  }

  strokeText(text: string, x: number, y: number): void {
    this.calls.push(['strokeText', text, x, y]);
    this._paintText(text, x, y);
  }

  resetTransform(): void {
    this.calls.push(['resetTransform']);
    this._sx = 1;
    this._sy = 1;
  }

  scale(x: number, y: number): void {
    this.calls.push(['scale', x, y]);
    this._sx *= x;
    this._sy *= y;
  }

  translate(x: number, y: number): void {
    this.calls.push(['translate', x, y]);
  }

  rotate(a: number): void {
    this.calls.push(['rotate', a]);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(['clearRect', x, y, w, h]);
    if (x <= 0 && y <= 0 && x + w >= this.canvas.width && y + h >= this.canvas.height) this.painted = null;
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(['strokeRect', x, y, w, h]);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(['fillRect', x, y, w, h]);
  }

  createLinearGradient(...args: number[]): FakeGradient {
    this.calls.push(['createLinearGradient', ...args]);
    return new FakeGradient('linear', args);
  }

  createRadialGradient(...args: number[]): FakeGradient {
    this.calls.push(['createRadialGradient', ...args]);
    return new FakeGradient('radial', args);
  }

  createPattern(source: { width?: number } | null, repetition: string): FakePattern {
    this.calls.push(['createPattern', repetition]);
    return new FakePattern(source ? `w${source.width}` : 'null', repetition);
  }

  drawImage(src: unknown, ...args: number[]): void {
    const desc = src instanceof FakeCanvas ? 'canvas' : (src as { tag?: string })?.tag ?? 'image';
    this.calls.push(['drawImage', desc, ...args]);
    if (src instanceof FakeCanvas) {
      const p = src.context.painted;
      if (!p) return;
      const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8 ? args : [0, 0, src.width, src.height, args[0], args[1], src.width, src.height];
      const kx = dw / sw;
      const ky = dh / sh;
      this._paintRect({
        minX: dx + (Math.max(p.minX, sx) - sx) * kx,
        minY: dy + (Math.max(p.minY, sy) - sy) * ky,
        maxX: dx + (Math.min(p.maxX, sx + sw) - sx) * kx,
        maxY: dy + (Math.min(p.maxY, sy + sh) - sy) * ky,
      });
    }
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    this.calls.push(['getImageData', x, y, w, h]);
    const data = new Uint8ClampedArray(w * h * 4);
    const p = this.painted;
    if (p) {
      // 像素中心落在画过的矩形里就算不透明
      for (let py = 0; py < h; py++) {
        const cy = y + py + 0.5;
        if (cy < p.minY || cy > p.maxY) continue;
        for (let px = 0; px < w; px++) {
          const cx = x + px + 0.5;
          if (cx < p.minX || cx > p.maxX) continue;
          data[(py * w + px) * 4 + 3] = 255;
        }
      }
    }
    return { data, width: w, height: h };
  }
}

// 属性:赋值记一条 ['set', 名, 值]
for (const name of RECORDED_PROPS) {
  Object.defineProperty(FakeContext2D.prototype, name, {
    get(this: FakeContext2D) {
      return (this as unknown as { _props: Record<string, unknown> })._props[name];
    },
    set(this: FakeContext2D, v: unknown) {
      this.calls.push(['set', name, v]);
      (this as unknown as { _props: Record<string, unknown> })._props[name] = v;
    },
    configurable: true,
    enumerable: true,
  });
}

let canvasCount = 0;

export class FakeCanvas {
  readonly id = canvasCount++;
  private _w: number;
  private _h: number;
  private _ctx: FakeContext2D | null = null;
  style: Record<string, string> = {};

  constructor(width = 0, height = 0) {
    this._w = width | 0;
    this._h = height | 0;
  }

  get width(): number {
    return this._w;
  }
  set width(v: number) {
    this._w = Number(v) | 0;
    if (this._ctx) this._ctx.painted = null;
  }
  get height(): number {
    return this._h;
  }
  set height(v: number) {
    this._h = Number(v) | 0;
    if (this._ctx) this._ctx.painted = null;
  }

  get context(): FakeContext2D {
    return (this._ctx ??= new FakeContext2D(this));
  }

  getContext(type: string, settings?: unknown): FakeContext2D | null {
    if (type !== '2d') return null;
    if (!this._ctx) this._ctx = new FakeContext2D(this, settings);
    return this._ctx;
  }
}

/** 假 Image:设 src 后下一个微任务触发 onload */
export class FakeImage {
  tag = 'image';
  width = 0;
  height = 0;
  crossOrigin: string | null = null;
  onload: (() => void) | null = null;
  private _src = '';
  get src(): string {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    if (v) queueMicrotask(() => this.onload?.());
  }
  remove(): void {}
}

/** 同时满足 pixi.js 的 DOMAdapter 与 engine2d 的 TextDOMAdapter */
export function makeFakeAdapter(): {
  createCanvas(w?: number, h?: number): FakeCanvas;
  createImage(): FakeImage;
  getCanvasRenderingContext2D(): { prototype: object };
  getWebGLRenderingContext(): unknown;
  getNavigator(): { userAgent: string; gpu: null };
  getBaseUrl(): string;
  getFontFaceSet(): null;
  fetch(url: RequestInfo, options?: RequestInit): Promise<Response>;
  parseXML(xml: string): Document;
} {
  return {
    createCanvas: (w?: number, h?: number) => new FakeCanvas(w ?? 0, h ?? 0),
    createImage: () => new FakeImage(),
    getCanvasRenderingContext2D: () => FakeContext2D,
    getWebGLRenderingContext: () => class {},
    getNavigator: () => ({ userAgent: 'node-fake Chrome', gpu: null }),
    getBaseUrl: () => 'http://localhost/',
    getFontFaceSet: () => null,
    fetch: () => Promise.reject(new Error('no fetch in tests')),
    parseXML: () => {
      throw new Error('no xml in tests');
    },
  };
}
