/**
 * VideoSource(视频纹理源)与 Pixi 8.17 的 VideoSource 并排对照(node 里用假 video 元素驱动,不需要浏览器):
 * - 路由:`TextureSource.from(video)` 得到 VideoSource(同 Pixi autoDetectSource),不再落到 ImageSource;
 * - 缺省:autoGarbageCollect false(空闲回收不收)、uploadMethodId 'video'、autoLoad / autoPlay 开;
 * - 加载:未就绪时挂 canplay / canplaythrough / error 并调 element.load();就绪后按 videoWidth/Height 定尺寸、传首帧、autoPlay 则 play();
 * - 播放中逐帧更新:有 requestVideoFrameCallback 且 updateFPS 为 0 走 rVFC,否则挂 Ticker.shared;暂停 / autoUpdate=false 摘掉;
 *   暂停时 seeked 补一帧;
 * - destroy:摘元素监听、pause、清 src、load()。
 * 与 Pixi 唯一的有意差别:Pixi 的 destroy 在挂着 Ticker.shared 播放时不摘 ticker 监听(永远空转一个已销毁源的回调),
 * 这里摘掉(画面上没有差别)。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { RhiTextureUsage } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from './Texture';
import { ImageSource, TextureSource, VideoSource } from './TextureSource';
import { Ticker } from '../ticker/Ticker';
import { GpuTextures } from '../gpu/GpuTextures';
import { WebGPURenderer } from '../gpu/WebGPURenderer';

type Fn = (e?: unknown) => void;

/** 假 HTMLVideoElement:只有 VideoSource 用到的那些成员;事件照 DOM 按 (type, capture) 去重 */
class FakeVideo {
  readonly HAVE_FUTURE_DATA = 3;
  readonly HAVE_ENOUGH_DATA = 4;
  width = 0;
  height = 0;
  videoWidth = 0;
  videoHeight = 0;
  readyState = 0;
  paused = true;
  ended = false;
  playbackRate = 1;
  src = 'clip.mp4';
  log: string[];
  private readonly listeners = new Map<string, Set<Fn>>();

  constructor(log: string[]) {
    this.log = log;
  }

  addEventListener(type: string, fn: Fn, capture?: boolean): void {
    const k = capture ? `${type}:capture` : type;
    if (!this.listeners.has(k)) this.listeners.set(k, new Set());
    this.listeners.get(k)!.add(fn);
  }

  removeEventListener(type: string, fn: Fn, capture?: boolean): void {
    this.listeners.get(capture ? `${type}:capture` : type)?.delete(fn);
  }

  /** 当前挂着的监听(类型 × 份数),排好序便于对照 */
  listenerKeys(): string[] {
    const out: string[] = [];
    for (const [k, set] of this.listeners) if (set.size) out.push(`${k}×${set.size}`);
    return out.sort();
  }

  dispatch(type: string): void {
    for (const k of [type, `${type}:capture`]) for (const fn of [...(this.listeners.get(k) ?? [])]) fn({ type });
  }

  load(): void {
    this.log.push(`el:load(${this.src})`);
  }

  play(): Promise<void> {
    this.log.push('el:play');
    if (this.paused) {
      this.paused = false;
      queueMicrotask(() => this.dispatch('play'));
    }
    return Promise.resolve();
  }

  pause(): void {
    this.log.push('el:pause');
    if (!this.paused) {
      this.paused = true;
      queueMicrotask(() => this.dispatch('pause'));
    }
  }
}

/** 带 requestVideoFrameCallback 的假视频(Chrome / Safari 的情形) */
class FakeVideoRvfc extends FakeVideo {
  private readonly frameCbs = new Map<number, Fn>();
  private nextId = 1;

  requestVideoFrameCallback(cb: Fn): number {
    const id = this.nextId++;
    this.log.push(`el:rvfc#${id}`);
    this.frameCbs.set(id, cb);
    return id;
  }

  cancelVideoFrameCallback(id: number): void {
    this.log.push(`el:cancel#${id}`);
    this.frameCbs.delete(id);
  }

