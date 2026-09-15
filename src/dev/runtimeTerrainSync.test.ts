import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_TERRAIN_API, RuntimeTerrainSync, isFreshTerrainPush, shouldAnswerProbe, shouldReloadTerrain, terrainPreviewDirUrl,
  type TerrainSyncDoc,
} from './runtimeTerrainSync';

const DOC: TerrainSyncDoc = { rev: 5, sceneId: '崖墓', ts: 1 };

describe('要不要按这份推送原地换地形', () => {
  it('比见过的新、场景对得上 ⇒ 换', () => {
    expect(shouldReloadTerrain(DOC, '崖墓', 4)).toBe(true);
  });
  it('🔴 第一次看到槽只记 rev 不换（否则每刷新一次都把上一次推送重放一遍）', () => {
    expect(shouldReloadTerrain(DOC, '崖墓', -1)).toBe(false);
  });
  it('场景对不上不动', () => {
    expect(shouldReloadTerrain(DOC, '雾津街头', 4)).toBe(false);
  });
  it('rev 不比见过的新就不动', () => {
    expect(shouldReloadTerrain(DOC, '崖墓', 5)).toBe(false);
    expect(shouldReloadTerrain(DOC, '崖墓', 9)).toBe(false);
  });
  it('第一次看到槽：本局启动之后才推的那行算新推送；启动前留在盘上的不算', () => {
    expect(isFreshTerrainPush({ rev: 5, sceneId: '崖墓', ts: 1500 }, -1, 1000)).toBe(true);
    expect(isFreshTerrainPush({ rev: 5, sceneId: '崖墓', ts: 900 }, -1, 1000)).toBe(false);
    expect(isFreshTerrainPush({ rev: 5, sceneId: '崖墓' }, -1, 1000)).toBe(false);
  });
  it('预览目录 URL 形状（碰撞在根，行走面在 ground/<烘焙目录>/）', () => {
    expect(terrainPreviewDirUrl('崖墓')).toBe(`${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}`);
  });
});

describe('探测请求要不要答', () => {
  it('序号新、场景对、有点 ⇒ 答；答过的 / 别的场景 / 空点 ⇒ 不答', () => {
    const doc: TerrainSyncDoc = { rev: 1, sceneId: '崖墓', probe: { seq: 3, sceneId: '崖墓', points: [[1, 2]] } };
    expect(shouldAnswerProbe(doc, '崖墓', 2)).toBe(true);
    expect(shouldAnswerProbe(doc, '崖墓', 3)).toBe(false);
    expect(shouldAnswerProbe(doc, '雾津街头', 2)).toBe(false);
    expect(shouldAnswerProbe({ rev: 1, sceneId: '崖墓', probe: { seq: 4, sceneId: '崖墓', points: [] } }, '崖墓', 2)).toBe(false);
    expect(shouldAnswerProbe({ rev: 1, sceneId: '崖墓' }, '崖墓', 2)).toBe(false);
  });
});

describe('RuntimeTerrainSync 的轮询', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn<(cacheBust: string) => Promise<boolean>>>;
  let probe: ReturnType<typeof vi.fn<(pts: Array<[number, number]>) => { blocked: string; grid: unknown } | null>>;
  let sceneId: string | null;

  const reply = (doc: TerrainSyncDoc | null) => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init && init.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      return { json: async () => ({ doc }) } as unknown as Response;
    });
  };
  const make = () => new RuntimeTerrainSync({ currentSceneId: () => sceneId, reload, probe });
  const tick = async (s: RuntimeTerrainSync) => { await (s as unknown as { tick: () => Promise<void> }).tick(); };

  beforeEach(() => {
    sceneId = '崖墓';
    reload = vi.fn<(cacheBust: string) => Promise<boolean>>(async () => true);
    probe = vi.fn(() => ({ blocked: '0110', grid: { grid_width: 2 } }));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    });
    vi.stubGlobal('AbortController', class { signal = {}; abort() { /* 测试里不真中断 */ } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('第一拍只认 rev，第二拍才换；换的时候带 rev 当缓存戳', async () => {
    const s = make();
    reply({ rev: 3, sceneId: '崖墓' });
    await tick(s);
    expect(reload).not.toHaveBeenCalled();
    reply({ rev: 4, sceneId: '崖墓' });
    await tick(s);
    expect(reload).toHaveBeenCalledWith('4');
    expect(s.bustFor('崖墓')).toBe('4');
  });

  it('preview 记下"这个场景用预览"，export 忘掉', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '崖墓' });
    await tick(s);
    reply({ rev: 2, sceneId: '崖墓', source: 'preview' });
    await tick(s);
    expect(s.previewFor('崖墓')).toEqual({ rev: 2 });
    reply({ rev: 3, sceneId: '崖墓', source: 'export' });
    await tick(s);
    expect(s.previewFor('崖墓')).toBeNull();
    expect(s.bustFor('崖墓')).toBe('3');
  });

  it('探测：序号新就用 probe 判、POST 回 status；同一序号不重答；与 rev 无关', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '崖墓', probe: { seq: 7, sceneId: '崖墓', points: [[1, 1], [2, 2], [3, 3], [4, 4]] } });
    await tick(s);
    expect(probe).toHaveBeenCalledTimes(1);
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toBe(`${RUNTIME_TERRAIN_API}/status`);
    const body = JSON.parse(String((posts[0][1] as RequestInit).body));
    expect(body).toMatchObject({ sceneId: '崖墓', probeSeq: 7, blocked: '0110' });
    await tick(s);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();                 // 第一次看到 rev=1 不换
  });

  it('场景没装完：只心跳（loading=1），既不换也不答', async () => {
    sceneId = null;
    const s = make();
    reply({ rev: 9, sceneId: '崖墓', probe: { seq: 1, sceneId: '崖墓', points: [[0, 0]] } });
    await tick(s);
    const qs = new URLSearchParams(String(fetchMock.mock.calls[0][0]).split('?')[1]);
    expect(qs.get('loading')).toBe('1');
    expect(reload).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('连不上就退避，状态行说得出收发次数', async () => {
    const s = make();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await tick(s);
    expect(s.statusLine()).toContain('ECONNREFUSED');
    await tick(s);                                           // 退避期：不再敲
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
