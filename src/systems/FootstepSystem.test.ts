import { describe, expect, it } from 'vitest';

import {
  FootstepSystem,
  framesBetween,
  isLocomotionClip,
  resolveSfx,
  type FootstepEmitter,
  type FootstepSpatialContext,
  type FootstepSystemDeps,
} from './FootstepSystem';
import type { AudioPlaybackHandle, FootstepConfig } from '../data/types';
import { planarResolver } from '../utils/audioSpace';
import type { Vec3 } from '../utils/sceneSpace';

// ===========================================================================
// 纯函数
// ===========================================================================

describe('framesBetween：走过了哪几帧', () => {
  it('正向推进', () => {
    expect(framesBetween(0, 3, 8)).toEqual([1, 2, 3]);
  });

  it('一帧推进多帧也要全部走到 —— 低帧率/高倍速下会跨过落脚帧，漏了那一步就无声', () => {
    expect(framesBetween(6, 2, 8)).toEqual([7, 0, 1, 2]);
  });

  it('反向播放取反向路径，不会被误判成正向绕一圈', () => {
    expect(framesBetween(3, 1, 8)).toEqual([2, 1]);
    expect(framesBetween(1, 7, 8)).toEqual([0, 7]);
  });

  it('原地不动返回空；单帧片段返回空（它的帧号永不推进）', () => {
    expect(framesBetween(3, 3, 8)).toEqual([]);
    expect(framesBetween(0, 0, 1)).toEqual([]);
  });

  it('帧号越界也归一（负数/超长）', () => {
    expect(framesBetween(-1, 1, 8)).toEqual([0, 1]);
    expect(framesBetween(9, 10, 8)).toEqual([2]);
  });
});

describe('resolveSfx：一个片段一条 key，声明式回落，查不到就不发声', () => {
  const sfx = { walk: 'a', run: 'b', carry_walk: 'c' };
  const fallback = { carry_heavy_walk: 'run', crouchWalk: 'walk' };

  it('直接命中', () => {
    expect(resolveSfx(sfx, fallback, 'carry_walk')).toBe('c');
  });

  it('按回落表命中', () => {
    expect(resolveSfx(sfx, fallback, 'carry_heavy_walk')).toBe('b');
  });

  it('🔴 未登记的片段一律返回 null —— 绝不能隐式兜底到 walk', () => {
    // 真机回归：第一版有「最后兜底到 walk」，于是站着不动（clip='idle'）也在响脚步，
    // 而 36 条单测全绿（测试配置里从没出现过 idle）。判据必须是「显式登记过才算移动片段」。
    expect(resolveSfx(sfx, fallback, 'idle')).toBeNull();
    expect(resolveSfx(sfx, fallback, 'gaze')).toBeNull();
    expect(resolveSfx(sfx, fallback, 'lie')).toBeNull();
    expect(resolveSfx(sfx, fallback, '不存在的片段')).toBeNull();
  });

  it('连 walk 都没有就返回 null —— 不许随便挑一个存在的键顶上', () => {
    expect(resolveSfx({ run: 'b' }, undefined, '不存在的片段')).toBeNull();
  });

  it('回落表成环也不死循环', () => {
    expect(resolveSfx({ run: 'b' }, { x: 'y', y: 'x' }, 'x')).toBeNull();
  });

  it('空串 / 非字符串视同没有（继续沿回落链找，链尽则 null）', () => {
    expect(resolveSfx({ walk: '' }, undefined, 'walk')).toBeNull();
    expect(resolveSfx({ run: '   ', walk: 'a' }, { run: 'walk' }, 'run')).toBe('a');
    expect(resolveSfx({ walk: 5 as unknown as string }, undefined, 'walk')).toBeNull();
  });

  it('isLocomotionClip：只认显式登记，不按名字猜', () => {
    expect(isLocomotionClip(CFG, 'walk')).toBe(true);
    expect(isLocomotionClip(CFG, 'carry_walk')).toBe(true);        // 在某个集的 sfx 里
    expect(isLocomotionClip(CFG, 'carry_heavy_walk')).toBe(true);  // 在 clipFallback 里
    expect(isLocomotionClip(CFG, 'idle')).toBe(false);
    // 名字里带 walk 但没登记 —— 仍然不算（真实片段名有 hero_walk_guangcai 这种）
    expect(isLocomotionClip(CFG, 'hero_walk_guangcai')).toBe(false);
  });
});

// ===========================================================================
// 系统行为
// ===========================================================================

