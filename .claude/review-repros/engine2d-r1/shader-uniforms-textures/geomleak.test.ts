import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Mesh } from '../../../../src/engine2d/mesh/Mesh';
import { MeshGeometry } from '../../../../src/engine2d/mesh/MeshGeometry';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { MeshGeometry as PMeshGeometry } from 'pixi.js';

describe('geometry.destroy() without destroyBuffers', () => {
  it('pixi destroys the index buffer; engine2d keeps all GPU buffers alive', () => {
    const pg = new PMeshGeometry({ positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
    const pIdx = pg.indexBuffer;
    pg.destroy();
    console.log('pixi indexBuffer.destroyed after geometry.destroy():', (pIdx as any).destroyed, 'data', (pIdx as any).data);

    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const root = new Container();
    for (let scene = 0; scene < 3; scene++) {
      // many vertices so the mesh is NOT batched: (> 100 verts) -> custom path uses geometry buffers
      const n = 120;
      const g = new MeshGeometry({ positions: new Float32Array(n * 2), uvs: new Float32Array(n * 2), indices: new Uint32Array((n - 2) * 3) });
      const m = new Mesh({ geometry: g, texture: Texture.WHITE });
      root.addChild(m);
      renderer.render({ container: root });
      root.removeChild(m);
      m.destroy();
      g.destroy();
      renderer.render({ container: root });
    }
    const created = rhi.log.filter((l) => /create buffer (attribute-mesh|index-mesh)/.test(l)).length;
    const released = rhi.log.filter((l) => /release buffer (attribute-mesh|index-mesh)/.test(l)).length;
    console.log('created', created, 'released', released);
    expect(released).toBe(0);
    renderer.destroy();
  });
});
