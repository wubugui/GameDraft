/**
 * Canvas 位图文字。移植自 PixiJS v8.17(MIT)`scene/text/Text.mjs` + `canvas/CanvasTextPipe.mjs` + `canvas/BatchableText.mjs`:
 * - 包围盒 = CanvasTextMetrics 的度量宽高按锚点摆(trim 时 = 非透明像素包围盒);
 * - 渲染:文字 / 样式 / 分辨率变了先经 `canvasTextSystem` 取(或生成)共享纹理,再交一个四边形给收集器,
 *   四边形 = 纹理 orig 按锚点摆、扣掉 padding(updateTextBounds),颜色 / 变换 / 混合取本次渲染的 group 量。
 */
import type { BatchableElement, RenderCollector } from '../core/contracts';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { TextureStyle, type TextureStyleOptions } from '../textures/TextureStyle';
import { AbstractText, ensureTextOptions, type TextOptions, type TextString } from './AbstractText';
import { CanvasTextGenerator } from './canvas/CanvasTextGenerator';
import { CanvasTextMetrics } from './canvas/CanvasTextMetrics';
import { canvasTextSystem } from './CanvasTextSystem';
import { TextStyle, type TextStyleOptions } from './TextStyle';
import { updateTextBounds } from './utils/updateTextBounds';

export interface CanvasTextOptions extends TextOptions {
  textureStyle?: TextureStyle | TextureStyleOptions;
  autoGenerateMipmaps?: boolean;
}

/** Pixi 的 BatchableText(= BatchableSprite)在 engine2d 里的对应:收集器的合批元素 + 当前纹理键 */
export interface TextGpuData {
  batchable: BatchableElement;
  texture: Texture | null;
  currentKey: string;
}

export function createTextGpuData(transform: BatchableElement['transform']): TextGpuData {
  return {
    texture: null,
    currentKey: '--',
    batchable: {
      texture: Texture.EMPTY,
      transform,
      color: 0xffffffff,
      roundPixels: 0,
      blendMode: 'normal',
      topology: 'triangle-list',
      packAsQuad: true,
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 0 },
      attributeOffset: 0,
      attributeSize: 4,
      indexOffset: 0,
      indexSize: 6,
    },
  };
}

export class Text extends AbstractText<TextStyle, TextStyleOptions, CanvasTextOptions> {
  override renderPipeId = 'text';
  textureStyle?: TextureStyle;
  autoGenerateMipmaps?: boolean;
  /** @internal */
  _gpuText: TextGpuData | null = null;

  constructor(options?: CanvasTextOptions);
  constructor(text?: TextString, options?: Partial<TextStyle> | TextStyleOptions);
  constructor(...args: [CanvasTextOptions?] | [TextString?, (Partial<TextStyle> | TextStyleOptions)?]) {
    const options = ensureTextOptions<CanvasTextOptions>(args, 'Text');
    super(options, TextStyle);
    if (options.textureStyle) {
      this.textureStyle = options.textureStyle instanceof TextureStyle ? options.textureStyle : new TextureStyle(options.textureStyle);
    }
    this.autoGenerateMipmaps = options.autoGenerateMipmaps ?? (TextureSource.defaultOptions.autoGenerateMipmaps as boolean);
  }

  protected updateBounds(): void {
    const bounds = this._bounds;
    const anchor = this._anchor;
    let width = 0;
    let height = 0;
    if (this._style.trim) {
      const { frame, canvasAndContext } = CanvasTextGenerator.getCanvasAndContext({
        text: this.text,
        style: this._style,
        resolution: 1,
      });
      CanvasTextGenerator.returnCanvasAndContext(canvasAndContext);
      width = frame.width;
      height = frame.height;
    } else {
      const canvasMeasurement = CanvasTextMetrics.measureText(this._text, this._style);
      width = canvasMeasurement.width;
      height = canvasMeasurement.height;
    }
    bounds.minX = -anchor._x * width;
    bounds.maxX = bounds.minX + width;
    bounds.minY = -anchor._y * height;
    bounds.maxY = bounds.minY + height;
  }

  /**
   * 渲染核心在收集阶段调用(照 CanvasTextPipe.addRenderable)。`collector.resolution` = 渲染器分辨率;
   * 自动分辨率的文字在它变化时重生成(对应 Pixi 的 resolutionChange)。
   */
  override collectRenderables(collector: RenderCollector): void {
    const gpuText = (this._gpuText ??= createTextGpuData(this.groupTransform));
    const resolution = this._autoResolution ? collector.resolution : this.resolution;
    if (this._autoResolution && this._resolution !== resolution) this._didTextUpdate = true;
    if (this._didTextUpdate) {
      if (gpuText.currentKey !== this.styleKey || this._resolution !== resolution) {
        this._updateGpuText(collector.resolution);
      }
      this._didTextUpdate = false;
      updateTextBounds(gpuText.batchable, this);
    }
    const b = gpuText.batchable;
    b.transform = this.groupTransform;
    b.color = this.groupColorAlpha;
    b.roundPixels = this._latchRoundPixels(collector);
    b.blendMode = this.groupBlendMode;
    collector.addBatchable(b);
  }

  /** @internal 照 CanvasTextPipe._updateGpuText */
  _updateGpuText(rendererResolution: number): void {
    const gpuText = (this._gpuText ??= createTextGpuData(this.groupTransform));
    if (gpuText.texture) {
      canvasTextSystem.decreaseReferenceCount(gpuText.currentKey);
    }
    this._resolution = this._autoResolution ? rendererResolution : this.resolution;
    gpuText.texture = canvasTextSystem.getManagedTexture(this, rendererResolution);
    gpuText.batchable.texture = gpuText.texture;
    gpuText.currentKey = this.styleKey;
  }

  /** 照 CanvasTextPipe.onTextUnload:还掉纹理引用 */
  protected _releaseGpuData(): void {
    const gpuData = this._gpuText;
    if (!gpuData) return;
    const refCount = canvasTextSystem.getReferenceCount(gpuData.currentKey);
    if (refCount > 0) {
      canvasTextSystem.decreaseReferenceCount(gpuData.currentKey);
    } else if (gpuData.texture) {
      canvasTextSystem.returnTexture(gpuData.texture);
    }
    this._gpuText = null;
  }
}