const CFG: FootstepConfig = {
  sets: {
    plank: { sfx: { walk: 'step_plank', carry_walk: 'step_plank_heavy' } },
    paper: { sfx: { walk: 'step_paper' } },
  },
  clipFallback: { carry_heavy_walk: 'run', crouchWalk: 'walk' },
  defaults: { gainDb: 0 },
};

/**
 * 发声体替身。`contacts` 模拟 sockets.json 的落脚帧标注：这里直接按**片段帧下标**给
 * （真机上由 SpriteEntity 把帧下标换成图集槽位再查 contactSlots，那一层在 SpriteEntity 里）。
 * 缺省 walk 的落脚帧是 [3, 11]（与 player_anim/walk 的真值一致）。
 */
class FakeEmitter implements FootstepEmitter {
  clip = 'walk';
  frame = 0;
  count = 16;
  x = 100;
  y = 100;
  visible = true;
  contacts: number[] = [3, 11];
  constructor(readonly id: string) {}
  getContactX() { return this.x; }
  getContactY() { return this.y; }
  getClip() { return this.clip; }
  getFrameIndex() { return this.frame; }
  getFrameCount() { return this.count; }
  isContactFrame(f: number) { return this.contacts.includes(f); }
  isVisible() { return this.visible; }
}

interface Played {
  id: string; world: Vec3;
  opts: { volume?: number; onEnd?: () => void; spatialized?: boolean };
}

function harness(over: Partial<FootstepSystemDeps> = {}) {
  const played: Played[] = [];
  const stopped: string[] = [];
  const ctx: FootstepSpatialContext = { resolver: planarResolver() };
  let setId: string | null = 'plank';
  const deps: FootstepSystemDeps = {
    playAt(id, world, opts) {
      played.push({ id, world, opts });
      const h: AudioPlaybackHandle = { stop: () => { stopped.push(id); } };
      return h;
    },
    getSpatialContext: () => ctx,
    resolveSetAt: () => setId,
    getConfig: () => CFG,
    ...over,
  };
  const sys = new FootstepSystem(deps);
  return {
    sys, played, stopped, ctx,
    setSet(v: string | null) { setId = v; },
  };
}

/** 推进若干帧。dt 只是走个过场——判定纯按帧。 */
function step(sys: FootstepSystem, e: FakeEmitter, frames: number[], dt = 0.2) {
  for (const f of frames) {
    e.frame = f;
    sys.update(dt);
  }
}

/** 起步于落脚帧 3：换片段那一刻当前帧就是落脚帧 ⇒ 立刻一响。 */
function startOnContact(h: ReturnType<typeof harness>, e: FakeEmitter) {
  e.frame = 3;
  h.sys.registerEmitter(e);
  h.sys.update(0.2);
}

