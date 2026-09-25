/**
 * 文字样式。移植自 PixiJS v8.17(MIT)`scene/text/TextStyle.mjs`:属性、缺省值、fontSize / fontStyle 的规范化、
 * fill / stroke 经 `toFillStyle` / `toStrokeStyle` 转换、dropShadow 与对象型 fill / stroke 用 Proxy 监听字段改动、
 * `styleKey` = `${uid}-${_tick}`、改任何属性发 `update` 事件,以及 v7 写法(strokeThickness / dropShadowXxx /
 * fillGradientStops)的兼容转换。
 */
import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import type { ColorSource } from '../color/Color';
import type { Filter } from '../filters/Filter';
import { fontStringFromTextStyle } from './canvas/utils/fontStringFromTextStyle';
import {
  defaultFillStyle,
  defaultStrokeStyle,
  isColorLike,
  isFillGradient,
  isFillPattern,
  toFillStyle,
  toStrokeStyle,
  type ConvertedFillStyle,
  type ConvertedStrokeStyle,
  type FillInput,
  type StrokeInput,
} from './fill';

export type TextStyleAlign = 'left' | 'center' | 'right' | 'justify';
export type TextStyleFill = string | string[] | number | number[] | CanvasGradient | CanvasPattern;
export type TextStyleFontStyle = 'normal' | 'italic' | 'oblique';
export type TextStyleFontVariant = 'normal' | 'small-caps';
export type TextStyleFontWeight =
  | 'normal' | 'bold' | 'bolder' | 'lighter'
  | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';
export type TextStyleLineJoin = 'miter' | 'round' | 'bevel';
export type TextStyleTextBaseline = 'alphabetic' | 'top' | 'hanging' | 'middle' | 'ideographic' | 'bottom';
export type TextStyleWhiteSpace = 'normal' | 'pre' | 'pre-line';

export type TextDropShadow = {
  alpha: number;
  angle: number;
  blur: number;
  color: ColorSource;
  distance: number;
};

export interface TextStyleOptions {
  align?: TextStyleAlign;
  breakWords?: boolean;
  dropShadow?: boolean | Partial<TextDropShadow>;
  fill?: FillInput;
  fontFamily?: string | string[];
  fontSize?: number | string;
  fontStyle?: TextStyleFontStyle;
  fontVariant?: TextStyleFontVariant;
  fontWeight?: TextStyleFontWeight;
  leading?: number;
  letterSpacing?: number;
  lineHeight?: number;
  padding?: number;
  stroke?: StrokeInput;
  textBaseline?: TextStyleTextBaseline;
  trim?: boolean;
  whiteSpace?: TextStyleWhiteSpace;
  wordWrap?: boolean;
  wordWrapWidth?: number;
  filters?: Filter[] | readonly Filter[];
  tagStyles?: Record<string, TextStyleOptions>;
}

/** Pixi `TextureDestroyOptions` / `TypeOrBool` */
export type TextStyleDestroyOptions = boolean | { texture?: boolean; textureSource?: boolean };

type AnyRecord = Record<string, unknown>;

export class TextStyle extends EventEmitter<{ update: TextStyle }> {
  static defaultDropShadow: TextDropShadow = {
    alpha: 1,
    angle: Math.PI / 6,
    blur: 0,
    color: 'black',
    distance: 5,
  };

  static defaultTextStyle: TextStyleOptions = {
    align: 'left',
    breakWords: false,
    dropShadow: null as unknown as undefined,
    fill: 'black',
    fontFamily: 'Arial',
    fontSize: 26,
    fontStyle: 'normal',
    fontVariant: 'normal',
    fontWeight: 'normal',
    leading: 0,
    letterSpacing: 0,
    lineHeight: 0,
    padding: 0,
    stroke: null,
    textBaseline: 'alphabetic',
    trim: false,
    whiteSpace: 'pre',
    wordWrap: false,
    wordWrapWidth: 100,
  };

  /** @internal */
  readonly uid: number = uid('textStyle');
  /** @internal 改动计数(styleKey 用) */
  _tick = 0;

