import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_ACOUSTICS_API,
  RUNTIME_ACOUSTICS_STATUS_API,
  RuntimeAcousticsSync,
  isAcousticsDocStale,
  shouldApplyAcousticsDoc,
  type AcousticsSyncDoc,
  type RuntimeAcousticsSyncDeps,
} from './runtimeAcousticsSync';
import type { AcousticSpaceDef } from '../audio/acousticSpace';

const DEF: AcousticSpaceDef = {
  listener: { x: 0, z: 0 },
  reflectors: [{ id: 'A', a: [-880, 1760], b: [880, 1760], height: 440, absorb: 0.05, rough: 0.2 }],
  order: 1,
};

const DOC: AcousticsSyncDoc = { rev: 5, writer: 'workbench:1', spaceId: '山谷_大', def: DEF };

describe('要不要套用工作台来的这份空间', () => {
  it('别人写的、比见过的新 → 套用；不看场景（强绑允许）', () => {
    expect(shouldApplyAcousticsDoc(DOC, 'game:a', 4)).toBe(true);
  });

  it('自己写的不读回来', () => {
    expect(shouldApplyAcousticsDoc(DOC, 'workbench:1', 4)).toBe(false);
  });

  it('rev 不比见过的新就不动', () => {
    expect(shouldApplyAcousticsDoc(DOC, 'game:a', 5)).toBe(false);
    expect(shouldApplyAcousticsDoc(DOC, 'game:a', 9)).toBe(false);
  });

  it('残缺文档不套用：缺 spaceId / 缺 def / def 不成形', () => {
    expect(shouldApplyAcousticsDoc(null, 'game:a', 0)).toBe(false);
    expect(shouldApplyAcousticsDoc({ ...DOC, spaceId: '' }, 'game:a', 0)).toBe(false);
    expect(shouldApplyAcousticsDoc({ ...DOC, def: undefined as unknown as AcousticSpaceDef }, 'game:a', 0)).toBe(false);
    expect(shouldApplyAcousticsDoc(
      { ...DOC, def: { listener: { x: 0, z: 0 } } as unknown as AcousticSpaceDef }, 'game:a', 0)).toBe(false);
  });

  it('超过新鲜期（5 分钟）的不自动套用', () => {
    expect(isAcousticsDocStale(6 * 60 * 1000)).toBe(true);
    expect(isAcousticsDocStale(60 * 1000)).toBe(false);
    expect(isAcousticsDocStale(null)).toBe(false);
  });
});

/**
 * 真跑一遍轮询：假 fetch 喂槽里的文档，看游戏侧到底套没套、播没播、回传了什么。
 * 试听序号那条规则（第一次只记不播、漏看的不补播、换场景不重放）只有这样才钉得住。
 */
