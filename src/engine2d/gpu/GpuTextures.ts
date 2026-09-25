/**
 * TextureSource → RHI 纹理 / TextureStyle → RHI 采样器。
 *
 * - 源的尺寸 / 格式变了(`_resourceId` 变)就重建;内容变了(`_updateId` 变)就重传。
 * - 上传语义照 Pixi 的 WebGPU 路径:图像源 `copyExternalImageToTexture`,`alphaMode === 'premultiply-alpha-on-upload'`
 *   时预乘;像素数组原样写入;没有资源的源(RenderTexture / 池里的临时纹理)建成可当渲染目标的空纹理。
 * - 采样器按采样参数共享,永不销毁(与 rendering/legacy/gpuSampler.ts 同一原则)。
 */
import { RhiTextureUsage, type RhiDevice, type RhiResourceScope, type RhiSampler, type RhiTexture, type RhiColorFormat } from '../../rendering/rhi';
import type { TextureSource } from '../textures/TextureSource';
import type { TextureStyle } from '../textures/TextureStyle';

interface Entry {
  texture: RhiTexture;
  resourceId: number;
  updateId: number;
  format: RhiColorFormat;
}

const BYTES_PER_PIXEL: Partial<Record<string, number>> = {
  r8unorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  r16float: 2,
  rg16float: 4,
  rgba16float: 8,
  r32float: 4,
  rg32float: 8,
  rgba32float: 16,
  r32uint: 4,
  rgba32uint: 16,
};

export function toRhiColorFormat(format: string): RhiColorFormat {
  if (!(format in BYTES_PER_PIXEL)) throw new Error(`[engine2d] 纹理格式 ${format} 不支持`);
  return format as RhiColorFormat;
}

export class GpuTextures {
  private readonly entries = new Map<TextureSource, Entry>();
  private readonly samplers = new Map<string, RhiSampler>();
  /** 某张 RHI 纹理要销毁了(渲染目标缓存据此收掉挂在它上面的目标) */
  onRelease: ((texture: RhiTexture) => void) | null = null;

  constructor(
    private readonly rhi: RhiDevice,
    private readonly scope: RhiResourceScope,
  ) {}

  /** 取源对应的 RHI 纹理,必要时建 / 传。`renderTarget` = 这张纹理要当渲染目标 */
  get(source: TextureSource, renderTarget = false): RhiTexture {
    if (source.destroyed) throw new Error(`[engine2d] 纹理源「${source.label}」已销毁`);
    let e = this.entries.get(source);
    if (e && e.resourceId !== source._resourceId) {
      this.onRelease?.(e.texture);
      e.texture.destroy();
      this.entries.delete(source);
      e = undefined;
    }
    if (!e) {
      const format = toRhiColorFormat(source.format);
      const hasResource = source.resource != null;
      let usage = RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST | RhiTextureUsage.COPY_SRC;
      // 没有 CPU 资源的源只能靠渲染写入;图像源的上传(copyExternalImage)也要求可作附件
      if (!hasResource || renderTarget || source.uploadMethodId === 'image') usage |= RhiTextureUsage.RENDER_TARGET;
      const texture = this.scope.createTexture({
        label: source.label || `engine2d-tex-${source.uid}`,
        width: Math.max(1, source.pixelWidth),
        height: Math.max(1, source.pixelHeight),
        format,
        usage,
      });
      e = { texture, resourceId: source._resourceId, updateId: -1, format };
      this.entries.set(source, e);
      source.once('destroy', () => this.release(source));
      source.on('unload', () => this.release(source));
    } else if (renderTarget && !(e.texture.usage & RhiTextureUsage.RENDER_TARGET)) {
      // 以前只当采样纹理,现在要当目标:按目标用途重建(内容由接下来的渲染写)
      this.onRelease?.(e.texture);
      e.texture.destroy();
      this.entries.delete(source);
      return this.get(source, true);
    }
    if (e.updateId !== source._updateId) {
      e.updateId = source._updateId;
      this.upload(source, e.texture);
    }
    return e.texture;
  }

  /** 源是否已有 GPU 纹理(不创建) */
  has(source: TextureSource): boolean {
    return this.entries.has(source);
  }

  sampler(style: TextureStyle): RhiSampler {
    const key = style._key;
    let s = this.samplers.get(key);
    if (!s) {
      s = this.scope.createSampler({
        label: `engine2d-sampler ${key}`,
        addressModeU: style.addressModeU,
        addressModeV: style.addressModeV,
        magFilter: style.magFilter,
        minFilter: style.minFilter,
        mipmapFilter: style.mipmapFilter,
        compare: style.compare,
      });
      this.samplers.set(key, s);
    }
    return s;
  }

  release(source: TextureSource): void {
    const e = this.entries.get(source);
    if (!e) return;
    this.onRelease?.(e.texture);
    e.texture.destroy();
    this.entries.delete(source);
  }

  destroy(): void {
    for (const e of this.entries.values()) e.texture.destroy();
    this.entries.clear();
    for (const s of this.samplers.values()) s.destroy();
    this.samplers.clear();
  }

  private upload(source: TextureSource, texture: RhiTexture): void {
    const r = source.resource as unknown;
    if (r == null) return;
    if (ArrayBuffer.isView(r)) {
      const bpp = BYTES_PER_PIXEL[source.format] ?? 4;
      const expected = source.pixelWidth * source.pixelHeight * bpp;
      const view = r as ArrayBufferView;
      const data = view.byteLength > expected ? new Uint8Array(view.buffer, view.byteOffset, expected) : view;
      this.rhi.writeTexture(texture, data);
      return;
    }
    // 图像源:ImageBitmap / HTMLImageElement / HTMLCanvasElement / OffscreenCanvas / VideoFrame / ImageData
    const img = r as ImageBitmap;
    if ((img as unknown as { width?: number }).width === 0) return;
    this.rhi.uploadImage(texture, img, { premultiplyAlpha: source.alphaMode === 'premultiply-alpha-on-upload' });
  }
}
