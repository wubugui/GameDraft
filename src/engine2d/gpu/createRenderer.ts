import { createRhiDevice } from '../../rendering/rhi';
import type { RhiDevice } from '../../rendering/rhi';
import type { RendererOptions } from './Renderer';
import { WebGPURenderer } from './WebGPURenderer';
import { EventSystem, type EventSystemOptions } from '../events/EventSystem';

export type CreateRendererOptions = Omit<RendererOptions, 'rhi' | 'canvas'> & {
  canvas?: HTMLCanvasElement;
  /** 已有设备就复用;否则按画布新建 */
  rhi?: RhiDevice;
  /** 画布合成:不透明背景用 opaque(缺省),需要透出页面时 premultiplied */
  alphaMode?: 'opaque' | 'premultiplied';
  eventMode?: EventSystemOptions['eventMode'];
  eventFeatures?: EventSystemOptions['eventFeatures'];
};

/** 建渲染器:没给设备就在画布上建 WebGPU 设备(环境没有 WebGPU 时抛错,不回落) */
export async function createRenderer(options: CreateRendererOptions = {}): Promise<WebGPURenderer> {
  const canvas = options.canvas ?? document.createElement('canvas');
  const alphaMode = options.alphaMode ?? ((options.backgroundAlpha ?? 1) < 1 ? 'premultiplied' : 'opaque');
  const ownsDevice = !options.rhi;
  if (ownsDevice) {
    // 建设备时画布上下文按画布当时的尺寸配置交换链与深度缓冲:零面积(resizeTo 的元素还没布局)会配出 0×0 的深度缓冲,
    // 先按目标尺寸摆好(至少 1 像素);渲染器构造时还会再 resize 一次
    const res = options.resolution ?? 1;
    canvas.width = Math.max(1, Math.round((options.width ?? 800) * res));
    canvas.height = Math.max(1, Math.round((options.height ?? 600) * res));
  }
  const rhi = options.rhi ?? (await createRhiDevice({ canvas, alphaMode, useDevicePixels: false, autoResize: false }));
  // 缺省尺寸与 Pixi 的 ViewSystem 相同
  const renderer = new WebGPURenderer({ width: 800, height: 600, ...options, rhi, canvas });
  renderer.ownsDevice = ownsDevice;
  // 事件系统(Pixi 由渲染器的系统初始化建;这里没有扩展系统,建完渲染器就接上)
  const events = new EventSystem(renderer);
  events.init({ eventMode: options.eventMode, eventFeatures: options.eventFeatures });
  renderer.events = events;
  return renderer;
}
