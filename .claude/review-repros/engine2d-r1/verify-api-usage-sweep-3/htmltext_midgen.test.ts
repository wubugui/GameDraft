import { describe, it, expect, vi } from 'vitest';
import { HTMLText as PixiHTMLText, Texture as PixiTexture, HTMLTextPipe } from 'pixi.js';
import { HTMLText as E2HTMLText, Texture as E2Texture } from '../../../../src/engine2d';
import { htmlTextSystem } from '../../../../src/engine2d/text/html/HTMLTextSystem';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; key: string };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HTMLText text change during texture generation', () => {
  it('Pixi 8.17 HTMLTextPipe drops the change; engine2d regenerates', async () => {
    // ---------- Pixi side (real HTMLTextPipe, mocked renderer.htmlText) ----------
    const pixiReqs: Deferred<any>[] = [];
    const renderer: any = {
      uid: 1, resolution: 1, _roundPixels: 0,
      runners: { resolutionChange: { add() {} } },
      gc: { addResourceHash() {}, now: 0 },
      renderPipes: { batch: { addToBatch() {} } },
      htmlText: {
        getTexturePromise(t: any) {
          let resolve!: (v: any) => void;
          const promise = new Promise<any>((r) => (resolve = r));
          pixiReqs.push({ promise, resolve, key: t.text });
          return promise;
        },
        decreaseReferenceCount() {}, returnTexturePromise() {}, getReferenceCount() { return null; },
      },
    };
    const pipe = new HTMLTextPipe(renderer);
    const pt = new PixiHTMLText({ text: 'a' });
    // generous to Pixi: call addRenderable every frame (as if the instruction set were rebuilt every frame)
    const pixiFrame = () => pipe.addRenderable(pt as any, {} as any);
    pixiFrame(); // starts gen for 'a'
    pt.text = 'ab'; // change while 'a' is generating
    pixiFrame(); // dropped: generatingTexture
    pixiReqs[0].resolve(PixiTexture.WHITE);
    await flush();
    for (let i = 0; i < 5; i++) { pixiFrame(); await flush(); }
    const pixiGpu: any = (pt as any)._gpuData[1];

    // ---------- engine2d side ----------
    const e2Reqs: Deferred<any>[] = [];
    vi.spyOn(htmlTextSystem, 'getTexturePromise').mockImplementation((t: any) => {
      let resolve!: (v: any) => void;
      const promise = new Promise<any>((r) => (resolve = r));
      e2Reqs.push({ promise, resolve, key: t.text });
      return promise;
    });
    vi.spyOn(htmlTextSystem, 'decreaseReferenceCount').mockImplementation(() => {});
    vi.spyOn(htmlTextSystem, 'returnTexturePromise').mockImplementation(() => {});
    const et = new E2HTMLText({ text: 'a' });
    const collector: any = { resolution: 1, addBatchable() {}, addCustom() {}, addUnbatched() {} };
    const e2Frame = () => et.collectRenderables(collector);
    e2Frame();
    et.text = 'ab';
    e2Frame();
    e2Reqs[0].resolve(E2Texture.WHITE);
    await flush();
    for (let i = 0; i < 5; i++) { e2Frame(); await flush(); }
    e2Reqs.slice(1).forEach((r) => r.resolve(E2Texture.WHITE));
    await flush();
    e2Frame();

    console.log('pixi requests:', pixiReqs.map((r) => r.key), 'currentKey starts with', pixiGpu.currentKey.split(':')[0]);
    console.log('e2 requests:', e2Reqs.map((r) => r.key), 'currentKey starts with', et._gpuText!.currentKey.split(':')[0]);
    expect(pixiReqs.map((r) => r.key)).toEqual(['a']);
    expect(e2Reqs.map((r) => r.key)).toEqual(['a', 'ab']);
  });
});
