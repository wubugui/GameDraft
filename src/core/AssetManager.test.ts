import { AssetManager } from './AssetManager';

describe('AssetManager.loadSceneData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a fresh scene data copy so runtime mutations cannot pollute json cache', async () => {
    const sceneRaw = {
      id: 'cache_probe',
      name: 'Cache Probe',
      worldWidth: 100,
      worldHeight: 80,
      spawnPoint: { x: 1, y: 2 },
      backgrounds: [{ image: 'background.png' }],
      hotspots: [
        {
          id: 'crate',
          type: 'inspect',
          x: 10,
          y: 20,
          interactionRange: 50,
          data: { text: '' },
          displayImage: {
            image: 'crate_a.png',
            worldWidth: 30,
            worldHeight: 40,
          },
        },
      ],
      npcs: [],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => sceneRaw,
    } as Response);

    const assets = new AssetManager();
    const first = await assets.loadSceneData('cache_probe');
    first.hotspots![0]!.x = 999;
    first.hotspots![0]!.displayImage = {
      image: 'runtime_only.png',
      worldWidth: 1,
      worldHeight: 1,
    };

    const second = await assets.loadSceneData('cache_probe');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.hotspots![0]!.x).toBe(10);
    expect(second.hotspots![0]!.displayImage?.image).toBe('crate_a.png');
  });
});

describe('AssetManager unified cache', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deduplicates concurrent loads for the same resource', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(fetchPromise);

    const assets = new AssetManager();
    const a = assets.loadJson('/assets/data/a.json');
    const b = assets.loadJson('/assets/data/a.json');

    resolveFetch({
      ok: true,
      json: async () => ({ id: 'a' }),
    } as Response);

    await expect(Promise.all([a, b])).resolves.toEqual([{ id: 'a' }, { id: 'a' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('supports synchronous cache reads without triggering loads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'cached' }),
    } as Response);

    const assets = new AssetManager();
    expect(assets.getJson('/assets/data/cached.json')).toBeNull();
    await assets.loadJson('/assets/data/cached.json');
    expect(assets.getJson<{ id: string }>('/assets/data/cached.json')?.id).toBe('cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps pinned resources through LRU pressure and evicts them after release', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ({
      ok: true,
      json: async () => ({ path: String(path) }),
    } as Response));

    const assets = new AssetManager({ json: { entries: 1 } });
    await assets.loadJson('/assets/data/a.json');
    assets.pinScope('scope:a', [{ type: 'json', path: '/assets/data/a.json' }]);

    await assets.loadJson('/assets/data/b.json');
    expect(assets.getJson('/assets/data/a.json')).not.toBeNull();
    expect(assets.getJson('/assets/data/b.json')).toBeNull();

    assets.releaseScope('scope:a');
    await assets.loadJson('/assets/data/c.json');

    expect(assets.getJson('/assets/data/a.json')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preloadManifest pins loaded resources under its scope', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ({
      ok: true,
      json: async () => ({ path: String(path) }),
    } as Response));

    const assets = new AssetManager({ json: { entries: 1 } });
    await assets.preloadManifest({
      scopeId: 'scene:test',
      refs: [
        { type: 'json', path: '/assets/data/a.json' },
        { type: 'json', path: '/assets/data/b.json' },
      ],
    });

    expect(assets.getStats().json.entries).toBe(2);
    expect(assets.getStats().json.pinned).toBe(2);

    assets.releaseScope('scene:test');
    await assets.loadJson('/assets/data/c.json');
    expect(assets.getStats().json.entries).toBe(1);
  });

  it('dropJson：丢掉之后 loadJson 重新读盘（粒子工作台撤销覆盖要的是盘上此刻那份，不是开局缓存的）', async () => {
    let version = 1;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ version }),
    } as Response));
    const assets = new AssetManager();
    expect(await assets.loadJson('/assets/data/vfx/fx.json')).toEqual({ version: 1 });
    version = 2;                                          // 作者在工作台里存了盘
    expect(await assets.loadJson('/assets/data/vfx/fx.json')).toEqual({ version: 1 });   // 不丢就是开局那份
    expect(assets.dropJson('/assets/data/vfx/fx.json')).toBe(true);
    expect(assets.getJson('/assets/data/vfx/fx.json')).toBeNull();
    expect(await assets.loadJson('/assets/data/vfx/fx.json')).toEqual({ version: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assets.dropJson('/assets/data/vfx/nope.json')).toBe(false);
  });

  it('dropJson：被 scope pin 住的也丢（JSON 不占显存），重读后 pin 从 scope 表补回来', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ({
      ok: true,
      json: async () => ({ path: String(path) }),
    } as Response));
    const assets = new AssetManager();
    await assets.preloadManifest({ scopeId: 'scene:x', refs: [{ type: 'json', path: '/assets/data/a.json' }] });
    expect(assets.getStats().json.pinned).toBe(1);
    expect(assets.dropJson('/assets/data/a.json')).toBe(true);
    expect(assets.getStats().json.entries).toBe(0);
    await assets.loadJson('/assets/data/a.json');
    expect(assets.getStats().json.pinned).toBe(1);
  });

  it('取消一个消费者不会取消同 URL 的其它消费者，也不会重复请求', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const assets = new AssetManager();
    const cancel = new AbortController();
    const first = assets.loadJson('/shared.json', { signal: cancel.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = assets.loadJson('/shared.json');
    await Promise.resolve(); await Promise.resolve();
    cancel.abort();
    await firstRejected;
    finish(new Response('{"ready":true}', { headers: { 'content-type': 'application/json' } }));
    await expect(second).resolves.toEqual({ ready: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assets.getJson('/shared.json')).toEqual({ ready: true });
    assets.dispose();
  });

  it('最后消费者取消会中止真实I/O与队列，释放并发槽且同URL立即可重试', async () => {
    const aborted: string[] = [];
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      calls.push(String(url));
      if (calls.length > 1) return Promise.resolve(new Response('{"ready":true}'));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted.push(String(url)); reject(init.signal?.reason); }, { once: true });
      });
    });
    const assets = new AssetManager({}, { concurrency: 1 });
    const firstCancel = new AbortController();
    const queuedCancel = new AbortController();
    const first = assets.loadJson('/cancel-shared.json', { signal: firstCancel.signal });
    const queued = assets.loadJson('/old-queued.json', { signal: queuedCancel.signal });
    const rejected = Promise.allSettled([first, queued]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    queuedCancel.abort();
    firstCancel.abort();
    expect((await rejected).every(result => result.status === 'rejected')).toBe(true);
    await expect(assets.loadJson('/cancel-shared.json')).resolves.toEqual({ ready: true });
    expect(aborted).toEqual(['./cancel-shared.json']);
    expect(calls).not.toContain('./old-queued.json');
    assets.dispose();
  });

  it('超时封口后可重试，晚到的旧产物不能覆盖新缓存', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let oldFinish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve; }))
      .mockResolvedValue(new Response('{"version":2}'));
    const assets = new AssetManager({}, { timeoutMs: 20 });
    const first = assets.loadJson('/retry.json');
    const rejection = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    await expect(assets.loadJson('/retry.json')).resolves.toEqual({ version: 2 });
    oldFinish(new Response('{"version":1}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(assets.getJson('/retry.json')).toEqual({ version: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    assets.dispose();
  });

  it('并发上限同时约束所有批次，dispose终止排队及在途消费者', async () => {
    let active = 0;
    let peak = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      active++; peak = Math.max(peak, active);
      init?.signal?.addEventListener('abort', () => { active--; reject(init.signal?.reason); }, { once: true });
    }));
    const assets = new AssetManager({}, { concurrency: 2 });
    const requests = Array.from({ length: 8 }, (_, i) => assets.loadJson(`/queued-${i}.json`));
    const settled = Promise.allSettled(requests);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(peak).toBe(2);
    assets.dispose();
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    expect(active).toBe(0);
    expect(assets.getStats().json.entries).toBe(0);
    await expect(assets.loadJson('/after-dispose.json')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('可选资源失败有独立进度，必需失败拒绝并释放scope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).includes('missing')) throw new Error('missing');
      return new Response('{"ok":true}');
    });
    const assets = new AssetManager();
    const statuses: string[] = [];
    const result = await assets.preloadManifest({ scopeId: 'optional', refs: [
      { type: 'json', path: '/good.json' }, { type: 'json', path: '/missing-optional.json', optional: true },
    ] }, { onItemProgress: progress => statuses.push(progress.status) });
    expect(result).toMatchObject({ loaded: 1, optionalFailed: 1, requiredFailed: 0 });
    expect(statuses).toContain('optional-failed');
    await expect(assets.preloadManifest({ scopeId: 'required', refs: [
      { type: 'json', path: '/required-good.json' }, { type: 'json', path: '/missing-required.json' },
    ] })).rejects.toMatchObject({ name: 'AssetPreloadError' });
    expect((assets as unknown as { scopeRefs: Map<string, unknown> }).scopeRefs.has('required')).toBe(false);
    assets.dispose();
  });
});

