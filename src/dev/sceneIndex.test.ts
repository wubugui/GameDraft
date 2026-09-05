import { describe, expect, it } from 'vitest';

import { SCENE_INDEX_URL, fetchSceneIndex, normalizeSceneIndex } from './sceneIndex';

function response(body: unknown, init: { ok?: boolean; type?: string } = {}): Response {
  const headers = new Headers({ 'content-type': init.type ?? 'application/json' });
  return { ok: init.ok ?? true, headers, json: async () => body } as unknown as Response;
}

describe('normalizeSceneIndex', () => {
  it('丢掉缺 id 的条目，name 缺省回落到 id，spawnPoints 只留非空串', () => {
    expect(
      normalizeSceneIndex({
        scenes: [
          { id: ' 义庄 ', name: '', spawnPoints: ['door', '', 7] },
          { id: '', name: '没 id' },
          null,
          { id: 'dev_room', name: 'Dev Room' },
        ],
      }),
    ).toEqual([
      { id: '义庄', name: '义庄', spawnPoints: ['door', '7'] },
      { id: 'dev_room', name: 'Dev Room', spawnPoints: [] },
    ]);
  });

  it('不是 {scenes: []} 的形状 → 空', () => {
    expect(normalizeSceneIndex(null)).toEqual([]);
    expect(normalizeSceneIndex({ scenes: 'x' })).toEqual([]);
    expect(normalizeSceneIndex([])).toEqual([]);
  });
});

describe('fetchSceneIndex', () => {
  it('拿到 JSON 就返回条目，且请求的是 SCENE_INDEX_URL', async () => {
    let url = '';
    const entries = await fetchSceneIndex(async (u) => {
      url = String(u);
      return response({ scenes: [{ id: '义庄' }] });
    });
    expect(url).toBe(SCENE_INDEX_URL);
    expect(entries).toEqual([{ id: '义庄', name: '义庄', spawnPoints: [] }]);
  });

  it('404 / 非 JSON（dev server 对缺失路径回 index.html）/ 抛错 → 空数组，调用方退回派生清单', async () => {
    expect(await fetchSceneIndex(async () => response({ scenes: [{ id: 'x' }] }, { ok: false }))).toEqual([]);
    expect(await fetchSceneIndex(async () => response('<html>', { type: 'text/html' }))).toEqual([]);
    expect(
      await fetchSceneIndex(async () => {
        throw new Error('offline');
      }),
    ).toEqual([]);
  });
});
