import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

function renderBlends(root: Container): string[] {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const rt = RenderTexture.create({ width: 8, height: 8 });
  renderer.render({ container: root, target: rt });
  const st = (renderer as any).states[0];
  const out = st.collector.instructions.filter((i: any) => i.t === 'batch').map((i: any) => i.blendMode);
  renderer.destroy();
  return out;
}

describe('detached render root own blendMode', () => {
  it('pixi: a detached root sprite with blendMode add keeps groupBlendMode normal (batch drawn normal)', () => {
    const spr = new P.Sprite(P.Texture.WHITE);
    spr.blendMode = 'add';
    spr.enableRenderGroup();
    P.updateRenderGroupTransforms(spr.renderGroup!, true);
    // BatchableSprite.blendMode getter reads renderable.groupBlendMode
    const b = new (P as any).BatchableSprite();
    b.renderable = spr;
    expect(spr.groupBlendMode).toBe('normal');
    expect(b.blendMode).toBe('normal');
  });
  it('pixi: a root previously in a tree under an add parent keeps stale add', () => {
    const parent = new P.Container(); parent.blendMode = 'add';
    const stage = new P.Container(); stage.enableRenderGroup(); stage.addChild(parent);
    const spr = new P.Sprite(P.Texture.WHITE); parent.addChild(spr);
    P.updateRenderGroupTransforms(stage.renderGroup!, true);
    expect(spr.groupBlendMode).toBe('add');
  });
  it('engine2d: detached root sprite with blendMode add is batched as add', () => {
    const spr = new Sprite(Texture.WHITE);
    spr.blendMode = 'add';
    const blends = renderBlends(spr);
    console.log('engine2d batch blends', blends);
    expect(blends).toEqual(['add']);
  });
  it('engine2d: detached container with blendMode add, child inherit -> normal (matches pixi tempContainer)', () => {
    const c = new Container(); c.blendMode = 'add';
    c.addChild(new Sprite(Texture.WHITE));
    expect(renderBlends(c)).toEqual(['normal']);
  });
});
