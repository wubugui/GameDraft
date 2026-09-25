/**
 * HTMLText 的样式:TextStyle + cssOverrides + 以 CSS 表达的 tagStyles。
 * 移植自 PixiJS v8.17(MIT)`scene/text-html/HTMLTextStyle.mjs`。
 */
import { TextStyle, type TextStyleOptions } from '../TextStyle';
import type { FillInput, StrokeInput } from '../fill';
import { textStyleToCSS } from './utils/textStyleToCSS';

export interface HTMLTextStyleOptions extends Omit<TextStyleOptions, 'leading' | 'textBaseline' | 'trim' | 'filters' | 'tagStyles'> {
  cssOverrides?: string[];
  tagStyles?: Record<string, HTMLTextStyleOptions>;
}

export class HTMLTextStyle extends TextStyle {
  private _cssOverrides: string[] = [];
  private _cssStyle: string | null = null;

  constructor(options: HTMLTextStyleOptions = {}) {
    super(options as TextStyleOptions);
    this._cssOverrides = [];
    this.cssOverrides = options.cssOverrides ?? [];
    this.tagStyles = (options.tagStyles ?? {}) as Record<string, TextStyleOptions>;
  }

  override get tagStyles(): Record<string, TextStyleOptions> | undefined {
    return this._tagStyles;
  }
  override set tagStyles(value: Record<string, TextStyleOptions> | undefined) {
    if (this._tagStyles === value) return;
    this._tagStyles = value ?? {};
    this.update();
  }

  set cssOverrides(value: string | string[]) {
    this._cssOverrides = value instanceof Array ? value : [value];
    this.update();
  }
  get cssOverrides(): string[] {
    return this._cssOverrides;
  }

  override update(): void {
    this._cssStyle = null;
    super.update();
  }

  override clone(): HTMLTextStyle {
    return new HTMLTextStyle({
      align: this.align,
      breakWords: this.breakWords,
      dropShadow: this.dropShadow ? { ...this.dropShadow } : (null as unknown as undefined),
      fill: this._fill as FillInput,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fontStyle: this.fontStyle,
      fontVariant: this.fontVariant,
      fontWeight: this.fontWeight,
      letterSpacing: this.letterSpacing,
      lineHeight: this.lineHeight,
      padding: this.padding,
      stroke: this._stroke as StrokeInput,
      whiteSpace: this.whiteSpace,
      wordWrap: this.wordWrap,
      wordWrapWidth: this.wordWrapWidth,
      cssOverrides: this.cssOverrides,
      tagStyles: { ...this.tagStyles } as Record<string, HTMLTextStyleOptions>,
    });
  }

  /** 整份样式的 CSS(缓存到下次 update) */
  get cssStyle(): string {
    if (!this._cssStyle) {
      this._cssStyle = textStyleToCSS(this);
    }
    return this._cssStyle;
  }

  addOverride(...value: string[]): void {
    const toAdd = value.filter((v) => !this.cssOverrides.includes(v));
    if (toAdd.length > 0) {
      this.cssOverrides.push(...toAdd);
      this.update();
    }
  }

  removeOverride(...value: string[]): void {
    const toRemove = value.filter((v) => this.cssOverrides.includes(v));
    if (toRemove.length > 0) {
      this.cssOverrides = this.cssOverrides.filter((v) => !toRemove.includes(v));
      this.update();
    }
  }

  /**
   * Pixi 的 HTMLTextStyle 只覆盖了 setter,继承下来的 getter 因此读出 undefined;engine2d 保留父类的读法。
   */
  override get fill(): FillInput {
    return super.fill;
  }
  override set fill(value: FillInput) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      console.warn('[HTMLTextStyle] only color fill is not supported by HTMLText');
    }
    super.fill = value;
  }

  override get stroke(): StrokeInput {
    return super.stroke;
  }
  override set stroke(value: StrokeInput) {
    if (value && typeof value !== 'string' && typeof value !== 'number') {
      console.warn('[HTMLTextStyle] only color stroke is not supported by HTMLText');
    }
    super.stroke = value;
  }
}
