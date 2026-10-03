/**
 * Assets 与 pixi.js 8.17 对照(主线程解码路径):同一串 load / get / unload 分别在 Pixi 的 Assets 与
 * engine2d 的 Assets 上跑,用同一个假 fetch / 假 createImageBitmap 记账,比较
 * - 抓了哪些地址(绝对地址,含去重)、
 * - createImageBitmap 收到的参数(**参数个数**与选项,"不带选项"与"带 undefined"要分得清)、
 * - 生成的 TextureSource 的 alphaMode / resolution / 尺寸 / label,纹理的缓存键与卸载后状态。
 * Worker 路径见 WorkerManager.test.ts。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { Assets } from './Assets';
import { loadTextures, loadImageBitmap } from './loader/parsers/loadTextures';
import { DOMAdapter, type Adapter } from '../environment/adapter';
import { Texture } from '../textures/Texture';
import { AssetManager } from '../../core/AssetManager';
import { Sprite } from '../sprite/Sprite';
import { Rectangle } from '../math/Rectangle';
import { resolveAssetPath } from '../../core/assetPath';

const BASE = 'http://localhost:5173/game/index.html';

interface Env {
  fetches: string[];
  bitmaps: Array<{ url: string; argc: number; options: unknown }>;
}

const env: Env = { fetches: [], bitmaps: [] };

class FakeBlob {
  constructor(readonly url: string) {}
}

/** 地址里带 `WxH` 就按它给位图尺寸,否则 64×32 */
function sizeOf(url: string): { width: number; height: number } {
  const m = /(\d+)x(\d+)/.exec(url.split('/').pop() ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 64, height: 32 };
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  env.fetches.push(url);
  if (url.includes('missing')) {
    return { ok: false, status: 404, statusText: 'Not Found' } as Response;
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    blob: async () => new FakeBlob(url),
    json: async () => ({ from: url }),
    text: async () => `text:${url}`,
  } as unknown as Response;
}

async function fakeCreateImageBitmap(...args: unknown[]): Promise<ImageBitmap> {
  const blob = args[0] as FakeBlob;
  env.bitmaps.push({ url: blob.url, argc: args.length, options: args[1] });
  return { ...sizeOf(blob.url), close() {} } as unknown as ImageBitmap;
}

/** 两边共用的操作序列;返回可比较的快照 */
interface LibUnderTest {
  load: (u: unknown) => Promise<unknown>;
  get: (k: string) => unknown;
  unload: (u: unknown) => Promise<void>;
  hasCache: (k: string) => boolean;
}

interface SourceSnapshot {
  label: string;
  alphaMode: string;
  resolution: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  uploadMethodId: string;
  autoGarbageCollect: boolean;
  scaleMode: string;
}

function snapTexture(t: unknown): { label: string; width: number; height: number; source: SourceSnapshot } {
  const tex = t as {
    label: string;
    width: number;
    height: number;
    source: SourceSnapshot & { style: { magFilter: string } };
  };
  const s = tex.source;
  return {
    label: tex.label,
    width: tex.width,
    height: tex.height,
    source: {
      label: s.label,
      alphaMode: s.alphaMode,
      resolution: s.resolution,
      width: s.width,
      height: s.height,
      pixelWidth: s.pixelWidth,
      pixelHeight: s.pixelHeight,
      uploadMethodId: s.uploadMethodId,
      autoGarbageCollect: s.autoGarbageCollect,
      scaleMode: s.style.magFilter,
    },
  };
}

