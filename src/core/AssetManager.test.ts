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
