import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import { Rectangle } from '../math/Rectangle';
import { groupD8 } from '../math/groupD8';
import type { PointData } from '../math/Point';
import { BufferImageSource, TextureSource, type TextureResourceLike } from './TextureSource';
import { TextureMatrix } from './TextureMatrix';

export interface UVs {
  x0: number; y0: number;
  x1: number; y1: number;
  x2: number; y2: number;
  x3: number; y3: number;
}

export interface TextureBorders {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TextureOptions<S extends TextureSource = TextureSource> {
  source?: S;
  label?: string;
  frame?: Rectangle;
  orig?: Rectangle;
  trim?: Rectangle;
  defaultAnchor?: PointData;
  defaultBorders?: TextureBorders;
  rotate?: number;
  dynamic?: boolean;
}

export type TextureSourceLike = TextureSource | TextureResourceLike | string;

/**
 * 一块纹理区域(照 Pixi `Texture`):`source` 上的 `frame`(像素,源的逻辑尺寸坐标),
 * `orig` = 未裁切的原尺寸,`trim` = 裁切后内容在 orig 里的位置。`uvs` 按 frame / 源尺寸算。
 */
export class Texture<S extends TextureSource = TextureSource> extends EventEmitter {
  static EMPTY: Texture;
  static WHITE: Texture<BufferImageSource>;

  readonly uid = uid('texture');
  readonly isTexture = true;
  label?: string;
  readonly uvs: UVs = { x0: 0, y0: 0, x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0 };
  readonly frame = new Rectangle();
  orig: Rectangle;
  trim?: Rectangle;
  rotate: number;
  defaultAnchor?: PointData;
  defaultBorders?: TextureBorders;
  noFrame: boolean;
  dynamic: boolean;
  destroyed = false;
  private _source!: S;
  private _textureMatrix: TextureMatrix | null = null;

  constructor({ source, label, frame, orig, trim, defaultAnchor, defaultBorders, rotate, dynamic }: TextureOptions<S> = {}) {
    super();
    this.label = label;
    this.source = (source?.source ?? new TextureSource()) as S;
    this.noFrame = !frame;
    if (frame) this.frame.copyFrom(frame);
    else {
      this.frame.width = this._source.width;
      this.frame.height = this._source.height;
    }
    this.orig = orig || this.frame;
    this.trim = trim;
    this.rotate = rotate ?? 0;
    this.defaultAnchor = defaultAnchor;
    this.defaultBorders = defaultBorders;
    this.dynamic = dynamic || false;
    this.updateUvs();
  }

  get source(): S {
    return this._source;
  }
  set source(value: S) {
    if (this._source) this._source.off('resize', this.update, this);
    this._source = value;
    value.on('resize', this.update, this);
    this.emit('update', this);
  }

  get textureMatrix(): TextureMatrix {
    return (this._textureMatrix ??= new TextureMatrix(this));
  }

  get width(): number {
    return this.orig.width;
  }

  get height(): number {
    return this.orig.height;
  }

  updateUvs(): void {
    const { uvs, frame } = this;
    const { width, height } = this._source;
    const nX = frame.x / width;
    const nY = frame.y / height;
    const nW = frame.width / width;
    const nH = frame.height / height;
    let rotate = this.rotate;
    if (rotate) {
      const w2 = nW / 2;
      const h2 = nH / 2;
      const cX = nX + w2;
      const cY = nY + h2;
      rotate = groupD8.add(rotate, groupD8.NW);
      uvs.x0 = cX + w2 * groupD8.uX(rotate);
      uvs.y0 = cY + h2 * groupD8.uY(rotate);
      rotate = groupD8.add(rotate, 2);
      uvs.x1 = cX + w2 * groupD8.uX(rotate);
      uvs.y1 = cY + h2 * groupD8.uY(rotate);
      rotate = groupD8.add(rotate, 2);
      uvs.x2 = cX + w2 * groupD8.uX(rotate);
      uvs.y2 = cY + h2 * groupD8.uY(rotate);
      rotate = groupD8.add(rotate, 2);
      uvs.x3 = cX + w2 * groupD8.uX(rotate);
      uvs.y3 = cY + h2 * groupD8.uY(rotate);
    } else {
      uvs.x0 = nX;
      uvs.y0 = nY;
      uvs.x1 = nX + nW;
      uvs.y1 = nY;
      uvs.x2 = nX + nW;
      uvs.y2 = nY + nH;
      uvs.x3 = nX;
      uvs.y3 = nY + nH;
    }
  }

  /** 帧 / 源尺寸改了之后调 */
  update(): void {
    if (this.noFrame) {
      this.frame.width = this._source.width;
      this.frame.height = this._source.height;
    }
    this.updateUvs();
    this.emit('update', this);
  }

  destroy(destroySource = false): void {
    if (this._source) {
      this._source.off('resize', this.update, this);
      if (destroySource) {
        this._source.destroy();
        this._source = null as unknown as S;
      }
    }
    this._textureMatrix = null;
    this.destroyed = true;
    this.emit('destroy', this);
    this.removeAllListeners();
  }

  /** 由资源建纹理(字符串 = 已由 Assets 载入的键) */
  static from(id: TextureSourceLike | Texture, skipCache = false): Texture {
    if (id instanceof Texture) return id;
    if (typeof id === 'string') {
      const t = textureFromCache(id);
      if (!t) throw new Error(`[engine2d] Texture.from('${id}'):缓存里没有这张纹理,先用 Assets.load 载入`);
      return t;
    }
    void skipCache;
    return new Texture({ source: TextureSource.from(id) });
  }
}

/** 由 Assets 注册:按键查已载入的纹理(避免 textures 依赖 assets) */
let textureFromCache: (id: string) => Texture | undefined = () => undefined;
export function setTextureCacheLookup(lookup: (id: string) => Texture | undefined): void {
  textureFromCache = lookup;
}

Texture.EMPTY = new Texture({ label: 'EMPTY', source: new TextureSource({ label: 'EMPTY' }) });
Texture.EMPTY.destroy = () => {};
Texture.WHITE = new Texture({
  source: new BufferImageSource({
    resource: new Uint8Array([255, 255, 255, 255]),
    width: 1,
    height: 1,
    alphaMode: 'premultiply-alpha-on-upload',
    label: 'WHITE',
  }),
  label: 'WHITE',
});
Texture.WHITE.destroy = () => {};
