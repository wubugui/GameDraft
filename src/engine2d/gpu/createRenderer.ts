import { createRhiDevice } from '../../rendering/rhi';
import type { RhiDevice } from '../../rendering/rhi';
import type { RendererOptions } from './Renderer';
import { WebGPURenderer } from './WebGPURenderer';

export type CreateRendererOptions = Omit<RendererOptions, 'rhi' | 'canvas'> & {
  canvas?: HTMLCanvasElement;
  /** 已有设备就复用;否则按画布新建 */
  rhi?: RhiDevice;
  /** 画布合成:不透明背景用 opaque(缺省),需要透出页面时 premultiplied */
  alphaMode?: 'opaque' | 'premultiplied';
};

/** 建渲染器:没给设备就在画布上建 WebGPU 设备(环境没有 WebGPU 时抛错,不回落) */
export async function createRenderer(options: CreateRendererOptions = {}): Promise<WebGPURenderer> {
  const canvas = options.canvas ?? document.createElement('canvas');
  const alphaMode = options.alphaMode ?? ((options.backgroundAlpha ?? 1) < 1 ? 'premultiplied' : 'opaque');
  const rhi = options.rhi ?? (await createRhiDevice({ canvas, alphaMode, useDevicePixels: false, autoResize: false }));
  // 缺省尺寸与 Pixi 的 ViewSystem 相同
  return new WebGPURenderer({ width: 800, height: 600, ...options, rhi, canvas });
}
