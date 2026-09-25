/**
 * 文字度量:整段宽高、分行、行宽、行高、字体 ascent / descent。
 * 移植自 PixiJS v8.17(MIT)`scene/text/canvas/CanvasTextMetrics.mjs`(测量缓存 = tiny-lru 1000 条,语义相同)。
 *
 * 画布 / 上下文按 Pixi 的顺序取:先试 OffscreenCanvas,不行再用 DOM 适配层(`text/adapter.ts`)建画布;
 * node 单测可 `CanvasTextMetrics._setCanvas()` 直接塞假画布。
 */
import { getContext2D, TextDOM, type ICanvas, type ICanvasRenderingContext2D } from '../adapter';
import type { TextStyle } from '../TextStyle';
import { measureTaggedText, type FontMetrics } from './utils/measureTaggedText';
import { hasTagMarkup, hasTagStyles, type TextStyleRun } from './utils/parseTaggedText';
import { isBreakingSpace, NEWLINE_MATCH_REGEX } from './utils/textTokenization';
import { wordWrap } from './utils/wordWrap';

export type { FontMetrics } from './utils/measureTaggedText';

const contextSettings: CanvasRenderingContext2DSettings = {
  // TextMetrics requires getImageData readback for measuring fonts.
  willReadFrequently: true,
};

/** tiny-lru 的必要子集:get 刷新最近使用,set 满了淘汰最久未用 */
class LruCache<V> {
  private readonly _map = new Map<string, V>();
  constructor(private readonly _max: number) {}
  has(key: string): boolean {
    return this._map.has(key);
  }
  get(key: string): V | undefined {
    const v = this._map.get(key);
    if (v !== undefined) {
      this._map.delete(key);
      this._map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._max > 0 && this._map.size >= this._max) {
      const first = this._map.keys().next().value as string;
      this._map.delete(first);
    }
    this._map.set(key, value);
  }
  clear(): void {
    this._map.clear();
  }
}

export class CanvasTextMetrics {
  /** 用来测字体度量的串:都是高字符 */
  static METRICS_STRING = '|\xC9q\xC5';
  static BASELINE_SYMBOL = 'M';
  static BASELINE_MULTIPLIER = 1.4;
  static HEIGHT_MULTIPLIER = 2;

  /**
   * 按字素簇切分(有 Intl.Segmenter 用它,否则按码点)。可替换。
   */
  static graphemeSegmenter: (s: string) => string[] = (() => {
    // ES2020 的 lib 没有 Intl.Segmenter 的类型声明
    const IntlSeg = (typeof Intl !== 'undefined' ? Intl : undefined) as unknown as {
      Segmenter?: new () => { segment(s: string): Iterable<{ segment: string }> };
    } | undefined;
    if (typeof IntlSeg?.Segmenter === 'function') {
      const segmenter = new IntlSeg.Segmenter();
      return (s: string): string[] => {
        const segments = segmenter.segment(s);
        const result: string[] = [];
        let i = 0;
        for (const segment of segments) {
          result[i++] = segment.segment;
        }
        return result;
      };
    }
    return (s: string): string[] => [...s];
  })();

  static _experimentalLetterSpacingSupported?: boolean;
  /** 用浏览器原生 letterSpacing(实验性;缺省关,与 Pixi 相同) */
  static experimentalLetterSpacing = false;

  private static _fonts: Record<string, FontMetrics> = {};
  private static __canvas: ICanvas | undefined;
  private static __context: ICanvasRenderingContext2D | undefined;
  private static readonly _measurementCache = new LruCache<CanvasTextMetrics>(1e3);

  text: string;
  style: TextStyle;
  width: number;
  height: number;
  lines: string[];
  lineWidths: number[];
  lineHeight: number;
  maxLineWidth: number;
  fontProperties: FontMetrics;
  runsByLine?: TextStyleRun[][];
  lineAscents?: number[];
  lineDescents?: number[];
  lineHeights?: number[];
  hasDropShadow?: boolean;

  constructor(
    text: string,
    style: TextStyle,
    width: number,
    height: number,
    lines: string[],
    lineWidths: number[],
    lineHeight: number,
    maxLineWidth: number,
    fontProperties: FontMetrics,
    taggedData?: {
      runsByLine?: TextStyleRun[][];
      lineAscents?: number[];
      lineDescents?: number[];
      lineHeights?: number[];
      hasDropShadow?: boolean;
    },
  ) {
    this.text = text;
    this.style = style;
    this.width = width;
    this.height = height;
    this.lines = lines;
    this.lineWidths = lineWidths;
    this.lineHeight = lineHeight;
    this.maxLineWidth = maxLineWidth;
    this.fontProperties = fontProperties;
    if (taggedData) {
      this.runsByLine = taggedData.runsByLine;
      this.lineAscents = taggedData.lineAscents;
      this.lineDescents = taggedData.lineDescents;
      this.lineHeights = taggedData.lineHeights;
      this.hasDropShadow = taggedData.hasDropShadow;
    }
  }