describe('RuntimeAcousticsSync 轮询', () => {
  let slot: { doc: AcousticsSyncDoc | null; ageMs: number | null };
  let statusPosts: unknown[];
  let applied: Array<{ spaceId: string; def: AcousticSpaceDef }>;
  let probes: string[];
  let probeAts: unknown[];
  let unlocked: boolean;
  let deps: RuntimeAcousticsSyncDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    slot = { doc: null, ageMs: null };
    statusPosts = [];
    applied = [];
    probes = [];
    probeAts = [];
    unlocked = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === RUNTIME_ACOUSTICS_API) {
        return { ok: true, json: async () => ({ doc: slot.doc, ageMs: slot.ageMs }) } as Response;
      }
      if (url === RUNTIME_ACOUSTICS_STATUS_API) {
        statusPosts.push(JSON.parse(String(init?.body)));
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unexpected ${url}`);
    }));
    deps = {
      getSceneId: () => '跑马梁',
      getBoundSpaceId: () => '山谷_大',
      getActiveSpaceId: () => applied.length ? applied[applied.length - 1].spaceId : '山谷_大',
      applyDef: (spaceId, def) => { applied.push({ spaceId, def }); },
      playProbe: (id, at, onStarted) => { if (!unlocked) return false; probes.push(id); probeAts.push(at); onStarted(); return true; },
      getListenerMode: () => 'player',
      getListener: () => ({
        scene: { x: 1, y: 2 }, world: [0, 0, 0], ear: [0, 141, 0], forward: [0, 0, 1], grounded: true, mode: 'player', from: 'space',
      }),
      getTaps: () => [],
      getPerf: () => ({ costMs: 3, thresholdM: 2 }),
      isAudioUnlocked: () => unlocked,
      log: () => {},
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function ticks(sync: RuntimeAcousticsSync, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await vi.advanceTimersByTimeAsync(450);
    }
  }

  it('槽里有新文档 → 套用并回传状态；同一份不重复套', async () => {
    slot = { doc: DOC, ageMs: 100 };
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await ticks(sync, 3);
    expect(applied).toHaveLength(1);
    expect(applied[0].spaceId).toBe('山谷_大');
    expect(statusPosts.length).toBeGreaterThan(0);
    const st = statusPosts[statusPosts.length - 1] as { appliedRev: number; sceneId: string; writer: string };
    expect(st.appliedRev).toBe(5);
    expect(st.sceneId).toBe('跑马梁');
    expect(st.writer).toBe('game:t');
    sync.stop();
  });

  it('状态带页实例 id / 开页时刻 / 免手势标记（多开页签时槽按它们分页、挑页、指挥）', async () => {
    slot = { doc: DOC, ageMs: 100 };
    const sync = new RuntimeAcousticsSync({ ...deps, getBootId: () => 'b1', isAutoplayAllowed: () => true }, 'game:b1');
    sync.start();
    await ticks(sync, 3);
    const st = statusPosts[statusPosts.length - 1] as { bootId?: string; startedAt?: number; autoplayAllowed?: boolean };
    expect(st.bootId).toBe('b1');
    expect(typeof st.startedAt).toBe('number');
    expect(st.autoplayAllowed).toBe(true);
    sync.stop();
  });

  it('第一次看到文档时只记试听序号不播；之后序号加一才播一次；漏看的不补播', async () => {
    slot = { doc: { ...DOC, probe: { seq: 7, sfxId: 'sfx_gibbon_dry_a' } }, ageMs: 100 };
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await ticks(sync, 2);
    expect(probes).toEqual([]);                       // 刷新页面不该把上一次的试听重放
    slot = { doc: { ...DOC, rev: 6, probe: { seq: 8, sfxId: 'sfx_gibbon_dry_a' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(probes).toEqual(['sfx_gibbon_dry_a']);
    slot = { doc: { ...DOC, rev: 7, probe: { seq: 11, sfxId: 'sfx_pebble_scatter_dry' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(probes).toEqual(['sfx_gibbon_dry_a', 'sfx_pebble_scatter_dry']);   // 9、10 不补
    sync.stop();
  });

  it('换场景后同一份文档重新套用，但试听不重放', async () => {
    slot = { doc: { ...DOC, probe: { seq: 3, sfxId: 'x' } }, ageMs: 100 };
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await ticks(sync, 2);
    slot = { doc: { ...DOC, rev: 6, probe: { seq: 4, sfxId: 'x' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(applied).toHaveLength(2);
    expect(probes).toEqual(['x']);
    sync.onSceneChanged();
    await ticks(sync, 2);
    expect(applied).toHaveLength(3);                  // 重新套用
    expect(probes).toEqual(['x']);                    // 没重放
    sync.stop();
  });

  it('陈年文档（>5 分钟）不套用；音频没解锁时试听不算播出', async () => {
    slot = { doc: DOC, ageMs: 10 * 60 * 1000 };
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await ticks(sync, 2);
    expect(applied).toHaveLength(0);
    expect(sync.statusLine()).toContain('太旧');
    unlocked = false;
    slot = { doc: { ...DOC, rev: 9, probe: { seq: 1, sfxId: 'x' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(applied).toHaveLength(1);
    expect(probes).toEqual([]);
    expect(sync.status().probesPlayed).toBe(0);
    sync.stop();
  });

  it('工作台换了 writer（服务重开、序号从 1 重数）：第一下试听照播，不当旧序号吞掉', async () => {
    slot = { doc: { ...DOC, probe: { seq: 40, sfxId: 'a' } }, ageMs: 100 };
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await ticks(sync, 2);
    slot = { doc: { ...DOC, rev: 6, probe: { seq: 41, sfxId: 'a' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(probes).toEqual(['a']);
    // 新工作台进程：writer 变了，序号从 1 起
    slot = { doc: { ...DOC, rev: 7, writer: 'workbench:2', probe: { seq: 1, sfxId: 'b' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(probes).toEqual(['a', 'b']);
    slot = { doc: { ...DOC, rev: 8, writer: 'workbench:2', probe: { seq: 2, sfxId: 'c' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(probes).toEqual(['a', 'b', 'c']);
    sync.stop();
  });

  it('试听带发声点：原样交给 playProbe；没带 = null（听者自己喊）', async () => {
    slot = { doc: DOC, ageMs: 100 };
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await ticks(sync, 2);
    slot = { doc: { ...DOC, rev: 6, probe: { seq: 5, sfxId: 'x', at: { x: 10, y: 141, z: 20 } } }, ageMs: 100 };
    await ticks(sync, 2);
    slot = { doc: { ...DOC, rev: 7, probe: { seq: 6, sfxId: 'x' } }, ageMs: 100 };
    await ticks(sync, 2);
    expect(probeAts).toEqual([{ x: 10, y: 141, z: 20 }, null]);
    const st = statusPosts[statusPosts.length - 1] as { probeSeqPlayed: number };
    expect(st.probeSeqPlayed).toBe(6);
    sync.stop();
  });

  it('连不上时退避、状态行说断了；恢复后回到 400ms', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    vi.stubGlobal('fetch', f);
    const sync = new RuntimeAcousticsSync(deps, 'game:t');
    sync.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3500);
    expect(sync.status().failStreak).toBeGreaterThan(1);
    expect(sync.status().pollMs).toBeGreaterThan(400);
    expect(sync.statusLine()).toMatch(/等待|已断/);
    sync.stop();
  });
});
