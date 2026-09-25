/**
 * 文字纹理的生成与共享。移植自 PixiJS v8.17(MIT)`scene/text/shared/AbstractTextSystem.mjs`
 * (WebGL / WebGPU 用的 `CanvasTextSystem` 就是它):
 * - `getManagedTexture(text)`:按 `text.styleKey`(文字 + 样式 uid/tick + 分辨率)共享纹理,引用计数;
 * - `decreaseReferenceCount(key)`:计数归零把纹理还回池;
 * - `getTexture(options)`:直接生成一张(调用方负责 `returnTexture`)。
 *
 * engine2d 只有一个渲染器,这里是模块级单例 `canvasTextSystem`(Pixi 挂在 `renderer.canvasText`)。
 * 画布留在纹理上直到还回(见 getTextureFromCanvas 的说明),即 Pixi 的 `retainCanvasContext = true` 行为。
 */
import type { Filter } from '../filters/Filter';
import type { Texture } from '../textures/Texture';
import { TextureStyle, type TextureStyleOptions } from '../textures/TextureStyle';
import { getContext2D } from './adapter';
import { CanvasTextGenerator } from './canvas/CanvasTextGenerator';
import { TextStyle, type TextStyleOptions } from './TextStyle';
import { defaultTextTextureStyle, getTextureCanvas, getTextureFromCanvas } from './utils/getTextureFromCanvas';

export interface CanvasTextTextureOptions {
  text: string | number | { toString(): string };
  style?: TextStyle | TextStyleOptions;
  resolution?: number;
  textureStyle?: TextureStyle | TextureStyleOptions;
  autoGenerateMipmaps?: boolean;
}

/** 生成纹理需要的 Text 字段(Text 类实现它) */
export interface ManagedTextLike {
  readonly text: string;
  readonly style: TextStyle;
  readonly styleKey: string;
  readonly resolution: number;
  _resolution: number | null;
  _autoResolution: boolean;
  textureStyle?: TextureStyle;
  autoGenerateMipmaps?: boolean;
}

/**
 * style.filters 的执行钩子(Pixi 走 `renderer.filter.generateFilteredTexture`)。渲染核心接好之前,
 * 带 filters 的文字按无滤镜画并告警一次。
 */
export interface TextFilterHook {
  apply(texture: Texture, filters: readonly Filter[]): Texture;
  release(texture: Texture): void;
}

let warnedFilters = false;

export class CanvasTextSystem {
  /** 调用方没给分辨率时用(Pixi = renderer.resolution);渲染核心可在分辨率变化时同步 */
  resolution = 1;
  filterHook: TextFilterHook | null = null;
  private _activeTextures: Record<string, { texture: Texture; usageCount: number } | null> = {};
  private readonly _filteredTextures = new WeakSet<Texture>();

  getTexture(options: CanvasTextTextureOptions | string, _resolution?: number, _style?: TextStyle, _textKey?: string): Texture {
    if (typeof options === 'string') {
      options = { text: options, style: _style, resolution: _resolution };
    }
    if (!(options.style instanceof TextStyle)) {
      options.style = new TextStyle(options.style);
    }
    if (!(options.textureStyle instanceof TextureStyle)) {
      // Pixi 这里每次 new TextureStyle(options.textureStyle);没给选项时参数与缺省共享实例相同
      options.textureStyle = options.textureStyle ? new TextureStyle(options.textureStyle) : defaultTextTextureStyle;
    }
    if (typeof options.text !== 'string') {
      options.text = options.text.toString();
    }
    const { text, textureStyle, autoGenerateMipmaps } = options;
    const style = options.style as TextStyle;
    const resolution = options.resolution ?? this.resolution;
    const { frame, canvasAndContext } = CanvasTextGenerator.getCanvasAndContext({ text: text as string, style, resolution });
    const texture = getTextureFromCanvas(canvasAndContext.canvas, frame.width, frame.height, resolution, autoGenerateMipmaps);
    if (textureStyle) texture.source.style = textureStyle as TextureStyle;
    if (style.trim) {
      frame.pad(style.padding);
      texture.frame.copyFrom(frame);
      texture.frame.scale(1 / resolution);
      texture.updateUvs();
    }
    if (style.filters && style.filters.length > 0) {
      if (this.filterHook) {
        const filteredTexture = this.filterHook.apply(texture, style.filters);
        this.returnTexture(texture);
        this._filteredTextures.add(filteredTexture);
        return filteredTexture;
      }
      if (!warnedFilters) {
        warnedFilters = true;
        console.warn('[engine2d] TextStyle.filters:渲染核心尚未接入文字滤镜,按无滤镜绘制');
      }
    }
    return texture;
  }

  /** 还回 getTexture 得到的纹理(画布回画布池,纹理留在画布上待复用) */
  returnTexture(texture: Texture): void {
    if (this._filteredTextures.has(texture)) {
      this._filteredTextures.delete(texture);
      this.filterHook?.release(texture);
      return;
    }
    const canvas = getTextureCanvas(texture);
    if (canvas) {
      const context = getContext2D(canvas);
      if (context) CanvasTextGenerator.returnCanvasAndContext({ canvas, context });
    }
  }

  /** 按 text.styleKey 取共享纹理(没有就生成),引用计数 +1 */
  getManagedTexture(text: ManagedTextLike, rendererResolution: number = this.resolution): Texture {
    text._resolution = text._autoResolution ? rendererResolution : text.resolution;
    const textKey = text.styleKey;
    if (this._activeTextures[textKey]) {
      this._increaseReferenceCount(textKey);
      return this._activeTextures[textKey]!.texture;
    }
    const texture = this.getTexture({
      text: text.text,
      style: text.style,
      resolution: text._resolution,
      textureStyle: text.textureStyle,
      autoGenerateMipmaps: text.autoGenerateMipmaps,
    });
    this._activeTextures[textKey] = { texture, usageCount: 1 };
    return texture;
  }

  /** 引用计数 -1;归零则还回纹理 */
  decreaseReferenceCount(textKey: string): void {
    const activeTexture = this._activeTextures[textKey];
    if (!activeTexture) return;
    activeTexture.usageCount--;
    if (activeTexture.usageCount === 0) {
      this.returnTexture(activeTexture.texture);
      this._activeTextures[textKey] = null;
    }
  }

  getReferenceCount(textKey: string): number {
    return this._activeTextures[textKey]?.usageCount ?? 0;
  }

  private _increaseReferenceCount(textKey: string): void {
    this._activeTextures[textKey]!.usageCount++;
  }

  destroy(): void {
    for (const key in this._activeTextures) {
      if (this._activeTextures[key]) this.returnTexture(this._activeTextures[key]!.texture);
    }
    this._activeTextures = {};
  }
}

/** 全局文字纹理系统(Pixi 的 `renderer.canvasText`) */
export const canvasTextSystem = new CanvasTextSystem();
