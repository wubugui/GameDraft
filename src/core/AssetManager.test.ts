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
});
