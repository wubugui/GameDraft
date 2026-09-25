/**
 * Pooled text canvases + lazy upload: over several frames with text churn and shared styles, every Text drawn
 * must sample a GPU texture whose last upload snapshot == its current string.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Text } from '../../../../src/engine2d/text/Text';
import { TextStyle } from '../../../../src/engine2d/text/TextStyle';
import { FakeCanvas, FakeContext2D, makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';

beforeAll(() => {
  setTextDOMAdapter(makeFakeAdapter() as unknown as TextDOMAdapter);
});

/** text currently painted on a fake canvas = fillText calls since the last full clearRect */
function painted(ctx: FakeContext2D): string {
  let out: string[] = [];
  for (const c of ctx.calls) {
    if (c[0] === 'clearRect') out = [];
    if (c[0] === 'fillText') out.push(c[1] as string);
  }
  return out.join('|');
}

describe('text canvas pool lifecycle', () => {
  it('uploads always match the current text across churn', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    // snapshot uploads: rhi texture -> painted string at upload time
    const uploaded = new Map<unknown, string>();
    const orig = rhi.uploadImage.bind(rhi);
    rhi.uploadImage = ((tex: unknown, img: unknown, opts: unknown) => {
      const c = img as FakeCanvas;
      uploaded.set(tex, painted(c.context));
      return orig(tex as never, img as never, opts as never);
    }) as typeof rhi.uploadImage;

    const shared = new TextStyle({ fontSize: 20, fill: 0xffffff, wordWrap: true, wordWrapWidth: 200, breakWords: true });
    const stage = new Container();
    const texts: Text[] = [];
    for (let i = 0; i < 6; i++) {
      const t = new Text({ text: '', style: i % 2 ? shared : { fontSize: 20, fill: 0xffffff } });
      t.y = i * 10;
      stage.addChild(t);
      texts.push(t);
    }
    const words = ['你好', '夜里的巷子', '谁在那里', '你好', '回去吧', '夜里的巷子'];
    let seed = 1;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const gt = (renderer as unknown as { gpuTextures?: unknown }).gpuTextures;
    void gt;
    for (let frame = 0; frame < 60; frame++) {
      for (const t of texts) {
        const r = rnd();
        if (r < 0.4) t.text = words[Math.floor(rnd() * words.length)];
        else if (r < 0.5) t.visible = !t.visible;
        else if (r < 0.55) t.text = t.text + '。';
      }
      renderer.render({ container: stage });
      for (const t of texts) {
        if (!t.visible) continue;
        const g = t._gpuText!;
        const src = g.texture!.source;
        const c = src.resource as unknown as FakeCanvas;
        // CPU canvas content must be this text
        if (t.text === '') continue;
        const want = t.text;
        expect(painted(c.context).replace(/\|/g, '')).toBe(want);
        const ent = (renderer as unknown as { textures: { entries: Map<unknown, { texture: unknown }> } }).textures.entries.get(src);
        expect(ent, 'gpu entry').toBeTruthy();
        expect(uploaded.get(ent!.texture)?.replace(/\|/g, ''), `frame ${frame}`).toBe(want);
      }
    }
    renderer.destroy();
    expect(uploaded.size).toBeGreaterThan(0);
  });
});
