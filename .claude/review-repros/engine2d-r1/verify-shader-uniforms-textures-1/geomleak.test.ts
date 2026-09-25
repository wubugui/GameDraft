import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Mesh } from '../../../../src/engine2d/mesh/Mesh';
import { MeshGeometry } from '../../../../src/engine2d/mesh/MeshGeometry';
import { Shader } from '../../../../src/engine2d/shader/Shader';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { MeshGeometry as PixiMeshGeometry, Buffer as PixiBuffer, BufferUsage as PixiBufferUsage, GCSystem } from 'pixi.js';
// GCManagedHash is not re-exported at top level in every build; import the module directly
// @ts-ignore
import { GCManagedHash } from '../../../../node_modules/pixi.js/lib/utils/data/GCManagedHash.mjs';

const WGSL = `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> };
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 };
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VSOutput { @builtin(position) position: vec4<f32>, @location(0) vUV: vec2<f32> };
@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
  var o: VSOutput; o.position = vec4<f32>(aPosition, 0.0, 1.0); o.vUV = aUV; return o;
}
@fragment
fn mainFragment(i: VSOutput) -> @location(0) vec4<f32> { return vec4<f32>(i.vUV, 0.0, 1.0); }
`;

const quad = () => ({ positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), uvs: new Float32Array(8), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });

describe('A: Geometry.destroy() index buffer', () => {
  it('Pixi destroys indexBuffer; engine2d does not', () => {
    const pg = new PixiMeshGeometry(quad());
    const pIdx = pg.indexBuffer;
    pg.destroy();
    const eg = new MeshGeometry(quad());
    const eIdx = eg.indexBuffer!;
    let eDestroyed = false; eIdx.once('destroy', () => { eDestroyed = true; });
    eg.destroy();
    console.log('pixi indexBuffer.destroyed =', pIdx.destroyed, ' engine2d indexBuffer destroyed =', eDestroyed);
    expect(pIdx.destroyed).toBe(true);
    expect(eDestroyed).toBe(false);
  });
});

describe('B: Pixi GCManagedHash frees idle buffers after 60 s (master mechanism)', () => {
  it('unloads gpu data of an abandoned buffer', () => {
    let t = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const renderer: any = { uid: 7, scheduler: { repeat: (_f: () => void) => 1, cancel: () => {} } };
    const gc = new (GCSystem as any)(renderer);
    renderer.gc = gc;
    gc.init({}); // defaults: gcActive true, 60000 ms
    const hash = new GCManagedHash({ renderer, type: 'resource', onUnload: () => {}, name: 'glBuffer' });
    const buf = new PixiBuffer({ data: new Float32Array(8), usage: PixiBufferUsage.VERTEX });
    let gpuFreed = false;
    buf._gpuData[7] = { destroy: () => { gpuFreed = true; } };
    hash.add(buf);
    t += 61000; gc.now = t;
    gc.run();
    console.log('pixi: after 61 s idle gpuData destroyed =', gpuFreed, ' still in hash =', !!hash.items[buf.uid]);
    expect(gpuFreed).toBe(true);
    expect(hash.items[buf.uid]).toBeFalsy();
    spy.mockRestore();
  });
});

describe('C: engine2d keeps RHI buffers of destroyed geometries forever', () => {
  it('EntityShadow / LitSpriteQuad teardown patterns', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const created: { label: string; destroyed: boolean }[] = [];
    const orig = rhi.createBuffer.bind(rhi);
    vi.spyOn(rhi, 'createBuffer').mockImplementation((scope: any, desc: any) => {
      const b = orig(scope, desc) as any;
      const rec = { label: desc.label ?? '', destroyed: false };
      const d = b.destroy.bind(b);
      b.destroy = () => { rec.destroyed = true; d(); };
      created.push(rec);
      return b;
    });
    const rt = RenderTexture.create({ width: 8, height: 8 });
    const baseline = () => created.filter((c) => !c.destroyed).length;
    const empty = new Container();
    renderer.render({ container: empty, target: rt });
    const b0 = baseline();
    for (let scene = 0; scene < 5; scene++) {
      const root = new Container();
      // EntityShadow pattern: mesh.destroy(); shader.destroy(); geometry.destroy()
      const g = new MeshGeometry(quad());
      const sh = Shader.from({ gpu: { vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } }, resources: {} });
      const m = new Mesh({ geometry: g, shader: sh, texture: Texture.WHITE });
      // LitSpriteQuad pattern: only mesh.destroy()
      const g2 = new MeshGeometry(quad());
      const m2 = new Mesh({ geometry: g2, shader: sh, texture: Texture.WHITE });
      root.addChild(m, m2);
      renderer.render({ container: root, target: rt });
      m.destroy(); sh.destroy(); g.destroy();
      m2.removeFromParent(); m2.destroy();
    }
    // many more frames of an empty scene (engine2d has no idle-time GC at all)
    for (let i = 0; i < 100; i++) renderer.render({ container: empty, target: rt });
    const live = baseline() - b0;
    const entries = (renderer as any).buffers.entries.size;
    console.log(created.filter(c=>!c.destroyed).map(c=>c.label).join(','));console.log('engine2d: live geometry RHI buffers after 5 teardowns =', live, ' GpuBuffers.entries.size =', entries);
    expect(live).toBe(30);
    renderer.destroy();
  });
});
