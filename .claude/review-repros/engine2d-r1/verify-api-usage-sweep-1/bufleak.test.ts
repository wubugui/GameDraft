/**
 * Verify: geometry.destroy() (no `true`) after mesh.destroy() leaves the vertex/index Buffers in
 * engine2d's GpuBuffers forever, while Pixi 8.17's GCSystem unloads them after gcMaxUnusedTime.
 * Uses the exact EntityShadow destroy order (mesh, shader, geometry).
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, GpuProgram, Shader, Mesh, MeshGeometry, Texture, WebGPURenderer } from '../../../../src/engine2d';
import { Buffer as PixiBuffer, BufferUsage as PixiBufferUsage, GCSystem } from 'pixi.js';
import { GCManagedHash } from '../../../../node_modules/pixi.js/lib/utils/data/GCManagedHash.mjs';

const WGSL = /* wgsl */ `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> @builtin(position) vec4<f32> {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return vec4<f32>((m * vec3<f32>(aPosition + aUV * 0.0, 1.0)).xy, 0.0, 1.0);
}
@fragment fn mainFragment() -> @location(0) vec4<f32> { return localUniforms.uColor; }
`;

describe('geometry.destroy() without true', () => {
  it('engine2d: buffers retained forever (RHI buffers never destroyed)', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 } as any);
    const program = new GpuProgram({ name: 't', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
    const stage = new Container();
    const entries = () => ((renderer as any).buffers.entries as Map<unknown, { buffer: { destroy(): void } }>);
    let baseline = -1;
    const now = vi.spyOn(performance, 'now');
    let t = 0;
    now.mockImplementation(() => t);
    const LIFETIMES = 10;
    for (let i = 0; i < LIFETIMES; i++) {
      // Same shape as PlanarEntityShadow: MeshGeometry{positions,uvs,indices} + custom shader
      const geometry = new MeshGeometry({ positions: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]), uvs: new Float32Array(8), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
      const shader = new Shader({ gpuProgram: program, resources: {} });
      const mesh = new Mesh({ geometry, shader, texture: Texture.WHITE });
      stage.addChild(mesh);
      if (baseline < 0) { baseline = entries().size; }
      renderer.render({ container: stage });
      if (i === 0) baseline = entries().size - geometry.buffers.length;
      mesh.destroy();
      shader.destroy();
      geometry.destroy();
      t += 120_000; // 2 minutes per "scene"; Pixi would have GC'd by now
    }
    for (let k = 0; k < 5; k++) { t += 60_000; renderer.render({ container: stage }); }
    const leaked = entries().size - baseline;
    console.log('[engine2d] baseline entries', baseline, 'entries after', LIFETIMES, 'lifetimes:', entries().size, 'leaked:', leaked);
    expect(leaked).toBe(LIFETIMES * 3);
    now.mockRestore();
  });

  it('pixi 8.17: GCSystem unloads unused buffers from GlBufferSystem-style GCManagedHash', () => {
    // Minimal renderer stub for GCSystem + GCManagedHash (exact code GlBufferSystem uses)
    const repeats: Array<() => void> = [];
    const renderer: any = { uid: 1, tick: 0, scheduler: { repeat: (fn: () => void) => { repeats.push(fn); return repeats.length; }, cancel() {} } };
    let t = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const gc = new GCSystem(renderer);
    renderer.gc = gc;
    gc.init({});
    const managed = new GCManagedHash({ renderer, type: 'resource', onUnload: () => {}, name: 'glBuffer' });
    const gpuDestroyed = vi.fn();
    const LIFETIMES = 10;
    for (let i = 0; i < LIFETIMES; i++) {
      for (let j = 0; j < 3; j++) {
        const buf = new PixiBuffer({ data: new Float32Array(8), usage: PixiBufferUsage.VERTEX | PixiBufferUsage.COPY_DST });
        // GlBufferSystem.createGLBuffer: buffer._gpuData[uid] = glBuffer; _managedBuffers.add(buffer)
        (buf as any)._gpuData[renderer.uid] = { destroy: gpuDestroyed };
        managed.add(buf);
        (buf as any)._gcLastUsed = gc.now; // getGlBuffer stamps the use
      }
      t += 120_000;
      gc.now = t;
      // scheduler fires _ready, postrender runs GC
      repeats[0]();
      gc.postrender();
    }
    const live = Object.values(managed.items).filter(Boolean).length;
    console.log('[pixi] live glBuffers after', LIFETIMES, 'lifetimes:', live, 'gpu buffers destroyed:', gpuDestroyed.mock.calls.length);
    expect(live).toBe(0);
    expect(gpuDestroyed).toHaveBeenCalledTimes(LIFETIMES * 3);
    now.mockRestore();
  });
});
