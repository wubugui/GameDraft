import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiBuffer, RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Mesh, MeshGeometry, Shader } from '../../../../src/engine2d';

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

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  return { rhi, renderer };
}

describe('renderer-resources', () => {
  it('autoGenerateMipmaps: GPU texture gets a mip chain?', () => {
    const { rhi, renderer } = setup();
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const src = new BufferImageSource({ resource: new Uint8Array(64 * 64 * 4), width: 64, height: 64, format: 'rgba8unorm' } as never);
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const root = new Container();
    const sp = new Sprite(new Texture({ source: src }));
    sp.scale.set(0.25);
    root.addChild(sp);
    renderer.render({ container: root });
    const descs = createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((d) => d.width === 64);
    console.log('mip descs', descs.map((d) => ({ w: d.width, mipLevels: d.mipLevels })), 'src.mipLevelCount', src.mipLevelCount);
    renderer.destroy();
  });

  it('custom-shader mesh buffers after mesh.destroy()+geometry.destroy()', () => {
    const { rhi, renderer } = setup();
    const created: RhiBuffer[] = [];
    const orig = rhi.createBuffer.bind(rhi);
    vi.spyOn(rhi, 'createBuffer').mockImplementation((s, d) => { const b = orig(s, d); created.push(b); return b; });
    for (let i = 0; i < 5; i++) {
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
      geometry.destroy();
      shader.destroy();
      root.destroy();
    }
    const geo = created.filter((b) => !/engine2d-(batch|uniforms)/.test(b.label));
    console.log('geometry rhi buffers created', geo.length, 'alive', geo.filter((b) => !b.destroyed).length, geo.map((b) => b.label));
    renderer.destroy();
  });

  it('RT resize cycles: unload/destroy listeners accumulate?', () => {
    const { renderer } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8 });
    const root = new Container();
    root.addChild(new Sprite(Texture.WHITE));
    for (let i = 0; i < 10; i++) {
      rt.resize(8 + i, 8 + i);
      renderer.render({ container: root, target: rt });
    }
    console.log('unload listeners', rt.source.listenerCount('unload'), 'destroy listeners', rt.source.listenerCount('destroy'));
    renderer.destroy();
  });
});
