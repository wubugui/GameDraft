import { describe, expect, it, beforeEach, vi } from 'vitest';
import { PlayerIdleBehaviorSystem, type PlayerIdleDeps } from './PlayerIdleBehaviorSystem';
import { DeterministicRandom } from '../utils/deterministicRandom';
import { FlagStore } from '../core/FlagStore';
import { EventBus } from '../core/EventBus';
import type { GameContext, IEmoteBubbleAnchor, PlayerIdleConfig } from '../data/types';

const anchor: IEmoteBubbleAnchor = { getDisplayObject: () => ({}), getEmoteBubbleAnchorLocalY: () => -10 };

interface Harness {
  sys: PlayerIdleBehaviorSystem;
  said: string[];
  played: string[];
  /** 动画所有权的当前值（true=被待机系统或动作系统占着） */
  owned: () => boolean;
  ownedWrites: boolean[];
  /** 被 cleanupByOwner 撤掉的归属标记 */
  cleaned: string[];
  state: { exploring: boolean; busy: boolean; states: Set<string>; clipSec: number; bubbleOnPlayer: boolean; activeBubbles: number; maxConcurrent: number };
  /** 触发一次「玩家动手了」 */
  act: () => void;
  /** 上一次 playPlayerAnimation 的播完回调 */
  finishAnim: () => void;
  tick: (seconds: number) => void;
}

function makeHarness(): Harness {
  const said: string[] = [];
  const played: string[] = [];
  const ownedWrites: boolean[] = [];
  const cleaned: string[] = [];
  let owned = false;
  let onDone: (() => void) | null = null;
  let inputCb: (() => void) | null = null;
  const state = { exploring: true, busy: false, states: new Set(['yawn', 'stretch']), clipSec: 0, bubbleOnPlayer: false, activeBubbles: 0, maxConcurrent: 2 };

  const deps: PlayerIdleDeps = {
    emoteBubbleManager: {
      show: (_a: unknown, text: string) => { said.push(text); },
      cleanupByOwner: (owner: string) => { cleaned.push(owner); },
      hasBubbleFor: () => state.bubbleOnPlayer,
      activeBubbleCount: () => state.activeBubbles,
    } as never,
    maxConcurrentBubbles: () => state.maxConcurrent,
    playerAnchor: () => anchor,
    playPlayerAnimation: (s, done) => { played.push(s); onDone = done; return state.clipSec; },
    hasPlayerAnimationState: (s) => state.states.has(s),
    setPlayerAnimationOwned: (v) => { owned = v; ownedWrites.push(v); },
    isExploring: () => state.exploring,
    isPlayerBusy: () => state.busy,
    subscribeAnyInput: (cb) => { inputCb = cb; return () => { inputCb = null; }; },
    resolveRichText: (raw) => raw.replace('[tag:player]', '关二狗'),
    random: new DeterministicRandom('idle-test'),
  };
  const sys = new PlayerIdleBehaviorSystem(deps);
  sys.init({} as GameContext);
  return {
    sys, said, played, ownedWrites, cleaned,
    owned: () => owned,
    state,
    act: () => inputCb?.(),
    finishAnim: () => { const f = onDone; onDone = null; f?.(); },
    tick: (seconds: number) => {
      const steps = Math.round(seconds * 60);
      for (let i = 0; i < steps; i++) sys.update(1 / 60);
    },
  };
}

const BUBBLE_ONLY: PlayerIdleConfig = {
  firstDelayMs: 1000,
  repeatIntervalMs: 1000,
  jitterMs: 0,
  entries: [{ bubbleText: '我是[tag:player]' }],
};

const ANIM_ONLY: PlayerIdleConfig = {
  firstDelayMs: 1000,
  repeatIntervalMs: 1000,
  jitterMs: 0,
  entries: [{ animState: 'yawn' }],
};

