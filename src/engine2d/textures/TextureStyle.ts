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

  /** 采样参数的键(GPU 采样器按它共享) */
  get _key(): string {
    return `${this.addressModeU}|${this.addressModeV}|${this.addressModeW}|${this.magFilter}|${this.minFilter}|${this.mipmapFilter}|${this.lodMinClamp}|${this.lodMaxClamp}|${this.compare}|${this._maxAnisotropy}`;
  }

  update(): void {
    this.emit('change', this);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroy', this);
    this.emit('change', this);
    this.removeAllListeners();
  }
}