async function runScenario(lib: LibUnderTest): Promise<Record<string, unknown>> {
  env.fetches = [];
  env.bitmaps = [];
  const out: Record<string, unknown> = {};

  // 1. 普通图片(相对地址)
  const plain = await lib.load('./assets/images/ui/icon.png');
  out.plain = snapTexture(plain);
  out.plainCached = lib.get('./assets/images/ui/icon.png') === plain;

  // 2. @2x 从文件名读分辨率(根相对地址)
  out.retina = snapTexture(await lib.load('/runtime/scenes/a/bg@2x-200x100.png'));

  // 3. 法线图集:alpha 当数据,{ src, data: { alphaMode: 'premultiplied-alpha' } }
  out.normal = snapTexture(await lib.load({ src: './assets/anim/hero.normal.png', data: { alphaMode: 'premultiplied-alpha' } }));

  // 4. data.resolution 覆盖文件名;data 里的其它 TextureSource 参数照传
  out.resOverride = snapTexture(await lib.load({ src: './assets/x@2x.jpg', data: { resolution: 3, scaleMode: 'nearest' } }));

  // 5. 同一地址并发:只抓一次,拿到同一个纹理
  const [a, b] = await Promise.all([lib.load('./assets/same.webp'), lib.load('./assets/same.webp')]);
  out.concurrentSame = a === b;

  // 6. 数组形式 + 带别名
  const many = (await lib.load(['./assets/m1.png', './assets/m2.avif'])) as Record<string, unknown>;
  out.manyKeys = Object.keys(many).sort();
  await lib.load({ alias: 'heroAlias', src: './assets/alias-target.png' });
  out.aliasCached = lib.hasCache('heroAlias') && lib.hasCache('./assets/alias-target.png');

  // 7. 已登记过的键再用 {src,data} 装:不覆盖原登记(先到先得)
  const again = await lib.load({ src: './assets/images/ui/icon.png', data: { alphaMode: 'premultiplied-alpha' } });
  out.secondDataIgnored = again === plain && snapTexture(again).source.alphaMode;

  // 8. JSON 走 loadJson
  out.json = await lib.load('./assets/data/cfg.json');

  // 9. 抓取失败 → 抛错,且不留缓存
  try {
    await lib.load('./assets/missing.png');
    out.missing = 'no-throw';
  } catch (e) {
    out.missing = String((e as Error).message).split('\n')[0];
  }
  out.missingCached = lib.hasCache('./assets/missing.png');

  // 10. 卸载:缓存摘掉、纹理与源销毁
  await lib.unload('./assets/same.webp');
  out.unloaded = {
    cached: lib.hasCache('./assets/same.webp'),
    texDestroyed: (a as { destroyed: boolean }).destroyed,
  };

  out.fetches = env.fetches;
  out.bitmaps = env.bitmaps;
  return out;
}

let e2dAdapter0: Adapter;
let pixiAdapter0: ReturnType<typeof PIXI.DOMAdapter.get>;

beforeAll(() => {
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('createImageBitmap', fakeCreateImageBitmap);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  pixiAdapter0 = PIXI.DOMAdapter.get();
  PIXI.DOMAdapter.set({ ...pixiAdapter0, getBaseUrl: () => BASE, fetch: fakeFetch as never });
  e2dAdapter0 = DOMAdapter.get();
  DOMAdapter.set({ ...e2dAdapter0, getBaseUrl: () => BASE, fetch: fakeFetch as never });
  // Pixi 的视频格式探测要 document.createElement('video'),node 里没有;engine2d 也不移植它(不装载视频)
  for (const d of [PIXI.detectMp4, PIXI.detectOgv, PIXI.detectWebm]) {
    const i = PIXI.Assets.detections.indexOf(d);
    if (i >= 0) PIXI.Assets.detections.splice(i, 1);
  }
  // 主线程路径(node 里没有 Worker);Worker 路径另测
  PIXI.Assets.setPreferences({ preferWorkers: false });
  Assets.setPreferences({ preferWorkers: false });
});

