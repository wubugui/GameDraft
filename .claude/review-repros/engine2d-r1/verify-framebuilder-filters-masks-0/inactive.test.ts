import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import * as PIXI from 'pixi.js';

function fb(renderer: any) {
  const b = renderer.states[0].builder.filterStack[0].bounds;
  return [b.minX, b.minY, b.maxX, b.maxY];
}

function build(E: any) {
  const root = new E.Container();
  const world = new E.Container();
  root.addChild(world);
  const a = new E.Sprite(E.Texture.WHITE); a.width = 16; a.height = 16; a.position.set(10, 10);
  const npc = new E.Container();
  const b = new E.Sprite(E.Texture.WHITE); b.width = 16; b.height = 16; npc.addChild(b); npc.position.set(100, 100);
  world.addChild(a, npc);
  return { root, world, npc };
}

describe('verify: filter bounds with inactive subtree', () => {
  it('never-active npc', () => {
    const out: any = {};
    for (const mode of ['visible', 'active'] as const) {
      const rhi = new NullRhiDevice();
      const canvas = { width: 256, height: 256, style: {} } as unknown as HTMLCanvasElement;
      const renderer = new WebGPURenderer({ rhi, canvas, width: 256, height: 256 });
      const { root, world, npc } = build({ Container, Sprite, Texture });
      if (mode === 'visible') npc.visible = false; else npc.setActive(false);
      world.filters = [new AlphaFilter({ alpha: 0.5 })];
      renderer.render(root);
      out[mode] = fb(renderer);
    }
    // Pixi reference: master hid via visible=false
    const p = build(PIXI);
    p.npc.visible = false;
    const pb = p.world.getBounds();
    out.pixi = [pb.minX, pb.minY, pb.maxX, pb.maxY];
    console.log('NEVER-ACTIVE', JSON.stringify(out));
    expect(out.visible).toEqual(out.pixi);
    expect(out.active).not.toEqual(out.visible);
  });

  it('active then deactivated, camera moved', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 256, height: 256, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 256, height: 256 });
    const { root, world, npc } = build({ Container, Sprite, Texture });
    world.filters = [new AlphaFilter({ alpha: 0.5 })];
    renderer.render(root);
    const f1 = fb(renderer);
    npc.setActive(false);
    world.position.set(-5, -5); // camera move
    renderer.render(root);
    const f2 = fb(renderer);
    // expected (Pixi, visible=false): sprite a only at world offset
    const p = build(PIXI);

    p.npc.visible = false;
    p.world.position.set(-5, -5);
    const pb = p.world.getBounds();
    console.log('STALE', JSON.stringify({ f1, f2, pixi: [pb.minX, pb.minY, pb.maxX, pb.maxY] }));
    expect(f2).not.toEqual([pb.minX, pb.minY, pb.maxX, pb.maxY]);
  });
});