describe('FootstepSystem：落脚帧驱动', () => {
  it('起步那一刻就有第一响（换片段且当前帧是落脚帧）', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    expect(h.played).toHaveLength(1);
    expect(h.played[0].id).toBe('step_plank');
  });

  it('一个 16 帧循环里恰好响两次（落脚帧 3 与 11）', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);                                            // 帧 3 一响
    step(h.sys, e, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3]);
    // 帧 11 一响 + 回绕到 3 一响 = 共 3 响
    expect(h.played).toHaveLength(3);
  });

  it('一帧跨过落脚帧也要响（低帧率/卡顿）', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    e.frame = 5;
    h.sys.registerEmitter(e);
    h.sys.update(0.2);           // 起步：帧 5 不是落脚帧，不响
    expect(h.played).toHaveLength(0);
    step(h.sys, e, [12]);        // 5 → 12 一次跨过 11
    expect(h.played).toHaveLength(1);
  });

  it('单帧片段永不发声（它的帧号本来就不会推进）', () => {
    const h = harness();
    const e = new FakeEmitter('idle_single');
    e.clip = 'walk';
    e.count = 1;
    e.contacts = [0];
    h.sys.registerEmitter(e);
    h.sys.update(0.2);
    expect(h.played).toHaveLength(0);
  });

  it('🔴 没标落脚帧的片段一步都不响 —— 不按帧数猜「0 与中点」', () => {
    // 猜出来的 walk:[0,8] 与真值 [3,11] 差半步：声音响在脚还在空中的时候，且没有任何报错。
    // 所以规则是：没标 = 无声。校验器会把「登记了音效却没标落脚帧」报出来。
    const h = harness();
    const e = new FakeEmitter('player');
    e.clip = 'carry_walk';
    e.count = 12;
    e.contacts = [];
    h.sys.registerEmitter(e);
    h.sys.update(0.2);
    step(h.sys, e, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0]);
    expect(h.played).toHaveLength(0);
  });

  it('落脚帧按片段各自标：carry_walk 标在 0 与 6 就响在 0 与 6', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    e.clip = 'carry_walk';
    e.count = 12;
    e.contacts = [0, 6];
    h.sys.registerEmitter(e);
    h.sys.update(0.2);                 // 帧 0 → 一响
    step(h.sys, e, [3, 6]);            // 帧 6 → 一响
    expect(h.played).toHaveLength(2);
    expect(h.played[1].id).toBe('step_plank_heavy');
  });

  it('🔴 站着不动（idle）绝不发声 —— 真机回归', () => {
    // 第一版在真机上原地不动每秒响一声：idle 是 16 帧 @8fps，帧 0 撞上当时的缺省落脚帧规则，
    // 音效又被隐式兜底成 walk。两处叠加。现在两条都堵死：没标不响 + 未登记的片段不是移动片段。
    const h = harness();
    const e = new FakeEmitter('player');
    e.clip = 'idle';
    e.count = 16;
    e.contacts = [3, 11]; // 哪怕 idle 的图恰好被标成落脚帧（不该，但假设），未登记也不响
    h.sys.registerEmitter(e);
    h.sys.update(0.2);
    step(h.sys, e, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0]);
    expect(h.played).toHaveLength(0);
  });

  it('走 → 停 → 走：停下期间不响，重新走起来第一步就响', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);                    // walk 帧 3 → 一响
    const afterWalk = h.played.length;
    expect(afterWalk).toBe(1);
    e.clip = 'idle';
    step(h.sys, e, [0, 3, 8, 11, 0]);        // 站着
    expect(h.played).toHaveLength(afterWalk);
    e.clip = 'walk';
    e.frame = 3;
    h.sys.update(0.2);                       // 重新起步
    expect(h.played).toHaveLength(afterWalk + 1);
  });

  it('不可见的发声体不发声', () => {
    const h = harness();
    const e = new FakeEmitter('npc_1');
    e.visible = false;
    startOnContact(h, e);
    expect(h.played).toHaveLength(0);
  });

  it('🔴 防抖闸按帧计不按时间计：walk↔idle 每帧抖动不会打成机枪', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    e.frame = 3;
    h.sys.registerEmitter(e);
    h.sys.update(0.016);          // 起步一响
    for (let i = 0; i < 20; i++) {
      e.clip = i % 2 === 0 ? 'idle' : 'walk';
      e.frame = 3;                // 动画一帧都没推进过
      h.sys.update(0.016);
    }
    expect(h.played).toHaveLength(1);
  });

  it('🔴 播放速率无关：同样的帧序列，dt 大小完全不影响响几次', () => {
    // 这条锁住「声音绑帧不绑时间」。播放速率本身可调（applyLocomotionSpeed 最高 2×、
    // 过场另设 playbackSpeed），任何时间阈值都会在快放时误挡、慢放时误放。
    const seq = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];
    const counts = [0.0005, 0.016, 0.5].map((dt) => {
      const h = harness();
      const e = new FakeEmitter('player');
      h.sys.registerEmitter(e);
      e.frame = 3;
      h.sys.update(dt);
      step(h.sys, e, seq, dt);
      return h.played.length;
    });
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBe(counts[2]);
    expect(counts[0]).toBeGreaterThan(1);
  });

  it('🔴 一帧内推进小半圈（高倍速）仍然响，且 dt 极小也不被挡', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    e.frame = 5;                  // 非落脚帧起步
    h.sys.registerEmitter(e);
    h.sys.update(0.016);
    expect(h.played).toHaveLength(0);
    e.frame = 12;                 // 一帧跨 7 帧，跨过落脚帧 11
    h.sys.update(0.001);          // dt 极小 —— 若有时间闸这里会被误挡
    expect(h.played).toHaveLength(1);
  });

  it('单向跳跃超过半圈会被判成反向（已知取舍，锁在这里）', () => {
    // framesBetween 取最短方向来区分「正向绕一圈」与「反向退一帧」。
    // 代价是：一帧内正向推进超过 n/2 会被读成反向。真实播放不会这么跳
    // （那要求单帧 dt × fps × speed > n/2），但判据摆在这里，改动时能立刻看见。
    expect(framesBetween(0, 12, 16)).toEqual([15, 14, 13, 12]);
  });
});

