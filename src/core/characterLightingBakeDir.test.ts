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
});
