/**
 * 文字节点基类(Text / HTMLText 共用)。移植自 PixiJS v8.17(MIT)`scene/text/AbstractText.mjs`:
 * text / style / resolution(null = 自动,取渲染器分辨率)/ anchor / width·height 的读写语义(按度量包围盒 × scale)、
 * containsPoint、styleKey = `${text}:${style.styleKey}:${resolution}`、destroy 选项。
 */
import { ObservablePoint } from '../math/ObservablePoint';
import type { PointData } from '../math/Point';
import type { ContainerOptions, DestroyOptions } from '../scene/Container';
import { ViewContainer } from '../scene/ViewContainer';
import type { TextStyle, TextStyleOptions } from './TextStyle';

export type TextString = string | number | { toString: () => string };

export interface TextOptions<
  TEXT_STYLE extends TextStyle = TextStyle,
  TEXT_STYLE_OPTIONS extends TextStyleOptions = TextStyleOptions,
> extends ContainerOptions {
  anchor?: PointData | number;
  text?: TextString;
  /** null / 不给 = 自动(跟渲染器分辨率) */
  resolution?: number | null;
  style?: TEXT_STYLE | TEXT_STYLE_OPTIONS;
  roundPixels?: boolean;
  width?: number;
  height?: number;
}

export interface Size {
  width: number;
  height: number;
}

export abstract class AbstractText<
  TEXT_STYLE extends TextStyle = TextStyle,
  TEXT_STYLE_OPTIONS extends TextStyleOptions = TextStyleOptions,
  TEXT_OPTIONS extends TextOptions<TEXT_STYLE, TEXT_STYLE_OPTIONS> = TextOptions<TEXT_STYLE, TEXT_STYLE_OPTIONS>,
> extends ViewContainer {
  batched = true;
  _anchor!: ObservablePoint;
  /** 实际使用的分辨率(自动模式下渲染时写入渲染器分辨率) */
  _resolution: number | null = null;
  _autoResolution = true;
  _style!: TEXT_STYLE;
  /** @internal 内容变了,下次渲染要检查是否重生成纹理 */
  _didTextUpdate = true;
  protected _text!: string;
  private readonly _styleClass: new (options: TEXT_STYLE_OPTIONS) => TEXT_STYLE;

  constructor(options: TEXT_OPTIONS, styleClass: new (options: TEXT_STYLE_OPTIONS) => TEXT_STYLE) {
    const { text, resolution, style, anchor, width, height, roundPixels, ...rest } = options;
    super({ ...rest });
    this._styleClass = styleClass;
    this.text = text ?? '';
    this.style = style as TEXT_STYLE;
    this.resolution = resolution ?? null;
    this.allowChildren = false;
    this._anchor = new ObservablePoint({
      _onUpdate: () => {
        this.onViewUpdate();
      },
    });
    if (anchor) this.anchor = anchor;
    this.roundPixels = roundPixels ?? false;
    if (width !== undefined) this.width = width;
    if (height !== undefined) this.height = height;
  }

  get anchor(): ObservablePoint {
    return this._anchor;
  }
  set anchor(value: PointData | number) {
    typeof value === 'number' ? this._anchor.set(value) : this._anchor.copyFrom(value);
  }

  set text(value: TextString) {
    this._setText(value);
  }
  get text(): string {
    return this._text;
  }

  /** text setter 的本体(HTMLText 先清洗再调它) */
  protected _setText(textValue: TextString): void {
    const value = textValue.toString();
    if (this._text === value) return;
    this._text = value;
    this.onViewUpdate();
  }

  set resolution(value: number | null) {
    this._autoResolution = value === null;
    this._resolution = value;
    this.onViewUpdate();
  }
  get resolution(): number {
    return this._resolution as number;
  }

  get style(): TEXT_STYLE {
    return this._style;
  }
  set style(style: TEXT_STYLE | Partial<TEXT_STYLE> | TEXT_STYLE_OPTIONS) {
    style ||= {} as TEXT_STYLE_OPTIONS;
    this._style?.off('update', this.onViewUpdate, this);
    if (style instanceof this._styleClass) {
      this._style = style as TEXT_STYLE;
    } else {
      this._style = new this._styleClass(style as TEXT_STYLE_OPTIONS);
    }
    this._style.on('update', this.onViewUpdate, this);
    this.onViewUpdate();
  }

  override get width(): number {
    return Math.abs(this.scale.x) * this.bounds.width;
  }
  override set width(value: number) {
    this._setWidth(value, this.bounds.width);
  }

  override get height(): number {
    return Math.abs(this.scale.y) * this.bounds.height;
  }
  override set height(value: number) {
    this._setHeight(value, this.bounds.height);
  }

  override getSize(out?: Size): Size {
    out ||= {} as Size;
    out.width = Math.abs(this.scale.x) * this.bounds.width;
    out.height = Math.abs(this.scale.y) * this.bounds.height;
    return out;
  }

  override setSize(value: number | { width: number; height?: number }, height?: number): void {
    if (typeof value === 'object') {
      height = value.height ?? value.width;
      value = value.width;
    } else {
      height ??= value;
    }
    value !== undefined && this._setWidth(value, this.bounds.width);
    height !== undefined && this._setHeight(height, this.bounds.height);
  }

  override containsPoint(point: PointData): boolean {
    const width = this.bounds.width;
    const height = this.bounds.height;
    const x1 = -width * this.anchor.x;
    let y1 = 0;
    if (point.x >= x1 && point.x <= x1 + width) {
      y1 = -height * this.anchor.y;
      if (point.y >= y1 && point.y <= y1 + height) return true;
    }
    return false;
  }

  override onViewUpdate(): void {
    this._didTextUpdate = true;
    super.onViewUpdate();
  }

  /** 样式 / 分辨率 / 文字合成的缓存键 */
  get styleKey(): string {
    return `${this._text}:${this._style.styleKey}:${this._resolution}`;
  }

  /** 子类释放自己的纹理(destroy 时先调) */
  protected abstract _releaseGpuData(): void;

  /** 释放 GPU 侧数据(纹理引用);再次渲染时重新生成(Pixi `ViewContainer.unload` → 文字 pipe 的 onTextUnload) */
  override unload(): void {
    this.emit('unload', this);
    this._releaseGpuData();
    this._batchRoundPixels = -1;
    this.onViewUpdate();
  }

  override destroy(options: boolean | DestroyOptions = false): void {
    if (this.destroyed) return;
    this._releaseGpuData();
    super.destroy(options);
    // Pixi 这里不解除样式的 update 监听(共享样式会一直挂着已销毁的文字);engine2d 解除,避免泄漏
    this._style?.off('update', this.onViewUpdate, this);
    if (typeof options === 'boolean' ? options : options?.style) {
      this._style.destroy(options);
    }
    this._style = null as unknown as TEXT_STYLE;
    this._text = null as unknown as string;
  }
}

/** 兼容 v7 的 `new Text('字', style)` 写法 */
export function ensureTextOptions<TEXT_OPTIONS extends TextOptions>(args: unknown[], _name: string): TEXT_OPTIONS {
  let options = (args[0] ?? {}) as TEXT_OPTIONS;
  if (typeof options === 'string' || args[1]) {
    options = { text: options, style: args[1] } as unknown as TEXT_OPTIONS;
  }
  return options;
}