  /** 解码出一帧:触发所有挂着的帧回调 */
  frame(): void {
    const cbs = [...this.frameCbs.values()];
    this.frameCbs.clear();
    for (const cb of cbs) cb();
  }

  get pendingFrameCallbacks(): number {
    return this.frameCbs.size;
  }
}

interface Engine {
  name: string;
  VideoSource: any;
  TextureSource: any;
  Ticker: any;
}

const ENGINE2D: Engine = { name: 'engine2d', VideoSource, TextureSource, Ticker };
const PIXI_REF: Engine = { name: 'pixi', VideoSource: (PIXI as any).VideoSource, TextureSource: PIXI.TextureSource, Ticker: PIXI.Ticker };

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
let tickTime = 0;

beforeAll(() => {
  vi.stubGlobal('HTMLVideoElement', FakeVideo);
  // 两边的 Ticker.shared 都用 rAF 起循环;node 里没有,给个空实现(帧由测试手动 update)
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  // Pixi 的 load() 会 await detectVideoAlphaMode(用 DOMAdapter 建 WebGL 画布探测);node 里给个拿不到 webgl 的画布,
  // 它按缺省返回 'premultiply-alpha-on-upload'
  PIXI.DOMAdapter.set({ ...PIXI.DOMAdapter.get(), createCanvas: () => ({ getContext: () => null }) } as any);
  tickTime = performance.now() + 1000;
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function track(E: Engine, video: FakeVideo, options: Record<string, unknown> = {}) {
  const src = new E.VideoSource({ ...options, resource: video });
  src.on('update', () => video.log.push('src:update'));
  src.on('resize', () => video.log.push(`src:resize ${src.pixelWidth}x${src.pixelHeight}`));
  return src;
}

function tick(E: Engine): void {
  tickTime += 16;
  E.Ticker.shared.update(tickTime);
}

/** 未就绪 → canplay → autoPlay → rVFC 逐帧 → 暂停 → seeked → canplaythrough → destroy 的整段轨迹 */
async function rvfcStory(E: Engine) {
  const log: string[] = [];
  const snaps: Record<string, unknown> = {};
  const v = new FakeVideoRvfc(log);
  const src = track(E, v);
  // 等构造时的 load() 走完再取 promise:Pixi 的 load() 中途 await 了 alpha 探测,那之前再调 load() 会重进一次
  // (element.load() 两次、前一个 promise 永不 resolve),engine2d 不 await、不重进(见 VideoSource 类注释)
  await flush();
  let loaded: unknown = null;
  src.load().then((s: unknown) => { loaded = s; });
  await flush();
  snaps.constructed = { log: [...log], listeners: v.listenerKeys(), isReady: src.isReady, loaded: loaded === src };
  log.length = 0;

  v.videoWidth = 32;
  v.videoHeight = 16;
  v.readyState = 4;
  v.dispatch('canplay');
  await flush();
  snaps.ready = { log: [...log], listeners: v.listenerKeys(), isReady: src.isReady, loaded: loaded === src, size: [src.width, src.height], pending: v.pendingFrameCallbacks };
  log.length = 0;

  v.frame();
  v.frame();
  snaps.frames = { log: [...log], pending: v.pendingFrameCallbacks };
  log.length = 0;

  v.pause();
  await flush();
  snaps.paused = { log: [...log], pending: v.pendingFrameCallbacks };
  log.length = 0;

  v.dispatch('seeked');
  snaps.seeked = [...log];
  log.length = 0;

  // Pixi 的 _onCanPlayThrough 摘的是 canplay 的回调(照抄):canplaythrough 监听一直挂着,再来一次就再走一遍就绪流程
  v.dispatch('canplaythrough');
  await flush();
  snaps.canplaythrough = { log: [...log], listeners: v.listenerKeys(), pending: v.pendingFrameCallbacks };
  log.length = 0;

  src.destroy();
  await flush();
  v.frame();
  snaps.destroyed = { log: [...log], listeners: v.listenerKeys(), src: v.src, pending: v.pendingFrameCallbacks, destroyed: src.destroyed };
  return snaps;
}

/** 已就绪且正在播放、没有 rVFC:构造时就挂 Ticker.shared,逐 tick 更新,updateFPS 不拦更新(照 Pixi) */
async function tickerStory(E: Engine) {
  const log: string[] = [];
  const snaps: Record<string, unknown> = {};
  const v = new FakeVideo(log);
  v.videoWidth = 20;
  v.videoHeight = 10;
  v.readyState = 4;
  v.paused = false;
  const base = E.Ticker.shared.count;
  const src = track(E, v, { autoPlay: false, updateFPS: 30 });
  await flush();
  snaps.constructed = { log: [...log], ticker: E.Ticker.shared.count - base, isReady: src.isReady, size: [src.pixelWidth, src.pixelHeight] };
  log.length = 0;

  tick(E);
  tick(E);
  snaps.ticks = [...log];
  log.length = 0;

  src.updateFPS = 0;
  snaps.fps0 = { ticker: E.Ticker.shared.count - base, updateFPS: src.updateFPS };
  src.autoUpdate = false;
  snaps.autoUpdateOff = { ticker: E.Ticker.shared.count - base };
  tick(E);
  snaps.noTicks = [...log];
  src.autoUpdate = true;
  snaps.autoUpdateOn = { ticker: E.Ticker.shared.count - base };

  v.pause();
  await flush();
  snaps.paused = { log: [...log], ticker: E.Ticker.shared.count - base };
  log.length = 0;
  v.play();
  await flush();
  snaps.resumed = { log: [...log], ticker: E.Ticker.shared.count - base };
  log.length = 0;

  src.destroy();
  snaps.destroyedLog = [...log];
  const leaked = E.Ticker.shared.count - base;
  if (leaked) E.Ticker.shared.remove(src.updateFrame, src);
  return { snaps, leaked };
}

/** 有 rVFC 但给了 updateFPS:改走 Ticker.shared;updateFPS 改回 0 切回 rVFC */
async function fpsSwitchStory(E: Engine) {
  const log: string[] = [];
  const v = new FakeVideoRvfc(log);
  v.videoWidth = 8;
  v.videoHeight = 8;
  v.readyState = 4;
  const base = E.Ticker.shared.count;
  const src = track(E, v, { updateFPS: 24 });
  await flush();
  const a = { log: [...log], ticker: E.Ticker.shared.count - base, pending: v.pendingFrameCallbacks };
  log.length = 0;
  src.updateFPS = 0;
  const b = { log: [...log], ticker: E.Ticker.shared.count - base, pending: v.pendingFrameCallbacks };
  log.length = 0;
  src.updateFPS = 12;
  const c = { log: [...log], ticker: E.Ticker.shared.count - base, pending: v.pendingFrameCallbacks };
  v.pause();
  await flush();
  const d = { ticker: E.Ticker.shared.count - base, pending: v.pendingFrameCallbacks };
  src.destroy();
  return { a, b, c, d };
}

describe('VideoSource(对照 Pixi 8.17)', () => {
  it('Pixi 参考实现可用(本文件的对照前提)', () => {
    expect(typeof PIXI_REF.VideoSource).toBe('function');
  });

  it('TextureSource.from(video) 路由到 VideoSource;缺省选项同 Pixi(autoGarbageCollect false / uploadMethodId video)', async () => {
    for (const E of [PIXI_REF, ENGINE2D]) {
      const v = new FakeVideo([]);
      const src = E.TextureSource.from(v);
      expect(src, E.name).toBeInstanceOf(E.VideoSource);
      expect(src.autoGarbageCollect, E.name).toBe(false);
      expect(src.uploadMethodId, E.name).toBe('video');
      expect(src.alphaMode, E.name).toBe('premultiply-alpha-on-upload');
      expect(src.autoPlay, E.name).toBe(true);
      expect(src.autoUpdate, E.name).toBe(true);
      expect(src.updateFPS, E.name).toBe(0);
      expect(E.VideoSource.defaultOptions, E.name).toMatchObject({
        autoLoad: true, autoPlay: true, updateFPS: 0, crossorigin: true, loop: false, muted: true, playsinline: true, preload: false,
      });
      expect(E.VideoSource.MIME_TYPES, E.name).toEqual({ ogv: 'video/ogg', mov: 'video/quicktime', m4v: 'video/mp4' });
      await flush();
      src.destroy();
    }
    // Texture.from 同样得到视频源
    const t = Texture.from(new FakeVideo([]) as unknown as HTMLVideoElement);
    expect(t.source).toBeInstanceOf(VideoSource);
    await flush();
    t.destroy(true);
  });

  it('autoLoad: false 不挂监听、不 load;preload: true 不挂 canplay', async () => {
    for (const E of [PIXI_REF, ENGINE2D]) {
      const log: string[] = [];
      const v = new FakeVideo(log);
      const src = track(E, v, { autoLoad: false });
      await flush();
      expect(v.listenerKeys(), E.name).toEqual([]);
      expect(log, E.name).toEqual([]);
      src.destroy();
      const v2 = new FakeVideo([]);
      const src2 = track(E, v2, { preload: true });
      await flush();
      expect(v2.listenerKeys(), E.name).not.toContain('canplay×1');
      expect(v2.listenerKeys(), E.name).toContain('canplaythrough×1');
      src2.destroy();
    }
  });

  it('构造时显式给的 alphaMode 被 load() 覆盖成探测结果(Pixi 的 detectVideoAlphaMode;WebGPU 下恒为 premultiply-alpha-on-upload)', async () => {
    for (const E of [PIXI_REF, ENGINE2D]) {
      for (const alphaMode of ['premultiplied-alpha', 'no-premultiply-alpha']) {
        const src = track(E, new FakeVideo([]), { alphaMode });
        await flush();
        expect(src.alphaMode, `${E.name} ${alphaMode}`).toBe('premultiply-alpha-on-upload');
        src.destroy();
        // autoLoad: false 时构造值保留到 load() 才被覆盖
        const lazy = track(E, new FakeVideo([]), { alphaMode, autoLoad: false });
        await flush();
        expect(lazy.alphaMode, `${E.name} ${alphaMode} lazy`).toBe(alphaMode);
        void lazy.load();
        await flush();
        expect(lazy.alphaMode, `${E.name} ${alphaMode} lazy+load`).toBe('premultiply-alpha-on-upload');
        lazy.destroy();
      }
    }
  });

  it('rVFC 路径:加载 → 自动播放 → 逐帧更新 → 暂停 → seeked → destroy,轨迹与 Pixi 一致', async () => {
    const ours = await rvfcStory(ENGINE2D);
    const pixi = await rvfcStory(PIXI_REF);
    expect(ours).toEqual(pixi);
    // 关键点单独钉住(不只是「和 Pixi 一样」)
    expect((ours.ready as any).log).toEqual(['src:resize 32x16', 'src:update', 'el:play', 'el:rvfc#1']);
    expect((ours.frames as any).log).toEqual(['src:update', 'el:rvfc#2', 'src:update', 'el:rvfc#3']);
    expect((ours.paused as any).log).toEqual(['el:pause', 'el:cancel#3']);
    expect(ours.seeked).toEqual(['src:update']);
    expect((ours.destroyed as any).listeners).toEqual([]);
    expect((ours.destroyed as any).src).toBe('');
  });

  it('Ticker 路径(没有 rVFC):播放中每 tick 更新,暂停 / autoUpdate=false 摘掉,继续播放再挂上', async () => {
    const ours = await tickerStory(ENGINE2D);
    const pixi = await tickerStory(PIXI_REF);
    expect(ours.snaps).toEqual(pixi.snaps);
    expect((ours.snaps.constructed as any).ticker).toBe(1);
    expect(ours.snaps.ticks).toEqual(['src:update', 'src:update']);
    expect(ours.snaps.noTicks).toEqual([]);
    expect((ours.snaps.paused as any).ticker).toBe(0);
    expect((ours.snaps.resumed as any).ticker).toBe(1);
    // 有意差别:Pixi destroy 时不摘 Ticker.shared 的监听(漏一份空转回调),这里摘掉
    expect(pixi.leaked).toBe(1);
    expect(ours.leaked).toBe(0);
  });

  it('有 rVFC 但 updateFPS > 0 走 Ticker;updateFPS 改回 0 切回 rVFC', async () => {
    const ours = await fpsSwitchStory(ENGINE2D);
    const pixi = await fpsSwitchStory(PIXI_REF);
    expect(ours).toEqual(pixi);
    expect(ours.a.ticker).toBe(1);
    expect(ours.a.pending).toBe(0);
    expect(ours.b).toMatchObject({ ticker: 0, pending: 1 });
    expect(ours.c).toMatchObject({ ticker: 1, pending: 0 });
    expect(ours.d).toEqual({ ticker: 0, pending: 0 });
  });

  it('加载失败:error 事件发 error 并让 load() 的 promise 失败', async () => {
    for (const E of [PIXI_REF, ENGINE2D]) {
      const v = new FakeVideo([]);
      // autoLoad 关掉、手动 load():构造里 `void this.load()` 的那个 promise 失败时没人接(两边一样),测试里会报未处理的拒绝
      const src = track(E, v, { autoLoad: false });
      const errors: unknown[] = [];
      src.on('error', (e: unknown) => errors.push(e));
      const p = src.load();
      await flush();
      v.dispatch('error');
      await expect(p, E.name).rejects.toEqual({ type: 'error' });
      expect(errors, E.name).toEqual([{ type: 'error' }]);
      expect(v.listenerKeys(), E.name).not.toContain('error:capture×1');
      src.destroy();
    }
  });
});

describe('VideoSource 上 GPU(空后端)', () => {
  it('每解码一帧重传一次;没有新帧不重传;纹理可作附件(copyExternalImage 要求);空闲回收不收', async () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const upload = vi.spyOn(rhi, 'uploadImage');
    const v = new FakeVideoRvfc([]);
    v.videoWidth = 16;
    v.videoHeight = 16;
    v.readyState = 4;
    const src = new VideoSource({ resource: v as unknown as HTMLVideoElement });
    await flush();
    const root = new Container();
    root.addChild(new Sprite(new Texture({ source: src })));
    renderer.render({ container: root });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][2]).toEqual({ premultiplyAlpha: true });
    const desc = createTexture.mock.calls.map((c) => c[1]).find((d) => d.width === 16 && d.height === 16)!;
    expect(desc.usage & RhiTextureUsage.RENDER_TARGET).toBeTruthy();
    renderer.render({ container: root });
    expect(upload).toHaveBeenCalledTimes(1);
    v.frame();
    renderer.render({ container: root });
    expect(upload).toHaveBeenCalledTimes(2);
    renderer.destroy();
    src.destroy();

    // 空闲回收:ImageSource 包视频会被收,VideoSource 不收(同 Pixi 的 autoGarbageCollect 缺省)
    const rhi2 = new NullRhiDevice();
    const gpu = new GpuTextures(rhi2, rhi2.createScope('t'), { now: 0 });
    const v2 = new FakeVideo([]);
    v2.videoWidth = 4;
    v2.videoHeight = 4;
    v2.readyState = 4;
    const vs = new VideoSource({ resource: v2 as unknown as HTMLVideoElement, autoPlay: false });
    const is = new ImageSource({ resource: v2 as unknown as HTMLVideoElement });
    gpu.get(vs);
    gpu.get(is);
    gpu.collect(1e9, 60_000);
    expect(gpu.has(vs)).toBe(true);
    expect(gpu.has(is)).toBe(false);
    gpu.destroy();
    vs.destroy();
  });
});
