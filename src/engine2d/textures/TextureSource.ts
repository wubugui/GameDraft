import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import { TextureStyle, type TextureStyleOptions, type SCALE_MODE, type WRAP_MODE, type COMPARE_FUNCTION } from './TextureStyle';

/** GPU 纹理格式(WebGPU 名)。运行时实际用到的子集之外的格式按字符串透传给 RHI,RHI 不认就在建纹理时报错。 */
export type TEXTURE_FORMATS =
  | 'r8unorm' | 'rg8unorm' | 'rgba8unorm' | 'rgba8unorm-srgb' | 'bgra8unorm'
  | 'r16float' | 'rg16float' | 'rgba16float'
  | 'r32float' | 'rg32float' | 'rgba32float'
  | 'r32uint' | 'rgba32uint' | 'rgba16uint'
  | 'depth24plus-stencil8' | 'depth32float';

/**
 * alpha 语义(照 Pixi):
 * - `premultiply-alpha-on-upload`:资源是直通 alpha,上传时预乘(图片的缺省);
 * - `premultiplied-alpha`:资源已经是预乘的,原样上传;
 * - `no-premultiply-alpha`:原样上传,alpha 当数据用,着色器自己处理。
 * 缓冲源(BufferImageSource)一律原样上传,不管这个值。
 */
export type ALPHA_MODES = 'no-premultiply-alpha' | 'premultiply-alpha-on-upload' | 'premultiplied-alpha';

export type TypedArray = Float32Array | Float64Array | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;

export type TextureResourceLike = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | VideoFrame | ImageData | TypedArray;

export interface TextureSourceOptions<T = unknown> extends TextureStyleOptions {
  resource?: T;
  width?: number;
  height?: number;
  resolution?: number;
  format?: TEXTURE_FORMATS;
  label?: string;
  alphaMode?: ALPHA_MODES;
  antialias?: boolean;
  autoGenerateMipmaps?: boolean;
  mipLevelCount?: number;
  autoGarbageCollect?: boolean;
  /** 其余 Pixi 选项(dimensions / sampleCount 等)接受但不使用 */
  [key: string]: unknown;
}

export type TextureSourceUploadMethod = 'unknown' | 'image' | 'buffer' | 'none';

/**
 * 一块 GPU 纹理的 CPU 侧描述(照 Pixi `TextureSource`)。GPU 对象由渲染器的纹理管理按需建 / 传,
 * 这里只记内容版本:`update()` 表示内容变了要重传,`resize()` 表示尺寸变了要重建。
 */
export class TextureSource<T = unknown> extends EventEmitter {
  static defaultOptions: Partial<TextureSourceOptions> = {
    resolution: 1,
    format: 'bgra8unorm',
    alphaMode: 'premultiply-alpha-on-upload',
    mipLevelCount: 1,
    autoGenerateMipmaps: false,
    antialias: false,
    autoGarbageCollect: false,
  };

  readonly uid = uid('textureSource');
  readonly _resourceType = 'textureSource';
  label: string;
  resource: T;
  uploadMethodId: TextureSourceUploadMethod = 'unknown';
  pixelWidth = 1;
  pixelHeight = 1;
  width = 1;
  height = 1;
  format: TEXTURE_FORMATS;
  alphaMode: ALPHA_MODES;
  antialias: boolean;
  mipLevelCount: number;
  autoGenerateMipmaps: boolean;
  autoGarbageCollect: boolean;
  isPowerOfTwo = false;
  destroyed = false;
  /** 内容版本:每次 `update()` / 尺寸变化 +1;GPU 侧据此判断是否要重传 */
  _updateId = 0;
  /** 尺寸 / 格式版本:变了 GPU 纹理要重建 */
  _resourceId = uid('resource');
  _resolution = 1;
  private _style: TextureStyle | null = null;

  constructor(options: TextureSourceOptions<T> = {}) {
    super();
    const o = { ...TextureSource.defaultOptions, ...options } as TextureSourceOptions<T>;
    this.label = o.label ?? '';
    this.resource = o.resource as T;
    this.autoGarbageCollect = !!o.autoGarbageCollect;
    this._resolution = o.resolution ?? 1;
    this.pixelWidth = o.width ? o.width * this._resolution : this.resource ? this.resourceWidth || 1 : 1;
    this.pixelHeight = o.height ? o.height * this._resolution : this.resource ? this.resourceHeight || 1 : 1;
    this.width = this.pixelWidth / this._resolution;
    this.height = this.pixelHeight / this._resolution;
    this.format = o.format!;
    this.mipLevelCount = o.mipLevelCount ?? 1;
    this.autoGenerateMipmaps = !!o.autoGenerateMipmaps;
    this.antialias = !!o.antialias;
    this.alphaMode = o.alphaMode!;
    this.style = new TextureStyle(definedStyle(o));
    this._refreshPOT();
  }

