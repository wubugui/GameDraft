import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VfxEffectDef, VfxPlacementLibrary } from '../data/types';
import {
  RUNTIME_VFX_API,
  RUNTIME_VFX_STATUS_API,
  RuntimeVfxSync,
  phaseRequestNeedsAdvance,
  shouldApplyVfxDoc,
  type RuntimeVfxSyncDeps,
  type VfxSyncDoc,
} from './runtimeVfxSync';

const DEF = { id: 'paper_money', emitters: [] } as unknown as VfxEffectDef;
const LIB: VfxPlacementLibrary = {
  scenes: { 跑马梁: { base: [{ id: '纸钱_山顶', effect: 'paper_money', anchor: { x: 1, y: 2 } }], variants: { 夜: [] } } },
};
const DOC: VfxSyncDoc = { rev: 5, writer: 'workbench:1', effectId: 'paper_money', def: DEF };

describe('要不要套用工作台来的这份效果', () => {
  it('别人写的、比见过的新 → 套用；自己写的 / 不新 / 残缺 → 不套', () => {
    expect(shouldApplyVfxDoc(DOC, 'game:a', 4)).toBe(true);
    expect(shouldApplyVfxDoc(DOC, 'workbench:1', 4)).toBe(false);
    expect(shouldApplyVfxDoc(DOC, 'game:a', 5)).toBe(false);
    expect(shouldApplyVfxDoc({ ...DOC, def: {} as VfxEffectDef }, 'game:a', 0)).toBe(false);
  });
});

describe('「让游戏切到这个时段」要不要真推进', () => {
  it('🔴 游戏此刻的外观已经是目标时段那套 ⇒ 不推进（往回的时段只能跨午夜推，天数加一、延迟事件触发）', () => {
    // 午与辰都用基底：游戏在午、工作台发辰
    expect(phaseRequestNeedsAdvance('', '')).toBe(false);
    expect(phaseRequestNeedsAdvance('夜', '夜')).toBe(false);
  });

  it('外观不同 ⇒ 推进；没进场景给不出外观键 ⇒ 照旧推进', () => {
    expect(phaseRequestNeedsAdvance('', '夜')).toBe(true);
    expect(phaseRequestNeedsAdvance('夜', '')).toBe(true);
    expect(phaseRequestNeedsAdvance(null, '')).toBe(true);
    expect(phaseRequestNeedsAdvance('', null)).toBe(true);
  });
});

/**
 * 真跑一遍轮询（假 fetch 喂槽）：布置库整份套用 / 拆联动撤销、「让游戏切到这个时段」的序号规则
 * （第一次只记不做、漏看的不补、换 writer 从头数）、回传里带时段与布置来源。
 */
