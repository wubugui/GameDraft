import { RendererBase, type ExtractSystem, type GenerateTextureOptions, type RenderOptions } from './Renderer';
import type { Container } from '../scene/Container';
import type { RenderTexture } from '../textures/RenderTexture';

/** 具体渲染器(实现见 gpu 模块其余文件;此处先占位,由渲染核心补全) */
export class WebGPURenderer extends RendererBase {
  get extract(): ExtractSystem {
    throw new Error('[engine2d] extract 尚未实现');
  }

  render(_options: Container | RenderOptions): void {
    throw new Error('[engine2d] render 尚未实现');
  }

  generateTexture(_options: Container | GenerateTextureOptions): RenderTexture {
    throw new Error('[engine2d] generateTexture 尚未实现');
  }

  destroy(): void {}
}