  get source(): this {
    return this;
  }

  get style(): TextureStyle {
    return this._style!;
  }
  set style(value: TextureStyle) {
    if (this._style === value) return;
    this._style?.off('change', this._onStyleChange, this);
    this._style = value;
    this._style?.on('change', this._onStyleChange, this);
    this._onStyleChange();
  }

  get addressMode(): WRAP_MODE { return this.style.addressMode; }
  set addressMode(v: WRAP_MODE) { this.style.addressMode = v; }
  get repeatMode(): WRAP_MODE { return this.style.addressMode; }
  set repeatMode(v: WRAP_MODE) { this.style.addressMode = v; }
  get wrapMode(): WRAP_MODE { return this.style.addressMode; }
  set wrapMode(v: WRAP_MODE) { this.style.addressMode = v; }
  get magFilter(): SCALE_MODE { return this.style.magFilter; }
  set magFilter(v: SCALE_MODE) { this.style.magFilter = v; }
  get minFilter(): SCALE_MODE { return this.style.minFilter; }
  set minFilter(v: SCALE_MODE) { this.style.minFilter = v; }
  get mipmapFilter(): SCALE_MODE { return this.style.mipmapFilter; }
  set mipmapFilter(v: SCALE_MODE) { this.style.mipmapFilter = v; }
  get scaleMode(): SCALE_MODE { return this.style.scaleMode; }
  set scaleMode(v: SCALE_MODE) { this.style.scaleMode = v; }
  get maxAnisotropy(): number { return this.style.maxAnisotropy; }
  set maxAnisotropy(v: number) { this.style.maxAnisotropy = v; }
  get lodMinClamp(): number | undefined { return this.style.lodMinClamp; }
  set lodMinClamp(v: number | undefined) { this.style.lodMinClamp = v; }
  get lodMaxClamp(): number | undefined { return this.style.lodMaxClamp; }
  set lodMaxClamp(v: number | undefined) { this.style.lodMaxClamp = v; }
  get compare(): COMPARE_FUNCTION | undefined { return this.style.compare; }

  protected _onStyleChange(): void {
    this.emit('styleChange', this);
  }

  /** 资源内容变了(画布重画、像素数组改了):下次使用时重传;资源尺寸变了则先按新尺寸重建 */
  update(): void {
    if (this.resource && this.uploadMethodId !== 'buffer') {
      const r = this._resolution;
      if (this.resize(this.resourceWidth / r, this.resourceHeight / r)) return;
    }
    this._updateId++;
    this.emit('update', this);
  }

  destroy(): void {
    this.destroyed = true;
    this.unload();
    this.emit('destroy', this);
    if (this._style) {
      this._style.destroy();
      this._style = null;
    }
    this.resource = null as T;
    this.removeAllListeners();
  }

  /** 释放 GPU 侧对象(CPU 侧资源保留,下次使用重新上传) */
  unload(): void {
    this._resourceId = uid('resource');
    this.emit('change', this);
    this.emit('unload', this);
  }

  get resourceWidth(): number {
    const r = this.resource as unknown as Record<string, number>;
    return r.naturalWidth || r.videoWidth || r.displayWidth || r.width;
  }

  get resourceHeight(): number {
    const r = this.resource as unknown as Record<string, number>;
    return r.naturalHeight || r.videoHeight || r.displayHeight || r.height;
  }

  get resolution(): number {
    return this._resolution;
  }
  set resolution(resolution: number) {
    if (this._resolution === resolution) return;
    this._resolution = resolution;
    this.width = this.pixelWidth / resolution;
    this.height = this.pixelHeight / resolution;
  }

  resize(width?: number, height?: number, resolution?: number): boolean {
    resolution ||= this._resolution;
    width ||= this.width;
    height ||= this.height;
    const pw = Math.round(width * resolution);
    const ph = Math.round(height * resolution);
    this.width = pw / resolution;
    this.height = ph / resolution;
    this._resolution = resolution;
    if (this.pixelWidth === pw && this.pixelHeight === ph) return false;
    this.pixelWidth = pw;
    this.pixelHeight = ph;
    this._refreshPOT();
    this._updateId++;
    this._resourceId = uid('resource');
    this.emit('resize', this);
    this.emit('change', this);
    return true;
  }

  updateMipmaps(): void {
    if (this.autoGenerateMipmaps && this.mipLevelCount > 1) this.emit('updateMipmaps', this);
  }

  private _refreshPOT(): void {
    const p = (v: number): boolean => v > 0 && (v & (v - 1)) === 0;
    this.isPowerOfTwo = p(this.pixelWidth) && p(this.pixelHeight);
  }

  static test(_resource: unknown): boolean {
    throw new Error('Unimplemented');
  }

