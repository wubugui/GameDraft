import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { SpritePipe } from 'pixi.js';

function renderSprite(rendererRound: boolean, spriteRound: boolean) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64, roundPixels: rendererRound } as any);
  const writes: Uint8Array[] = [];
  const spy = vi.spyOn(rhi, 'writeBuffer').mockImplementation(function (this: any, b: any, data: ArrayBufferView, off = 0) {
    writes.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    (b as any).bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), off);
  });
  const root = new Container();
  const s = new Sprite(Texture.WHITE);
  s.x = 10.3; s.y = 5.7; s.roundPixels = spriteRound;
  root.addChild(s);
  renderer.render({ container: root });
  // find vertex data: first float == 10.3 (x0 = tx + 0)
  let flag: number | undefined;
  for (const w of writes) {
    if (w.byteLength % 4) continue;
    const f = new Float32Array(w.buffer, w.byteOffset, w.byteLength / 4);
    const u = new Uint32Array(w.buffer, w.byteOffset, w.byteLength / 4);
    for (let i = 0; i + 5 < f.length; i++) {
      if (Math.abs(f[i] - 10.3) < 1e-4 && Math.abs(f[i + 1] - 5.7) < 1e-4) { flag = u[i + 5] & 0xffff; break; }
    }
    if (flag !== undefined) break;
  }
  spy.mockRestore();
  renderer.destroy();
  return flag;
}

describe('renderer-level roundPixels on batched sprite', () => {
  it('engine2d vs pixi', () => {
    const e2d = {
      rOff_sOff: renderSprite(false, false),
      rOn_sOff: renderSprite(true, false),
      rOff_sOn: renderSprite(false, true),
    };
    // Pixi: SpritePipe._initGPUSprite
    const pipeSrc = SpritePipe.prototype['_initGPUSprite'].toString();
    const fakeRenderer = { _roundPixels: 1 } as any;
    const pipe = Object.create(SpritePipe.prototype);
    pipe._renderer = fakeRenderer;
    pipe._gpuSpriteHash = Object.create(null);
    const pixiSprite = { texture: { _source: {} }, _roundPixels: 0, uid: 1, on() {}, _gpuData: Object.create(null) } as any;
    let pixiFlag: number | undefined;
    try { const b = pipe._initGPUSprite(pixiSprite); pixiFlag = b.roundPixels; } catch (e) { pixiFlag = (e as Error).message as any; }
    console.log('engine2d flags', e2d, 'pixi rOn_sOff', pixiFlag, pipeSrc.split('\n').filter((l: string) => l.includes('roundPixels')).join('|'));
    expect(e2d.rOff_sOn).toBe(1);
    expect(pixiFlag).toBe(1);
    expect(e2d.rOn_sOff).toBe(0); // divergence: pixi would be 1
  });
});
