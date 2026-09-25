/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { getTemporaryCanvasFromImage } from '../../../../src/engine2d/text/html/utils/getTemporaryCanvasFromImage';
import { getTextureFromCanvas } from '../../../../src/engine2d/text/utils/getTextureFromCanvas';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

// exact sizing from HTMLTextSystem._buildTexturePromise (branch == Pixi)
function imageSize(Wcss: number, Hcss: number, res: number) {
  return [Math.ceil(Math.ceil(Wcss) * res) + 2, Math.ceil(Math.ceil(Hcss) * res) + 2];
}

function branch(Wcss: number, Hcss: number, res: number) {
  const [iw, ih] = imageSize(Wcss, Hcss, res);
  const img = { width: iw, height: ih } as unknown as HTMLImageElement;
  const cc = getTemporaryCanvasFromImage(img, res);
  const tex = getTextureFromCanvas(cc.canvas, iw - 2, ih - 2, res);
  return { tex, px: [tex.source.pixelWidth, tex.source.pixelHeight], frame: [tex.frame.width, tex.frame.height], uv: [tex.uvs.x1, tex.uvs.y2] };
}
// master: WebGL renderer -> _createCanvas=false -> getPo2TextureFromSource(image, iw-2, ih-2, res)
function master(Wcss: number, Hcss: number, res: number) {
  const [iw, ih] = imageSize(Wcss, Hcss, res);
  const t = PIXI.TexturePool.getOptimalTexture((iw / res) | 0, (ih / res) | 0, res, false);
  t.frame.width = (iw - 2) / res; t.frame.height = (ih - 2) / res; t.updateUvs();
  return { px: [t.source.pixelWidth, t.source.pixelHeight], frame: [t.frame.width, t.frame.height], uv: [t.uvs.x1, t.uvs.y2] };
}

it('HTMLText GPU texture size: branch vs master', () => {
  const out: string[] = [];
  for (const [w, h, r] of [[702, 24, 1], [702, 24, 2], [702, 24, 1.25], [1310, 24, 2.5], [2480, 24, 2]] as const) {
    const b = branch(w, h, r); const m = master(w, h, r);
    out.push(`css ${w}x${h} res ${r}: branch ${b.px.join('x')} frame ${b.frame.map(v=>v.toFixed(2)).join('x')} uv ${b.uv.map(v=>v.toFixed(4))} | master ${m.px.join('x')} frame ${m.frame.map(v=>v.toFixed(2)).join('x')} uv ${m.uv.map(v=>v.toFixed(4))}`);
  }
  console.log(out.join('\n'));
  expect(branch(702, 24, 1).px).toEqual(master(702, 24, 1).px);
  expect(branch(702, 24, 2).px).toEqual([4096, 128]);
  expect(master(702, 24, 2).px).toEqual([2048, 64]);
});

it('branch: 16384-wide HTMLText canvas texture fails createTexture on 8192-limit device', () => {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const spy = vi.spyOn(rhi, 'createTexture');
  const rt = RenderTexture.create({ width: 64, height: 64 });
  const { tex, px } = branch(2480, 24, 2);
  console.log('branch px', px, 'caps.maxTextureSize', rhi.caps.maxTextureSize, 'master px', master(2480, 24, 2).px);
  const root = new Container();
  root.addChild(new Sprite(tex));
  let err: unknown = null;
  try { renderer.render({ container: root, target: rt }); } catch (e) { err = e; }
  const d = spy.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((x) => x.label === 'text');
  console.log('text createTexture descs', d.map((x) => `${x.width}x${x.height}`), 'error:', err ? String((err as Error).message) : null);
  expect(err).not.toBeNull();
});
