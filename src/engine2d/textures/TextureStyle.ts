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

/** 采样键所含的全部参数(`TextureStyle._keyFields`) */
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
  /** `_key` 与算键当时的采样参数(update 时清) */
  private _cachedKey: string | null = null;
  private _cachedFields: TextureStyleKeyFields | null = null;

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
   * 采样参数的键(GPU 采样器按它共享)。照 Pixi 8.17 的 `_resourceId`:第一次取时算好缓存,之后改字段不生效,
   * `update()` 才重算。master 的 WebGL 在源初始化(第一次绑定 / 第一次渲染进 RT,以及回收后重建)时按字段现值下发,
   * 所以只有「第一次用之前改」与 master 一致;用过之后改字段必须 update()(游戏里都是这么做的)
   */
  get _key(): string {
    if (this._cachedKey === null) this.captureKey();
    return this._cachedKey!;
  }

  /**
   * 算 `_key` 当时的采样参数:建 GPU 采样器一律用它,不读字段现值——否则用过之后改了字段没 update,
   * 采样器表重建(设备丢失恢复)时旧键会配上新参数,连带同键的其他 style 一起错
   */
  get _keyFields(): Readonly<TextureStyleKeyFields> {
    if (this._cachedFields === null) this.captureKey();
    return this._cachedFields!;
  }

  private captureKey(): void {
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
    this._cachedFields = f;
    this._cachedKey = `${f.addressModeU}|${f.addressModeV}|${f.addressModeW}|${f.magFilter}|${f.minFilter}|${f.mipmapFilter}|${f.lodMinClamp}|${f.lodMaxClamp}|${f.compare}|${f.maxAnisotropy}`;
  }

  update(): void {
    this._cachedKey = null;
    this._cachedFields = null;
    this.emit('change', this);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroy', this);
    this.emit('change', this);
    this.removeAllListeners();
  }
}
