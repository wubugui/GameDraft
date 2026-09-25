/**
 * HTMLText 的位图生成(异步)与共享。移植自 PixiJS v8.17(MIT)`scene/text-html/HTMLTextSystem.mjs`:
 * 收集字体 → 测尺寸 → 拼 SVG foreignObject → 载入成 Image → (WebGPU 路径)画到池化画布 → 纹理;
 * 按 `text.styleKey` 共享 Promise 并引用计数。
 *
 * engine2d 固定走 Pixi 的 WebGPU 分支(`_createCanvas = true`);画布跟着纹理留到还回(上传在渲染时做)。
 */
import type { Texture } from '../../textures/Texture';
import { TextureStyle, type TextureStyleOptions } from '../../textures/TextureStyle';
import { getContext2D, TextDOM } from '../adapter';
import { CanvasPool } from '../canvas/CanvasPool';
import { getTextureCanvas, getTextureFromCanvas } from '../utils/getTextureFromCanvas';
import { HTMLTextRenderData } from './HTMLTextRenderData';
import type { HTMLTextStyle } from './HTMLTextStyle';
import { extractFontFamilies } from './utils/extractFontFamilies';
import { getFontCss } from './utils/getFontCss';
import { getSVGUrl } from './utils/getSVGUrl';
import { getTemporaryCanvasFromImage } from './utils/getTemporaryCanvasFromImage';
import { loadSVGImage } from './utils/loadSVGImage';
import { measureHtmlText } from './utils/measureHtmlText';

export interface HTMLTextTextureOptions {
  text: string;
  style: HTMLTextStyle;
  resolution: number;
  textureStyle?: TextureStyle | TextureStyleOptions;
  autoGenerateMipmaps?: boolean;
}

/** getManagedTexture 需要的 HTMLText 字段 */
export interface ManagedHTMLTextLike extends HTMLTextTextureOptions {
  readonly styleKey: string;
}

function isSafari(): boolean {
  const { userAgent } = TextDOM.get().getNavigator();
  return /^((?!chrome|android).)*safari/i.test(userAgent);
}

/** Pixi `BigPool.get(HTMLTextRenderData)` 的等价物 */
const renderDataPool: HTMLTextRenderData[] = [];

export class HTMLTextSystem {
  private _activeTextures: Record<string, { texture: Texture | null; promise: Promise<Texture>; usageCount: number } | null> = {};

  getTexture(options: HTMLTextTextureOptions): Promise<Texture> {
    return this.getTexturePromise(options);
  }

  getManagedTexture(text: ManagedHTMLTextLike): Promise<Texture> {
    const textKey = text.styleKey;
    if (this._activeTextures[textKey]) {
      this._increaseReferenceCount(textKey);
      return this._activeTextures[textKey]!.promise;
    }
    const promise = this._buildTexturePromise(text).then((texture) => {
      this._activeTextures[textKey]!.texture = texture;
      return texture;
    });
    this._activeTextures[textKey] = { texture: null, promise, usageCount: 1 };
    return promise;
  }

  getReferenceCount(textKey: string): number | null {
    return this._activeTextures[textKey]?.usageCount ?? null;
  }

  private _increaseReferenceCount(textKey: string): void {
    this._activeTextures[textKey]!.usageCount++;
  }

  decreaseReferenceCount(textKey: string): void {
    const activeTexture = this._activeTextures[textKey];
    if (!activeTexture) return;
    activeTexture.usageCount--;
    if (activeTexture.usageCount === 0) {
      if (activeTexture.texture) {
        this._cleanUp(activeTexture.texture);
      } else {
        activeTexture.promise
          .then((texture) => {
            activeTexture.texture = texture;
            this._cleanUp(activeTexture.texture);
          })
          .catch(() => {
            console.warn('HTMLTextSystem: Failed to clean texture');
          });
      }
      this._activeTextures[textKey] = null;
    }
  }

  getTexturePromise(options: HTMLTextTextureOptions): Promise<Texture> {
    return this._buildTexturePromise(options);
  }

  private async _buildTexturePromise(options: HTMLTextTextureOptions): Promise<Texture> {
    const { text, style, resolution, textureStyle, autoGenerateMipmaps } = options;
    const htmlTextData = renderDataPool.pop() ?? new HTMLTextRenderData();
    const fontFamilies = extractFontFamilies(text, style);
    const fontCSS = await getFontCss(fontFamilies);
    const measured = measureHtmlText(text, style, fontCSS, htmlTextData);
    const width = Math.ceil(Math.ceil(Math.max(1, measured.width) + style.padding * 2) * resolution);
    const height = Math.ceil(Math.ceil(Math.max(1, measured.height) + style.padding * 2) * resolution);
    const image = htmlTextData.image;
    const uvSafeOffset = 2;
    image.width = (width | 0) + uvSafeOffset;
    image.height = (height | 0) + uvSafeOffset;
    const svgURL = getSVGUrl(text, style, resolution, fontCSS, htmlTextData);
    await loadSVGImage(image, svgURL, isSafari() && fontFamilies.length > 0);
    const canvasAndContext = getTemporaryCanvasFromImage(image, resolution);
    const texture = getTextureFromCanvas(
      canvasAndContext.canvas,
      image.width - uvSafeOffset,
      image.height - uvSafeOffset,
      resolution,
      autoGenerateMipmaps,
    );
    if (textureStyle) {
      texture.source.style = textureStyle instanceof TextureStyle ? textureStyle : new TextureStyle(textureStyle);
    }
    renderDataPool.push(htmlTextData);
    return texture;
  }

  returnTexturePromise(texturePromise: Promise<Texture>): void {
    texturePromise
      .then((texture) => {
        this._cleanUp(texture);
      })
      .catch(() => {
        console.warn('HTMLTextSystem: Failed to clean texture');
      });
  }

  /** 纹理不用了:画布还池(纹理留在画布上待复用) */
  private _cleanUp(texture: Texture): void {
    const canvas = getTextureCanvas(texture);
    if (canvas) CanvasPool.returnCanvasAndContext({ canvas, context: getContext2D(canvas) });
  }

  destroy(): void {
    for (const key in this._activeTextures) {
      if (this._activeTextures[key]) this.returnTexturePromise(this._activeTextures[key]!.promise);
    }
    this._activeTextures = {};
  }
}

/** 全局 HTML 文字系统(Pixi 的 `renderer.htmlText`) */
export const htmlTextSystem = new HTMLTextSystem();
