import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { FrameBuilder } from '../../../../src/engine2d/gpu/FrameBuilder';
import { Mesh } from '../../../../src/engine2d/mesh/Mesh';
import { PlaneGeometry } from '../../../../src/engine2d/mesh/MeshGeometry';
import { BufferImageSource, Texture, Rectangle, RenderTexture } from '../../../../src/engine2d';

describe('unbatched default mesh texture matrix', () => {
  it('trimmed full-frame texture', () => {
    // engine2d
    const src = new BufferImageSource({ resource: new Uint8Array(16 * 16 * 4), width: 16, height: 16 });
    const tex = new Texture({ source: src, frame: new Rectangle(0, 0, 16, 16), orig: new Rectangle(0, 0, 20, 20), trim: new Rectangle(2, 2, 16, 16) });
    const tm = tex.textureMatrix; tm.update();
    // pixi
    const psrc = new PIXI.BufferImageSource({ resource: new Uint8Array(16 * 16 * 4), width: 16, height: 16 });
    const ptex = new PIXI.Texture({ source: psrc, frame: new PIXI.Rectangle(0, 0, 16, 16), orig: new PIXI.Rectangle(0, 0, 20, 20), trim: new PIXI.Rectangle(2, 2, 16, 16) });
    const ptm = ptex.textureMatrix; ptm.update();
    console.log('engine2d isSimple', tm.isSimple, 'mapCoord', tm.mapCoord.a, tm.mapCoord.d, tm.mapCoord.tx, tm.mapCoord.ty);
    console.log('pixi     isSimple', ptm.isSimple, 'mapCoord', ptm.mapCoord.a, ptm.mapCoord.d, ptm.mapCoord.tx, ptm.mapCoord.ty);

    const captured: unknown[] = [];
    const orig = (FrameBuilder.prototype as any).writeUbo;
    vi.spyOn(FrameBuilder.prototype as any, 'writeUbo').mockImplementation(function (this: unknown, layout: unknown, values: Record<string, unknown>) {
      if ('uTextureMatrix' in values) captured.push(values.uTextureMatrix);
      return orig.call(this, layout, values);
    });
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const geometry = new PlaneGeometry({ width: 16, height: 16, verticesX: 11, verticesY: 11 });
    const mesh = new Mesh({ geometry, texture: tex });
    console.log('batched', mesh.batched, 'verts', geometry.positions.length / 2);
    const rt = RenderTexture.create({ width: 8, height: 8 });
    renderer.render({ container: mesh, target: rt });
    const m = captured[0] as any;
    console.log('bound uTextureMatrix', m.a, m.d, m.tx, m.ty);
    // Pixi binds ptm.mapCoord
    expect([m.a, m.d, m.tx, m.ty]).toEqual([ptm.mapCoord.a, ptm.mapCoord.d, ptm.mapCoord.tx, ptm.mapCoord.ty]);
    renderer.destroy();
  });
});
