import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Text } from '../../../../src/engine2d/text/Text';
import { Container } from '../../../../src/engine2d/scene/Container';
import { canvasTextSystem } from '../../../../src/engine2d/text/CanvasTextSystem';
import { CanvasPool } from '../../../../src/engine2d/text/canvas/CanvasPool';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

describe('text leak', () => {
  it('changing text', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const createdTex = vi.spyOn(rhi, 'createTexture');
    const stage = new Container();
    const texts: Text[] = [];
    for (let k = 0; k < 5; k++) { const t = new Text({ text: 'x', style: { fontSize: 20 } }); stage.addChild(t); texts.push(t); }
    for (let i = 0; i < 300; i++) {
      for (const t of texts) t.text = 'frame ' + (i % 37) + ' ' + '字'.repeat(i % 5);
      renderer.render({ container: stage });
    }
    const active = Object.values((canvasTextSystem as any)._activeTextures).filter(Boolean).length;
    const pool = Object.values((CanvasPool as any)._canvasPool).reduce((a: number, l: any) => a + l.length, 0);
    console.log('active', active, 'pool', pool, 'createdTex', createdTex.mock.calls.length);
    // hide / show and destroy
    for (const t of texts) t.destroy();
    const active2 = Object.values((canvasTextSystem as any)._activeTextures).filter(Boolean).length;
    console.log('after destroy active', active2, 'keys', Object.keys((canvasTextSystem as any)._activeTextures).length);
    renderer.destroy();
  });
});
