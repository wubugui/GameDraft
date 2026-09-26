import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Container, Graphics, Shader, DOMAdapter, type BlendMode } from '../../../../src/engine2d';
import { vfxPipelineSpecs } from '../../../../src/rendering/vfx/VfxRenderer';
import { VfxBatchMesh } from '../../../../src/rendering/vfx/VfxBatchMesh';
import { VfxPlateBatchMesh } from '../../../../src/rendering/vfx/VfxPlateBatchMesh';
import { VfxBoltBatchMesh } from '../../../../src/rendering/vfx/VfxBoltBatchMesh';
import { createVfxBeamGeometry } from '../../../../src/rendering/vfx/VfxBeamView';
import { Mesh } from '../../../../src/engine2d';
import { getVfxBeamGpuProgram } from '../../../../src/rendering/vfx/vfxBeamShaders';
import { getVfxBoltGpuProgram, getVfxLitGpuProgram, getVfxPlateLitGpuProgram, getVfxUnlitGpuProgram } from '../../../../src/rendering/vfx/vfxShaders';

describe('vfx prewarm covers every game draw variant', () => {
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null, width: 0, height: 0, style: {} }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it.each([false, true])('no new pipeline on first draw (mask used before=%s)', (masked) => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64, antialias: false });
    const created = vi.spyOn(rhi, 'createRenderPipeline');
    renderer.prewarmPipelines(vfxPipelineSpecs());
    const stage = new Container();
    if (masked) {
      const ui = new Container();
      const body = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
      const mask = new Graphics().rect(0, 0, 2, 2).fill(0xffffff);
      ui.addChild(body, mask); body.mask = mask; stage.addChild(ui);
      renderer.render({ container: stage });
      stage.removeChild(ui);
      renderer.render({ container: stage });
    }
    const before = created.mock.calls.length;
    const sh = (p: any) => new Shader({ gpuProgram: p, resources: {} });
    const meshes: Array<[Mesh, BlendMode]> = [];
    for (const b of ['normal', 'add'] as BlendMode[]) {
      meshes.push([new VfxBatchMesh(64, sh(getVfxUnlitGpuProgram())).mesh as Mesh, b]);
      meshes.push([new VfxBatchMesh(64, sh(getVfxLitGpuProgram())).mesh as Mesh, b]);
      meshes.push([new VfxPlateBatchMesh(64, 4, sh(getVfxUnlitGpuProgram())).mesh as Mesh, b]);
      meshes.push([new VfxPlateBatchMesh(64, 4, sh(getVfxPlateLitGpuProgram())).mesh as Mesh, b]);
    }
    meshes.push([new VfxBoltBatchMesh(256, sh(getVfxBoltGpuProgram())).mesh as Mesh, 'add']);
    if (process.env.PF_SANITY) meshes.push([new VfxBatchMesh(64, sh(getVfxLitGpuProgram())).mesh as Mesh, "multiply" as BlendMode]);
    for (const b of ["add", "screen", "normal"] as BlendMode[]) meshes.push([new Mesh({ geometry: createVfxBeamGeometry(), shader: sh(getVfxBeamGpuProgram()) }), b]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [m, b] of meshes) {
      const layer = new Container();
      m.blendMode = b; layer.addChild(m); stage.addChild(layer);
      try { renderer.render({ container: stage }); } catch { /* NullRhi binding validation after setPipeline */ }
      stage.removeChild(layer);
    }
    err.mockRestore();
    const newOnes = created.mock.calls.slice(before).map((c) => (c[1] as any).label);
    console.log('TOTAL', created.mock.calls.length, 'before', before, created.mock.calls.map((c) => (c[1] as any).label).join(' | '));
    expect(newOnes).toEqual([]);
    renderer.destroy();
  });
});
