import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Text } from '../../../../src/engine2d/text/Text';
import { Container } from '../../../../src/engine2d/scene/Container';
import { canvasTextSystem } from '../../../../src/engine2d/text/CanvasTextSystem';

beforeAll(() => { setTextDOMAdapter(makeFakeAdapter() as unknown as TextDOMAdapter); });

describe('orphaned text', () => {
  it('menu rebuild without destroy (ObjectExamineScene.rebuildMenu pattern)', () => {
    const rhi = new NullRhiDevice();
    const renderer = new WebGPURenderer({ rhi, canvas: { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement, width: 64, height: 64 });
    const createdTex = vi.spyOn(rhi, 'createTexture');
    const stage = new Container();
    const menu = new Container(); stage.addChild(menu);
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (let open = 0; open < 50; open++) {
      menu.removeChildren();
      for (let k = 0; k < 4; k++) menu.addChild(new Text({ text: '操作' + k, style: { fontSize: 18 } }));
      for (let f = 0; f < 10; f++) { now += 16; renderer.render({ container: stage }); }
      now += 120_000; // > Pixi gcMaxUnusedTime(60s)+gcFrequency(30s)
    }
    renderer.render({ container: stage });
    const live = Object.values((canvasTextSystem as any)._activeTextures).filter(Boolean).length;
    console.log('live text textures', live, 'rhi textures created', createdTex.mock.calls.length);
    expect(live).toBe(200);
  });
});
