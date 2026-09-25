/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { FillGradient } from '../../../../src/engine2d/graphics/fill/FillGradient';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';

FillGradient.createCanvas = (width: number, height: number): any => {
  const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
  return { width, height, getContext: () => ctx };
};

describe('verify gradient leak', () => {
  it('hover redraw via clear() + drawSelectedRow pattern, and panel open/close', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const rt = RenderTexture.create({ width: 64, height: 64 });
    const entries = (renderer as any).textures.entries as Map<any, any>;
    const base = entries.size;
    const root = new Container();
    const bg = new Graphics();
    root.addChild(bg);
    for (let i = 0; i < 30; i++) {
      bg.clear();
      bg.rect(0, 0, 100, 20);
      bg.fill(new FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
        colorStops: [{ offset: 0, color: 'rgba(255,0,0,0.7)' }, { offset: 1, color: 'rgba(0,0,255,0.7)' }], textureSpace: 'local' }));
      renderer.render({ container: root, target: rt });
    }
    const afterHover = entries.size;
    // many frames of nothing — does anything evict?
    bg.clear();
    for (let i = 0; i < 200; i++) renderer.render({ container: root, target: rt });
    console.log('base', base, 'afterHover', afterHover, 'after 200 idle frames', entries.size,
      [...entries.keys()].map((s) => `${s.constructor.name} ${s.pixelWidth}x${s.pixelHeight} gc=${s.autoGarbageCollect}`).slice(-3));
    expect(entries.size).toBeGreaterThanOrEqual(base + 30);
  });
});
