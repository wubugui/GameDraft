import { Matrix } from '../math/Matrix';
import type { Texture } from './Texture';

const tempMat = new Matrix();

/** 纹理坐标映射(照 Pixi `TextureMatrix`):把 0..1 的网格 uv 映射到图集帧内,附带夹取框 */
export class TextureMatrix {
  readonly mapCoord = new Matrix();
  readonly uClampFrame = new Float32Array(4);
  readonly uClampOffset = new Float32Array(2);
  clampOffset = 0;
  clampMargin: number;
  isSimple = false;
  _updateID = 0;
  private _texture!: Texture;

  constructor(texture: Texture, clampMargin?: number) {
    this.clampMargin = clampMargin ?? (texture.width < 10 ? 0 : 0.5);
    this.texture = texture;
  }

  get texture(): Texture {
    return this._texture;
  }
  set texture(value: Texture) {
    if (this._texture === value) return;
    this._texture?.removeListener('update', this.update, this);
    this._texture = value;
    this._texture.addListener('update', this.update, this);
    this.update();
  }

  multiplyUvs(uvs: Float32Array, out?: Float32Array): Float32Array {
    out ??= uvs;
    const m = this.mapCoord;
    for (let i = 0; i < uvs.length; i += 2) {
      const x = uvs[i];
      const y = uvs[i + 1];
      out[i] = x * m.a + y * m.c + m.tx;
      out[i + 1] = x * m.b + y * m.d + m.ty;
    }
    return out;
  }

  update(): boolean {
    const tex = this._texture;
    this._updateID++;
    const uvs = tex.uvs;
    this.mapCoord.set(uvs.x1 - uvs.x0, uvs.y1 - uvs.y0, uvs.x3 - uvs.x0, uvs.y3 - uvs.y0, uvs.x0, uvs.y0);
    const { orig, trim } = tex;
    if (trim) {
      tempMat.set(orig.width / trim.width, 0, 0, orig.height / trim.height, -trim.x / trim.width, -trim.y / trim.height);
      this.mapCoord.append(tempMat);
    }
    const base = tex.source;
    const f = this.uClampFrame;
    const margin = this.clampMargin / base._resolution;
    const offset = this.clampOffset / base._resolution;
    f[0] = (tex.frame.x + margin + offset) / base.width;
    f[1] = (tex.frame.y + margin + offset) / base.height;
    f[2] = (tex.frame.x + tex.frame.width - margin + offset) / base.width;
    f[3] = (tex.frame.y + tex.frame.height - margin + offset) / base.height;
    this.uClampOffset[0] = this.clampOffset / base.pixelWidth;
    this.uClampOffset[1] = this.clampOffset / base.pixelHeight;
    this.isSimple = tex.frame.width === base.width && tex.frame.height === base.height && tex.rotate === 0;
    return true;
  }
}