describe('PlayerIdleBehaviorSystem 触发时机', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('没配 entries 时永远不演', () => {
    h.sys.setConfig({ firstDelayMs: 100 });
    h.tick(60);
    expect(h.said).toHaveLength(0);
    expect(h.played).toHaveLength(0);
  });

  it('enabled:false 关掉整块', () => {
    h.sys.setConfig({ ...BUBBLE_ONLY, enabled: false });
    h.tick(60);
    expect(h.said).toHaveLength(0);
  });

  it('停手够久才演第一个；之后按间隔继续', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.tick(0.9);
    expect(h.said).toHaveLength(0);
    h.tick(0.2);
    expect(h.said).toEqual(['我是关二狗']);
    h.tick(1.1);
    expect(h.said).toHaveLength(2);
  });

  it('非探索态不累计待机（切回来不会立刻演）', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.state.exploring = false;
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.exploring = true;
    h.tick(0.9);
    expect(h.said).toHaveLength(0);   // 计时是从回到探索态才开始算的
    h.tick(0.2);
    expect(h.said).toHaveLength(1);
  });

  it('玩家在动（busy）时不累计待机', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.state.busy = true;
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.busy = false;
    h.tick(1.1);
    expect(h.said).toHaveLength(1);
  });

  it('任意输入把待机计时打回去', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.tick(0.9);
    h.act();
    h.tick(0.9);
    expect(h.said).toHaveLength(0);
    h.tick(0.2);
    expect(h.said).toHaveLength(1);
  });
});

describe('PlayerIdleBehaviorSystem 动画所有权（最容易把游戏搞坏的一处）', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('播动画时取走所有权，播完归还', () => {
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    expect(h.played).toEqual(['yawn']);
    expect(h.owned()).toBe(true);
    h.finishAnim();
    expect(h.owned()).toBe(false);
  });

  it('演到一半玩家动了 → 立刻归还所有权', () => {
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.act();
    expect(h.owned()).toBe(false);
  });

  it('演到一半切出探索态 → 下一帧归还所有权（不能等回来才还）', () => {
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.state.exploring = false;
    h.tick(1 / 60);
    expect(h.owned()).toBe(false);
  });

  it('播完回调迟到（已被打断）不会二次写所有权', () => {
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    h.act();
    const writes = h.ownedWrites.length;
    h.finishAnim();
    expect(h.ownedWrites.length).toBe(writes);
    expect(h.owned()).toBe(false);
  });

  it('动画播不完时看门狗兜底归还（不然主角永远站不起来）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.sys.setConfig({ ...ANIM_ONLY, animWatchdogMs: 2000 });
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.tick(1.5);
    expect(h.owned()).toBe(true);
    h.tick(1);
    expect(h.owned()).toBe(false);
    warn.mockRestore();
  });

  it('主角头上已经有气泡（闲聊/导演式）时，待机不叠第二个', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.state.bubbleOnPlayer = true;
    h.tick(1.2);
    expect(h.said).toHaveLength(0);
    h.state.bubbleOnPlayer = false;
    h.tick(1.2);
    expect(h.said).toHaveLength(1);
  });

  it('同屏气泡到上限时待机不说（与闲聊共用一个口径，免得互相顶名额）', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.state.activeBubbles = 2;   // maxConcurrent 缺省 2
    h.tick(1.2);
    expect(h.said).toHaveLength(0);
    h.state.activeBubbles = 0;
    h.tick(1.2);
    expect(h.said).toHaveLength(1);
  });

  it('看门狗按片段真实时长放宽：8 秒的待机动画不会被 6 秒硬上限砍断', () => {
    h.state.clipSec = 8;
    h.sys.setConfig({ ...ANIM_ONLY, animWatchdogMs: 6000 });
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.tick(9);              // 远超旧的 6 秒硬上限
    expect(h.owned()).toBe(true);
    h.finishAnim();
    expect(h.owned()).toBe(false);
  });

  it('单帧姿势（结构上没有播完回调）按片段时长收掉，不白占配置的那 6 秒', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.clipSec = 1 / 8;                 // 1 帧 @8fps
    h.sys.setConfig({ ...ANIM_ONLY, animWatchdogMs: 6000 });
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.tick(1.5);                             // ≈1.19s 的窗口应已到点
    expect(h.owned()).toBe(false);
    expect(warn).not.toHaveBeenCalled();     // 这是正常收尾，不该刷 warn
    warn.mockRestore();
  });

  it('拿不到片段时长（状态解析不出来）时仍由配置看门狗收掉，并且要出声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.state.clipSec = 0;
    h.sys.setConfig({ ...ANIM_ONLY, animWatchdogMs: 2000 });
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.tick(2.5);
    expect(h.owned()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('刚离开探索态时撤掉在飞的待机气泡（否则与对白「……」气泡重叠）', () => {
    h.sys.setConfig(BUBBLE_ONLY);
    h.tick(1.1);
    expect(h.said).toHaveLength(1);
    expect(h.cleaned).toHaveLength(0);
    h.state.exploring = false;
    h.tick(1 / 60);
    expect(h.cleaned).toEqual(['playerIdle']);
    // 只在这条边撤一次，不是每帧狂撤
    h.tick(1);
    expect(h.cleaned).toEqual(['playerIdle']);
  });

  it('destroy 必须归还所有权（重开一局主角不能站着不动）', () => {
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.sys.destroy();
    expect(h.owned()).toBe(false);
  });

  it('演出期间不再累计新的待机、也不会叠第二个节目', () => {
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    expect(h.played).toHaveLength(1);
    h.tick(5);
    expect(h.played).toHaveLength(1);
  });
});