  _fill!: ConvertedFillStyle;
  private _originalFill!: FillInput;
  _stroke!: ConvertedStrokeStyle;
  private _originalStroke!: StrokeInput;
  private _dropShadow!: TextDropShadow | null;
  private _fontFamily!: string | string[];
  private _fontSize!: number;
  private _fontStyle!: TextStyleFontStyle;
  private _fontVariant!: TextStyleFontVariant;
  private _fontWeight!: TextStyleFontWeight;
  private _breakWords!: boolean;
  private _align!: TextStyleAlign;
  private _leading!: number;
  private _letterSpacing!: number;
  private _lineHeight!: number;
  private _textBaseline!: TextStyleTextBaseline;
  private _whiteSpace!: TextStyleWhiteSpace;
  private _wordWrap!: boolean;
  private _wordWrapWidth!: number;
  private _filters!: readonly Filter[];
  private _padding!: number;
  private _trim!: boolean;
  private _cachedFontString: string | null = null;
  _tagStyles: Record<string, TextStyleOptions> | undefined;
  /** @internal SplitText 用:渐变按整段文字的尺寸 / 偏移铺 */
  _gradientBounds?: { width: number; height: number };
  /** @internal */
  _gradientOffset?: { x: number; y: number };

  constructor(style: Partial<TextStyleOptions> | TextStyle = {}) {
    super();
    convertV7Tov8Style(style as AnyRecord);
    const isTextStyle = style instanceof TextStyle;
    const existingStyle = style as TextStyle;
    if (isTextStyle) style = existingStyle._toObject();
    const fullStyle = { ...TextStyle.defaultTextStyle, ...style } as AnyRecord;
    for (const key in fullStyle) {
      (this as unknown as AnyRecord)[key] = fullStyle[key];
    }
    this._tagStyles = (style as TextStyleOptions).tagStyles ?? undefined;
    this.update();
    this._tick = 0;
  }

  get align(): TextStyleAlign {
    return this._align;
  }
  set align(value: TextStyleAlign) {
    if (this._align === value) return;
    this._align = value;
    this.update();
  }

  get breakWords(): boolean {
    return this._breakWords;
  }
  set breakWords(value: boolean) {
    if (this._breakWords === value) return;
    this._breakWords = value;
    this.update();
  }

  get dropShadow(): TextDropShadow {
    return this._dropShadow as TextDropShadow;
  }
  set dropShadow(value: boolean | Partial<TextDropShadow> | null | undefined) {
    if (this._dropShadow === value) return;
    if (value !== null && typeof value === 'object') {
      this._dropShadow = this._createProxy({ ...TextStyle.defaultDropShadow, ...value });
    } else {
      this._dropShadow = value ? this._createProxy({ ...TextStyle.defaultDropShadow }) : null;
    }
    this.update();
  }

  get fontFamily(): string | string[] {
    return this._fontFamily;
  }
  set fontFamily(value: string | string[]) {
    if (this._fontFamily === value) return;
    this._fontFamily = value;
    this.update();
  }

  get fontSize(): number {
    return this._fontSize;
  }
  set fontSize(value: string | number) {
    if (this._fontSize === value) return;
    if (typeof value === 'string') {
      this._fontSize = parseInt(value, 10);
    } else {
      this._fontSize = value;
    }
    this.update();
  }

  get fontStyle(): TextStyleFontStyle {
    return this._fontStyle;
  }
  set fontStyle(value: TextStyleFontStyle) {
    if (this._fontStyle === value) return;
    this._fontStyle = value.toLowerCase() as TextStyleFontStyle;
    this.update();
  }

  get fontVariant(): TextStyleFontVariant {
    return this._fontVariant;
  }
  set fontVariant(value: TextStyleFontVariant) {
    if (this._fontVariant === value) return;
    this._fontVariant = value;
    this.update();
  }

  get fontWeight(): TextStyleFontWeight {
    return this._fontWeight;
  }
  set fontWeight(value: TextStyleFontWeight) {
    if (this._fontWeight === value) return;
    this._fontWeight = value;
    this.update();
  }

  get leading(): number {
    return this._leading;
  }
  set leading(value: number) {
    if (this._leading === value) return;
    this._leading = value;
    this.update();
  }

  get letterSpacing(): number {
    return this._letterSpacing;
  }
  set letterSpacing(value: number) {
    if (this._letterSpacing === value) return;
    this._letterSpacing = value;
    this.update();
  }

  get lineHeight(): number {
    return this._lineHeight;
  }
  set lineHeight(value: number) {
    if (this._lineHeight === value) return;
    this._lineHeight = value;
    this.update();
  }

  get padding(): number {
    return this._padding;
  }
  set padding(value: number) {
    if (this._padding === value) return;
    this._padding = value;
    this.update();
  }

  get filters(): readonly Filter[] {
    return this._filters;
  }
  set filters(value: Filter[] | readonly Filter[]) {
    if (this._filters === value) return;
    this._filters = Object.freeze(value);
    this.update();
  }

  get trim(): boolean {
    return this._trim;
  }
  set trim(value: boolean) {
    if (this._trim === value) return;
    this._trim = value;
    this.update();
  }

