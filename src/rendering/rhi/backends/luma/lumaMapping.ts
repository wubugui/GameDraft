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
  if (desc.stencil) {
    params.stencilCompare = desc.stencil.compare;
    params.stencilPassOperation = desc.stencil.passOp ?? 'keep';
    params.stencilFailOperation = desc.stencil.failOp ?? 'keep';
    params.stencilDepthFailOperation = desc.stencil.depthFailOp ?? 'keep';
    params.stencilReadMask = desc.stencil.readMask ?? 0xff;
    params.stencilWriteMask = desc.stencil.writeMask ?? 0xff;
  }
  if (desc.colorWriteMask !== undefined) params.colorMask = desc.colorWriteMask;
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

/**
 * 把回读数据去掉行填充(WebGPU 的纹理→缓冲拷贝要求行跨度按 256 字节对齐)。
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