describe('PlayerIdleBehaviorSystem 换装扮与条件', () => {
  it('当前装扮没有这个动画状态：纯动画条目跳过，不白占所有权', () => {
    const h = makeHarness();
    h.state.states = new Set();          // 换成没有 yawn 的装扮
    h.sys.setConfig(ANIM_ONLY);
    h.tick(3);
    expect(h.played).toHaveLength(0);
    expect(h.owned()).toBe(false);
  });

  it('动画没有但有台词：只说不动', () => {
    const h = makeHarness();
    h.state.states = new Set();
    h.sys.setConfig({
      firstDelayMs: 1000, repeatIntervalMs: 1000, jitterMs: 0,
      entries: [{ animState: 'yawn', bubbleText: '啊……' }],
    });
    h.tick(1.1);
    expect(h.said).toEqual(['啊……']);
    expect(h.played).toHaveLength(0);
    expect(h.owned()).toBe(false);
  });

  it('条件为假不演、为真演', () => {
    const h = makeHarness();
    const flagStore = new FlagStore(new EventBus());
    h.sys.setConditionEvalContextFactory(() => ({
      flagStore,
      questManager: { getStatus: () => 0 } as never,
      scenarioState: {} as never,
    }));
    h.sys.setConfig({
      firstDelayMs: 1000, repeatIntervalMs: 1000, jitterMs: 0,
      entries: [{ bubbleText: '背起来了', when: { flag: '背着尸体' } }],
    });
    h.tick(5);
    expect(h.said).toHaveLength(0);
    flagStore.set('背着尸体', true);
    h.tick(1.1);
    // 条件为假的那段时间里门槛也在按间隔往后推，跨了几次边沿取决于浮点余数——
    // 这里只断言"条件一真就开始演、且演的是这条"，不锁死次数
    expect(h.said.length).toBeGreaterThanOrEqual(1);
    expect(h.said.every((t) => t === '背起来了')).toBe(true);
  });

  it('没接条件上下文时带条件的条目不演（fail-safe）', () => {
    const h = makeHarness();
    h.sys.setConfig({
      firstDelayMs: 1000, repeatIntervalMs: 1000, jitterMs: 0,
      entries: [{ bubbleText: 'x', when: { flag: 'y' } }],
    });
    h.tick(10);
    expect(h.said).toHaveLength(0);
  });

  it('条目冷却期内不重复挑到它', () => {
    const h = makeHarness();
    h.sys.setConfig({
      firstDelayMs: 1000, repeatIntervalMs: 1000, jitterMs: 0,
      entries: [{ bubbleText: '甲', cooldownMs: 5000 }],
    });
    h.tick(1.1);
    expect(h.said).toHaveLength(1);
    h.tick(3);
    expect(h.said).toHaveLength(1);
    h.tick(3);
    expect(h.said).toHaveLength(2);
  });

  it('挑不出任何条目时也把下次门槛推后（不是每帧重试）', () => {
    const h = makeHarness();
    h.sys.setConfig({
      firstDelayMs: 500, repeatIntervalMs: 500, jitterMs: 0,
      entries: [{ bubbleText: '甲', cooldownMs: 100000 }],
    });
    h.tick(0.6);
    expect(h.said).toHaveLength(1);
    const before = (h.sys.getDebugState() as { nextAtMs: number }).nextAtMs;
    h.tick(0.6);
    expect(h.said).toHaveLength(1);
    expect((h.sys.getDebugState() as { nextAtMs: number }).nextAtMs).toBe(before);
  });

  it('setConfig 会把在演的节目收掉并归还所有权', () => {
    const h = makeHarness();
    h.sys.setConfig(ANIM_ONLY);
    h.tick(1.1);
    expect(h.owned()).toBe(true);
    h.sys.setConfig(BUBBLE_ONLY);
    expect(h.owned()).toBe(false);
  });

  it('待机是纯表现：不进存档', () => {
    const h = makeHarness();
    expect(h.sys.serialize()).toEqual({});
  });
});