  get textBaseline(): TextStyleTextBaseline {
    return this._textBaseline;
  }
  set textBaseline(value: TextStyleTextBaseline) {
    if (this._textBaseline === value) return;
    this._textBaseline = value;
    this.update();
  }

  get whiteSpace(): TextStyleWhiteSpace {
    return this._whiteSpace;
  }
  set whiteSpace(value: TextStyleWhiteSpace) {
    if (this._whiteSpace === value) return;
    this._whiteSpace = value;
    this.update();
  }

  get wordWrap(): boolean {
    return this._wordWrap;
  }
  set wordWrap(value: boolean) {
    if (this._wordWrap === value) return;
    this._wordWrap = value;
    this.update();
  }

  get wordWrapWidth(): number {
    return this._wordWrapWidth;
  }
  set wordWrapWidth(value: number) {
    if (this._wordWrapWidth === value) return;
    this._wordWrapWidth = value;
    this.update();
  }

  /**
   * 填充:颜色 / FillStyle 对象 / FillGradient / FillPattern / Texture。
   * 竖直渐变(90°)按行重复,其它角度铺满整段文字(见 getCanvasFillStyle)。
   */
  get fill(): FillInput {
    return this._originalFill;
  }
  set fill(value: FillInput) {
    if (value === this._originalFill) return;
    this._originalFill = value;
    if (this._isFillStyle(value)) {
      this._originalFill = this._createProxy({ ...defaultFillStyle, ...(value as object) } as AnyRecord, () => {
        this._fill = toFillStyle({ ...(this._originalFill as object) } as FillInput, defaultFillStyle) as ConvertedFillStyle;
      }) as FillInput;
    }
    this._fill = toFillStyle(value === 0 ? 'black' : value, defaultFillStyle) as ConvertedFillStyle;
    this.update();
  }

  get stroke(): StrokeInput {
    return this._originalStroke;
  }
  set stroke(value: StrokeInput) {
    if (value === this._originalStroke) return;
    this._originalStroke = value;
    if (this._isFillStyle(value)) {
      this._originalStroke = this._createProxy({ ...defaultStrokeStyle, ...(value as object) } as AnyRecord, () => {
        this._stroke = toStrokeStyle({ ...(this._originalStroke as object) } as StrokeInput, defaultStrokeStyle) as ConvertedStrokeStyle;
      }) as StrokeInput;
    }
    this._stroke = toStrokeStyle(value, defaultStrokeStyle) as ConvertedStrokeStyle;
    this.update();
  }

  /** 标签样式:`<red>字</red>`;为空时 `<` 按字面处理 */
  get tagStyles(): Record<string, TextStyleOptions> | undefined {
    return this._tagStyles;
  }
  set tagStyles(value: Record<string, TextStyleOptions> | undefined) {
    if (this._tagStyles === value) return;
    this._tagStyles = value ?? undefined;
    this.update();
  }

  update(): void {
    this._tick++;
    this._cachedFontString = null;
    this.emit('update', this);
  }

  /** 全部属性恢复缺省值 */
  reset(): void {
    const defaultStyle = TextStyle.defaultTextStyle as AnyRecord;
    for (const key in defaultStyle) {
      (this as unknown as AnyRecord)[key] = defaultStyle[key];
    }
  }

  /** 经各属性的 setter 批量赋值 */
  assign(values: Partial<TextStyleOptions>): this {
    for (const key in values) {
      (this as unknown as AnyRecord)[key] = (values as AnyRecord)[key];
    }
    return this;
  }

  /** 缓存键 */
  get styleKey(): string {
    return `${this.uid}-${this._tick}`;
  }

  /** @internal CSS font 串(缓存到下次 update) */
  get _fontString(): string {
    if (this._cachedFontString === null) {
      this._cachedFontString = fontStringFromTextStyle(this);
    }
    return this._cachedFontString;
  }

  /** @internal */
  _toObject(): Required<TextStyleOptions> {
    return ({
      align: this.align,
      breakWords: this.breakWords,
      dropShadow: this._dropShadow ? { ...this._dropShadow } : (null as unknown as TextDropShadow),
      fill: (this._fill ? { ...this._fill } : undefined) as FillInput,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fontStyle: this.fontStyle,
      fontVariant: this.fontVariant,
      fontWeight: this.fontWeight,
      leading: this.leading,
      letterSpacing: this.letterSpacing,
      lineHeight: this.lineHeight,
      padding: this.padding,
      stroke: (this._stroke ? { ...this._stroke } : undefined) as StrokeInput,
      textBaseline: this.textBaseline,
      trim: this.trim,
      whiteSpace: this.whiteSpace,
      wordWrap: this.wordWrap,
      wordWrapWidth: this.wordWrapWidth,
      filters: (this._filters ? [...this._filters] : undefined) as Filter[],
      tagStyles: (this._tagStyles ? { ...this._tagStyles } : undefined) as Record<string, TextStyleOptions>,
    } as TextStyleOptions) as Required<TextStyleOptions>;
  }

