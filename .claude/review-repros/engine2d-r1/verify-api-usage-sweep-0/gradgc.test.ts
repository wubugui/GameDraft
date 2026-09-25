import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, Graphics, FillGradient, WebGPURenderer } from '../../../../src/engine2d';

const fakeCtx = () => ({ createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, translate() {}, rotate() {}, scale() {}, fillStyle: '' });
const fakeCanvas = (w: number, h: number) => ({ width: w, height: h, getContext: () => fakeCtx() });
(FillGradient as any).createCanvas = fakeCanvas;
PIXI.DOMAdapter.set({ ...PIXI.DOMAdapter.get(), createCanvas: (w: number, h: number) => fakeCanvas(w ?? 1, h ?? 1) } as any);

const opts = () => ({ type: 'radial' as const, center: { x: 0.5, y: 0.42 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
  colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0.55)' }], textureSpace: 'local' as const });

describe('FillGradient GPU texture GC: engine2d vs Pixi 8.17', () => {
  it('source type / autoGarbageCollect flag', () => {
    const p = new PIXI.FillGradient(opts()); (p as any).buildGradient();
    const e = new FillGradient(opts() as any); (e as any).buildGradient();
    console.log('pixi source', p.texture.source.constructor.name, 'autoGC', p.texture.source.autoGarbageCollect);
    console.log('e2d  source', (e as any).texture.source.constructor.name, 'autoGC', (e as any).texture.source.autoGarbageCollect);
  });

  it('Pixi GCSystem+GCManagedHash unloads gradient source after 60s unused', () => {
    let now = 1000;
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer: any = { uid: 7, scheduler: { repeat: () => 1, cancel() {} } };
    const gc = new PIXI.GCSystem(renderer); renderer.gc = gc; gc.init({});
    let destroyedGl = 0;
    const hash = new PIXI.GCManagedHash({ renderer, type: 'resource', onUnload: () => {}, name: 'glTexture' } as any);
    const sources: any[] = [];
    for (let i = 0; i < 20; i++) {
      const g = new PIXI.FillGradient(opts()); (g as any).buildGradient();
      const s: any = g.texture.source;
      s._gpuData[renderer.uid] = { destroy: () => destroyedGl++ };
      hash.add(s); sources.push(s);
    }
    now += 61000; gc.now = now;
    gc.run();
    const live = Object.values((hash as any).items).filter(Boolean).length;
    console.log('pixi: after 61s GC run, live GL textures in hash =', live, ' gl destroyed =', destroyedGl);
    expect(live).toBe(0);
    perf.mockRestore();
  });

  it('engine2d: 20 panel cycles keep 20 GPU textures forever', () => {
    let now = 1000;
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 } as any);
    const stage = new Container();
    const entries = () => ((renderer as any).textures.entries as Map<unknown, unknown>).size;
    renderer.render({ container: stage });
    const base = entries();
    for (let i = 0; i < 20; i++) {
      const vig = new Graphics(); vig.rect(0, 0, 40, 30); vig.fill(new FillGradient(opts() as any));
      stage.addChild(vig); renderer.render({ container: stage });
      stage.removeChild(vig); vig.destroy({ children: true });
      renderer.render({ container: stage });
    }
    // advance 10 minutes, keep rendering
    for (let t = 0; t < 40; t++) { now += 15000; renderer.render({ container: stage }); }
    console.log('engine2d: base entries', base, ' after 20 cycles + 10min of frames =', entries());
    const big = [...((renderer as any).textures.entries as Map<any, any>).keys()].filter((s: any) => s.pixelWidth === 256).length; console.log("256x256 held:", big); expect(big).toBe(20);
    perf.mockRestore();
  });
});