describe('FootstepSystem：玩家不是特例', () => {
  it('玩家与 NPC 走同一条路径，各自独立跟踪帧号', () => {
    const h = harness();
    const p = new FakeEmitter('player');
    const n = new FakeEmitter('npc_1');
    n.x = 400;
    p.frame = 3;
    n.frame = 3;
    h.sys.registerEmitter(p);
    h.sys.registerEmitter(n);
    h.sys.update(0.2);
    expect(h.played).toHaveLength(2);
    const ids = h.sys.getDebugOutputState().emitters as string[];
    expect(ids).toEqual(['npc_1', 'player']);
  });

  it('NPC 与玩家走同一条路：都交出脚点世界坐标，配置音量一视同仁（距离衰减在空间音总线里，不在这）', () => {
    const h = harness();
    const p = new FakeEmitter('player');
    const n = new FakeEmitter('npc_far');
    n.x = 2000;
    p.frame = 3;
    n.frame = 3;
    h.sys.registerEmitter(p);
    h.sys.registerEmitter(n);
    h.sys.update(0.2);
    const rec = h.sys.getDebugOutputState().recent as Array<{ emitterId: string; world: [number, number, number]; gain: number }>;
    const byId = new Map(rec.map((r) => [r.emitterId, r]));
    expect(byId.get('npc_far')!.world[0]).toBeGreaterThan(byId.get('player')!.world[0] + 1000);
    expect(byId.get('npc_far')!.gain).toBe(byId.get('player')!.gain);
    expect(h.played.every((x) => x.world.length === 3)).toBe(true);
  });

  it('声像跟着发声体的左右走', () => {
    const h = harness();
    const l = new FakeEmitter('left');
    const r = new FakeEmitter('right');
    l.x = 100 - 800;
    r.x = 100 + 800;
    l.frame = 3;
    r.frame = 3;
    h.sys.registerEmitter(l);
    h.sys.registerEmitter(r);
    h.sys.update(0.2);
    // 声像不在本系统里算了：本系统交出去的是脚点的世界坐标，左边的发声体 X 更小
    const rec = h.sys.getDebugOutputState().recent as Array<{ emitterId: string; world: [number, number, number] }>;
    expect(rec.find((x) => x.emitterId === 'left')!.world[0]).toBeLessThan(rec.find((x) => x.emitterId === 'right')!.world[0]);
    expect(h.played.find((p) => p.world[0] < 100)).toBeTruthy();
  });
});

describe('FootstepSystem：确定性 —— 没有轮换、没有抖动', () => {
  it('同一块地同一个片段，每一步都是同一条 key（换声音靠 zone 切集，不靠掷骰子）', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    step(h.sys, e, [11, 3, 11, 3]);
    expect(h.played.length).toBe(5);
    for (const p of h.played) expect(p.id).toBe('step_plank');
  });

  it('不给 rate、同距离下 volume 逐步完全相同（不许无端引入随机）', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    step(h.sys, e, [11, 3]);
    expect(h.played).toHaveLength(3);
    for (const p of h.played) {
      expect('rate' in p.opts).toBe(false);
      expect(p.opts.volume).toBe(h.played[0].opts.volume);
      expect(p.world).toEqual(h.played[0].world);
    }
  });

  it('脚点从一块地走到另一块地，key 随集切换', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    expect(h.played[0].id).toBe('step_plank');
    h.setSet('paper');
    step(h.sys, e, [11]);
    expect(h.played[1].id).toBe('step_paper');
  });

  it('gainDb 负值确实压低音量', () => {
    const cfg: FootstepConfig = { ...CFG, defaults: { ...CFG.defaults, gainDb: -6 } };
    const a = harness();
    const b = harness({ getConfig: () => cfg });
    for (const h of [a, b]) {
      const e = new FakeEmitter('player');
      startOnContact(h, e);
    }
    expect(b.played[0].opts.volume!).toBeLessThan(a.played[0].opts.volume!);
    expect(b.played[0].opts.volume!).toBeCloseTo(a.played[0].opts.volume! * 0.5011872336, 6);
  });

  it('集级 gainDb 与全局 defaults.gainDb 相加', () => {
    const cfg: FootstepConfig = {
      ...CFG,
      sets: { plank: { sfx: { walk: 'step_plank' }, gainDb: -6 } },
      defaults: { gainDb: -6 },
    };
    const a = harness();
    const b = harness({ getConfig: () => cfg });
    for (const h of [a, b]) {
      const e = new FakeEmitter('player');
      startOnContact(h, e);
    }
    expect(b.played[0].opts.volume!).toBeCloseTo(a.played[0].opts.volume! * 0.2511886432, 6);
  });
});