  clone(): TextStyle {
    return new TextStyle(this._toObject());
  }

  /** @internal 最终 padding:取 padding 与滤镜 padding 之和的较大者 */
  _getFinalPadding(): number {
    let filterPadding = 0;
    if (this._filters) {
      for (let i = 0; i < this._filters.length; i++) {
        filterPadding += this._filters[i].padding;
      }
    }
    return Math.max(this._padding, filterPadding);
  }

  destroy(options: TextStyleDestroyOptions = false): void {
    this.removeAllListeners();
    const destroyTexture = typeof options === 'boolean' ? options : options?.texture;
    if (destroyTexture) {
      const destroyTextureSource = typeof options === 'boolean' ? options : options?.textureSource;
      const f = this._fill as Partial<ConvertedFillStyle> | null;
      const of = this._originalFill as { texture?: { destroy(s?: boolean): void } } | null;
      const s = this._stroke as Partial<ConvertedStrokeStyle> | null;
      const os = this._originalStroke as { texture?: { destroy(s?: boolean): void } } | null;
      if (f?.texture) f.texture.destroy(destroyTextureSource);
      if (of?.texture) of.texture.destroy(destroyTextureSource);
      if (s?.texture) s.texture.destroy(destroyTextureSource);
      if (os?.texture) os.texture.destroy(destroyTextureSource);
    }
    this._fill = null as unknown as ConvertedFillStyle;
    this._stroke = null as unknown as ConvertedStrokeStyle;
    this.dropShadow = null;
    this._originalStroke = null;
    this._originalFill = null;
  }

  private _createProxy<T extends object>(value: T, cb?: (property: string | symbol, newValue: unknown) => void): T {
    return new Proxy(value, {
      set: (target, property, newValue) => {
        if ((target as AnyRecord)[property as string] === newValue) return true;
        (target as AnyRecord)[property as string] = newValue;
        cb?.(property, newValue);
        this.update();
        return true;
      },
    });
  }

  private _isFillStyle(value: unknown): boolean {
    return (value ?? null) !== null && !(isColorLike(value) || isFillGradient(value) || isFillPattern(value));
  }
}

/** v7 写法 → v8(照 Pixi `convertV7Tov8Style`;渐变填充需要 graphics 模块的 FillGradient,这里只支持已是 v8 写法的渐变) */
function convertV7Tov8Style(style: AnyRecord): void {
  const oldStyle = style;
  if (typeof oldStyle.dropShadow === 'boolean' && oldStyle.dropShadow) {
    const defaults = TextStyle.defaultDropShadow;
    style.dropShadow = {
      alpha: oldStyle.dropShadowAlpha ?? defaults.alpha,
      angle: oldStyle.dropShadowAngle ?? defaults.angle,
      blur: oldStyle.dropShadowBlur ?? defaults.blur,
      color: oldStyle.dropShadowColor ?? defaults.color,
      distance: oldStyle.dropShadowDistance ?? defaults.distance,
    };
  }
  if (oldStyle.strokeThickness !== undefined) {
    const color = oldStyle.stroke;
    let obj: AnyRecord = {};
    if (isColorLike(color)) {
      obj.color = color;
    } else if (isFillGradient(color) || isFillPattern(color)) {
      obj.fill = color;
    } else if (Object.hasOwnProperty.call(color, 'color') || Object.hasOwnProperty.call(color, 'fill')) {
      obj = color as AnyRecord;
    } else {
      throw new Error('Invalid stroke value.');
    }
    style.stroke = { ...obj, width: oldStyle.strokeThickness };
  }
  if (Array.isArray(oldStyle.fillGradientStops)) {
    if (!Array.isArray(oldStyle.fill) || oldStyle.fill.length === 0) {
      throw new Error('Invalid fill value. Expected an array of colors for gradient fill.');
    }
    // Pixi 这里会 new FillGradient(竖直、local)再逐个 addColorStop;engine2d 的 FillGradient 在 graphics 模块。
    // 游戏不用 v7 渐变写法,保留校验、不做转换。
    throw new Error('[engine2d] TextStyle: v7 的 fillGradientStops 写法不支持,请用 v8 的 FillGradient');
  }
}
