import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

// Pixi 8.17: real SpritePipe + real DefaultBatcher.packQuadAttributes -> round bit in vertex word 5
function pixiRoundBits(): number[] {
  const out: number[] = [];
  const pack = (el: any) => {
    const f32 = new Float32Array(24); const u32 = new Uint32Array(f32.buffer);
    (PIXI as any).DefaultBatcher.prototype.packQuadAttributes.call({}, el, f32, u32, 0, 0);
    out.push(u32[5] & 0xffff);
  };
  const renderer: any = { uid: 7, _roundPixels: 0, renderPipes: { batch: { addToBatch: (el: any) => { el._batcher = { updateElement: pack }; pack(el); } } } };
  const pipe = new (PIXI as any).SpritePipe(renderer);
  const s = new PIXI.Sprite(new PIXI.Texture({ source: new PIXI.TextureSource({ width: 8, height: 8 }) }));
  s.position.set(0.3, 0.3);
  pipe.addRenderable(s, {});           // frame 1 (scene loading)
  s.roundPixels = true;                // syncEntityPixelDensityMatch
  s.didViewUpdate = true;
  pipe.addRenderable(s, {});           // frame 2 (rebuild path)
  pipe.updateRenderable(s);            // frame 3 (no-rebuild path; updateElement -> packs again)
  return out;
}

function engineRoundBits(): number[] {
  const rhi = new NullRhiDevice();
  const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
  const writes: Uint32Array[] = [];
  const wb = vi.spyOn(rhi, 'writeBuffer').mockImplementation(function (this: any, b: any, d: ArrayBufferView, o?: number) {
    writes.push(new Uint32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)));
    return (NullRhiDevice.prototype.writeBuffer as any).call(this, b, d, o);
  });
  const root = new Container();
  const s = new Sprite(new Texture({ source: new TextureSource({ width: 8, height: 8 }) }));
  s.position.set(0.3, 0.3);
  root.addChild(s);
  const bits: number[] = [];
  const frame = () => {
    writes.length = 0;
    renderer.render({ container: root });
    // find vertex buffer: 4 verts * 6 words; word 5 of vertex 0 holds textureId<<16|round
    const vb = writes.find((w) => w.length >= 24 && new Float32Array(w.buffer)[0] === 0.30000001192092896);
    bits.push(vb ? vb[5] & 0xffff : -1);
  };
  frame();
  s.roundPixels = true;
  frame();
  frame();
  wb.mockRestore();
  renderer.destroy();
  return bits;
}

describe('roundPixels toggled after first render', () => {
  it('pixi keeps first-render value; engine2d follows toggle', () => {
    const p = pixiRoundBits();
    const e = engineRoundBits();
    console.log('pixi round bits', p, 'engine2d round bits', e);
    expect(p).toEqual([0, 0, 0]);
    expect(e).toEqual([0, 1, 1]);
  });
});
