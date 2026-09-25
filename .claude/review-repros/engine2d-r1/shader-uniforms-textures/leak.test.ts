import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Mesh } from '../../../../src/engine2d/mesh/Mesh';
import { MeshGeometry } from '../../../../src/engine2d/mesh/MeshGeometry';
import { Shader } from '../../../../src/engine2d/shader/Shader';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

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

describe('geometry destroy() without buffers', () => {
  it('leaks RHI buffers per destroyed mesh (EntityShadow pattern)', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const created: { label: string; destroyed: boolean; destroy: () => void }[] = [];
    const orig = rhi.createBuffer.bind(rhi);
    vi.spyOn(rhi, 'createBuffer').mockImplementation((scope, desc) => {
      const b = orig(scope, desc) as any;
      const rec = { label: desc.label ?? '', destroyed: false, destroy: () => {} };
      const d = b.destroy.bind(b);
      b.destroy = () => { rec.destroyed = true; d(); };
      created.push(rec);
      return b;
    });
    const rt = RenderTexture.create({ width: 8, height: 8 });
    for (let scene = 0; scene < 5; scene++) {
      const root = new Container();
      const g = new MeshGeometry({ positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), uvs: new Float32Array(8), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
      const sh = Shader.from({ gpu: { vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } }, resources: {} });
      const m = new Mesh({ geometry: g, shader: sh, texture: Texture.WHITE });
      root.addChild(m);
      renderer.render({ container: root, target: rt });
      // EntityShadow.destroy(): mesh.destroy(); shader.destroy(); geometry.destroy();
      m.destroy(); sh.destroy(); g.destroy();
    }
    const live = created.filter((c) => !c.destroyed && /engine2d-buffer|attribute|index/.test(c.label));
    console.log('live geometry buffers after 5 scenes:', live.length, live.map((l) => l.label));
    expect(live.length).toBe(15);
    renderer.destroy();
  });
});
