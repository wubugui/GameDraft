import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import * as PIXI from 'pixi.js';

function build(order: 'fm' | 'mf') {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const root = new Container();
  const c = new Container();
  c.addChild(new Sprite(Texture.WHITE));
  const g = new Graphics().rect(0, 0, 8, 8).fill(0xffffff);
  root.addChild(g); root.addChild(c);
  if (order === 'fm') { c.filters = [new AlphaFilter()]; c.mask = g; }
  else { c.mask = g; c.filters = [new AlphaFilter()]; }
  renderer.render({ container: root, target: RenderTexture.create({ width: 64, height: 64 }) });
  const instr = ((renderer as any).states[0].collector.instructions as any[]).map((i) => i.t).filter((t: string) => /Filter|Mask/.test(t));
  return { kinds: c.effects.map((e) => e.kind), renderer, instr };
}

describe('effect priority', () => {
  it('pixi vs engine2d', () => {
    const e1 = build('fm'), e2 = build('mf');
    const px = (o: string) => {
      const pc = new PIXI.Container(); const pg = new PIXI.Graphics().rect(0,0,8,8).fill(0xffffff);
      if (o === 'fm') { pc.filters = [{ enabled: true } as any]; pc.mask = pg; } else { pc.mask = pg; pc.filters = [{ enabled: true } as any]; }
      return pc.effects.map((e: any) => `${e.constructor.name}:${e.priority}`);
    };
    console.log('engine2d filters-then-mask', e1.kinds, 'mask-then-filters', e2.kinds);
    console.log('pixi filters-then-mask', px('fm'), 'mask-then-filters', px('mf'));
    console.log('INSTR fm ' + JSON.stringify(e1.instr)); console.log('INSTR mf ' + JSON.stringify(e2.instr));
    expect(e1.kinds).toEqual(['filters', 'mask']);
    expect(e2.kinds).toEqual(['mask', 'filters']);
    expect(px('fm')[0]).toMatch(/Mask:0/);
  });
});