describe('RuntimeVfxSync 布置与切时段', () => {
  let slot: { doc: VfxSyncDoc | null; ageMs: number | null };
  let statusPosts: Array<Record<string, unknown>>;
  let libs: Array<VfxPlacementLibrary | null>;
  let phases: string[];
  let deps: RuntimeVfxSyncDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    slot = { doc: null, ageMs: null };
    statusPosts = [];
    libs = [];
    phases = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === RUNTIME_VFX_API) return { ok: true, json: async () => ({ doc: slot.doc, ageMs: slot.ageMs }) } as Response;
      if (url === RUNTIME_VFX_STATUS_API) {
        statusPosts.push(JSON.parse(String(init?.body)));
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unexpected ${url}`);
    }));
    deps = {
      getSceneId: () => '跑马梁',
      applyPreview: () => {},
      clearPreview: () => {},
      emitField: () => true,
      applyPlacements: (lib) => { libs.push(lib); },
      requestTimePhase: (p) => { if (p === '不存在') return false; phases.push(p); return true; },
      getStatus: () => ({
        sceneId: '跑马梁', instances: [], allInstances: 0,
        stats: { instances: 0, live: 0, drawCalls: 0, fields: 0, simMs: 0 },
        playerScene: null, playerWorld: null, spaceKind: 'field',
        timePhase: '夜', appearancePhase: '夜', placementsApplied: { sceneId: '跑马梁', phase: '夜', preview: true },
      }),
      log: () => {},
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ticks = async (n: number) => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(450); };

  it('旧工作台的整库副本不进入运行时；显式清空范围被保留', async () => {
    slot = { doc: { ...DOC, placements: { library: LIB, sceneId: '跑马梁', phase: '' } }, ageMs: 100 };
    const sync = new RuntimeVfxSync(deps, 'game:t');
    sync.start();
    await ticks(2);
    expect(libs).toEqual([]);
    const emptyScope = { scenes: { 跑马梁: { base: [] } } };
    slot = { doc: { ...DOC, rev: 6, placements: { mode: 'scoped', library: emptyScope, sceneId: '跑马梁', phase: '' } }, ageMs: 100 };
    await ticks(2);
    expect(libs).toEqual([emptyScope]);
    sync.stop();
  });

  it('文档带布置库 → 整份套用；不带 / 形状不对的不动布置；拆联动时撤销', async () => {
    slot = { doc: { ...DOC, placements: { mode: 'scoped', library: LIB, sceneId: '跑马梁', phase: '' } }, ageMs: 100 };
    const sync = new RuntimeVfxSync(deps, 'game:t');
    sync.start();
    await ticks(2);
    expect(libs).toEqual([LIB]);
    slot = { doc: { ...DOC, rev: 6 }, ageMs: 100 };
    await ticks(2);
    expect(libs).toHaveLength(1);
    slot = { doc: { ...DOC, rev: 7, placements: { mode: 'scoped', library: { nope: 1 } as unknown as VfxPlacementLibrary, sceneId: '', phase: '' } }, ageMs: 100 };
    await ticks(2);
    expect(libs).toEqual([LIB, null]);
    sync.stop();
    expect(libs).toEqual([LIB, null]);
  });

  it('陈年文档（>5 分钟）连布置一起不套', async () => {
    slot = { doc: { ...DOC, placements: { mode: 'scoped', library: LIB, sceneId: '跑马梁', phase: '' } }, ageMs: 10 * 60 * 1000 };
    const sync = new RuntimeVfxSync(deps, 'game:t');
    sync.start();
    await ticks(2);
    expect(libs).toEqual([]);
    sync.stop();
    expect(libs).toEqual([]);                          // 没套过就不撤
  });

  it('切时段：第一次看到只记序号；加一才推进一次；漏看的不补；换 writer 从头数', async () => {
    slot = { doc: { ...DOC, phaseRequest: { seq: 4, timePhase: '夜' } }, ageMs: 100 };
    const sync = new RuntimeVfxSync(deps, 'game:t');
    sync.start();
    await ticks(2);
    expect(phases).toEqual([]);                        // 刷新游戏页不该把上一次的切时段重放
    slot = { doc: { ...DOC, rev: 6, phaseRequest: { seq: 5, timePhase: '夜' } }, ageMs: 100 };
    await ticks(2);
    expect(phases).toEqual(['夜']);
    await ticks(2);
    expect(phases).toEqual(['夜']);                    // 同一个序号不重复推进
    slot = { doc: { ...DOC, rev: 7, phaseRequest: { seq: 9, timePhase: '午' } }, ageMs: 100 };
    await ticks(2);
    expect(phases).toEqual(['夜', '午']);
    slot = { doc: { ...DOC, rev: 8, writer: 'workbench:2', phaseRequest: { seq: 1, timePhase: '辰' } }, ageMs: 100 };
    await ticks(2);
    expect(phases).toEqual(['夜', '午', '辰']);
    const st = statusPosts[statusPosts.length - 1];
    expect(st.phaseSeqDone).toBe(9);                  // 已做序号只增不减（新 writer 的 1 不回写成更小）
    expect(st.timePhase).toBe('夜');
    expect(st.appearancePhase).toBe('夜');
    expect(st.placementsApplied).toEqual({ sceneId: '跑马梁', phase: '夜', preview: true });
    sync.stop();
  });

  it('换效果：先撤掉上一个效果的覆盖、再套新的（撤销由 VfxSystem 从盘上重读）；同一个效果再来不撤', async () => {
    const calls: string[] = [];
    deps.applyPreview = (id) => { calls.push(`apply:${id}`); };
    deps.clearPreview = (id) => { calls.push(`clear:${id}`); };
    slot = { doc: DOC, ageMs: 100 };
    const sync = new RuntimeVfxSync(deps, 'game:t');
    sync.start();
    await ticks(2);
    slot = { doc: { ...DOC, rev: 6 }, ageMs: 100 };
    await ticks(2);
    expect(calls).toEqual(['apply:paper_money', 'apply:paper_money']);
    slot = { doc: { ...DOC, rev: 7, effectId: 'bats', def: { id: 'bats', emitters: [] } as unknown as VfxEffectDef }, ageMs: 100 };
    await ticks(2);
    expect(calls.slice(2)).toEqual(['clear:paper_money', 'apply:bats']);
    sync.stop();
    expect(calls[calls.length - 1]).toBe('clear:bats');
  });

  it('游戏里没有那个时段：不算做过', async () => {
    slot = { doc: { ...DOC, phaseRequest: { seq: 1, timePhase: '夜' } }, ageMs: 100 };
    const sync = new RuntimeVfxSync(deps, 'game:t');
    sync.start();
    await ticks(2);
    slot = { doc: { ...DOC, rev: 6, phaseRequest: { seq: 2, timePhase: '不存在' } }, ageMs: 100 };
    await ticks(2);
    expect(phases).toEqual([]);
    expect(statusPosts[statusPosts.length - 1].phaseSeqDone).toBe(0);
    sync.stop();
  });
});
