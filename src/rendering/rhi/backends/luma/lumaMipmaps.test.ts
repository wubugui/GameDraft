/**
 * WebGPU mip 生成器(假 GPUDevice,不需要 GPU),与真 Pixi 8.17 的 GpuMipmapGenerator 跑同一台假设备逐条对照:
 * 管线按格式只建一次、一张纹理全部级一次提交、逐级「上一级 → 下一级」。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { WebGpuMipmapGenerator } from './lumaMipmaps';

function fakeDevice() {
  const log: string[] = [];
  let ids = 0;
  const device: any = {
    createShaderModule: () => { log.push('module'); return { id: ++ids }; },
    createSampler: (d: any) => { log.push(`sampler min=${d.minFilter}`); return { id: ++ids }; },
    createRenderPipeline: (d: any) => {
      log.push(`pipeline ${d.fragment.targets[0].format}`);
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup: (d: any) => ({ src: d.entries[1].resource.level }),
    createCommandEncoder: () => ({
      beginRenderPass: (d: any) => {
        const dst = d.colorAttachments[0].view.level;
        let src = -1;
        return {
          setPipeline() {},
          setBindGroup: (_i: number, g: any) => { src = g.src; },
          draw: (n: number) => log.push(`pass ${src}->${dst} draw ${n}`),
          end() {},
        };
      },
      finish: () => ({}),
    }),
    queue: { submit: (bufs: unknown[]) => log.push(`submit ${bufs.length}`) },
  };
  const texture = (format: string, mipLevelCount: number): any => ({
    format, mipLevelCount, dimension: '2d', depthOrArrayLayers: 1, width: 512, height: 512,
    usage: 0x10 | 0x04,
    createView: (d: any) => ({ level: d.baseMipLevel }),
  });
  return { device, texture, log };
}

afterEach(() => vi.unstubAllGlobals());

describe('WebGpuMipmapGenerator', () => {
  it('与 Pixi GpuMipmapGenerator 同一串 GPU 调用:管线按格式缓存、全部级一次提交', () => {
    vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
    const run = (make: (d: any) => { generate(t: any): void }) => {
      const f = fakeDevice();
      const g = make(f.device);
      g.generate(f.texture('rgba8unorm', 10));
      g.generate(f.texture('rgba8unorm', 10));
      g.generate(f.texture('bgra8unorm', 3));
      // 着色器模块 / 采样器创建的先后与语义无关,只比对管线、pass、提交
      return { calls: f.log.filter((l) => !l.startsWith('module') && !l.startsWith('sampler')), all: f.log };
    };
    const ours = run((d) => new WebGpuMipmapGenerator(d));
    const pixi = run((d) => {
      const p = new (PIXI as any).GpuMipmapGenerator(d);
      return { generate: (t: any) => p.generateMipmap(t) };
    });
    expect(ours.calls).toEqual(pixi.calls);
    // 格式各一条管线;每次生成只提交一次(luma 的 generateMipmapsWebGPU 每级提交一次、每次重建管线)
    expect(ours.calls.filter((l) => l.startsWith('pipeline'))).toEqual(['pipeline rgba8unorm', 'pipeline bgra8unorm']);
    expect(ours.calls.filter((l) => l.startsWith('submit'))).toEqual(['submit 1', 'submit 1', 'submit 1']);
    expect(ours.calls.slice(1, 4)).toEqual(['pass 0->1 draw 3', 'pass 1->2 draw 3', 'pass 2->3 draw 3']);
    // 着色器模块、采样器(与 Pixi 同为 minFilter linear)整个生成器只建一次
    expect(ours.all.filter((l) => l === 'module')).toHaveLength(1);
    expect(ours.all.filter((l) => l.startsWith('sampler'))).toEqual(['sampler min=linear']);
  });

  it('单级纹理什么都不做', () => {
    const f = fakeDevice();
    new WebGpuMipmapGenerator(f.device).generate(f.texture('rgba8unorm', 1));
    expect(f.log).toEqual([]);
  });
});
