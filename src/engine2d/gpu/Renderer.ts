/**
 * engine2d 的渲染器(对外 API 对齐 Pixi v8 的 `Renderer` 子集)。唯一后端:RHI(WebGPU)。
 *
 * 每次 `render()` = 一次完整的「算本次世界量 → 收集 → 规划 → 上传 → 录制 → 提交」;画到画布时在
 * RHI 的 `runFrame` 里录(拿交换链),画到纹理时用 `submit`。嵌套调用(onRender 回调里再 render)各自独立提交。
 */
import type { RhiDevice } from '../../rendering/rhi';
import { Rectangle } from '../math/Rectangle';
import type { Matrix } from '../math/Matrix';
import { Color, type ColorSource } from '../color/Color';
import type { Container } from '../scene/Container';
import type { Texture } from '../textures/Texture';
import type { RenderTexture } from '../textures/RenderTexture';
import type { RenderSurface } from './renderTargets';

export interface RendererOptions {
  /** 已建好的 RHI 设备(画布就是设备建时给的那张) */
  rhi: RhiDevice;
  canvas: HTMLCanvasElement;
  width?: number;
  height?: number;
  resolution?: number;
  autoDensity?: boolean;
  antialias?: boolean;
  background?: ColorSource;
  backgroundColor?: ColorSource;
  backgroundAlpha?: number;
  clearBeforeRender?: boolean;
  roundPixels?: boolean;
}

export interface RenderOptions {
  container: Container;
  target?: RenderSurface;
  clear?: boolean;
  clearColor?: ColorSource | number[];
  transform?: Matrix;
}

export interface GenerateTextureOptions {
  target: Container;
  frame?: Rectangle;
  resolution?: number;
  clearColor?: ColorSource;
  antialias?: boolean;
  textureSourceOptions?: Record<string, unknown>;
}

export interface ExtractOptions {
  target: Container | Texture;
  frame?: Rectangle;
  resolution?: number;
  clearColor?: ColorSource;
  antialias?: boolean;
  format?: 'png' | 'jpg' | 'webp';
  quality?: number;
}

export interface ExtractSystem {
  pixels(target: Container | Texture | ExtractOptions): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }>;
  canvas(target: Container | Texture | ExtractOptions): Promise<HTMLCanvasElement>;
  base64(target: Container | Texture | ExtractOptions): Promise<string>;
  image(target: Container | Texture | ExtractOptions): Promise<HTMLImageElement>;
  texture(target: Container | GenerateTextureOptions): RenderTexture;
}

export interface BackgroundSystem {
  color: Color;
  alpha: number;
  clearBeforeRender: boolean;
  readonly colorRgba: [number, number, number, number];
}

/** 事件系统(events 模块的 EventSystem;这里只要类型) */
export type RendererEventSystem = import('../events/EventSystem').EventSystem;

export abstract class RendererBase {
  readonly type = 2;
  readonly name = 'webgpu';
  readonly rhi: RhiDevice;
  readonly canvas: HTMLCanvasElement;
  /** 逻辑尺寸(CSS 像素) */
  readonly screen = new Rectangle();
  resolution: number;
  autoDensity: boolean;
  roundPixels: boolean;
  readonly background: BackgroundSystem;
  lastObjectRendered: Container | null = null;
  events: RendererEventSystem | null = null;
  abstract readonly extract: ExtractSystem;

  constructor(options: RendererOptions) {
    this.rhi = options.rhi;
    this.canvas = options.canvas;
    this.resolution = options.resolution ?? 1;
    this.autoDensity = !!options.autoDensity;
    this.roundPixels = !!options.roundPixels;
    const color = new Color(options.background ?? options.backgroundColor ?? 0x000000);
    const bg = {
      color,
      alpha: options.backgroundAlpha ?? 1,
      clearBeforeRender: options.clearBeforeRender ?? true,
      get colorRgba(): [number, number, number, number] {
        return [color.red, color.green, color.blue, bg.alpha];
      },
    };
    this.background = bg;
    this.resize(options.width ?? this.canvas.width / this.resolution, options.height ?? this.canvas.height / this.resolution, this.resolution);
  }

  /** 画布像素宽 */
  get width(): number {
    return this.canvas.width;
  }

  /** 画布像素高 */
  get height(): number {
    return this.canvas.height;
  }

  get view(): { canvas: HTMLCanvasElement; resolution: number; screen: Rectangle } {
    return { canvas: this.canvas, resolution: this.resolution, screen: this.screen };
  }

  resize(width: number, height: number, resolution = this.resolution): void {
    if (resolution !== this.resolution) this.events?.resolutionChange(resolution);
    this.resolution = resolution;
    this.screen.width = width;
    this.screen.height = height;
    const pw = Math.round(width * resolution);
    const ph = Math.round(height * resolution);
    if (this.canvas.width !== pw) this.canvas.width = pw;
    if (this.canvas.height !== ph) this.canvas.height = ph;
    this.rhi.resizeSwapchain(pw, ph);
    if (this.autoDensity && 'style' in this.canvas) {
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
  }

  abstract render(options: Container | RenderOptions): void;
  abstract generateTexture(options: Container | GenerateTextureOptions): RenderTexture;
  abstract destroy(options?: boolean | { removeView?: boolean }): void;
}