afterAll(() => {
  PIXI.DOMAdapter.set(pixiAdapter0);
  DOMAdapter.set(e2dAdapter0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Assets(对照 pixi.js 8.17)', () => {
  let pixiResult: Record<string, unknown>;
  let e2dResult: Record<string, unknown>;

  beforeAll(async () => {
    pixiResult = await runScenario({
      load: (u) => PIXI.Assets.load(u as string),
      get: (k) => PIXI.Assets.get(k),
      unload: (u) => PIXI.Assets.unload(u as string),
      hasCache: (k) => PIXI.Cache.has(k),
    });
    e2dResult = await runScenario({
      load: (u) => Assets.load(u as string),
      get: (k) => Assets.get(k),
      unload: (u) => Assets.unload(u as string),
      hasCache: (k) => Assets.cache.has(k),
    });
  });

  it('整串操作的结果与 Pixi 逐项相同', () => {
    expect(e2dResult).toEqual(pixiResult);
  });

  it('抓的都是按 getBaseUrl 解析的绝对地址,并发同址只抓一次', () => {
    const imageFetches = (e2dResult.fetches as string[]).filter((u) => !u.startsWith('data:'));
    expect(imageFetches).toContain('http://localhost:5173/game/assets/images/ui/icon.png');
    expect(imageFetches).toContain('http://localhost:5173/runtime/scenes/a/bg@2x-200x100.png');
    expect(imageFetches.filter((u) => u.endsWith('same.webp')).length).toBe(1);
    expect(e2dResult.concurrentSame).toBe(true);
  });

  it('createImageBitmap:缺省**不带选项**(浏览器解码期预乘);alphaMode=premultiplied-alpha 时 premultiplyAlpha:none', () => {
    const bitmaps = (e2dResult.bitmaps as Env['bitmaps']).filter((b) => !b.url.startsWith('data:'));
    const icon = bitmaps.find((b) => b.url.endsWith('icon.png'))!;
    expect(icon.argc).toBe(1);
    expect(icon.options).toBeUndefined();
    const normal = bitmaps.find((b) => b.url.endsWith('hero.normal.png'))!;
    expect(normal.argc).toBe(2);
    expect(normal.options).toEqual({ premultiplyAlpha: 'none' });
  });

  it('TextureSource:alphaMode 缺省 premultiply-alpha-on-upload,data 覆盖;resolution 取 data 或文件名 @Nx', () => {
    const plain = e2dResult.plain as ReturnType<typeof snapTexture>;
    expect(plain.source.alphaMode).toBe('premultiply-alpha-on-upload');
    expect(plain.source.resolution).toBe(1);
    expect(plain.source.label).toBe('http://localhost:5173/game/assets/images/ui/icon.png');
    expect(plain.label).toBe(plain.source.label);
    const retina = e2dResult.retina as ReturnType<typeof snapTexture>;
    expect(retina.source.resolution).toBe(2);
    expect([retina.width, retina.height, retina.source.pixelWidth, retina.source.pixelHeight]).toEqual([100, 50, 200, 100]);
    const normal = e2dResult.normal as ReturnType<typeof snapTexture>;
    expect(normal.source.alphaMode).toBe('premultiplied-alpha');
    const over = e2dResult.resOverride as ReturnType<typeof snapTexture>;
    expect(over.source.resolution).toBe(3);
    expect(over.source.scaleMode).toBe('nearest');
    expect(e2dResult.secondDataIgnored).toBe('premultiply-alpha-on-upload');
  });

  it('失败抛错且不入缓存;卸载后缓存摘掉、纹理销毁', () => {
    expect(String(e2dResult.missing)).toContain('[Loader.load] Failed to load http://localhost:5173/game/assets/missing.png.');
    expect(e2dResult.missingCached).toBe(false);
    expect(e2dResult.unloaded).toEqual({ cached: false, texDestroyed: true });
  });

  it('Texture.from(已载入的键) 查 Assets 缓存', async () => {
    const tex = await Assets.load<Texture>('./assets/from-cache.png');
    expect(Texture.from('./assets/from-cache.png')).toBe(tex);
    expect(() => Texture.from('./assets/never-loaded.png')).toThrow();
  });
});

describe('loadTextures 单独对照', () => {
  it('合法lease最后释放不触发绕过Assets销毁告警，真正直接销毁仍然告警', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new AssetManager();
    let sprite: Sprite | null = null;
    try {
      const root = await manager.loadTexture('/ordered-lease-release.png');
      const source = root.source;
      const close = vi.spyOn(source.resource as ImageBitmap, 'close');
      sprite = new Sprite(new Texture({ source, frame: new Rectangle(0, 0, 16, 16) }));
      manager.dispose();
      expect(source.destroyed).toBe(false);
      sprite.destroy();
      expect(source.destroyed).toBe(true);
      expect(root.destroyed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      expect(Assets.cache.has(resolveAssetPath('/ordered-lease-release.png'))).toBe(false);
      expect(Assets.loader.promiseCache[root.label!]).toBeUndefined();
      const assetWarnings = (): unknown[][] => warnings.mock.calls.filter(args => args.some(arg => String(arg).includes('managed by Assets was destroyed instead of unloaded')));
      expect(assetWarnings()).toHaveLength(0);

      const direct = await Assets.load<Texture>('/direct-wrapper-destroy.png');
      const directSource = direct.source;
      const bitmap = directSource.resource as ImageBitmap;
      direct.destroy(false);
      expect(assetWarnings()).toHaveLength(1);
      expect(String(assetWarnings()[0])).toContain('A Texture managed by Assets');
      expect(directSource.destroyed).toBe(false);
      Assets.cache.removeValue(direct);
      directSource.destroy();
      bitmap.close();
    } finally {
      sprite?.destroy();
      manager.dispose();
      warnings.mockRestore();
    }
  });

  it('场景LRU不能关闭仍被UI子纹理绑定的CPU源，同源换帧后新manager能接管缓存', async () => {
    const firstManager = new AssetManager({ texture: { entries: 1 } });
    const path = '/ui-view-lease.png';
    const cacheKey = resolveAssetPath(path);
    await firstManager.preloadManifest({ scopeId: 'scene-ui', refs: [{ type: 'texture', path }] });
    const root = firstManager.getTexture(path)!;
    const source = root.source;
    const close = vi.spyOn(source.resource as ImageBitmap, 'close');
    const firstFrame = new Texture({ source, frame: new Rectangle(0, 0, 16, 16) });
    const secondFrame = new Texture({ source, frame: new Rectangle(16, 0, 16, 16) });
    const portrait = new Sprite(firstFrame);
    firstManager.releaseScope('scene-ui');
    await firstManager.preloadManifest({ scopeId: 'scene-next', refs: [{ type: 'texture', path: '/ui-view-lease-next.png' }] });
    expect(firstManager.getTexture(path)).toBeNull();
    expect(source.destroyed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(Assets.get(cacheKey)).toBe(root);
    expect(Assets.getTextureLeaseStats().deferredSources).toBeGreaterThan(0);
    portrait.texture = secondFrame;
    expect(source.destroyed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    const secondManager = new AssetManager();
    expect(await secondManager.loadTexture(path)).toBe(root);
    firstManager.dispose();
    portrait.destroy();
    expect(root.destroyed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    secondManager.dispose();
    expect(source.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(Assets.cache.has(cacheKey)).toBe(false);
    expect(Assets.loader.promiseCache[root.label!]).toBeUndefined();
    firstFrame.destroy();
    secondFrame.destroy();
  });

  it('manager已退出时最后Sprite换图才关闭旧源、摘全局缓存并允许重新解码', async () => {
    const manager = new AssetManager();
    const path = '/deferred-view-release.png';
    const cacheKey = resolveAssetPath(path);
    const root = await manager.loadTexture(path);
    const source = root.source;
    const close = vi.spyOn(source.resource as ImageBitmap, 'close');
    const portrait = new Sprite(root);
    manager.dispose();
    expect(source.destroyed).toBe(false);
    expect(Assets.get(cacheKey)).toBe(root);
    portrait.texture = Texture.EMPTY;
    expect(source.destroyed).toBe(true);
    expect(root.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(Assets.cache.has(cacheKey)).toBe(false);
    expect(Assets.loader.promiseCache[root.label!]).toBeUndefined();
    const nextManager = new AssetManager();
    const next = await nextManager.loadTexture(path);
    expect(next).not.toBe(root);
    expect(next.source.destroyed).toBe(false);
    nextManager.dispose();
    portrait.destroy();
  });

  it('跨游戏管理器共享CPU源，最后owner销毁才摘Loader/Cache并关闭位图', async () => {
    const a = new AssetManager();
    const b = new AssetManager();
    const first = await a.loadTexture('/lease-shared.png');
    const second = await b.loadTexture('/lease-shared.png');
    expect(second).toBe(first);
    const close = vi.spyOn(first.source.resource as ImageBitmap, 'close');
    a.dispose();
    expect(first.destroyed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    b.dispose();
    expect(first.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(Assets.cache.has(resolveAssetPath('/lease-shared.png'))).toBe(false);
    expect(Assets.loader.promiseCache[first.label!]).toBeUndefined();
  });

  it('零scope的场景纹理LRU淘汰真正关闭CPU位图，重新进入重新载入有效源', async () => {
    const assets = new AssetManager({ texture: { entries: 1 } });
    await assets.preloadManifest({ scopeId: 'first', refs: [{ type: 'texture', path: '/scoped-first.png' }] });
    const first = assets.getTexture('/scoped-first.png')!;
    const close = vi.spyOn(first.source.resource as ImageBitmap, 'close');
    assets.releaseScope('first');
    await assets.preloadManifest({ scopeId: 'second', refs: [{ type: 'texture', path: '/scoped-second.png' }] });
    expect(first.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(Assets.cache.has(resolveAssetPath('/scoped-first.png'))).toBe(false);
    assets.releaseScope('second');
    await assets.preloadManifest({ scopeId: 'first-again', refs: [{ type: 'texture', path: '/scoped-first.png' }] });
    expect(assets.getTexture('/scoped-first.png')).not.toBe(first);
    expect(assets.getTexture('/scoped-first.png')!.source.destroyed).toBe(false);
    assets.dispose();
  });

  it('解码超时之后同URL能重试，迟到的旧bitmap关闭且不能删新资源', async () => {
    vi.useFakeTimers();
    let finishOld!: (bitmap: ImageBitmap) => void;
    const bitmapSpy = vi.spyOn(globalThis, 'createImageBitmap').mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    try {
      const first = Assets.load<Texture>('/decode-timeout.png', { timeoutMs: 20 });
      const rejected = expect(first).rejects.toThrow('Failed to load');
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      const retry = await Assets.load<Texture>('/decode-timeout.png', { timeoutMs: 100 });
      const close = vi.fn();
      finishOld({ width: 1, height: 1, close } as unknown as ImageBitmap);
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);
      expect(Assets.get('/decode-timeout.png')).toBe(retry);
      expect(retry.destroyed).toBe(false);
      await Assets.unload('/decode-timeout.png');
    } finally { bitmapSpy.mockRestore(); vi.useRealTimers(); }
  });
  it('config 缺省值、test() 的扩展名 / data: 判定与 Pixi 相同', () => {
    expect(loadTextures.config).toEqual({ preferWorkers: false, preferCreateImageBitmap: true, crossOrigin: 'anonymous' });
    expect(PIXI.loadTextures.config).toEqual(loadTextures.config);
    const urls = [
      'a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.webp', 'a.avif', 'a.gif', 'a.svg', 'a.png?v=3', 'a.json',
      'data:image/png;base64,AAAA', 'data:image/webp;base64,AAAA', 'data:text/plain,hi', 'dir.png/file', 'a.normal.png',
    ];
    for (const u of urls) {
      expect(loadTextures.test!(u), u).toBe(PIXI.loadTextures.test!(u));
    }
  });

  it('loadImageBitmap 与 Pixi 的同名函数给 createImageBitmap 的参数相同', async () => {
    const cases = [undefined, { data: {} }, { data: { alphaMode: 'premultiplied-alpha' } }, { data: { alphaMode: 'no-premultiply-alpha' } }];
    for (const asset of cases) {
      env.bitmaps = [];
      await PIXI.loadImageBitmap('http://h/x.png', asset as never);
      const pixi = env.bitmaps.slice();
      env.bitmaps = [];
      await loadImageBitmap('http://h/x.png', asset as never);
      expect(env.bitmaps, JSON.stringify(asset)).toEqual(pixi);
    }
  });
});
