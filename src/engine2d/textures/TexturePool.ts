import { Texture } from './Texture';
import { TextureSource, type TextureSourceOptions } from './TextureSource';
import { TextureStyle } from './TextureStyle';

function nextPow2(v: number): number {
  v += v === 0 ? 1 : 0;
  --v;
  v |= v >>> 1;
  v |= v >>> 2;
  v |= v >>> 4;
  v |= v >>> 8;
  v |= v >>> 16;
  return v + 1;
}

let count = 0;

/**
 * 临时渲染纹理池(照 Pixi `TexturePool`):尺寸向上取 2 的幂复用;帧取请求的逻辑尺寸。
 * 滤镜系统的中间纹理都从这里拿——滤镜 uniform(uInputSize 等)按池里纹理的真实尺寸算,
 * 所以取整规则必须与 Pixi 一致,否则滤镜采样坐标与 master 不同。
 */
export class TexturePoolClass {
  textureOptions: TextureSourceOptions;
  enableFullScreen = false;
  textureStyle: TextureStyle;
  private _texturePool: Record<number, Texture[]> = {};
  private _poolKeyHash: Record<number, number> = Object.create(null);

  constructor(textureOptions: TextureSourceOptions = {}) {
    this.textureOptions = textureOptions;
    this.textureStyle = new TextureStyle(textureOptions);
  }

  createTexture(pixelWidth: number, pixelHeight: number, antialias: boolean, autoGenerateMipmaps = false): Texture {
    const source = new TextureSource({
      ...this.textureOptions,
      width: pixelWidth,
      height: pixelHeight,
      resolution: 1,
      antialias,
      autoGarbageCollect: false,
      autoGenerateMipmaps,
    });
    return new Texture({ source, label: `texturePool_${count++}` });
  }

  getOptimalTexture(frameWidth: number, frameHeight: number, resolution = 1, antialias = false, autoGenerateMipmaps = false): Texture {
    let w = Math.ceil(frameWidth * resolution - 1e-6);
    let h = Math.ceil(frameHeight * resolution - 1e-6);
    w = nextPow2(w);
    h = nextPow2(h);
    const key = (w << 17) + (h << 2) + ((autoGenerateMipmaps ? 1 : 0) << 1) + (antialias ? 1 : 0);
    const pool = (this._texturePool[key] ??= []);
    let texture = pool.pop();
    if (!texture) texture = this.createTexture(w, h, antialias, autoGenerateMipmaps);
    const s = texture.source;
    s._resolution = resolution;
    s.width = w / resolution;
    s.height = h / resolution;
    s.pixelWidth = w;
    s.pixelHeight = h;
    texture.frame.x = 0;
    texture.frame.y = 0;
    texture.frame.width = frameWidth;
    texture.frame.height = frameHeight;
    texture.updateUvs();
    this._poolKeyHash[texture.uid] = key;
    return texture;
  }

  getSameSizeTexture(texture: Texture, antialias = false): Texture {
    return this.getOptimalTexture(texture.width, texture.height, texture.source._resolution, antialias);
  }

  returnTexture(texture: Texture, resetStyle = false): void {
    const key = this._poolKeyHash[texture.uid];
    if (resetStyle) texture.source.style = this.textureStyle;
    (this._texturePool[key] ??= []).push(texture);
  }

  clear(destroyTextures = true): void {
    if (destroyTextures) {
      for (const k in this._texturePool) for (const t of this._texturePool[k]) t.destroy(true);
    }
    this._texturePool = {};
  }
}

export const TexturePool = new TexturePoolClass();
