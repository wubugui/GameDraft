import { Texture } from './Texture';
import { TextureSource, type TextureSourceOptions } from './TextureSource';

/** 可作渲染目标的纹理(照 Pixi `RenderTexture`):源没有 CPU 资源,内容只由 `renderer.render({target})` 写 */
export class RenderTexture extends Texture {
  static create(options: TextureSourceOptions & { dynamic?: boolean }): RenderTexture {
    const { dynamic, ...rest } = options;
    return new RenderTexture({ source: new TextureSource(rest), dynamic: dynamic ?? false });
  }

  resize(width: number, height: number, resolution?: number): this {
    this.source.resize(width, height, resolution);
    return this;
  }
}
