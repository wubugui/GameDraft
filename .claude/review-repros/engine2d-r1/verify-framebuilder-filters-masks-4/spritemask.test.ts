import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('sprite mask', () => {
  it('pixi picks AlphaMask for Sprite, ColorMask for number', () => {
    const c = new PIXI.Container();
    c.mask = new PIXI.Sprite(PIXI.Texture.WHITE);
    console.log('pixi sprite mask effect:', c.effects.map((e: any) => e.constructor.name + '/' + e.pipe));
    const c2 = new PIXI.Container();
    c2.mask = 0xff0000 as any;
    console.log('pixi number mask effect:', c2.effects.map((e: any) => e.constructor.name + '/' + e.pipe));
    const c3 = new PIXI.Container();
    c3.mask = new PIXI.Graphics().rect(0,0,1,1).fill(0xffffff);
    console.log('pixi graphics mask effect:', c3.effects.map((e: any) => e.constructor.name + '/' + e.pipe));
  });

  it('engine2d treats Sprite mask as stencil', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const root = new Container();
    const content = new Sprite(Texture.WHITE);
    content.width = 8; content.height = 8;
    const m = new Sprite(Texture.WHITE); m.width = 4; m.height = 4;
    root.addChild(m);
    root.addChild(content);
    content.mask = m;
    console.log('engine2d effects:', (content as any).effects?.map((e: any) => e.constructor.name + '/' + e.kind));
    const rt = RenderTexture.create({ width: 8, height: 8 });
    renderer.render({ container: root, target: rt });
    console.log(rhi.log.join('\n'));
    let err: unknown = null;
    try { const c2 = new Container(); (c2 as any).mask = 0xff0000; } catch (e) { err = e; }
    console.log('engine2d number mask:', String(err));
    renderer.destroy();
  });
});
