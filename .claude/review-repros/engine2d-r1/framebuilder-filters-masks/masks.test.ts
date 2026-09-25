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

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  return { rhi, renderer };
}
const cmds = (r: WebGPURenderer) => (r as any).states[0].builder.commands as any[];

describe('masks', () => {
  it('inverse mask pop leaves subsequent siblings in inverse stencil mode', () => {
    const { renderer } = setup();
    const root = new Container();
    const masked = new Sprite(Texture.WHITE);
    masked.width = 32; masked.height = 32;
    const g = new Graphics().rect(0, 0, 16, 16).fill(0xffffff);
    root.addChild(g);
    masked.setMask({ mask: g, inverse: true });
    root.addChild(masked);
    const after = new Sprite(Texture.WHITE);
    after.position.set(40, 40);
    root.addChild(after);
    renderer.render({ container: root, target: RenderTexture.create({ width: 64, height: 64 }) });
    const draws = cmds(renderer).filter((c) => c.t === 'draw');
    const summary = draws.map((d) => `${d.pipeline.stencil}/${d.stencilRef}/cm${d.pipeline.colorMask}`);
    console.log(summary);
    const lastDraw = draws[draws.length - 1];
    expect(lastDraw.pipeline.stencil).toBe('inverse');
    expect(lastDraw.stencilRef).toBe(0);
  });

  it('effect order: filters set before mask', () => {
    const c = new Container();
    const g = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    c.filters = [new AlphaFilter()];
    c.mask = g;
    console.log('engine2d effects', c.effects.map((e) => e.kind));
    const pc = new PIXI.Container();
    const pg = new PIXI.Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    pc.filters = [{ enabled: true } as any];
    pc.mask = pg;
    console.log('pixi effects', pc.effects.map((e: any) => e.pipe));
    expect(c.effects[0].kind).toBe('filters');
    expect((pc.effects[0] as any).pipe).toBe('stencilMask');
  });
});