describe('FootstepSystem：没有配置就安静，不瞎凑', () => {
  it('脚点不在任何脚步集上 ⇒ 不发声', () => {
    const h = harness();
    h.setSet(null);
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    expect(h.played).toHaveLength(0);
  });

  it('集里没给这个片段的音效、回落链也没命中 ⇒ 不发声', () => {
    const h = harness();
    h.setSet('paper');                       // paper 只有 walk
    const e = new FakeEmitter('player');
    e.clip = 'carry_walk';                   // 未在 clipFallback 里
    e.contacts = [3, 11];
    startOnContact(h, e);
    expect(h.played).toHaveLength(0);
  });

  it('没有空间上下文（场景没就绪/音频没解锁）⇒ 不发声', () => {
    const h = harness({ getSpatialContext: () => null });
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    expect(h.played).toHaveLength(0);
  });

});

describe('FootstepSystem：生命周期 —— 谁播的谁停', () => {
  it('场景卸载停掉在播的尾音', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    expect(h.played).toHaveLength(1);
    h.sys.clearEmitters();
    expect(h.stopped).toHaveLength(1);
    expect((h.sys.getDebugOutputState().liveHandles as number)).toBe(0);
  });

  it('destroy 停掉在播的尾音并清空发声体', () => {
    const h = harness();
    startOnContact(h, new FakeEmitter('player'));
    h.sys.destroy();
    expect(h.stopped).toHaveLength(1);
    expect(h.sys.getDebugOutputState().emitters).toEqual([]);
  });

  it('读档作废在途尾音（旧时间线不写新状态）', () => {
    const h = harness();
    startOnContact(h, new FakeEmitter('player'));
    h.sys.deserialize({});
    expect(h.stopped).toHaveLength(1);
  });

  it('自然播完的句柄自己摘掉，不会无限积累', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    h.played[0].opts.onEnd?.();
    expect(h.sys.getDebugOutputState().liveHandles).toBe(0);
  });

  it('setEnabled(false) 立即噤声', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    h.sys.setEnabled(false);
    step(h.sys, e, [11, 3]);
    expect(h.played).toHaveLength(1);
    expect(h.stopped).toHaveLength(1);
  });
});

describe('FootstepSystem：调试状态可断言', () => {
  it('记下脚步集/片段/帧/音效/增益/声像/距离/精度级别，并报每个发声体此刻是否在落脚帧', () => {
    const h = harness();
    const e = new FakeEmitter('player');
    startOnContact(h, e);
    const st = h.sys.getDebugOutputState();
    const rec = (st.recent as Array<Record<string, unknown>>)[0];
    expect(rec.setId).toBe('plank');
    expect(rec.clip).toBe('walk');
    expect(rec.frame).toBe(3);
    expect(rec.audioId).toBe('step_plank');
    expect(rec.emitterId).toBe('player');
    expect(rec.mode).toBe('planar');
    expect(typeof rec.gain).toBe('number');
    expect(Array.isArray(rec.world) && (rec.world as number[]).length === 3).toBe(true);
    const live = st.emitterState as Array<{ id: string; contact: boolean }>;
    expect(live[0].id).toBe('player');
    expect(live[0].contact).toBe(true);
  });
});

