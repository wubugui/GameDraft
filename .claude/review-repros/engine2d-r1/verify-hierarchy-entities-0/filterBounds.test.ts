import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import * as PIXI from 'pixi.js';

function run(hide: 'visible' | 'active' | 'none', moveAfterHide = false) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 128, height: 128, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 128, height: 128 });
  const root = new Container();
  const layer = new Container();
  root.addChild(layer);
  const a = new Sprite(Texture.WHITE); a.width = 4; a.height = 4;
  const npc = new Container(); npc.position.set(40, 40);
  const b = new Sprite(Texture.WHITE); b.width = 4; b.height = 4;
  npc.addChild(b);
  layer.addChild(a, npc);
  renderer.render({ container: root });
  if (hide === 'visible') npc.visible = false; else if (hide === 'active') npc.setActive(false);
  if (moveAfterHide) npc.position.set(100, 100);
  const f = new AlphaFilter({ alpha: 0.5 }); f.padding = 0;
  layer.filters = [f];
  const spy = vi.spyOn(rhi, 'createTexture');
  renderer.render({ container: root });
  const sizes = spy.mock.calls.map((c) => c[1] as RhiTextureDesc).map((d) => `${d.width}x${d.height}`);
  renderer.destroy();
  return sizes;
}

// Pixi reference: the same traversal Pixi's FilterSystem uses (getFastGlobalBounds -> _getGlobalBoundsRecursive)
function pixiBounds(hide: boolean) {
  const root = new PIXI.Container({ isRenderGroup: true });
  const layer = new PIXI.Container(); root.addChild(layer);
  const a = new PIXI.Sprite(PIXI.Texture.WHITE); a.width = 4; a.height = 4;
  const npc = new PIXI.Container(); npc.position.set(40, 40);
  const b = new PIXI.Sprite(PIXI.Texture.WHITE); b.width = 4; b.height = 4;
  npc.addChild(b); layer.addChild(a, npc);
  if (hide) npc.visible = false;
  (PIXI as any).updateRenderGroupTransforms(root.renderGroup, true);
  const bb = layer.getFastGlobalBounds(true);
  return [bb.minX, bb.minY, bb.maxX, bb.maxY];
}

describe('filter bounds with hidden child', () => {
  it('compare', () => {
    const none = run('none');
    const v = run('visible');
    const act = run('active');
    const actMoved = run('active', true);
    console.log('shown ->', none, ' visible=false ->', v, ' setActive(false) ->', act, ' setActive(false)+moved ->', actMoved);
    console.log('pixi fast bounds shown', pixiBounds(false), 'hidden', pixiBounds(true));
    expect(act).toEqual(v);
  });
});
