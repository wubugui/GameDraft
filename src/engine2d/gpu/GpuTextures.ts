/**
 * TextureSource → RHI 纹理 / TextureStyle → RHI 采样器。
 *
 * - 源的尺寸 / 格式变了(`_resourceId` 变)就重建;内容变了(`_updateId` 变)就重传。
 * - 上传语义照 Pixi 的 WebGPU 路径:图像 / 视频源 `copyExternalImageToTexture`,`alphaMode === 'premultiply-alpha-on-upload'`
 *   时预乘;像素数组原样写入;没有资源的源(RenderTexture / 池里的临时纹理)建成可当渲染目标的空纹理。
 * - 采样器按采样参数共享,永不销毁(与 rendering/legacy/gpuSampler.ts 同一原则)。
 * - mip 照 Pixi 的 GpuTextureSystem:`autoGenerateMipmaps` 的源建纹理时按 `floor(log2(max(pw, ph))) + 1` 定级数
 *   (写回 `source.mipLevelCount`),每次上传后、以及源发 `updateMipmaps` 时重新生成;其余纹理单级不变。
 * - 空闲回收照 Pixi 的 GCSystem:每次取用记「最近用过」(`gc.now`),`collect` 对 `autoGarbageCollect` 的源
 *   `unload()`(→ 'unload' → 释放);源的监听每建一次纹理挂一份、释放时摘掉(同 Pixi 的 GCManagedHash:
 *   不叠加,放掉之后也不再拽着源)。
 */
import { RhiTextureUsage, type RhiDevice, type RhiResourceScope, type RhiSampler, type RhiTexture, type RhiColorFormat } from '../../rendering/rhi';
import type { TextureSource } from '../textures/TextureSource';
import type { TextureStyle } from '../textures/TextureStyle';

interface Entry {
  texture: RhiTexture;
  resourceId: number;
  updateId: number;
  format: RhiColorFormat;
  /** 最近一次被取用的时刻(GC 时钟,见 GCSystem) */
  lastUsed: number;
}

