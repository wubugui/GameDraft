/**
 * 候选侧 = 本分支:这一侧的页面由「候选」Vite 服务提供,`@src` 指向工作区的 src,`pixi.js` 被别名到
 * engine2d 的公共入口(运行时代码与用例里的同名 API 全走 engine2d → RHI → WebGPU,跑 WGSL)。
 * 只用离屏目标、经 RHI 回读,不往画布上屏(无头 SwiftShader 也能跑)。
 */
import { createRenderer } from '@src/engine2d/gpu/createRenderer';
import type { WebGPURenderer } from '@src/engine2d';
import type { Renderer, RenderTexture } from 'pixi.js';
import { fromHalf, type ParityTarget, type SideRenderer } from './harness';

export const SIDE_LABEL = '候选(本分支 · engine2d WebGPU)';

export async function createSideRenderer(): Promise<SideRenderer> {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const renderer = await createRenderer({ canvas, width: 16, height: 16, antialias: false, resolution: 1, backgroundAlpha: 0 });
  return {
    side: 'gpu',
    renderer: renderer as unknown as Renderer,
    read: (rt, target) => readGpu(renderer, rt, target),
  };
}

async function readGpu(renderer: WebGPURenderer, rt: RenderTexture, target: ParityTarget): Promise<Float32Array> {
  const rb = await renderer.readTextureRaw(rt.source as never);
  const { width, height } = rb;
  const out = new Float32Array(width * height * 4);
  if (target === 'rgba8unorm') {
    for (let i = 0; i < out.length; i++) out[i] = rb.data[i] / 255;
    // 没指定格式的渲染目标缺省是 bgra8unorm:显存里真是 BGRA 字节序(WebGL 侧存 RGBA),换回 RGBA 再比
    if (rb.format === 'bgra8unorm') {
      for (let i = 0; i < out.length; i += 4) {
        const b = out[i];
        out[i] = out[i + 2];
        out[i + 2] = b;
      }
    }
  } else if (target === 'rgba16float') {
    const u16 = new Uint16Array(rb.data.buffer, rb.data.byteOffset, rb.data.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = fromHalf(u16[i]);
  } else {
    out.set(new Float32Array(rb.data.buffer, rb.data.byteOffset, out.length));
  }
  return out;
}
