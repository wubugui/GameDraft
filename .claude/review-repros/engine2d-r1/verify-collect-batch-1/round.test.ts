import { describe, expect, it, vi } from 'vitest';
import * as P from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

/** Pixi 8.17: drive SpritePipe.addRenderable exactly as instruction building does, pack with DefaultBatcher. */
function pixiRoundBits(frames: boolean[]): number[] {
  const captured: any[] = [];
  const renderer = { uid: 3, _roundPixels: 0, renderPipes: { batch: { addToBatch: (e: any) => captured.push(e) } } };
  const pipe = new P.SpritePipe(renderer as never);
  const spr = new P.Sprite(P.Texture.WHITE);
  const batcher = Object.create(P.DefaultBatcher.prototype);
  const out: number[] = [];
  for (const rp of frames) {
    spr.roundPixels = rp;
    spr.didViewUpdate = true; // force the update path too
    pipe.addRenderable(spr, {} as never);
    const el = captured[captured.length - 1];
    const f32 = new Float32Array(24);
    const u32 = new Uint32Array(f32.buffer);
    batcher.packQuadAttributes(el, f32, u32, 0, 0);
    out.push(u32[5] & 0xffff);
  }
  return out;
}

function engine2dRoundBits(frames: boolean[]): number[] {
  const rhi = new NullRhiDevice();
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const writes: Uint32Array[] = [];
  const origWrite = rhi.writeBuffer.bind(rhi);
  vi.spyOn(rhi, 'writeBuffer').mockImplementation((b: any, data: ArrayBufferView, off?: number) => {
    if (/vert|attr|batch/i.test(String(b.label))) writes.push(new Uint32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    return origWrite(b, data, off);
  });
  const origCreate = rhi.createBuffer.bind(rhi);
  vi.spyOn(rhi, 'createBuffer').mockImplementation((s: any, d: any) => {
    if (d.data && /vert|attr|batch/i.test(String(d.label))) writes.push(new Uint32Array(d.data.buffer.slice(d.data.byteOffset, d.data.byteOffset + d.data.byteLength)));
    return origCreate(s, d);
  });
  const root = new Container();
  const spr = new Sprite(Texture.WHITE);
  root.addChild(spr);
  const out: number[] = [];
  for (const rp of frames) {
    spr.roundPixels = rp;
    const n = writes.length;
    renderer.render({ container: root });
    const w = writes.slice(n).find((a) => a.length >= 24);
    out.push(w ? w[5] & 0xffff : -1);
  }
  renderer.destroy();
  return out;
}

describe('roundPixels toggled after first render', () => {
  it('Pixi 8.17 latches first value; engine2d follows live value', () => {
    const seq = [false, true, true];
    const pixi = pixiRoundBits(seq);
    const e2d = engine2dRoundBits(seq);
    console.log('pixi', pixi, 'engine2d', e2d);
    expect(pixi).toEqual([0, 0, 0]);
    expect(e2d).toEqual([0, 1, 1]);
  });
  it('first value true -> Pixi keeps 1 after set false', () => {
    const seq = [true, false];
    const pixi = pixiRoundBits(seq);
    const e2d = engine2dRoundBits(seq);
    console.log('pixi', pixi, 'engine2d', e2d);
    expect(pixi).toEqual([1, 1]);
    expect(e2d).toEqual([1, 0]);
  });
});
