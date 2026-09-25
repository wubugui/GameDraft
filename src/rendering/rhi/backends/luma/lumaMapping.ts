/**
 * RHI 描述符 → luma.gl 属性的纯映射。不碰设备,便于单测。
 */
import { Buffer as LumaBuffer, Texture as LumaTexture } from '@luma.gl/core';
import type {
  BufferLayout,
  RenderPipelineParameters,
  SamplerProps,
  TextureFormat,
  VertexFormat,
} from '@luma.gl/core';
import {
  RhiBufferUsage,
  RhiTextureUsage,
  type RhiBackendType,
  type RhiRenderPipelineDesc,
  type RhiSamplerDesc,
  type RhiTextureFormat,
  type RhiVertexBufferLayout,
} from '../../types';

export function toLumaBufferUsage(usage: number): number {
  let out = 0;
  if (usage & RhiBufferUsage.VERTEX) out |= LumaBuffer.VERTEX;
  if (usage & RhiBufferUsage.INDEX) out |= LumaBuffer.INDEX;
  if (usage & RhiBufferUsage.UNIFORM) out |= LumaBuffer.UNIFORM;
  if (usage & RhiBufferUsage.STORAGE) out |= LumaBuffer.STORAGE;
  if (usage & RhiBufferUsage.INDIRECT) out |= LumaBuffer.INDIRECT;
  if (usage & RhiBufferUsage.COPY_SRC) out |= LumaBuffer.COPY_SRC;
  if (usage & RhiBufferUsage.COPY_DST) out |= LumaBuffer.COPY_DST;
  return out;
}

export function toLumaTextureUsage(usage: number): number {
  let out = 0;
  if (usage & RhiTextureUsage.SAMPLED) out |= LumaTexture.SAMPLE;
  if (usage & RhiTextureUsage.RENDER_TARGET) out |= LumaTexture.RENDER;
  if (usage & RhiTextureUsage.STORAGE) out |= LumaTexture.STORAGE;
  if (usage & RhiTextureUsage.COPY_SRC) out |= LumaTexture.COPY_SRC;
  if (usage & RhiTextureUsage.COPY_DST) out |= LumaTexture.COPY_DST;
  return out;
}

/** RHI 纹理格式名与 luma 的 TextureFormat 同名(都取 WebGPU 命名),这里只做类型收窄 */
export function toLumaTextureFormat(format: RhiTextureFormat): TextureFormat {
  return format as TextureFormat;
}

export function toLumaVertexFormat(format: string): VertexFormat {
  return format as VertexFormat;
}

export function toLumaBufferLayout(layouts: readonly RhiVertexBufferLayout[] | undefined): BufferLayout[] {
  return (layouts ?? []).map((l) => ({
    name: l.name,
    byteStride: l.stride,
    stepMode: l.stepMode ?? 'vertex',
    attributes: l.attributes.map((a) => ({
      attribute: a.name,
      format: toLumaVertexFormat(a.format),
      byteOffset: a.offset,
    })),
  }));
}

export function toLumaPipelineParameters(desc: RhiRenderPipelineDesc): RenderPipelineParameters {
  const params: RenderPipelineParameters = {
    cullMode: desc.cullMode ?? 'none',
  };
  if (desc.blend) {
    params.blend = true;
    params.blendColorSrcFactor = desc.blend.color.srcFactor;
    params.blendColorDstFactor = desc.blend.color.dstFactor;
    params.blendColorOperation = desc.blend.color.operation ?? 'add';
    params.blendAlphaSrcFactor = desc.blend.alpha.srcFactor;
    params.blendAlphaDstFactor = desc.blend.alpha.dstFactor;
    params.blendAlphaOperation = desc.blend.alpha.operation ?? 'add';
  } else {
    params.blend = false;
  }
  if (desc.depthFormat) {
    params.depthWriteEnabled = desc.depth?.write ?? true;
    params.depthCompare = desc.depth?.compare ?? 'less-equal';
    params.depthFormat = desc.depthFormat;
  }
  return params;
}

export function toLumaSamplerProps(desc: RhiSamplerDesc): SamplerProps {
  const props: SamplerProps = {
    id: desc.label,
    addressModeU: desc.addressModeU ?? 'clamp-to-edge',
    addressModeV: desc.addressModeV ?? 'clamp-to-edge',
    magFilter: desc.magFilter ?? 'linear',
    minFilter: desc.minFilter ?? 'linear',
    mipmapFilter: desc.mipmapFilter ?? 'none',
  };
  if (desc.compare) {
    props.type = 'comparison-sampler';
    props.compare = desc.compare;
  }
  return props;
}

/** luma 的设备类型名 → RHI 后端名 */
export function toRhiBackend(type: string): RhiBackendType {
  return type === 'webgpu' ? 'webgpu' : 'webgl2';
}

/**
 * 后端尝试顺序。`auto` = 能用 WebGPU 就先试 WebGPU,失败回落 WebGL2;
 * 指定了就只试那一个(指定 WebGPU 而环境没有,直接失败,不偷偷换成 WebGL2)。
 */
export function backendAttemptOrder(requested: 'auto' | RhiBackendType, hasWebGPU: boolean): RhiBackendType[] {
  if (requested === 'webgpu') return ['webgpu'];
  if (requested === 'webgl2') return ['webgl2'];
  return hasWebGPU ? ['webgpu', 'webgl2'] : ['webgl2'];
}

/**
 * 把一份紧排或带行填充的回读数据去掉行填充。
 * `bytesPerRow` 是带填充的行跨度,`rowBytes` 是一行真实像素的字节数。
 */
export function stripRowPadding(src: Uint8Array, width: number, height: number, bytesPerPixel: number, bytesPerRow: number): Uint8Array {
  const rowBytes = width * bytesPerPixel;
  if (bytesPerRow === rowBytes) return src.slice(0, rowBytes * height);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  return out;
}