describe('FootstepSystem：全局空间化总闸 defaults.spatialized', () => {
  const withDefaults = (defaults: Record<string, unknown>) =>
    harness({ getConfig: () => ({ ...CFG, defaults } as typeof CFG) });

  it('缺省（键不存在）走空间化 —— 现网 footstep_sets.json 里根本没这个键,不许因此变哑或变干', () => {
    const h = harness();
    startOnContact(h, new FakeEmitter('player'));
    expect(h.played[0].opts.spatialized).toBe(true);
  });

  it('写 false ⇒ 就播一个声音（AudioManager 据此绕开整条空间音通道）', () => {
    const h = withDefaults({ gainDb: 0, spatialized: false });
    startOnContact(h, new FakeEmitter('player'));
    expect(h.played[0].opts.spatialized).toBe(false);
    // 脚点照算照记：关的是"参不参与发声",不是"算不算得出来"
    expect(Array.isArray(h.played[0].world)).toBe(true);
  });

  it('写 true 与不写等价', () => {
    const h = withDefaults({ gainDb: 0, spatialized: true });
    startOnContact(h, new FakeEmitter('player'));
    expect(h.played[0].opts.spatialized).toBe(true);
  });

  it('🔴 只认真布尔 false：0 / "false" 一律当"没关"', () => {
    for (const bad of [0, 'false', null] as unknown[]) {
      const h = withDefaults({ gainDb: 0, spatialized: bad });
      startOnContact(h, new FakeEmitter('player'));
      expect(h.played[0].opts.spatialized).toBe(true);
    }
  });

  it('总闸不动全局音量：gainDb 照常参与,关空间化不该顺便变响', () => {
    const on = withDefaults({ gainDb: -6 });
    const off = withDefaults({ gainDb: -6, spatialized: false });
    startOnContact(on, new FakeEmitter('player'));
    startOnContact(off, new FakeEmitter('player'));
    expect(off.played[0].opts.volume).toBeCloseTo(on.played[0].opts.volume as number, 12);
  });

  it('调试记录里报出来 —— 不报的话"坐标好好的却没有空间感"查不出原因', () => {
    const h = withDefaults({ gainDb: 0, spatialized: false });
    startOnContact(h, new FakeEmitter('player'));
    const rec = (h.sys.getDebugOutputState().recent as Array<Record<string, unknown>>)[0];
    expect(rec.spatialized).toBe(false);
  });

  it('全局音量缩放：defaults.gainDb 与每集 gainDb 相加后折线性', () => {
    const h = harness({
      getConfig: () => ({
        ...CFG, defaults: { gainDb: -6 },
        sets: { plank: { ...CFG.sets.plank, gainDb: -6 } },
      } as typeof CFG),
    });
    startOnContact(h, new FakeEmitter('player'));
    expect(h.played[0].opts.volume).toBeCloseTo(Math.pow(10, -12 / 20), 10);
  });
});

describe('FootstepSystem：逐条本处音量（乘在 gainDb 之上）', () => {
  it('值写成 { id, volume } 时仍取得出音效 key', () => {
    expect(resolveSfx({ walk: { id: 'step_a', volume: 0.4 } }, undefined, 'walk'))
      .toEqual({ id: 'step_a', volume: 0.4 });
  });

  it('回落链对对象形态一样管用（有 id 就算登记过）', () => {
    const sfx = { walk: { id: 'step_a', volume: 0.4 } };
    const fallback = { carry_walk: 'walk' };
    expect(resolveSfx(sfx, fallback, 'carry_walk')).toEqual({ id: 'step_a', volume: 0.4 });
  });

  it('对象形态里 id 为空 = 没登记，回落链继续往下走', () => {
    expect(resolveSfx({ walk: { id: '  ' } }, undefined, 'walk')).toBeNull();
  });

  it('🔴 本处音量是**乘**在 gainDb 之上，不是替换（dB 管地面、volume 管片段）', () => {
    const cfg: FootstepConfig = {
      ...CFG,
      sets: { plank: { sfx: { walk: { id: 'step_plank', volume: 0.5 } } } },
    };
    const a = harness();
    const b = harness({ getConfig: () => cfg });
    for (const h of [a, b]) {
      const e = new FakeEmitter('player');
      startOnContact(h, e);
    }
    expect(b.played[0].id).toBe('step_plank');
    expect(b.played[0].opts.volume!).toBeCloseTo(a.played[0].opts.volume! * 0.5, 6);
  });

  it('与集级 gainDb 叠加：dB 转线性后再乘本条 volume', () => {
    const cfg: FootstepConfig = {
      ...CFG,
      sets: { plank: { sfx: { walk: { id: 'step_plank', volume: 0.5 } }, gainDb: -6 } },
    };
    const a = harness();
    const b = harness({ getConfig: () => cfg });
    for (const h of [a, b]) {
      const e = new FakeEmitter('player');
      startOnContact(h, e);
    }
    expect(b.played[0].opts.volume!)
      .toBeCloseTo(a.played[0].opts.volume! * 0.5011872336 * 0.5, 6);
  });

  it('没写本处音量的条目行为一字不变（旧数据零迁移）', () => {
    const cfg: FootstepConfig = {
      ...CFG,
      sets: { plank: { sfx: { walk: { id: 'step_plank' } } } },
    };
    const a = harness();
    const b = harness({ getConfig: () => cfg });
    for (const h of [a, b]) {
      const e = new FakeEmitter('player');
      startOnContact(h, e);
    }
    expect(b.played[0].opts.volume!).toBeCloseTo(a.played[0].opts.volume!, 6);
  });
});
