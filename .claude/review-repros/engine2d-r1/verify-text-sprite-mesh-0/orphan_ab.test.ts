import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { GCSystem } from 'pixi.js';
// Pixi internals (not all exported from index)
import { CanvasTextPipe } from '../../../../node_modules/pixi.js/lib/scene/text/canvas/CanvasTextPipe.mjs';
import { AbstractTextSystem } from '../../../../node_modules/pixi.js/lib/scene/text/shared/AbstractTextSystem.mjs';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Text } from '../../../../src/engine2d/text/Text';
import { Container } from '../../../../src/engine2d/scene/Container';
import { canvasTextSystem } from '../../../../src/engine2d/text/CanvasTextSystem';

let now = 0;
beforeAll(() => { setTextDOMAdapter(makeFakeAdapter() as unknown as TextDOMAdapter); });
afterEach(() => vi.restoreAllMocks());

const ROUNDS = 50, PER = 4;

describe('orphaned Text (removeChildren without destroy) - Pixi 8.17 GC vs engine2d', () => {
  it('Pixi: real GCSystem + CanvasTextPipe + AbstractTextSystem refcounting does NOT release orphan text textures', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    now = 0;
    // fake scheduler: repeat(fn, ms) fires fn whenever `now` crosses the next deadline (tick())
    const jobs: { fn: () => void; ms: number; next: number }[] = [];
    const scheduler = { repeat: (fn: () => void, ms: number) => { jobs.push({ fn, ms, next: now + ms }); return jobs.length; }, cancel() {} };
    const tickScheduler = () => { for (const j of jobs) while (now >= j.next) { j.fn(); j.next += j.ms; } };
    const renderer: any = { uid: 1, tick: 0, resolution: 1, scheduler, runners: { resolutionChange: { add() {} } },
      renderPipes: { batch: { addToBatch() {} } } };
    const gc = new GCSystem(renderer); renderer.gc = gc; gc.init({});
    let returned = 0;
    class FakeTextSystem extends (AbstractTextSystem as any) {
      getTexture() { return new PIXI.Texture({ source: new PIXI.TextureSource({ width: 64, height: 32 }) }); }
      returnTexture() { returned++; }
    }
    const canvasText: any = new FakeTextSystem(renderer, false); renderer.canvasText = canvasText;
    const pipe = new CanvasTextPipe(renderer);
    const stage = new PIXI.Container({ isRenderGroup: true });
    const menu = new PIXI.Container(); stage.addChild(menu);
    const renderFrame = () => {
      tickScheduler();
      gc.prerender({ container: stage } as any);
      // what RenderGroupSystem does per renderable on stage: addRenderable
      for (const c of menu.children) pipe.addRenderable(c as any, {} as any);
      gc.postrender();
    };
    for (let r = 0; r < ROUNDS; r++) {
      menu.removeChildren();
      for (let k = 0; k < PER; k++) menu.addChild(new PIXI.Text({ text: 'op' + k, style: { fontSize: 18 } }));
      for (let f = 0; f < 10; f++) { now += 16; renderFrame(); }
      now += 120_000;
    }
    renderFrame();
    const live = Object.values(canvasText._activeTextures).filter(Boolean).length;
    const tracked = Object.values(pipe['_managedTexts'].items).filter(Boolean).length;
    console.log('[pixi] live managed text textures', live, 'tracked texts', tracked, 'returned', returned);
    expect(tracked).toBe(PER); // GC did unload the 196 orphans...
    expect(live).toBe(ROUNDS * PER); // ...but onTextUnload never ran: runOnHash nulls items[uid] before unload(), GCManagedHash.remove early-returns
    expect(returned).toBe(0);
  });

  it('engine2d: orphans keep their texture entry forever', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    now = 0;
    const before = Object.values((canvasTextSystem as any)._activeTextures).filter(Boolean).length;
    const rhi = new NullRhiDevice();
    const renderer = new WebGPURenderer({ rhi, canvas: { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement, width: 64, height: 64 });
    const created = vi.spyOn(rhi, 'createTexture');
    const stage = new Container();
    const menu = new Container(); stage.addChild(menu);
    for (let r = 0; r < ROUNDS; r++) {
      menu.removeChildren();
      for (let k = 0; k < PER; k++) menu.addChild(new Text({ text: 'op' + k, style: { fontSize: 18 } }));
      for (let f = 0; f < 10; f++) { now += 16; renderer.render({ container: stage }); }
      now += 120_000;
    }
    renderer.render({ container: stage });
    const live = Object.values((canvasTextSystem as any)._activeTextures).filter(Boolean).length - before;
    console.log('[engine2d] live text textures', live, 'rhi textures created', created.mock.calls.length);
    expect(live).toBe(ROUNDS * PER);
  });
});