/** 取「现在」:渲染器的 GC 时钟(每次 render 开始更新) */
export interface GpuResourceClock {
  readonly now: number;
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
    private readonly clock: GpuResourceClock = { get now() { return performance.now(); } },
  ) {}

  /** 取源对应的 RHI 纹理,必要时建 / 传。`renderTarget` = 这张纹理要当渲染目标 */
  get(source: TextureSource, renderTarget = false): RhiTexture {
    if (source.destroyed) throw new Error(`[engine2d] 纹理源「${source.label}」已销毁`);
    let e = this.entries.get(source);
    if (e && e.resourceId !== source._resourceId) {
      this.drop(source, e);
      e = undefined;
    }
    if (!e) {
      const format = toRhiColorFormat(source.format);
      const hasResource = source.resource != null;
      // 照 Pixi GpuTextureSystem._initSource:自动 mip 的源按像素尺寸定满级数,写回源上
      if (source.autoGenerateMipmaps) {
        source.mipLevelCount = Math.floor(Math.log2(Math.max(source.pixelWidth, source.pixelHeight))) + 1;
      }
      const mipLevels = Math.max(1, source.mipLevelCount | 0);
      let usage = RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST | RhiTextureUsage.COPY_SRC;
      // 没有 CPU 资源的源只能靠渲染写入;图像源的上传(copyExternalImage)也要求可作附件;生成 mip 逐级渲染,同样要
      if (!hasResource || renderTarget || source.uploadMethodId === 'image' || source.uploadMethodId === 'video' || mipLevels > 1) usage |= RhiTextureUsage.RENDER_TARGET;
      const texture = this.scope.createTexture({
        label: source.label || `engine2d-tex-${source.uid}`,
        width: Math.max(1, source.pixelWidth),
        height: Math.max(1, source.pixelHeight),
        format,
        usage,
        ...(mipLevels > 1 ? { mipLevels } : {}),
      });
      e = { texture, resourceId: source._resourceId, updateId: -1, format, lastUsed: this.clock.now };
      this.entries.set(source, e);
      source.once('destroy', this.onSourceGone, this);
      source.once('unload', this.onSourceGone, this);
      source.on('updateMipmaps', this.onUpdateMipmaps, this);
    } else if (renderTarget && !(e.texture.usage & RhiTextureUsage.RENDER_TARGET)) {
      // 以前只当采样纹理,现在要当目标:按目标用途重建(内容由接下来的渲染写)
      this.drop(source, e);
      return this.get(source, true);
    }
    e.lastUsed = this.clock.now;
    if (e.updateId !== source._updateId) {
      e.updateId = source._updateId;
      if (this.upload(source, e.texture) && source.autoGenerateMipmaps && e.texture.mipLevels > 1) {
        this.rhi.generateMipmaps(e.texture);
      }
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
    if (e) this.drop(source, e);
  }

  /**
   * 空闲回收(GCSystem 的回收器):`autoGarbageCollect` 的源 `now - 最近用过 >= maxUnusedTime` 就 `unload()`
   * (同 Pixi GCSystem.runOnHash);unload 发 'unload' → 这里释放 GPU 纹理,下次取用时从 CPU 资源重建重传。
   */
  collect(now: number, maxUnusedTime: number): void {
    for (const [source, e] of [...this.entries]) {
      if (source.autoGarbageCollect && now - e.lastUsed >= maxUnusedTime) source.unload();
    }
  }

  destroy(): void {
    this.reset();
  }

  /**
   * 丢掉全部纹理与采样器、摘掉源上的监听。设备丢失后重建时也走这里(照 Pixi GlTextureSystem.contextChange:
   * `_managedTextures.removeAll(true)` + 清采样器;旧设备上的纹理此时已作废):下次取用时建新纹理、从 CPU 资源重传,
   * 没有资源的源(RenderTexture)建成空的
   */
  reset(): void {
    for (const [source, e] of [...this.entries]) {
      this.unhook(source);
      e.texture.destroy();
    }
    this.entries.clear();
    for (const s of this.samplers.values()) s.destroy();
    this.samplers.clear();
  }

  private onSourceGone(source: TextureSource): void {
    this.release(source);
  }

  /** 源发 `updateMipmaps`(Pixi `TextureSource.updateMipmaps`):按 level 0 重新生成各级 */
  private onUpdateMipmaps(source: TextureSource): void {
    const e = this.entries.get(source);
    if (e && e.texture.mipLevels > 1) this.rhi.generateMipmaps(e.texture);
  }

  private drop(source: TextureSource, e: Entry): void {
    this.onRelease?.(e.texture);
    e.texture.destroy();
    this.entries.delete(source);
    this.unhook(source);
  }

  private unhook(source: TextureSource): void {
    source.off('destroy', this.onSourceGone, this);
    source.off('unload', this.onSourceGone, this);
    source.off('updateMipmaps', this.onUpdateMipmaps, this);
  }

  /** 把 CPU 资源写进纹理的 level 0;返回是否真的写了(没有资源 / 图还没解码出尺寸的不写) */
  private upload(source: TextureSource, texture: RhiTexture): boolean {
    const r = source.resource as unknown;
    if (r == null) return false;
    if (ArrayBuffer.isView(r)) {
      const bpp = BYTES_PER_PIXEL[source.format] ?? 4;
      const expected = source.pixelWidth * source.pixelHeight * bpp;
      const view = r as ArrayBufferView;
      const data = view.byteLength > expected ? new Uint8Array(view.buffer, view.byteOffset, expected) : view;
      this.rhi.writeTexture(texture, data);
      return true;
    }
    // 图像源:ImageBitmap / HTMLImageElement / HTMLCanvasElement / OffscreenCanvas / HTMLVideoElement / VideoFrame / ImageData。
    // 尺寸看资源的固有尺寸(naturalWidth / videoWidth / displayWidth / width,同 Pixi 上传器用的 resourceWidth):
    // 视频元素的 `width` 是 HTML 属性(缺省 0),拿它判断会让视频永远传不上去
    if (!source.resourceWidth || !source.resourceHeight) return false;
    this.rhi.uploadImage(texture, r as ImageBitmap, { premultiplyAlpha: source.alphaMode === 'premultiply-alpha-on-upload' });
    return true;
  }
}