  /** 按资源类型选合适的源(Pixi `autoDetectSource` 的等价物) */
  static from(resource: TextureResourceLike | TextureSource, options: Partial<TextureSourceOptions> = {}): TextureSource {
    if (resource instanceof TextureSource) return resource;
    if (CanvasSource.test(resource)) return new CanvasSource({ ...options, resource: resource as HTMLCanvasElement });
    if (BufferImageSource.test(resource)) return new BufferImageSource({ ...options, resource: resource as TypedArray });
    return new ImageSource({ ...options, resource: resource as ImageBitmap });
  }
}

function definedStyle(o: TextureSourceOptions<unknown>): TextureStyleOptions {
  const out: Record<string, unknown> = {};
  for (const k of ['addressMode', 'addressModeU', 'addressModeV', 'addressModeW', 'magFilter', 'minFilter', 'mipmapFilter', 'scaleMode', 'lodMinClamp', 'lodMaxClamp', 'compare', 'maxAnisotropy'] as const) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out as TextureStyleOptions;
}

/** 图片 / ImageBitmap / VideoFrame 源 */
export class ImageSource extends TextureSource<ImageBitmap | HTMLImageElement | VideoFrame | ImageData | HTMLVideoElement> {
  constructor(options: TextureSourceOptions<ImageBitmap | HTMLImageElement | VideoFrame | ImageData | HTMLVideoElement>) {
    super(options);
    this.uploadMethodId = 'image';
    this.autoGarbageCollect = true;
  }

  static override test(resource: unknown): boolean {
    return (typeof HTMLImageElement !== 'undefined' && resource instanceof HTMLImageElement)
      || (typeof ImageBitmap !== 'undefined' && resource instanceof ImageBitmap)
      || (typeof VideoFrame !== 'undefined' && resource instanceof VideoFrame)
      || (typeof ImageData !== 'undefined' && resource instanceof ImageData);
  }
}

export interface CanvasSourceOptions extends TextureSourceOptions<HTMLCanvasElement | OffscreenCanvas> {
  autoDensity?: boolean;
  transparent?: boolean;
}

/** 画布源:画布内容改了调 `update()` */
export class CanvasSource extends TextureSource<HTMLCanvasElement | OffscreenCanvas> {
  autoDensity: boolean;
  transparent: boolean;
  private _context2D: CanvasRenderingContext2D | null = null;

  constructor(options: CanvasSourceOptions) {
    const o = { ...options };
    o.resource ??= document.createElement('canvas');
    const res = o.resolution ?? 1;
    if (!o.width) {
      o.width = o.resource.width;
      if (!o.autoDensity) o.width /= res;
    }
    if (!o.height) {
      o.height = o.resource.height;
      if (!o.autoDensity) o.height /= res;
    }
    super(o);
    this.uploadMethodId = 'image';
    this.autoDensity = !!o.autoDensity;
    this.transparent = !!o.transparent;
    this.resizeCanvas();
  }

  resizeCanvas(): void {
    const r = this.resource;
    if (this.autoDensity && 'style' in r) {
      r.style.width = `${this.width}px`;
      r.style.height = `${this.height}px`;
    }
    if (r.width !== this.pixelWidth || r.height !== this.pixelHeight) {
      r.width = this.pixelWidth;
      r.height = this.pixelHeight;
    }
  }

  override resize(width = this.width, height = this.height, resolution = this._resolution): boolean {
    const did = super.resize(width, height, resolution);
    if (did) this.resizeCanvas();
    return did;
  }

  get context2D(): CanvasRenderingContext2D {
    return (this._context2D ??= this.resource.getContext('2d') as CanvasRenderingContext2D);
  }

  static override test(resource: unknown): boolean {
    return (typeof HTMLCanvasElement !== 'undefined' && resource instanceof HTMLCanvasElement)
      || (typeof OffscreenCanvas !== 'undefined' && resource instanceof OffscreenCanvas);
  }
}

/** 像素数组源:数组内容改了调 `update()`;原样上传(不预乘) */
export class BufferImageSource extends TextureSource<TypedArray> {
  constructor(options: TextureSourceOptions<TypedArray>) {
    const buffer = options.resource ?? new Float32Array((options.width ?? 1) * (options.height ?? 1) * 4);
    let format = options.format;
    if (!format) {
      if (buffer instanceof Float32Array) format = 'rgba32float';
      else if (buffer instanceof Int32Array || buffer instanceof Uint32Array) format = 'rgba32uint';
      else if (buffer instanceof Int16Array || buffer instanceof Uint16Array) format = 'rgba16uint';
      else format = 'bgra8unorm';
    }
    super({ ...options, resource: buffer, format });
    this.uploadMethodId = 'buffer';
  }

  static override test(resource: unknown): boolean {
    return ArrayBuffer.isView(resource) && !(resource instanceof DataView);
  }
}
