import { describe, expect, it } from 'vitest';

import { FollowerFootstepSystem, type FollowerFootstepDef } from './FollowerFootstepSystem';
import type { FootstepContact } from './FootstepSystem';
import { GameClock } from './gameClock';

/**
 * 跟脚声 = **玩家落脚事件的延迟重放**。听感判不了「错拍对不对」，这份钉死可判的那些：
 *
 * 1. 不走就不响（触发口只有落脚事件，没有任何计时器自己跑）。
 * 2. 错拍按**步间隔的比例**算——同一份配置在两种步频下给出两个不同的延迟，
 *    这正是固定毫秒做不到的那件事（常态一步 ~500ms、背尸一步 ~1000ms）。
 * 3. 声音落在**玩家当时那个脚点**（踩你的脚印）：距离与方向都是白送的。
 * 4. 关掉时排队的最后一声照样响（"你停下了后头还有一下"），`abrupt` 才掐掉。
 * 5. `GameClock.cancelAll()` 是**立刻兑现**不是丢弃——读档那一刻不许凭空响出一串脚步。
 * 6. 开关进档、在途不进档。
 */

/** 真时钟：`after` / `cancelAll` 的语义正是要测的东西，不用假的。 */
function setup(overrides: Partial<FollowerFootstepDef> = {}) {
  const clock = new GameClock();
  const played: Array<{
    emitterId: string; clip: string; sceneX: number; sceneY: number;
    setId?: string; gainDb?: number; atMs: number;
  }> = [];
  let fireProtected = false;
  const sys = new FollowerFootstepSystem({
    nowMs: () => clock.now,
    after: (ms, fire) => clock.after(ms, fire),
    playStep: (args) => { played.push({ ...args, atMs: clock.now }); return true; },
    hasFireProtection: () => fireProtected,
  });
  const def: FollowerFootstepDef = {
    id: 'ridge', delayRatio: 0.5, minDelayMs: 180, gainDb: -6, fireStops: false, ...overrides,
  };
  return {
    clock, played, sys, def,
    setFire: (on: boolean) => { fireProtected = on; },
    /** 推进 ms 毫秒游戏时间（时钟只在没暂停时前进，这里直接喂秒数） */
    advance: (ms: number) => clock.advance(ms / 1000),
    step: (x: number, y: number, clip = 'walk'): FootstepContact => {
      const c: FootstepContact = { emitterId: 'player', clip, frame: 3, contactX: x, contactY: y };
      sys.onSourceContact(c);
      return c;
    },
  };
}

describe('跟脚声：玩家走他才走', () => {
  it('没有落脚事件就一声都不响（站着不动 = 结构上没有触发口）', () => {
    const t = setup();
    t.sys.set(t.def);
    t.advance(10000);
    expect(t.played).toHaveLength(0);
  });

  it('一步之后半拍响一声，落在玩家当时那个脚点上', () => {
    const t = setup();
    t.sys.set(t.def);
    // 第一步：还没量到步间隔，用种子 500ms ⇒ 延迟 250ms
    t.step(100, 200);
    t.advance(249);
    expect(t.played).toHaveLength(0);
    t.advance(2);
    expect(t.played).toHaveLength(1);
    // 踩你的脚印：坐标是**落脚当时**的，不是现在的
    expect(t.played[0]).toMatchObject({ sceneX: 100, sceneY: 200, emitterId: 'follower:ridge', gainDb: -6 });
  });

  it('步频变了错拍跟着变：常态 500ms/步 → 延迟 250ms；背尸 1000ms/步 → 延迟 500ms', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(0, 0); t.advance(500);           // 量到 500ms 一步
    t.step(10, 0);
    const beforeSlow = t.played.length;
    t.advance(250);
    expect(t.played.length).toBe(beforeSlow + 1);  // 半步 = 250ms

    // 换成背尸的步频：两步间隔 1000ms
    t.advance(750);
    t.step(20, 0);
    t.advance(1000);
    t.step(30, 0);
    const n = t.played.length;
    t.advance(499);
    expect(t.played.length).toBe(n);               // 250ms 时还没响 —— 固定毫秒在这里就错了
    t.advance(2);
    expect(t.played.length).toBe(n + 1);           // 半步 = 500ms
  });

  it('跑起来时按下限兜住，不贴成回声', () => {
    const t = setup({ minDelayMs: 180 });
    t.sys.set(t.def);
    t.step(0, 0); t.advance(200);   // 200ms 一步（跑）
    t.step(10, 0);
    t.advance(179);
    expect(t.played).toHaveLength(1); // 只有第一步那一声（种子 500 × 0.5 = 250 < 200+179）
    const n = t.played.length;
    t.advance(2);
    expect(t.played.length).toBe(n + 1); // 100ms 被夹到 180ms
  });

  it('站住很久再起步，不拿那段空白当步频', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(0, 0); t.advance(500);
    t.step(10, 0);                    // 量到 500ms
    t.advance(20000);                 // 站了 20 秒
    t.step(20, 0);
    const n = t.played.length;
    t.advance(250);
    expect(t.played.length).toBe(n + 1); // 仍是半步 250ms，而不是 10 秒
  });
});

