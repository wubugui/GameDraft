import { describe, it, expect } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, Sprite, Texture, TextureSource, RenderTexture, WebGPURenderer } from '../../../../src/engine2d';
import * as PIXI from 'pixi.js';

(globalThis as any).GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

function e2dRenderer() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  return new WebGPURenderer({ rhi, canvas, width: 8, height: 8 } as any);
}
function pixiTexSys() {
  const renderer: any = { uid: 1, gc: { addCollection() {}, addResourceHash() {}, now: 0 } };
  const sys: any = new (PIXI as any).GpuTextureSystem(renderer);
  sys.contextChange({ device: {
    createTexture: (d: any) => ({ width: d.size.width, height: d.size.height, destroy() {}, createView() { return {}; } }),
    queue: { writeTexture() {}, copyExternalImageToTexture() {} },
  } });
  return sys;
}
const cnt = (s: any) => `${s.listenerCount('unload')}/${s.listenerCount('destroy')}`;

describe('texture-source listener growth', () => {
  it('unload + reuse cycle', () => {
    const r = e2dRenderer();
    const src = new TextureSource({ resource: new Uint8Array(16), width: 2, height: 2, format: 'rgba8unorm' } as any);
    const root = new Container(); root.addChild(new Sprite(new Texture({ source: src })));
    const psys = pixiTexSys();
    const psrc = new PIXI.TextureSource({ resource: new Uint8Array(16), width: 2, height: 2, format: 'rgba8unorm' } as any);
    const e: string[] = [], p: string[] = [];
    for (let i = 0; i < 5; i++) {
      r.render({ container: root }); e.push(cnt(src)); src.unload();
      psys.initSource(psrc); p.push(cnt(psrc) + ` upd=${psrc.listenerCount('update')}`); psrc.unload();
    }
    console.log('engine2d unload/destroy:', e.join(' '));
    console.log('pixi     unload/destroy:', p.join(' '));
  });
  it('RenderTexture resize cycle', () => {
    const r = e2dRenderer();
    const rt = RenderTexture.create({ width: 4, height: 4 });
    const root = new Container(); root.addChild(new Sprite(Texture.WHITE));
    const psys = pixiTexSys();
    const prt = PIXI.RenderTexture.create({ width: 4, height: 4 });
    const e: string[] = [], p: string[] = [];
    for (let i = 0; i < 5; i++) {
      rt.resize(5 + i, 5 + i); r.render({ container: root, target: rt }); e.push(cnt(rt.source));
      prt.resize(5 + i, 5 + i); psys.initSource(prt.source); p.push(cnt(prt.source) + ` rsz=${prt.source.listenerCount('resize')}`);
    }
    console.log('engine2d RT unload/destroy:', e.join(' '));
    console.log('pixi     RT unload/destroy:', p.join(' '));
  });
});
