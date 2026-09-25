import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import { Ticker } from '../ticker/Ticker';
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

export type TextureSourceUploadMethod = 'unknown' | 'image' | 'video' | 'buffer' | 'none';

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
    if (VideoSource.test(resource)) return new VideoSource({ ...options, resource: resource as HTMLVideoElement });
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

export interface VideoSourceOptions extends TextureSourceOptions<HTMLVideoElement> {
  /** 构造时就开始加载(缺省 true) */
  autoLoad?: boolean;
  /** 加载好就播放(缺省 true) */
  autoPlay?: boolean;
  /** 每秒从视频取几次帧;0 = 播放中每帧都取(有 requestVideoFrameCallback 时跟着解码帧走) */
  updateFPS?: number;
  /** 以下四项照 Pixi 只是缺省值,给建 video 元素的一方(Pixi 的视频加载器)用,源本身不改元素属性 */
  crossorigin?: boolean | string | null;
  loop?: boolean;
  muted?: boolean;
  playsinline?: boolean;
  /** true:不挂 canplay,等 canplaythrough 才算就绪 */
  preload?: boolean;
  preloadTimeoutMs?: number;
}

/** VideoSource 用到的 video 元素成员(requestVideoFrameCallback 不是所有浏览器都有) */
type VideoElement = HTMLVideoElement & {
  complete?: boolean;
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * 视频源(照 Pixi 8.17 `VideoSource`):按 videoWidth / videoHeight 定尺寸,播放中逐帧 `update()` 重传——
 * updateFPS 为 0 且浏览器有 `requestVideoFrameCallback` 时跟着解码帧走,否则挂 `Ticker.shared` 每 tick 取一帧;
 * 暂停 / 播完 / `autoUpdate = false` 时停。不参与空闲回收(autoGarbageCollect 缺省 false)。
 *
 * 与 Pixi 的差别(都不影响画面):
 * - Pixi 的 `load()` 会 `await detectVideoAlphaMode()`(建 WebGL 画布探测浏览器传视频时是否已预乘),结果写进 alphaMode。
 *   那是给 WebGL `texImage2D` 用的;engine2d 只走 WebGPU 的 `copyExternalImageToTexture`,预乘与否由规范保证,
 *   不需要探测:alphaMode 保持构造时的值(缺省 premultiply-alpha-on-upload,传上去就是预乘的,与 master 的 WebGL 结果相同)。
 *   不 await 也就没有 Pixi 那个重进窗口(构造后立刻再调 `load()`,Pixi 会第二次 element.load()、构造时那个 promise 永不 resolve)。
 * - Pixi 的 `destroy()` 在挂着 `Ticker.shared` 播放时不摘 ticker 监听(已销毁的源永远空转一个回调),这里摘掉。
 */
export class VideoSource extends TextureSource<HTMLVideoElement> {
  static override defaultOptions: Partial<TextureSourceOptions> & Pick<VideoSourceOptions, 'autoLoad' | 'autoPlay' | 'updateFPS' | 'crossorigin' | 'loop' | 'muted' | 'playsinline' | 'preload'> = {
    ...TextureSource.defaultOptions,
    autoLoad: true,
    autoPlay: true,
    updateFPS: 0,
    crossorigin: true,
    loop: false,
    muted: true,
    playsinline: true,
    preload: false,
  };

  /** 扩展名推不出来的视频 MIME 类型 */
  static readonly MIME_TYPES: Record<string, string> = {
    ogv: 'video/ogg',
    mov: 'video/quicktime',
    m4v: 'video/mp4',
  };

  /** 视频已可播放(拿到了 videoWidth / videoHeight) */
  isReady = false;
  autoPlay: boolean;
  /** 构造时传入的原样选项(Pixi 的 `TextureSource.options`) */
  readonly options: VideoSourceOptions;
  private _autoUpdate = true;
  private _isConnectedToTicker = false;
  private _updateFPS: number;
  private _msToNextUpdate = 0;
  private _videoFrameRequestCallbackHandle: number | null = null;
  private _load: Promise<this> | null = null;
  private _resolve: ((source: this) => void) | null = null;
  private _reject: ((reason: unknown) => void) | null = null;
  private _preloadTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(options: VideoSourceOptions) {
    super(options);
    this.uploadMethodId = 'video';
    this.options = options;
    const o = { ...VideoSource.defaultOptions, ...options };
    this._updateFPS = o.updateFPS || 0;
    this.autoPlay = o.autoPlay !== false;
    this.alphaMode = o.alphaMode ?? 'premultiply-alpha-on-upload';
    if (o.autoLoad !== false) void this.load();
  }

  /** 取一帧:源没销毁且视频有尺寸就 `update()`(下次渲染重传) */
  updateFrame(): void {
    if (this.destroyed) return;
    if (this._updateFPS) {
      const elapsedMS = Ticker.shared.elapsedMS * this.resource.playbackRate;
      this._msToNextUpdate = Math.floor(this._msToNextUpdate - elapsedMS);
    }
    if (!this._updateFPS || this._msToNextUpdate <= 0) {
      this._msToNextUpdate = this._updateFPS ? Math.floor(1000 / this._updateFPS) : 0;
    }
    // 照 Pixi 8.17:updateFPS 只推倒计时,并不拦这里的 update(挂在 ticker 上时每 tick 都重传)
    if (this.isValid) this.update();
  }

  private readonly _videoFrameRequestCallback = (): void => {
    this.updateFrame();
    if (this.destroyed) this._videoFrameRequestCallbackHandle = null;
    else this._videoFrameRequestCallbackHandle = (this.resource as VideoElement).requestVideoFrameCallback!(this._videoFrameRequestCallback);
  };

  /** 视频已有尺寸 */
  get isValid(): boolean {
    return !!this.resource.videoWidth && !!this.resource.videoHeight;
  }

  /** 开始加载;视频有了尺寸就 resolve,出错 reject */
  async load(): Promise<this> {
    if (this._load) return this._load;
    const source = this.resource as VideoElement;
    const options = this.options;
    if ((source.readyState === source.HAVE_ENOUGH_DATA || source.readyState === source.HAVE_FUTURE_DATA) && source.width && source.height) {
      source.complete = true;
    }
    source.addEventListener('play', this._onPlayStart);
    source.addEventListener('pause', this._onPlayStop);
    source.addEventListener('seeked', this._onSeeked);
    if (!this._isSourceReady()) {
      if (!options.preload) source.addEventListener('canplay', this._onCanPlay);
      source.addEventListener('canplaythrough', this._onCanPlayThrough);
      source.addEventListener('error', this._onError, true);
    } else {
      this._mediaReady();
    }
    // (Pixi 在这里 await detectVideoAlphaMode();WebGPU 下不需要,见类注释)
    this._load = new Promise<this>((resolve, reject) => {
      if (this.isValid) {
        resolve(this);
      } else {
        this._resolve = resolve;
        this._reject = reject;
        if (options.preloadTimeoutMs !== undefined) {
          // 照 Pixi 8.17 原样:setTimeout 没带延时参数(下一轮宏任务就报超时)
          this._preloadTimeout = setTimeout(() => {
            this._onError(new ErrorEvent(`Preload exceeded timeout of ${options.preloadTimeoutMs}ms`));
          });
        }
        source.load();
      }
    });
    return this._load;
  }

  private readonly _onError = (event: unknown): void => {
    this.resource.removeEventListener('error', this._onError, true);
    this.emit('error', event);
    if (this._reject) {
      this._reject(event);
      this._reject = null;
      this._resolve = null;
    }
  };

  private _isSourcePlaying(): boolean {
    const source = this.resource;
    return !source.paused && !source.ended;
  }

  private _isSourceReady(): boolean {
    return this.resource.readyState > 2;
  }

  private readonly _onPlayStart = (): void => {
    if (!this.isValid) this._mediaReady();
    this._configureAutoUpdate();
  };

  private readonly _onPlayStop = (): void => {
    this._configureAutoUpdate();
  };

  /** 暂停时拖动进度:补传当前帧 */
  private readonly _onSeeked = (): void => {
    if (this._autoUpdate && !this._isSourcePlaying()) {
      this._msToNextUpdate = 0;
      this.updateFrame();
      this._msToNextUpdate = 0;
    }
  };

  private readonly _onCanPlay = (): void => {
    this.resource.removeEventListener('canplay', this._onCanPlay);
    this._mediaReady();
  };

  private readonly _onCanPlayThrough = (): void => {
    // 照 Pixi 8.17 原样:这里摘的是 _onCanPlay(摘不掉),canplaythrough 的监听留到 destroy,之后每次 canplaythrough 都再走一遍就绪
    this.resource.removeEventListener('canplaythrough', this._onCanPlay);
    if (this._preloadTimeout) {
      clearTimeout(this._preloadTimeout);
      this._preloadTimeout = undefined;
    }
    this._mediaReady();
  };

  /** 可以播放了:按视频尺寸定大小、传首帧、resolve load(),然后接上逐帧更新或自动播放 */
  private _mediaReady(): void {
    const source = this.resource;
    if (this.isValid) {
      this.isReady = true;
      this.resize(source.videoWidth, source.videoHeight);
    }
    this._msToNextUpdate = 0;
    this.updateFrame();
    this._msToNextUpdate = 0;
    if (this._resolve) {
      this._resolve(this);
      this._resolve = null;
      this._reject = null;
    }
    if (this._isSourcePlaying()) this._onPlayStart();
    else if (this.autoPlay) void this.resource.play();
  }

  override destroy(): void {
    this._configureAutoUpdate();
    // 与 Pixi 的差别:播放中销毁时把 Ticker.shared 上的监听也摘掉(Pixi 漏摘;rVFC 那条下一帧自己停,照旧)
    if (this._isConnectedToTicker) {
      Ticker.shared.remove(this.updateFrame, this);
      this._isConnectedToTicker = false;
    }
    const source = this.resource;
    if (source) {
      source.removeEventListener('play', this._onPlayStart);
      source.removeEventListener('pause', this._onPlayStop);
      source.removeEventListener('seeked', this._onSeeked);
      source.removeEventListener('canplay', this._onCanPlay);
      source.removeEventListener('canplaythrough', this._onCanPlayThrough);
      source.removeEventListener('error', this._onError, true);
      source.pause();
      source.src = '';
      source.load();
    }
    super.destroy();
  }

  /** 播放中自动逐帧更新(缺省 true) */
  get autoUpdate(): boolean {
    return this._autoUpdate;
  }
  set autoUpdate(value: boolean) {
    if (value !== this._autoUpdate) {
      this._autoUpdate = value;
      this._configureAutoUpdate();
    }
  }

  /** 每秒从视频取几次帧;0 = 每帧都取 */
  get updateFPS(): number {
    return this._updateFPS;
  }
  set updateFPS(value: number) {
    if (value !== this._updateFPS) {
      this._updateFPS = value;
      this._configureAutoUpdate();
    }
  }

  /**
   * 按当前状态接 / 断逐帧更新(同 Pixi):自动更新且在播放时,updateFPS 为 0 且有 rVFC 用 rVFC,否则挂 Ticker.shared;
   * 不在播放或关了自动更新就两样都断。
   */
  private _configureAutoUpdate(): void {
    const source = this.resource as VideoElement;
    if (this._autoUpdate && this._isSourcePlaying()) {
      if (!this._updateFPS && source.requestVideoFrameCallback) {
        if (this._isConnectedToTicker) {
          Ticker.shared.remove(this.updateFrame, this);
          this._isConnectedToTicker = false;
          this._msToNextUpdate = 0;
        }
        if (this._videoFrameRequestCallbackHandle === null) {
          this._videoFrameRequestCallbackHandle = source.requestVideoFrameCallback(this._videoFrameRequestCallback);
        }
      } else {
        if (this._videoFrameRequestCallbackHandle !== null) {
          source.cancelVideoFrameCallback!(this._videoFrameRequestCallbackHandle);
          this._videoFrameRequestCallbackHandle = null;
        }
        if (!this._isConnectedToTicker) {
          Ticker.shared.add(this.updateFrame, this);
          this._isConnectedToTicker = true;
          this._msToNextUpdate = 0;
        }
      }
    } else {
      if (this._videoFrameRequestCallbackHandle !== null) {
        source.cancelVideoFrameCallback!(this._videoFrameRequestCallbackHandle);
        this._videoFrameRequestCallbackHandle = null;
      }
      if (this._isConnectedToTicker) {
        Ticker.shared.remove(this.updateFrame, this);
        this._isConnectedToTicker = false;
        this._msToNextUpdate = 0;
      }
    }
  }

  static override test(resource: unknown): boolean {
    return typeof HTMLVideoElement !== 'undefined' && resource instanceof HTMLVideoElement;
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
