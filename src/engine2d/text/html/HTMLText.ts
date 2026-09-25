/**
 * HTML 文字(SVG foreignObject 渲染,异步出图)。移植自 PixiJS v8.17(MIT)`scene/text-html/HTMLText.mjs` +
 * `HTMLTextPipe.mjs` + `BatchableHTMLText.mjs`。
 *
 * 与 Pixi 的差别:Pixi 在纹理生成中途又改了文字时会丢掉这次改动(`generatingTexture` 时直接 return,且已清
 * `_didTextUpdate`),要等下一次改动才补上;engine2d 在生成完成后若键已变,标记重生成,最终画面总是最后一次的文字。
 */
import type { BatchableElement, RenderCollector } from '../../core/contracts';
import { Texture } from '../../textures/Texture';
import { TextureSource } from '../../textures/TextureSource';
import { TextureStyle, type TextureStyleOptions } from '../../textures/TextureStyle';
import { AbstractText, ensureTextOptions, type TextOptions, type TextString } from '../AbstractText';
import { createTextGpuData } from '../Text';
import { updateTextBounds } from '../utils/updateTextBounds';
import { HTMLTextStyle, type HTMLTextStyleOptions } from './HTMLTextStyle';
import { htmlTextSystem } from './HTMLTextSystem';
import { measureHtmlText } from './utils/measureHtmlText';

export interface HTMLTextOptions extends TextOptions<HTMLTextStyle, HTMLTextStyleOptions> {
  textureStyle?: TextureStyle | TextureStyleOptions;
  autoGenerateMipmaps?: boolean;
}

/** Pixi 的 BatchableHTMLText */
interface HTMLTextGpuData {
  batchable: BatchableElement;
  texture: Texture;
  currentKey: string;
  generatingTexture: boolean;
  texturePromise: Promise<Texture> | null;
}

export class HTMLText extends AbstractText<HTMLTextStyle, HTMLTextStyleOptions, HTMLTextOptions> {
  override renderPipeId = 'htmlText';
  textureStyle?: TextureStyle;
  autoGenerateMipmaps?: boolean;
  /** @internal */
  _gpuText: HTMLTextGpuData | null = null;

  constructor(options?: HTMLTextOptions);
  constructor(text?: TextString, options?: Partial<HTMLTextStyle> | HTMLTextStyleOptions);
  constructor(...args: [HTMLTextOptions?] | [TextString?, (Partial<HTMLTextStyle> | HTMLTextStyleOptions)?]) {
    const options = ensureTextOptions<HTMLTextOptions>(args, 'HtmlText');
    super(options, HTMLTextStyle);
    if (options.textureStyle) {
      this.textureStyle = options.textureStyle instanceof TextureStyle ? options.textureStyle : new TextureStyle(options.textureStyle);
    }
    this.autoGenerateMipmaps = options.autoGenerateMipmaps ?? (TextureSource.defaultOptions.autoGenerateMipmaps as boolean);
  }

  protected updateBounds(): void {
    const bounds = this._bounds;
    const anchor = this._anchor;
    const htmlMeasurement = measureHtmlText(this.text, this._style);
    const { width, height } = htmlMeasurement;
    bounds.minX = -anchor._x * width;
    bounds.maxX = bounds.minX + width;
    bounds.minY = -anchor._y * height;
    bounds.maxY = bounds.minY + height;
  }

  override get text(): string {
    return this._text;
  }
  override set text(text: TextString) {
    const sanitisedText = this._sanitiseText(text.toString());
    this._setText(sanitisedText);
  }

  private _sanitiseText(text: string): string {
    return this._removeInvalidHtmlTags(text.replace(/<br>/gi, '<br/>').replace(/<hr>/gi, '<hr/>').replace(/&nbsp;/gi, '&#160;'));
  }

  private _removeInvalidHtmlTags(input: string): string {
    const brokenTagPattern = /<[^>]*?(?=<|$)/g;
    return input.replace(brokenTagPattern, '');
  }

  private _getGpuText(rendererResolution: number): HTMLTextGpuData {
    if (this._gpuText) return this._gpuText;
    const base = createTextGpuData(this.groupTransform);
    this._resolution = this._autoResolution ? rendererResolution : this.resolution;
    this._gpuText = {
      batchable: base.batchable,
      texture: Texture.EMPTY,
      currentKey: '--',
      generatingTexture: false,
      texturePromise: null,
    };
    return this._gpuText;
  }

  /** 渲染核心在收集阶段调用(照 HTMLTextPipe.addRenderable) */
  override collectRenderables(collector: RenderCollector): void {
    const gpuText = this._getGpuText(collector.resolution);
    const resolution = this._autoResolution ? collector.resolution : this.resolution;
    if (this._autoResolution && this._resolution !== resolution) this._didTextUpdate = true;
    if (this._didTextUpdate) {
      if (gpuText.currentKey !== this.styleKey || this.resolution !== resolution) {
        this._updateGpuText(collector.resolution).catch((e) => {
          console.error(e);
        });
      }
      this._didTextUpdate = false;
      updateTextBounds({ texture: gpuText.texture, bounds: gpuText.batchable.bounds }, this);
    }
    // 纹理出来之前 Pixi 画的是 Texture.EMPTY(全透明);这里直接不交,画面相同
    if (gpuText.texture === Texture.EMPTY) return;
    const b = gpuText.batchable;
    b.texture = gpuText.texture;
    b.transform = this.groupTransform;
    b.color = this.groupColorAlpha;
    b.roundPixels = this._roundPixels;
    b.blendMode = this.groupBlendMode;
    collector.addBatchable(b);
  }

  /** @internal 照 HTMLTextPipe._updateGpuText */
  async _updateGpuText(rendererResolution: number): Promise<void> {
    this._didTextUpdate = false;
    const gpuText = this._getGpuText(rendererResolution);
    if (gpuText.generatingTexture) return;
    const oldTexturePromise = gpuText.texturePromise;
    gpuText.texturePromise = null;
    gpuText.generatingTexture = true;
    this._resolution = this._autoResolution ? rendererResolution : this.resolution;
    // 与 Pixi 相同:HTMLText 走不共享的 getTexturePromise,旧纹理在新纹理就绪后还回
    let texturePromise = htmlTextSystem.getTexturePromise(this);
    if (oldTexturePromise) {
      texturePromise = texturePromise.finally(() => {
        htmlTextSystem.decreaseReferenceCount(gpuText.currentKey);
        htmlTextSystem.returnTexturePromise(oldTexturePromise);
      });
    }
    gpuText.texturePromise = texturePromise;
    gpuText.currentKey = this.styleKey;
    const texture = await texturePromise;
    if (this._gpuText !== gpuText) return; // 生成期间已销毁 / 卸载
    gpuText.texture = texture;
    gpuText.generatingTexture = false;
    updateTextBounds({ texture: gpuText.texture, bounds: gpuText.batchable.bounds }, this);
    // 生成期间文字 / 样式又变了:补一次(Pixi 会丢掉这次改动)
    if (gpuText.currentKey !== this.styleKey) this._didTextUpdate = true;
  }

  /** 照 HTMLTextPipe.onTextUnload */
  protected _releaseGpuData(): void {
    const gpuData = this._gpuText;
    if (!gpuData) return;
    this._gpuText = null;
    if (htmlTextSystem.getReferenceCount(gpuData.currentKey) === null) {
      if (gpuData.texturePromise) htmlTextSystem.returnTexturePromise(gpuData.texturePromise);
    } else {
      htmlTextSystem.decreaseReferenceCount(gpuData.currentKey);
    }
  }
}
