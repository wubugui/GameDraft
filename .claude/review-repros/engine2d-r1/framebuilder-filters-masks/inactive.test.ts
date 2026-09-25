import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

function run(hideVia: 'visible' | 'active') {
  const rhi = new NullRhiDevice();
  const canvas = { width: 256, height: 256, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 256, height: 256 });
  const root = new Container();
  const world = new Container();
  root.addChild(world);
  const a = new Sprite(Texture.WHITE); a.width = 16; a.height = 16; a.position.set(10, 10);
  const npc = new Container();
  const b = new Sprite(Texture.WHITE); b.width = 16; b.height = 16; npc.addChild(b); npc.position.set(200, 200);
  world.addChild(a, npc);
  if (hideVia === 'visible') npc.visible = false; else npc.setActive(false);
  world.filters = [new AlphaFilter({ alpha: 0.5 })];
  renderer.render(root);
  const b0 = (renderer as any).states[0].builder.filterStack[0].bounds;
  return [b0.minX, b0.minY, b0.maxX, b0.maxY];
}

describe('filter bounds and inactive children', () => {
  it('compare', () => {
    const vis = run('visible');
    const act = run('active');
    console.log('visible=false', vis, 'setActive(false)', act);
    expect(act).not.toEqual(vis);
  });
});
