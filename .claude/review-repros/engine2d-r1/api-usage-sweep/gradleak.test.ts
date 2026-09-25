import { describe, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, Graphics, FillGradient, WebGPURenderer } from '../../../../src/engine2d';

// node 里没有 document:给 FillGradient 一个假画布(只要 2d 上下文的几个方法)
(FillGradient as any).createCanvas = (w: number, h: number) => ({
  width: w, height: h,
  getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, translate() {}, rotate() {}, scale() {}, set fillStyle(_v: unknown) {} }),
});

describe('FillGradient GPU texture retention', () => {
  it('panel open/close cycles', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 } as any);
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const stage = new Container();
    const entries = () => ((renderer as any).textures.entries as Map<unknown, unknown>).size;
    for (let i = 0; i < 20; i++) {
      // 照 PanelSkin.createPanel 的暗角:每次开面板 new 一个 FillGradient
      const vig = new Graphics();
      vig.rect(0, 0, 40, 30);
      vig.fill(new FillGradient({ type: 'radial', center: { x: 0.5, y: 0.42 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
        colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0.55)' }], textureSpace: 'local' }));
      stage.addChild(vig);
      renderer.render({ container: stage });
      stage.removeChild(vig);
      vig.destroy({ children: true });   // 面板关掉(Pixi 同样不会销毁 FillGradient 的纹理)
      renderer.render({ container: stage });
    }
    const made = createTexture.mock.calls.filter((c) => (c[1] as any)?.width === 256).length;
    console.log('256x256 gradient GPU textures created:', made, ' still held in GpuTextures.entries:', entries());
  });
});
