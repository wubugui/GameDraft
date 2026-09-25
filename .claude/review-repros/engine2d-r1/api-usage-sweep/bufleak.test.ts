import { describe, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, GpuProgram, Shader, Mesh, MeshGeometry, Texture, WebGPURenderer } from '../../../../src/engine2d';

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
describe('mesh geometry.destroy() without true', () => {
  it('GPU buffers retained', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 } as any);
    const program = new GpuProgram({ name: 't', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
    const stage = new Container();
    const destroyed = vi.fn();
    for (let i = 0; i < 10; i++) {
      // 照 EntityShadow:每个实体一份 MeshGeometry + 自定义 shader;场景卸载时 mesh.destroy() + geometry.destroy()
      const geometry = new MeshGeometry({ positions: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]), uvs: new Float32Array(8), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
      const shader = new Shader({ gpuProgram: program, resources: {} });
      const mesh = new Mesh({ geometry, shader, texture: Texture.WHITE });
      stage.addChild(mesh);
      renderer.render({ container: stage });
      mesh.destroy();
      shader.destroy();
      geometry.destroy();
    }
    renderer.render({ container: stage });
    console.log('GpuBuffers entries after 10 entity lifetimes:', ((renderer as any).buffers.entries as Map<unknown, unknown>).size);
  });
});
