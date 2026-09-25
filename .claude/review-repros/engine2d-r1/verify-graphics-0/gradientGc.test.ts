/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { FillGradient } from '../../../../src/engine2d/graphics/fill/FillGradient';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import * as PIXI from 'pixi.js';

const fakeCtx: any = new Proxy({}, { get: (_t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
const fakeCanvas = (width: number, height: number): any => ({ width, height, getContext: () => fakeCtx });
FillGradient.createCanvas = fakeCanvas;
const origAdapter = PIXI.DOMAdapter.get();
PIXI.DOMAdapter.set({ ...origAdapter, createCanvas: fakeCanvas } as any);

const radial = (FG: any) => new FG({
  type: 'radial', center: { x: 0.5, y: 0.42 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
  colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0.55)' }], textureSpace: 'local',
});
const linear = (FG: any) => new FG({
  type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
  colorStops: [{ offset: 0, color: 'rgba(200,150,50,0.72)' }, { offset: 1, color: 'rgba(100,70,20,0.72)' }], textureSpace: 'local',
});

describe('gradient texture lifetime: engine2d vs Pixi 8.17 GC', () => {
  it('engine2d: panel open/close + ghost hover, then 10 min idle -> textures never freed', () => {
    let now = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const rhi = new NullRhiDevice();
    const destroySpy = vi.fn();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const rt = RenderTexture.create({ width: 64, height: 64 });
    const entries = (renderer as any).textures.entries as Map<any, any>;
    const base = entries.size;
    const radialSources: any[] = [];
    // 10 panel opens (PanelSkin vignette) + 10 ghost-button hovers (UIDecor.drawSelectedRow into bg after clear())
    const btnBg = new Graphics();
    const btnRoot = new Container(); btnRoot.addChild(btnBg);
    for (let i = 0; i < 10; i++) {
      const c = new Container();
      const vig = new Graphics();
      vig.rect(0, 0, 400, 300); const fg = radial(FillGradient); vig.fill(fg);
      c.addChild(vig);
      renderer.render({ container: c, target: rt });
      radialSources.push(fg.texture.source);
      c.destroy({ children: true });
      btnBg.clear(); btnBg.rect(0, 0, 100, 20); btnBg.fill(linear(FillGradient));
      renderer.render({ container: btnRoot, target: rt });
      now += 1000;
    }
    const afterUse = entries.size - base;
    // idle 10 minutes, rendering an unrelated empty scene every "frame"
    const idle = new Container();
    for (let t = 0; t < 600; t++) { now += 1000; renderer.render({ container: idle, target: rt }); }
    const afterIdle = entries.size - base;
    const stillHeld = radialSources.filter((s) => entries.has(s)).length;
    console.log('[engine2d] GpuTextures entries added:', afterUse, 'after 10 min idle:', afterIdle, 'radial sources still held:', stillHeld,
      'renderer.gc =', (renderer as any).gc, 'destroyed RHI textures:', destroySpy.mock.calls.length);
    spy.mockRestore();
    expect(afterIdle).toBe(afterUse); // documents divergence: nothing reclaimed
    expect(afterUse).toBeGreaterThanOrEqual(19);
  });

  it('Pixi 8.17: GCSystem (defaults) + GCManagedHash (as GlTextureSystem) unloads idle gradient ImageSources', () => {
    let now = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer: any = { uid: 1, tick: 0, scheduler: { repeat: () => 1, cancel: () => {} } };
    const gc = new (PIXI as any).GCSystem(renderer);
    renderer.gc = gc;
    gc.init({}); // default options, as master (no gc options passed)
    expect(gc.enabled).toBe(true);
    expect(gc.maxUnusedTime).toBe(60000);
    const unloaded: any[] = [];
    const hash = new (PIXI as any).GCManagedHash({ renderer, type: 'resource', name: 'glTexture', onUnload: (s: any) => unloaded.push(s) });
    const sources: any[] = [];
    const gpuDestroyed: any[] = [];
    for (let i = 0; i < 10; i++) {
      for (const fg of [radial(PIXI.FillGradient), linear(PIXI.FillGradient)]) {
        fg.buildGradient();
        const src = fg.texture.source;
        expect(src.constructor.name).toBe('ImageSource');
        expect(src.autoGarbageCollect).toBe(true);
        // what GlTextureSystem.initSource does:
        src._gpuData[renderer.uid] = { destroy() { gpuDestroyed.push(src); } };
        hash.add(src);
        sources.push(src);
      }
      now += 1000;
      gc.now = now;
    }
    // GCSystem timer fires every 30 s; simulate 10 minutes of runs
    for (let t = 0; t < 20; t++) { now += 30000; gc.now = now; gc.run(); }
    const live = Object.values(hash.items).filter((x) => x).length;
    const liveBefore = sources.length;
    console.log('[pixi] gradient sources registered:', liveBefore, 'GC unload() -> gpuData.destroy calls:', gpuDestroyed.length,
      'onSourceUnload (gl.deleteTexture) calls:', unloaded.length, 'still referenced by texture hash:', live,
      'sources with _gpuData cleared:', sources.filter((s) => !s._gpuData[1]).length);
    spy.mockRestore();
    expect(live).toBe(0); // hash no longer references any gradient source -> JS-collectable
    expect(gpuDestroyed.length).toBe(sources.length);
  });
});
