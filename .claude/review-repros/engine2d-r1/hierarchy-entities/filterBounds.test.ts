import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

function run(hide: 'visible' | 'active') {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const root = new Container();
  const layer = new Container();
  root.addChild(layer);
  const a = new Sprite(Texture.WHITE); a.width = 4; a.height = 4; // 0..4
  const npc = new Container(); npc.position.set(40, 40);
  const b = new Sprite(Texture.WHITE); b.width = 4; b.height = 4;
  npc.addChild(b);
  layer.addChild(a, npc);
  renderer.render({ container: root }); // npc 画过一次:groupTransform 落在 (40,40)
  if (hide === 'visible') npc.visible = false; else npc.setActive(false);
  const f = new AlphaFilter({ alpha: 0.5 }); f.padding = 0;
  layer.filters = [f];
  const spy = vi.spyOn(rhi, 'createTexture');
  renderer.render({ container: root });
  const sizes = spy.mock.calls.map((c) => c[1] as RhiTextureDesc).map((d) => `${d.width}x${d.height}`);
  renderer.destroy();
  return sizes;
}

describe('filter bounds with hidden child', () => {
  it('visible=false vs setActive(false)', () => {
    const v = run('visible');
    const a = run('active');
    console.log('visible=false ->', v, ' setActive(false) ->', a);
    expect(a).toEqual(v);
  });
});
