/**
 * `CharacterLightingSystem.load` 的 `bakeDirOverride`（工具用）：给了就只认那个目录，不按场景 id + 背景图名推导、
 * 不回落扁平布局 / 几何借用；不给时与原来逐个请求相同（游戏从不传它）。
 * 角色照明实验室把「工作台按游戏载荷格式现场变换的虚拟目录」经它交给游戏同一个装载器。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterLightingSystem } from './CharacterLightingSystem';

function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (u: string) => {
    urls.push(String(u));
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe('CharacterLightingSystem.load 的烘焙目录', () => {
  const presentMeta = {
    version: 3, background_sha1: 'baked-hash', work: { w: 1, h: 1 },
    cal: { theta: 0, ppu: 1, cx: 0, cy: 0 },
    world: { M: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 },
    probes: { nx: 1, ny: 1, nz: 1 },
    vol: { nx: 1, ny: 1, nz: 1, tiles_x: 1, tiles_y: 1, qx_min: 0, qx_max: 1, qy_min: 0, qy_max: 1, qz_min: 0, qz_max: 1 },
    ambient_sh: [], lights: [], ground_d: { min: 0, max: 1 },
  };
  it('不给 override：按背景图名的目录 → 扁平布局 → 几何借用目录，逐个试（与游戏原行为相同）', async () => {
    const urls = stubFetch();
    const cl = new CharacterLightingSystem();
    await cl.load('s1', 800, 450, 'night.png', 'background.png');
    expect(urls).toEqual([
      '/resources/runtime/scenes/s1/lighting/night/lighting.json',
      '/resources/runtime/scenes/s1/lighting/lighting.json',
      '/resources/runtime/scenes/s1/lighting/background/lighting.json',
    ]);
    expect(cl.active).toBe(false);
  });

  it('给了 override：只取那个目录，不回落、不借几何', async () => {
    const urls = stubFetch();
    const cl = new CharacterLightingSystem();
    await cl.load('s1', 800, 450, 'night.png', 'background.png', '/api/game_payload/s1/n0-a1.000');
    expect(urls).toEqual(['/api/game_payload/s1/n0-a1.000/lighting.json']);
    expect(cl.active).toBe(false);
  });

  it('默认未烘入口仍可降级，strict显式目录缺入口必须报失败', async () => {
    stubFetch();
    const cl = new CharacterLightingSystem();
    await cl.load('s1', 800, 450, 'background.png', undefined, undefined, { strict: true });
    expect(cl.active).toBe(false);
    await expect(cl.load('s1', 800, 450, 'background.png', undefined, '/explicit', { strict: true })).rejects.toThrow(/explicitly requested/);
    cl.destroy();
  });

  it('取消旧角色请求后不会继续尝试legacy目录或发出ready，新请求独立完成', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      if (url.includes('/old/')) return new Promise<Response>(() => {});
      return Promise.resolve(new Response('nope', { status: 404 }));
    });
    const cl = new CharacterLightingSystem();
    cl.onReady = vi.fn();
    const old = cl.load('old', 800, 450).catch((error) => error);
    await cl.load('new', 800, 450);
    expect(await old).toMatchObject({ name: 'AbortError' });
    expect(urls.filter((url) => url.includes('/old/'))).toHaveLength(1);
    expect(cl.onReady).not.toHaveBeenCalled();
    expect(cl.active).toBe(false);
    cl.destroy();
  });

  it('发现入口后缺必需probe图集不能报ready，strict返回真实失败', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/lighting.json')) return Response.json(presentMeta);
      if (url.endsWith('/background.png')) return new Response('background');
      return new Response('not found', { status: 404 });
    });
    const cl = new CharacterLightingSystem();
    cl.onReady = vi.fn();
    await expect(cl.load('s', 800, 450, 'background.png', undefined, undefined, { strict: true })).rejects.toThrow(/atlas_bin\.bin.*404/);
    expect(cl.onReady).not.toHaveBeenCalled();
    expect(cl.active).toBe(false);
    expect(cl.groundDepthField).toBeNull();
    cl.destroy();
  });

  it('旧哈希门被取消后不得把新载荷的stale标记写成true', async () => {
    let hashStarted!: () => void;
    const started = new Promise<void>((resolve) => { hashStarted = resolve; });
    vi.stubGlobal('fetch', (url: string) => {
      if (url.includes('/old/') && url.endsWith('/lighting.json')) return Promise.resolve(Response.json(presentMeta));
      if (url.includes('/old/') && url.endsWith('/background.png')) {
        hashStarted();
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const cl = new CharacterLightingSystem();
    const old = cl.load('old', 800, 450).catch((error) => error);
    await started;
    await cl.load('new', 800, 450);
    expect(await old).toMatchObject({ name: 'AbortError' });
    expect(cl.isPayloadStale).toBe(false);
    expect(cl.active).toBe(false);
    cl.destroy();
  });
});
