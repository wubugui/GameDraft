import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Container, Shader, DOMAdapter, type Mesh } from '../../../../src/engine2d';
import { vfxPipelineSpecs } from '../../../../src/rendering/vfx/VfxRenderer';
import { VfxBatchMesh } from '../../../../src/rendering/vfx/VfxBatchMesh';
import { getVfxLitGpuProgram } from '../../../../src/rendering/vfx/vfxShaders';

describe('vfx prewarm after device loss', () => {
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null, width: 0, height: 0, style: {} }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('lit particle pipeline: prewarmed before loss, compiled on first visible draw after restore', async () => {
    const rhi = new NullRhiDevice({ swapchainSize: [32, 32] });
    const canvas = { width: 32, height: 32, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 32, height: 32 });
    renderer.prewarmPipelines(vfxPipelineSpecs());
    const created = vi.spyOn(rhi, 'createRenderPipeline');
    const stage = new Container();
    const draw = () => {
      const m = new VfxBatchMesh(8, new Shader({ gpuProgram: getVfxLitGpuProgram(), resources: {} })).mesh as Mesh;
      m.blendMode = 'add';
      const layer = new Container(); layer.addChild(m); stage.addChild(layer);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try { renderer.render({ container: stage }); } catch { /* NullRhi binding validation (after setPipeline) */ }
      err.mockRestore();
      stage.removeChild(layer);
    };
    draw();
    const beforeLoss = created.mock.calls.length;
    await rhi.loseDevice('test', { restore: true });
    await new Promise((r) => setTimeout(r, 20));
    renderer.render({ container: new Container() });
    // reveal gate after restore: resolves immediately (nothing created) — does not cover VFX
    expect(await renderer.pipelinesReady(100)).toBe(true);
    const beforeDraw = created.mock.calls.length;
    draw();
    const labels = created.mock.calls.slice(beforeDraw).map((c) => (c[1] as { label: string }).label);
    console.log('beforeLoss', beforeLoss, 'afterRestore created on first lit draw:', labels);
    expect(beforeLoss).toBe(0);
    expect(labels.length).toBe(0); // fails on the branch: prewarm not replayed after contextChange
    renderer.destroy();
  });
});
