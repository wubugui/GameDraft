import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiBuffer } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Mesh, MeshGeometry, Shader } from '../../../../src/engine2d';
// Pixi side: the exact GC machinery master uses (GlBufferSystem registers every GL buffer in a GCManagedHash)
import { Buffer as PixiBuffer, BufferUsage as PixiBufferUsage, GCSystem, GCManagedHash } from 'pixi.js';

const WGSL = `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> };
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 };
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VSOut { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOut {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return VSOut(vec4((m * vec3(aPosition, 1.0)).xy, 0.0, 1.0), aUV);
}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> { return vec4(uv, 0.0, 1.0); }
`;

function run(destroyBuffers: boolean, advanceMs: number) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const created: RhiBuffer[] = [];
  const orig = rhi.createBuffer.bind(rhi);
  vi.spyOn(rhi, 'createBuffer').mockImplementation((s, d) => { const b = orig(s, d); created.push(b); return b; });
  let t = 1000;
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => t);
  const cycles = 5;
  for (let i = 0; i < cycles; i++) {
    // same shape as breathingOverlayMesh.ts / LitBackground.ts / EntityShadow.ts
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({ gpu: { vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } }, resources: {} } as never);
    const mesh = new Mesh({ geometry, shader });
    const root = new Container();
    root.addChild(mesh);
    renderer.render({ container: root });
    mesh.destroy();
    geometry.destroy(destroyBuffers);
    shader.destroy();
    root.destroy();
  }
  // keep rendering an empty stage for advanceMs (Pixi's GC would run in postrender every 30s)
  const empty = new Container();
  for (let ms = 0; ms < advanceMs; ms += 1000) { t += 1000; renderer.render({ container: empty }); }
  const geo = created.filter((b) => !/engine2d-(batch|uniforms)/.test(b.label));
  const alive = geo.filter((b) => !b.destroyed).length;
  renderer.destroy();
  nowSpy.mockRestore();
  return { created: geo.length, alive, labels: geo.map((b) => b.label) };
}

describe('verify: GpuBuffers never reclaims geometry buffers', () => {
  it('engine2d: mesh.destroy()+geometry.destroy() (game pattern) leaves RHI buffers alive even after 120s of frames', () => {
    const r = run(false, 120_000);
    console.log('engine2d geometry.destroy()', r);
    expect(r.created).toBe(15);
    expect(r.alive).toBe(15); // leak: nothing ever frees them
  });
  it('engine2d: geometry.destroy(true) frees them (fix path works)', () => {
    const r = run(true, 0);
    console.log('engine2d geometry.destroy(true)', r);
    expect(r.alive).toBe(0);
  });
  it('pixi 8.17 (master): GCManagedHash + GCSystem unload an unused buffer after gcMaxUnusedTime', () => {
    let t = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const scheduler = { repeat: () => 1, cancel: () => {} };
    const renderer: any = { uid: 7, scheduler };
    const gc = new (GCSystem as any)(renderer);
    renderer.gc = gc;
    gc.init({}); // defaults: gcActive true, 60s, 30s
    expect(gc.enabled).toBe(true);
    const unloaded: number[] = [];
    const hash = new (GCManagedHash as any)({ renderer, type: 'resource', name: 'glBuffer', onUnload: (b: any) => unloaded.push(b.uid) });
    const buf = new PixiBuffer({ data: new Float32Array(8), usage: PixiBufferUsage.VERTEX });
    const gpuData = { destroy: vi.fn() };
    (buf as any)._gpuData[renderer.uid] = gpuData; // what GlBufferSystem.createGLBuffer stores
    hash.add(buf); // GlBufferSystem.createGLBuffer -> _managedBuffers.add
    expect(buf.autoGarbageCollect).toBe(true);
    t += 30_000; gc.now = t; gc.run();
    expect(gpuData.destroy).not.toHaveBeenCalled();
    t += 40_000; gc.now = t; gc.run(); // 70s since last use > 60s
    console.log('pixi unloaded', unloaded, 'gl buffer destroyed', gpuData.destroy.mock.calls.length, 'hash slot', hash.items[buf.uid]);
    expect(gpuData.destroy).toHaveBeenCalledTimes(1);
    expect(hash.items[buf.uid]).toBeNull();
    nowSpy.mockRestore();
  });
});
