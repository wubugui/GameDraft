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

describe('gradient texture lifetime (createPanel vignette pattern)', () => {
  it('opening/closing a panel N times', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const rt = RenderTexture.create({ width: 64, height: 64 });
    const entries = (renderer as any).textures.entries as Map<unknown, unknown>;
    const base = entries.size;
    for (let i = 0; i < 20; i++) {
      // PanelSkin.createPanel vignette
      const c = new Container();
      const vig = new Graphics();
      vig.rect(0, 0, 400, 300);
      vig.fill(new FillGradient({
        type: 'radial', center: { x: 0.5, y: 0.42 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
        colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0.55)' }], textureSpace: 'local',
      }));
      c.addChild(vig);
      renderer.render({ container: c, target: rt });
      // UIWindow / dialogue close
      c.destroy({ children: true });
    }
    console.log('GpuTextures entries: base', base, 'after 20 open/close', entries.size);
    expect(entries.size - base).toBeLessThan(5);
  });
});
