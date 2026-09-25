import { beforeAll, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { getTemporaryCanvasFromImage } from '../../../../src/engine2d/text/html/utils/getTemporaryCanvasFromImage';
import { getTextureFromCanvas } from '../../../../src/engine2d/text/utils/getTextureFromCanvas';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

// HTMLTextSystem._buildTexturePromise sizing: image = ceil(ceil(W)*res)+2 (device px)
function branch(Wcss: number, Hcss: number, res: number) {
  const iw = Math.ceil(Math.ceil(Wcss) * res) + 2;
  const ih = Math.ceil(Math.ceil(Hcss) * res) + 2;
  const img = { width: iw, height: ih, tag: 'image' } as unknown as HTMLImageElement;
  const cc = getTemporaryCanvasFromImage(img, res);
  const tex = getTextureFromCanvas(cc.canvas, iw - 2, ih - 2, res);
  return { canvas: [cc.canvas.width, cc.canvas.height], gpuPx: [tex.source.pixelWidth, tex.source.pixelHeight] };
}
// master (WebGL, _createCanvas=false): getPo2TextureFromSource(image, ...) -> TexturePool.getOptimalTexture(iw/res|0, ih/res|0, res)
function master(Wcss: number, Hcss: number, res: number) {
  const iw = Math.ceil(Math.ceil(Wcss) * res) + 2;
  const ih = Math.ceil(Math.ceil(Hcss) * res) + 2;
  const t = PIXI.TexturePool.getOptimalTexture((iw / res) | 0, (ih / res) | 0, res, false);
  return { gpuPx: [t.source.pixelWidth, t.source.pixelHeight] };
}

it('HTMLText texture pixel size vs master', () => {
  const rows: string[] = [];
  for (const [w, h, r] of [[702, 24, 2], [702, 24, 1], [2480, 48, 2], [1456, 48, 2.5], [1840, 48, 2]] as const) {
    const b = branch(w, h, r);
    const m = master(w, h, r);
    rows.push(`W=${w} H=${h} res=${r}: branch canvas/gpu ${b.gpuPx.join('x')}  master gpu ${m.gpuPx.join('x')}`);
  }
  console.log(rows.join('\n'));
  expect(branch(2480, 48, 2).gpuPx[0]).toBe(16384);
  expect(master(2480, 48, 2).gpuPx[0]).toBe(8192);
});