describe('AssetManager.loadOptionalJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) =>
      handler(String(input), init)));
  }

  it('dev server 的 SPA 兜底（200 + text/html）当作"文件不存在"，不报错也不刷红条', async () => {
    // 实测：Vite 对缺失的 /…/sockets.json 回 200 + index.html，所以判据必须是 content-type。
    // 只看 res.ok 会放行 → response.json() 撞 <!DOCTYPE 抛错 → reportDevError 刷屏。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => new Response('<!DOCTYPE html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const am = new AssetManager();
    await expect(am.loadOptionalJson('/resources/runtime/animation/x/sockets.json')).resolves.toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('真 404（静态托管）同样安静返回 null', async () => {
    stubFetch(() => new Response('', { status: 404 }));
    const am = new AssetManager();
    await expect(am.loadOptionalJson('/nope.json')).resolves.toBeNull();
  });

  it('网络层直接失败也当"没有这个可选文件"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const am = new AssetManager();
    await expect(am.loadOptionalJson('/nope.json')).resolves.toBeNull();
  });

  it('content-type 是 JSON 时正常载入并进缓存', async () => {
    const payload = { schemaVersion: 1, sockets: {} };
    stubFetch((_url, init) => (init?.method === 'HEAD'
      ? new Response('', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify(payload), {
        status: 200, headers: { 'content-type': 'application/json' },
      })));
    const am = new AssetManager();
    await expect(am.loadOptionalJson('/real.json')).resolves.toEqual(payload);
    // 第二次读缓存，不再发请求
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await expect(am.loadOptionalJson('/real.json')).resolves.toEqual(payload);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });
});
