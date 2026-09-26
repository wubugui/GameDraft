import { EventEmitter } from '../utils/EventEmitter';

export type WRAP_MODE = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
export type SCALE_MODE = 'nearest' | 'linear';
export type COMPARE_FUNCTION = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';

export interface TextureStyleOptions {
  addressMode?: WRAP_MODE;
  addressModeU?: WRAP_MODE;
  addressModeV?: WRAP_MODE;
  addressModeW?: WRAP_MODE;
  magFilter?: SCALE_MODE;
  minFilter?: SCALE_MODE;
  mipmapFilter?: SCALE_MODE;
  scaleMode?: SCALE_MODE;
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: COMPARE_FUNCTION;
  maxAnisotropy?: number;
}

/** 采样键所含的全部参数(`TextureStyle._captureKey`) */
export interface TextureStyleKeyFields {
  addressModeU: WRAP_MODE;
  addressModeV: WRAP_MODE;
  addressModeW: WRAP_MODE;
  magFilter: SCALE_MODE;
  minFilter: SCALE_MODE;
  mipmapFilter: SCALE_MODE;
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: COMPARE_FUNCTION;
  maxAnisotropy: number;
}

/**
 * 采样状态(= GPU 采样器)。照 Pixi:`scaleMode` 同时设 mag / min / mipmap,`addressMode` 同时设 U / V / W;
 * 改了参数调 `update()` 通知使用方。
 */
export class TextureStyle extends EventEmitter {
  static defaultOptions: TextureStyleOptions = { addressMode: 'clamp-to-edge', scaleMode: 'linear' };

  readonly _resourceType = 'textureSampler';
  addressModeU!: WRAP_MODE;
  addressModeV!: WRAP_MODE;
  addressModeW!: WRAP_MODE;
  magFilter!: SCALE_MODE;
  minFilter!: SCALE_MODE;
  mipmapFilter!: SCALE_MODE;
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: COMPARE_FUNCTION;
  destroyed = false;
  private _maxAnisotropy = 1;
  /**
   * 参数版本(对照 Pixi `_resourceId` 只在 `update()` 时重算):每次 update 加一。GPU 缓存(`GpuTextures`)各自按
   * 「版本 → 采样键」记一份,版本没变就沿用自己那份键(R4-6)
   */
  _updateId = 0;

  constructor(options: TextureStyleOptions = {}) {
    super();
    const o = { ...TextureStyle.defaultOptions, ...options };
    this.addressMode = o.addressMode!;
    this.addressModeU = o.addressModeU ?? this.addressModeU;
    this.addressModeV = o.addressModeV ?? this.addressModeV;
    this.addressModeW = o.addressModeW ?? this.addressModeW;
    this.scaleMode = o.scaleMode!;
    this.magFilter = o.magFilter ?? this.magFilter;
    this.minFilter = o.minFilter ?? this.minFilter;
    this.mipmapFilter = o.mipmapFilter ?? this.mipmapFilter;
    this.lodMinClamp = o.lodMinClamp;
    this.lodMaxClamp = o.lodMaxClamp;
    this.compare = o.compare;
    this.maxAnisotropy = o.maxAnisotropy ?? 1;
  }

  set addressMode(value: WRAP_MODE) {
    this.addressModeU = value;
    this.addressModeV = value;
    this.addressModeW = value;
  }
  get addressMode(): WRAP_MODE {
    return this.addressModeU;
  }

  set wrapMode(value: WRAP_MODE) {
    this.addressMode = value;
  }
  get wrapMode(): WRAP_MODE {
    return this.addressMode;
  }

  set scaleMode(value: SCALE_MODE) {
    this.magFilter = value;
    this.minFilter = value;
    this.mipmapFilter = value;
  }
  get scaleMode(): SCALE_MODE {
    return this.magFilter;
  }

  set maxAnisotropy(value: number) {
    this._maxAnisotropy = Math.min(value, 16);
    if (this._maxAnisotropy > 1) this.scaleMode = 'linear';
  }
  get maxAnisotropy(): number {
    return this._maxAnisotropy;
  }

  /**
   * 按字段现值算采样键与参数(GPU 采样器按键共享,建采样器一律用同一份参数,保证同键必同参数)。
   * 什么时候算由 GPU 缓存决定(`GpuTextures.sampler`):照 master 的 WebGL,某个渲染器 / 某次设备第一次用这个 style
   * 时读现值(GL 纹理初始化 applyStyleParams 读现值,设备丢失恢复 / 新渲染器同理);同一缓存里用过之后照 Pixi 8.17 WebGPU,
   * 改字段要 update() 才生效(游戏里都是这么做的;GC 回收后重传仍用原键,同 Pixi WebGPU)。
   * 多个渲染器同时在用时各记各的,互不影响
   */
  _captureKey(): { key: string; fields: Readonly<TextureStyleKeyFields> } {
    const f: TextureStyleKeyFields = {
      addressModeU: this.addressModeU,
      addressModeV: this.addressModeV,
      addressModeW: this.addressModeW,
      magFilter: this.magFilter,
      minFilter: this.minFilter,
      mipmapFilter: this.mipmapFilter,
      lodMinClamp: this.lodMinClamp,
      lodMaxClamp: this.lodMaxClamp,
      compare: this.compare,
      maxAnisotropy: this._maxAnisotropy,
    };
    return {
      key: `${f.addressModeU}|${f.addressModeV}|${f.addressModeW}|${f.magFilter}|${f.minFilter}|${f.mipmapFilter}|${f.lodMinClamp}|${f.lodMaxClamp}|${f.compare}|${f.maxAnisotropy}`,
      fields: f,
    };
  }

  update(): void {
    this._updateId++;
    this.emit('change', this);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroy', this);
    this.emit('change', this);
    this.removeAllListeners();
  }
}
