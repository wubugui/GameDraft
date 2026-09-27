/**
 * 接入层 · 离屏渲染纹理 + 异步回读（`offscreenReadback.ts`）的无 GPU 单测（空后端 `NullRhiDevice`；真 GPU 上的像素与行序
 * 由各工作台的 Chrome 自检 / 逐像素对照覆盖，如呼吸工作台 selftest S10 与 `tests/parity/run.mjs` 的出片例）。
 *
 * 钉住的是这个模块自己的契约：画进的是成品尺寸的渲染纹理（不是画布）、回读的拷贝在调用那一刻就发出（之后再画不影响它）、
 * 行序原样（自上而下，不翻）、BGRA 换成 RGBA、没画过 / 销毁后读要报错、销毁放掉纹理。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTexture, RhiTextureReadback } from '../../src/rendering/rhi';
import { Container, Graphics, WebGPURenderer } from '../../src/engine2d';
import { traceRhi } from './rhiTrace';
import { createOffscreenTarget } from './offscreenReadback';

function setup() {
  const rhi = new NullRhiDevice({ swapchainSize: [64, 48] });
  const trace = traceRhi(rhi);
  const canvas = { width: 64, height: 48, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 48, resolution: 1, background: 0x000000 });
  return { rhi, renderer, trace };
}

function scene(): Container {
  const root = new Container();
  root.addChild(new Graphics().rect(2, 3, 10, 6).fill(0xff8800));
  return root;
}

/** 假回读：每行第一个像素的 B 通道 = 行号（BGRA 存储），其余 0 */
function fakeReadback(t: RhiTexture): RhiTextureReadback {
  const data = new Uint8Array(t.width * t.height * 4);
  for (let y = 0; y < t.height; y++) {
    data[y * t.width * 4] = y;
    data[y * t.width * 4 + 2] = 200;
    data[y * t.width * 4 + 3] = 255;
  }
  return { width: t.width, height: t.height, format: 'bgra8unorm', data };
}

describe('offscreenReadback：离屏渲染纹理 + 异步回读', () => {
  it('画进的是成品尺寸的渲染纹理，不碰画布', () => {
    const { renderer, trace } = setup();
    const tgt = createOffscreenTarget(renderer, 30, 20);
    expect([tgt.width, tgt.height]).toEqual([30, 20]);
    trace.clear();
    tgt.render(scene());
    const passes = trace.lines.filter((l) => l.startsWith('pass'));
    expect(passes.length).toBe(1);
    expect(passes[0]).toContain('30x20');
    expect(trace.lines).not.toContain('frame');   // 画到画布才走 runFrame
    tgt.destroy();
  });

  it('宿主（带 renderer 的对象）与渲染器本身都能给', () => {
    const { renderer } = setup();
    const t = createOffscreenTarget({ renderer }, 8, 8);
    expect(t.renderer).toBe(renderer);
    t.destroy();
  });

  it('回读：拷贝在调用那一刻就发出（之后再画不影响），行序原样自上而下，BGRA → RGBA', async () => {
    const { rhi, renderer } = setup();
    const order: string[] = [];
    const origSubmit = rhi.submit.bind(rhi);
    vi.spyOn(rhi, 'submit').mockImplementation((label, rec) => { order.push('submit'); return origSubmit(label, rec); });
    vi.spyOn(rhi, 'readTexture').mockImplementation(async (t) => { order.push('read'); return fakeReadback(t); });
    const tgt = createOffscreenTarget(renderer, 5, 4);
    const p1 = tgt.capture(scene());
    const p2 = tgt.capture(scene());
    expect(order).toEqual(['submit', 'read', 'submit', 'read']);
    const [a, b] = await Promise.all([p1, p2]);
    expect([a.width, a.height, a.data.length]).toEqual([5, 4, 5 * 4 * 4]);
    for (let y = 0; y < 4; y++) expect([...a.data.subarray(y * 20, y * 20 + 4)]).toEqual([200, 0, y, 255]);
    expect([...b.data]).toEqual([...a.data]);
    tgt.destroy();
  });

  it('没画过就读 / 销毁后再用：明确报错', async () => {
    const { renderer } = setup();
    const tgt = createOffscreenTarget(renderer, 4, 4);
    await expect(tgt.read()).rejects.toThrow('还没画过');
    tgt.destroy();
    await expect(tgt.read()).rejects.toThrow('已销毁');
    expect(() => tgt.render(scene())).toThrow('已销毁');
    expect(tgt.texture.destroyed).toBe(true);
    expect(() => createOffscreenTarget(renderer, 0, 4)).toThrow('尺寸');
  });
});