describe('跟脚声：关掉与作废', () => {
  it('关掉时排队的最后一声照样响（你停下了，后头还有一下）', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(100, 200);
    t.sys.clear('ridge');
    t.advance(250);
    expect(t.played).toHaveLength(1);
  });

  it('abrupt 连排队的那一声一起掐掉', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(100, 200);
    t.sys.clear('ridge', true);
    t.advance(1000);
    expect(t.played).toHaveLength(0);
  });

  it('关掉之后新的落脚不再排队', () => {
    const t = setup();
    t.sys.set(t.def);
    t.sys.clear('ridge', true);
    t.step(100, 200);
    t.advance(1000);
    expect(t.played).toHaveLength(0);
  });

  it('cancelAll 是「立刻兑现」，但时钟没走到点就不许响（读档不凭空响一串脚步）', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(100, 200);
    t.clock.cancelAll();
    expect(t.played).toHaveLength(0);
    // 兑现过的定时器不会再响第二次
    t.advance(1000);
    expect(t.played).toHaveLength(0);
  });

  it('换场景作废在途那一步（脚点属于上一张图）', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(100, 200);
    t.sys.onSceneChanged();
    t.advance(1000);
    expect(t.played).toHaveLength(0);
    expect(t.sys.has('ridge')).toBe(true); // 跟脚者本人跟着你过去
  });
});

describe('跟脚声：火与存档', () => {
  it('fireStops：举着火不排队；排队之后点着火也不响', () => {
    const t = setup({ fireStops: true });
    t.sys.set(t.def);
    t.setFire(true);
    t.step(0, 0);
    t.advance(1000);
    expect(t.played).toHaveLength(0);

    t.setFire(false);
    t.step(10, 0);
    t.setFire(true);          // 排完队才点着
    t.advance(1000);
    expect(t.played).toHaveLength(0);

    t.setFire(false);
    t.step(20, 0);
    t.advance(1000);
    expect(t.played).toHaveLength(1);
  });

  it('开关与参数进档；在途那一步不进档，读回来也不许响', () => {
    const t = setup();
    t.sys.set({ ...t.def, footstepSet: '纸钱路' });
    t.step(100, 200);
    const snap = t.sys.serialize();
    expect(snap).toEqual({
      followers: [{ id: 'ridge', delayRatio: 0.5, minDelayMs: 180, footstepSet: '纸钱路', gainDb: -6, fireStops: false }],
    });

    const t2 = setup();
    t2.sys.deserialize(snap);
    expect(t2.sys.has('ridge')).toBe(true);
    t2.advance(5000);
    expect(t2.played).toHaveLength(0);     // 旧时间线的那一步没被带过来

    t2.step(7, 8);
    t2.advance(250);
    expect(t2.played[0]).toMatchObject({ setId: '纸钱路', sceneX: 7, sceneY: 8 });
  });

  it('读档作废自己在途的那一步', () => {
    const t = setup();
    t.sys.set(t.def);
    t.step(100, 200);
    t.sys.deserialize({ followers: [{ id: 'ridge' }] });
    t.advance(1000);
    expect(t.played).toHaveLength(0);
    // 缺项按缺省补齐
    expect(t.sys.serialize()).toEqual({
      followers: [{ id: 'ridge', delayRatio: 0.5, minDelayMs: 180, footstepSet: undefined, gainDb: 0, fireStops: false }],
    });
  });

  it('同时两位跟脚者，各响各的', () => {
    const t = setup();
    t.sys.set({ ...t.def, id: 'a', delayRatio: 0.5 });
    t.sys.set({ ...t.def, id: 'b', delayRatio: 1.2 });
    t.step(0, 0);
    t.advance(250);
    expect(t.played.map((p) => p.emitterId)).toEqual(['follower:a']);
    t.advance(350);
    expect(t.played.map((p) => p.emitterId)).toEqual(['follower:a', 'follower:b']);
  });
});
