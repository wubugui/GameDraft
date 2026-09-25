/**
 * 纹理装载的 Worker 路径(Pixi 缺省走它)与 pixi.js 8.17 对照:
 * - 两段内联 worker 源码与 Pixi 的逐字相同(worker 里 createImageBitmap 的参数就写在这段源码里);
 * - 发给 worker 的消息([绝对地址, alphaMode])与 Pixi 相同;生成的 TextureSource 相同。
 * 用假 Blob / URL.createObjectURL / Worker 截获。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { Assets } from './Assets';
import { DOMAdapter, type Adapter } from '../environment/adapter';

const BASE = 'http://localhost:5173/game/index.html';

const blobCode = new Map<string, string>();
const createdBlobs: string[] = [];
const posted: unknown[][] = [];
let blobSeq = 0;

class FakeBlob {
  readonly code: string;
  constructor(parts: string[]) {
    this.code = parts.join('');
    createdBlobs.push(this.code);
  }
}

type Listener = (event: { data: unknown; target: unknown }) => void;

class FakeWorker {
  private readonly listeners: Listener[] = [];
  private readonly code: string;
  constructor(url: string) {
    this.code = blobCode.get(url) ?? '';
    if (this.code.includes('checkImageBitmap')) {
      // 探测 worker:启动即回报"支持"
      queueMicrotask(() => this.dispatch(true));
    }
  }
  addEventListener(type: string, fn: Listener): void {
    if (type === 'message') this.listeners.push(fn);
  }
  postMessage(msg: { data: unknown[]; uuid: number; id: string }): void {
    posted.push(msg.data);
    const [url] = msg.data as [string];
    queueMicrotask(() => this.dispatch({ data: { width: 128, height: 64, close() {}, src: url }, uuid: msg.uuid, id: msg.id }));
  }
  terminate(): void {}
  private dispatch(data: unknown): void {
    for (const l of this.listeners) l({ data, target: this });
  }
}

let e2dAdapter0: Adapter;
let pixiAdapter0: ReturnType<typeof PIXI.DOMAdapter.get>;

beforeAll(async () => {
  vi.stubGlobal('Blob', FakeBlob);
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: unknown) => {
    const url = `blob:fake/${++blobSeq}`;
    blobCode.set(url, (blob as FakeBlob).code);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('createImageBitmap', async () => {
    throw new Error('Worker 路径不应在主线程解码');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  pixiAdapter0 = PIXI.DOMAdapter.get();
  PIXI.DOMAdapter.set({ ...pixiAdapter0, getBaseUrl: () => BASE });
  e2dAdapter0 = DOMAdapter.get();
  DOMAdapter.set({ ...e2dAdapter0, getBaseUrl: () => BASE });
  for (const d of [PIXI.detectMp4, PIXI.detectOgv, PIXI.detectWebm]) {
    const i = PIXI.Assets.detections.indexOf(d);
    if (i >= 0) PIXI.Assets.detections.splice(i, 1);
  }
  // 格式探测不走 worker,这里跳过(它会调主线程 createImageBitmap)
  await PIXI.Assets.init({ skipDetections: true });
  await Assets.init({ skipDetections: true });
});

afterAll(() => {
  PIXI.DOMAdapter.set(pixiAdapter0);
  DOMAdapter.set(e2dAdapter0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Snap {
  alphaMode: string;
  resolution: number;
  width: number;
  pixelWidth: number;
  label: string;
}

async function scenario(load: (u: unknown) => Promise<unknown>): Promise<{ posted: unknown[][]; snaps: Snap[]; blobs: string[] }> {
  posted.length = 0;
  createdBlobs.length = 0;
  const snaps: Snap[] = [];
  for (const u of [
    './assets/a.png',
    { src: './assets/hero.normal.png', data: { alphaMode: 'premultiplied-alpha' } },
    '/runtime/b@2x.webp',
  ]) {
    const t = (await load(u)) as { source: Snap };
    const s = t.source;
    snaps.push({ alphaMode: s.alphaMode, resolution: s.resolution, width: s.width, pixelWidth: s.pixelWidth, label: s.label });
  }
  return { posted: posted.slice(), snaps, blobs: createdBlobs.slice() };
}

describe('Worker 路径(对照 pixi.js 8.17)', () => {
  it('内联 worker 源码逐字相同;发给 worker 的消息与生成的纹理源相同', async () => {
    expect(PIXI.loadTextures.config?.preferWorkers).toBe(true);
    const pixi = await scenario((u) => PIXI.Assets.load(u as string));
    const e2d = await scenario((u) => Assets.load(u as string));

    expect(pixi.blobs.length).toBe(2); // 探测 worker + 装载 worker
    expect(e2d.blobs).toEqual(pixi.blobs);
    expect(e2d.posted).toEqual(pixi.posted);
    expect(e2d.snaps).toEqual(pixi.snaps);

    expect(pixi.posted).toEqual([
      ['http://localhost:5173/game/assets/a.png', undefined],
      ['http://localhost:5173/game/assets/hero.normal.png', 'premultiplied-alpha'],
      ['http://localhost:5173/runtime/b@2x.webp', undefined],
    ]);
    expect(e2d.snaps.map((s) => s.alphaMode)).toEqual(['premultiply-alpha-on-upload', 'premultiplied-alpha', 'premultiply-alpha-on-upload']);
    expect(e2d.snaps[2].resolution).toBe(2);
    // worker 里的解码参数:只有 premultiplied-alpha 才 { premultiplyAlpha: 'none' }
    const loadCode = e2d.blobs.find((c) => c.includes('loadImageBitmap'))!;
    expect(loadCode).toContain('alphaMode === "premultiplied-alpha" ? createImageBitmap(imageBlob, { premultiplyAlpha: "none" }) : createImageBitmap(imageBlob)');
  });
});