  /** 浏览器是否有 2D 上下文的 letterSpacing(Chrome < 94 叫 textLetterSpacing) */
  static get experimentalLetterSpacingSupported(): boolean {
    let result = CanvasTextMetrics._experimentalLetterSpacingSupported;
    if (result === undefined) {
      const proto = TextDOM.get().getCanvasRenderingContext2D().prototype;
      result = CanvasTextMetrics._experimentalLetterSpacingSupported = 'letterSpacing' in proto || 'textLetterSpacing' in proto;
    }
    return result;
  }

  /** 测一段文字(结果按 文字 + styleKey + 是否换行 缓存) */
  static measureText(text = ' ', style: TextStyle, canvas: ICanvas = CanvasTextMetrics._canvas, wordWrap2: boolean = style.wordWrap): CanvasTextMetrics {
    const textKey = `${text}-${style.styleKey}-wordWrap-${wordWrap2}`;
    if (CanvasTextMetrics._measurementCache.has(textKey)) {
      return CanvasTextMetrics._measurementCache.get(textKey)!;
    }
    const isTagged = hasTagStyles(style) && hasTagMarkup(text);
    if (isTagged) {
      const result = measureTaggedText(
        text,
        style,
        wordWrap2,
        CanvasTextMetrics._context,
        CanvasTextMetrics._measureText,
        CanvasTextMetrics.measureFont,
        CanvasTextMetrics.canBreakChars,
        CanvasTextMetrics.wordWrapSplit,
      );
      const measurements2 = new CanvasTextMetrics(
        text,
        style,
        result.width,
        result.height,
        result.lines,
        result.lineWidths,
        result.lineHeight,
        result.maxLineWidth,
        result.fontProperties,
        {
          runsByLine: result.runsByLine,
          lineAscents: result.lineAscents,
          lineDescents: result.lineDescents,
          lineHeights: result.lineHeights,
          hasDropShadow: result.hasDropShadow,
        },
      );
      CanvasTextMetrics._measurementCache.set(textKey, measurements2);
      return measurements2;
    }
    const font = style._fontString;
    const fontProperties = CanvasTextMetrics.measureFont(font);
    if (fontProperties.fontSize === 0) {
      fontProperties.fontSize = style.fontSize;
      fontProperties.ascent = style.fontSize;
      fontProperties.descent = 0;
    }
    const context = CanvasTextMetrics._context;
    context.font = font;
    const outputText = wordWrap2 ? CanvasTextMetrics._wordWrap(text, style, canvas) : text;
    const lines = outputText.split(NEWLINE_MATCH_REGEX);
    const lineWidths = new Array<number>(lines.length);
    let maxLineWidth = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineWidth = CanvasTextMetrics._measureText(lines[i], style.letterSpacing, context);
      lineWidths[i] = lineWidth;
      maxLineWidth = Math.max(maxLineWidth, lineWidth);
    }
    const strokeWidth = style._stroke?.width ?? 0;
    const lineHeight = style.lineHeight || fontProperties.fontSize;
    const baseWidth = CanvasTextMetrics._getAlignWidth(maxLineWidth, style, wordWrap2);
    const width = CanvasTextMetrics._adjustWidthForStyle(baseWidth, style);
    const baseHeight = Math.max(lineHeight, fontProperties.fontSize + strokeWidth) + (lines.length - 1) * (lineHeight + style.leading);
    const height = CanvasTextMetrics._adjustHeightForStyle(baseHeight, style);
    const measurements = new CanvasTextMetrics(
      text,
      style,
      width,
      height,
      lines,
      lineWidths,
      lineHeight + style.leading,
      maxLineWidth,
      fontProperties,
    );
    CanvasTextMetrics._measurementCache.set(textKey, measurements);
    return measurements;
  }

  private static _adjustWidthForStyle(baseWidth: number, style: TextStyle): number {
    const strokeWidth = style._stroke?.width || 0;
    let width = baseWidth + strokeWidth;
    if (style.dropShadow) width += style.dropShadow.distance;
    return width;
  }

  private static _adjustHeightForStyle(baseHeight: number, style: TextStyle): number {
    let height = baseHeight;
    if (style.dropShadow) height += style.dropShadow.distance;
    return height;
  }

  private static _getAlignWidth(maxLineWidth: number, style: TextStyle, wordWrapEnabled: boolean): number {
    const useWrapWidth = wordWrapEnabled && style.align !== 'left';
    return useWrapWidth ? Math.max(maxLineWidth, style.wordWrapWidth) : maxLineWidth;
  }

  /** @internal 一串字的渲染宽(含字距),取 advance 宽与实际包围盒宽的较大者 */
  static _measureText(text: string, letterSpacing: number, context: ICanvasRenderingContext2D): number {
    let useExperimentalLetterSpacing = false;
    if (CanvasTextMetrics.experimentalLetterSpacingSupported) {
      if (CanvasTextMetrics.experimentalLetterSpacing) {
        context.letterSpacing = `${letterSpacing}px`;
        context.textLetterSpacing = `${letterSpacing}px`;
        useExperimentalLetterSpacing = true;
      } else {
        context.letterSpacing = '0px';
        context.textLetterSpacing = '0px';
      }
    }
    const metrics = context.measureText(text);
    let metricWidth = metrics.width;
    const actualBoundingBoxLeft = -(metrics.actualBoundingBoxLeft ?? 0);
    const actualBoundingBoxRight = metrics.actualBoundingBoxRight ?? 0;
    let boundsWidth = actualBoundingBoxRight - actualBoundingBoxLeft;
    if (metricWidth > 0) {
      if (useExperimentalLetterSpacing) {
        metricWidth -= letterSpacing;
        boundsWidth -= letterSpacing;
      } else {
        const val = (CanvasTextMetrics.graphemeSegmenter(text).length - 1) * letterSpacing;
        metricWidth += val;
        boundsWidth += val;
      }
    }
    return Math.max(metricWidth, boundsWidth);
  }

  private static _wordWrap(text: string, style: TextStyle, canvas: ICanvas = CanvasTextMetrics._canvas): string {
    return wordWrap(
      text,
      style,
      canvas,
      CanvasTextMetrics._measureText,
      CanvasTextMetrics.canBreakWords,
      CanvasTextMetrics.canBreakChars,
      CanvasTextMetrics.wordWrapSplit,
    );
  }

  /** 可覆盖:是否可断行的空白 */
  static isBreakingSpace(char: string, _nextChar?: string): boolean {
    return isBreakingSpace(char, _nextChar);
  }

  /** 可覆盖:这个词能不能拆 */
  static canBreakWords(_token: string, breakWords: boolean): boolean {
    return breakWords;
  }

  /** 可覆盖:这两个字之间能不能断 */
  static canBreakChars(_char: string, _nextChar: string, _token: string, _index: number, _breakWords: boolean): boolean {
    return true;
  }

  /** 可覆盖:拆词时的切分 */
  static wordWrapSplit(token: string): string[] {
    return CanvasTextMetrics.graphemeSegmenter(token);
  }

  /** 字体的 ascent / descent / fontSize(按 font 串缓存) */
  static measureFont(font: string): FontMetrics {
    if (CanvasTextMetrics._fonts[font]) {
      return CanvasTextMetrics._fonts[font];
    }
    const context = CanvasTextMetrics._context;
    context.font = font;
    const metrics = context.measureText(CanvasTextMetrics.METRICS_STRING + CanvasTextMetrics.BASELINE_SYMBOL);
    const ascent = metrics.actualBoundingBoxAscent ?? 0;
    const descent = metrics.actualBoundingBoxDescent ?? 0;
    const properties: FontMetrics = {
      ascent,
      descent,
      fontSize: ascent + descent,
    };
    CanvasTextMetrics._fonts[font] = properties;
    return properties;
  }

  /** 清字体度量缓存(不给 font 则全清) */
  static clearMetrics(font = ''): void {
    if (font) {
      delete CanvasTextMetrics._fonts[font];
    } else {
      CanvasTextMetrics._fonts = {};
    }
  }

  /** @ignore 测量用画布 */
  static get _canvas(): ICanvas {
    if (!CanvasTextMetrics.__canvas) {
      let canvas: ICanvas;
      try {
        const c = new OffscreenCanvas(0, 0);
        const context = c.getContext('2d', contextSettings);
        if (context?.measureText) {
          CanvasTextMetrics.__canvas = c;
          return c;
        }
        canvas = TextDOM.get().createCanvas();
      } catch (_cx) {
        canvas = TextDOM.get().createCanvas();
      }
      canvas.width = canvas.height = 10;
      CanvasTextMetrics.__canvas = canvas;
    }
    return CanvasTextMetrics.__canvas;
  }

  /** @ignore */
  static get _context(): ICanvasRenderingContext2D {
    if (!CanvasTextMetrics.__context) {
      CanvasTextMetrics.__context = getContext2D(CanvasTextMetrics._canvas, contextSettings);
    }
    return CanvasTextMetrics.__context;
  }

  /**
   * engine2d 附加(测试 / 换环境用):替换测量画布并清空全部缓存(字体度量、测量结果、字距支持探测)。
   * 传 undefined 则恢复为下次按 Pixi 的规则重新获取。
   */
  static _setCanvas(canvas?: ICanvas): void {
    CanvasTextMetrics.__canvas = canvas;
    CanvasTextMetrics.__context = undefined;
    CanvasTextMetrics._fonts = {};
    CanvasTextMetrics._measurementCache.clear();
    CanvasTextMetrics._experimentalLetterSpacingSupported = undefined;
  }
}
