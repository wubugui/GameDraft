/**
 * 粒子 / 群体模拟核心的行为契约：确定性、不入地、不进墙、惊起 → 惊散 → 回巢、碰撞子发射。
 * 空间用合成的（地面 y=0、x=300 处一堵朝 −x 的墙），不依赖任何场景数据。
 */
import { describe, expect, it } from 'vitest';
import type { VfxEffectDef, VfxFieldDef, VfxFlockBehaviorDef } from '../../data/types';
import type { ShellContact } from '../../utils/depthShellField';
import type { Vec3 } from '../../utils/sceneSpace';
import { VfxInstanceSim, VfxParticleMode, createFieldRuntime, type VfxFieldRuntime, type VfxStepContext } from './vfxSim';
import type { VfxSpace } from './vfxSpace';

const WALL_X = 300;

class TestSpace implements VfxSpace {
  readonly kind = 'field' as const;
  readonly hasShell = true;
  readonly wuPerQ = 1;
  readonly viewDir: Vec3 = [0, 0, 1];
  groundY(): number { return 0; }
  groundObserved(): boolean { return true; }
  shellContact(x: number, y: number, z: number): ShellContact | null {
    void y; void z;
    return { penWu: x - WALL_X, normal: [-1, 0, 0], px: 0, py: 0, groundLike: false };
  }
  shellDepthWu(): number | null { return null; }
  toScene(w: Vec3, out: { x: number; y: number }): void { out.x = w[0]; out.y = -w[2] - w[1]; }
  toQ(w: Vec3, out: Vec3): void { out[0] = w[0]; out[1] = w[1]; out[2] = w[2]; }
  anchorToWorld(a: { x: number; y: number; h?: number }): Vec3 { return [a.x, a.h ?? 0, -a.y]; }
  groundWorldAtScene(x: number, y: number): Vec3 { return [x, 0, -y]; }
}

const BAT: VfxFlockBehaviorDef = {
  cruise: 400, max: 700, maxAccel: 2600, minAltitude: 60,
  senseRadius: 120, separation: 30,
  accel: { separation: 2000, alignment: 800, cohesion: 600 },
  orbit: { radius: 180, height: 170, handedness: 'mixed' },
  home: { nestRadius: 40, rangeRadius: 900, startleRadius: 260 },
  attitude: { fear: { 'item:bug': 1, startle: 0 }, reactionDelay: [0.05, 0.25], fearDecay: 0.6, fleeThreshold: 0.25, calmSeconds: 2 },
  initialState: 'roosting',
  wingFlap: { atCruise: 8, atMax: 14 },
  speedJitter: 0.15,
  wander: 300,
};

function batEffect(): VfxEffectDef {
  return {
    id: 'bat_test',
    emitters: [{
      id: 'bats',
      appearance: { animFile: 'x', sizeWu: 22 },
      spawn: { max: 40 },
      behavior: BAT,
    }],
  };
}

function dripEffect(): VfxEffectDef {
  return {
    id: 'drip_test',
    emitters: [
      {
        id: 'drop',
        appearance: { image: 'x', sizeWu: 4 },
        spawn: { max: 20, rate: 4, speed: [0, 0] },
        motion: { gravity: 865 },
        life: { seconds: [5, 5] },
        collision: { ground: 'kill', onHit: { emitter: 'splash', count: 3 } },
      },
      {
        id: 'splash',
        subOnly: true,
        appearance: { image: 'x', sizeWu: 2 },
        spawn: { max: 60, speed: [80, 160], spread: 60 },
        motion: { gravity: 865 },
        life: { seconds: [0.4, 0.4] },
        collision: { ground: 'kill' },
      },
    ],
  };
}

function ctx(fields: VfxFieldRuntime[] = [], player: Vec3 | null = null, speed = 0, time = 0): VfxStepContext {
  return { fields, player: player ? { world: player, speed } : null, time };
}

function run(sim: VfxInstanceSim, seconds: number, mk: (t: number) => VfxStepContext, dt = 1 / 64): void {
  let t = 0;
  while (t < seconds) { sim.step(dt, mk(t)); t += dt; }
}

function positions(sim: VfxInstanceSim): number[] {
  const out: number[] = [];
  for (const e of sim.emitters) for (let i = 0; i < e.p.cap; i++) {
    if (!e.p.alive[i]) continue;
    out.push(e.p.x[i], e.p.y[i], e.p.z[i]);
  }
  return out;
}

describe('vfxSim · 确定性', () => {
  it('同种子 + 同 dt 串 ⇒ 逐位相同（含群体与子发射）', () => {
    const mk = (t: number) => ctx([], [150, 0, 0], 0, t);
    const a = new VfxInstanceSim('a', batEffect(), [100, 0, 100], 42, new TestSpace());
    const b = new VfxInstanceSim('b', batEffect(), [100, 0, 100], 42, new TestSpace());
    run(a, 3, mk); run(b, 3, mk);
    expect(positions(a)).toEqual(positions(b));
    const c = new VfxInstanceSim('c', dripEffect(), [0, 200, 0], 7, new TestSpace());
    const d = new VfxInstanceSim('d', dripEffect(), [0, 200, 0], 7, new TestSpace());
    run(c, 4, () => ctx()); run(d, 4, () => ctx());
    expect(positions(c)).toEqual(positions(d));
  });
  it('换种子 ⇒ 不同', () => {
    const mk = (t: number) => ctx([], [150, 0, 0], 0, t);
    const a = new VfxInstanceSim('a', batEffect(), [100, 0, 100], 1, new TestSpace());
    const b = new VfxInstanceSim('b', batEffect(), [100, 0, 100], 2, new TestSpace());
    run(a, 2, mk); run(b, 2, mk);
    expect(positions(a)).not.toEqual(positions(b));
  });
});

describe('vfxSim · 通用粒子', () => {
  it('滴水：落地即死，撞点发出水花子粒子，水花也落地死', () => {
    const sim = new VfxInstanceSim('d', dripEffect(), [0, 300, 0], 3, new TestSpace());
    const hits: number[] = [];
    let splashSeen = 0;
    run(sim, 3, () => ctx(), 1 / 64);
    // 逐步观察事件
    for (let k = 0; k < 64 * 3; k++) {
      sim.step(1 / 64, ctx());
      for (const ev of sim.events) if (ev.type === 'hit' && ev.emitter === 'drop') hits.push(ev.at[1]);
      splashSeen = Math.max(splashSeen, sim.emitters[1].p.liveCount);
    }
    expect(hits.length).toBeGreaterThan(5);
    for (const y of hits) expect(y).toBeCloseTo(2, 5);   // 半径 sizeWu/2 = 2
    expect(splashSeen).toBeGreaterThan(0);
    // 任何时刻没有粒子在地面之下
    for (const e of sim.emitters) for (let i = 0; i < e.p.cap; i++) if (e.p.alive[i]) expect(e.p.y[i]).toBeGreaterThanOrEqual(0);
  });
  it('寿命到即死、容量封顶', () => {
    // 起点够高（落地要 8 s 以上），寿命 5 s 先到
    const sim = new VfxInstanceSim('d', dripEffect(), [0, 30000, 0], 3, new TestSpace());
    run(sim, 10, () => ctx());
    expect(sim.emitters[0].p.liveCount).toBeLessThanOrEqual(20);
    expect(sim.emitters[0].p.liveCount).toBeGreaterThan(10);   // 4/s × 5s 寿命 = 20 稳态
  });
});

/** 会飘的普通粒子（萤火虫那一类）：可选地挂刺激反应 */
function driftEffect(stimulus?: { fear?: Record<string, number>; attract?: Record<string, number>; accel: number }): VfxEffectDef {
  return {
    id: 'drift_test',
    emitters: [{
      id: 'motes',
      appearance: { image: 'x', sizeWu: 6 },
      spawn: { max: 24, burst: 24, shape: { kind: 'sphere', radius: 60 }, speed: [0, 0] },
      motion: { drag: 0.6, maxSpeed: 110, ...(stimulus ? { stimulus } : {}) },
      life: { seconds: [60, 60] },
    }],
  };
}

/** 一群粒子离某点的平均距离 */
function meanDistTo(sim: VfxInstanceSim, at: Vec3): number {
  let n = 0, d = 0;
  for (const e of sim.emitters) for (let i = 0; i < e.p.cap; i++) {
    if (!e.p.alive[i]) continue;
    n++;
    d += Math.hypot(e.p.x[i] - at[0], e.p.y[i] - at[1], e.p.z[i] - at[2]);
  }
  return n ? d / n : 0;
}

describe('vfxSim · 普通粒子的刺激反应（motion.stimulus）', () => {
  const CENTER: Vec3 = [0, 200, 0];
  const FEAR: VfxFieldDef = { kind: 'fear', tag: 'player:motion', radius: 320, strength: 0.24 };

  it('没配 stimulus 的发射器对 fear 场完全无动于衷（烟 / 水滴不该被人走过就吹散）', () => {
    const sim = new VfxInstanceSim('a', driftEffect(), CENTER, 7, new TestSpace());
    const f = [createFieldRuntime(FEAR, CENTER)];
    sim.step(1 / 64, ctx(f));
    const d0 = meanDistTo(sim, CENTER);
    run(sim, 2, () => ctx(f));
    expect(meanDistTo(sim, CENTER)).toBeCloseTo(d0, 6);
  });

  it('配了就被推开，方向是"场心 → 粒子"', () => {
    const sim = new VfxInstanceSim('a', driftEffect({ fear: { 'player:motion': 1 }, accel: 1600 }), CENTER, 7, new TestSpace());
    const f = [createFieldRuntime(FEAR, CENTER)];
    sim.step(1 / 64, ctx(f));
    const d0 = meanDistTo(sim, CENTER);
    run(sim, 2, () => ctx(f));
    expect(meanDistTo(sim, CENTER)).toBeGreaterThan(d0 + 20);
  });

  it('只认自己表里的标签：标签对不上 = 权重 0 = 没反应', () => {
    const sim = new VfxInstanceSim('a', driftEffect({ fear: { 'item:bug': 1 }, accel: 1600 }), CENTER, 7, new TestSpace());
    const f = [createFieldRuntime(FEAR, CENTER)];
    sim.step(1 / 64, ctx(f));
    const d0 = meanDistTo(sim, CENTER);
    run(sim, 2, () => ctx(f));
    expect(meanDistTo(sim, CENTER)).toBeCloseTo(d0, 6);
  });

  it('attract 把它们拉过去（与 fear 反号）', () => {
    const at: VfxFieldDef = { kind: 'attract', tag: 'bait', radius: 320, strength: 0.5 };
    const sim = new VfxInstanceSim('a', driftEffect({ attract: { bait: 1 }, accel: 1600 }), CENTER, 7, new TestSpace());
    const f = [createFieldRuntime(at, CENTER)];
    sim.step(1 / 64, ctx(f));
    const d0 = meanDistTo(sim, CENTER);
    run(sim, 1.2, () => ctx(f));
    expect(meanDistTo(sim, CENTER)).toBeLessThan(d0);
  });

  it('场强 0（玩家站着不动）时一点也不推', () => {
    const still: VfxFieldDef = { ...FEAR, strength: 0 };
    const sim = new VfxInstanceSim('a', driftEffect({ fear: { 'player:motion': 1 }, accel: 1600 }), CENTER, 7, new TestSpace());
    const f = [createFieldRuntime(still, CENTER)];
    sim.step(1 / 64, ctx(f));
    const d0 = meanDistTo(sim, CENTER);
    run(sim, 2, () => ctx(f));
    expect(meanDistTo(sim, CENTER)).toBeCloseTo(d0, 6);
  });

  it('群体不吃这条：有 behavior 时 stimulus 被忽略（两套反应不叠加）', () => {
    const eff = batEffect();
    eff.emitters[0].motion = { stimulus: { fear: { 'player:motion': 1 }, accel: 5000 } };
    const sim = new VfxInstanceSim('a', eff, [0, 200, 0], 3, new TestSpace());
    expect(sim.emitters[0].stim).toBeNull();
  });
});

describe('vfxSim · 群体', () => {
  it('栖息：玩家远处不动；进惊起半径即惊起，个体全部离巢', () => {
    const sim = new VfxInstanceSim('b', batEffect(), [0, 200, 0], 5, new TestSpace());
    expect(sim.state).toBe('roosting');
    run(sim, 1, (t) => ctx([], [800, 0, 0], 0, t));
    expect(sim.state).toBe('roosting');
    for (let i = 0; i < 40; i++) expect(sim.emitters[0].p.mode[i]).toBe(VfxParticleMode.Roosting);
    sim.step(1 / 64, ctx([], [100, 0, 0], 0, 1));
    expect(sim.state).toBe('airborne');
    expect(sim.events.some((e) => e.type === 'flockState' && e.to === 'airborne')).toBe(true);
    run(sim, 0.5, (t) => ctx([], [100, 0, 0], 0, 1 + t));
    let flying = 0;
    for (let i = 0; i < 40; i++) if (sim.emitters[0].p.mode[i] === VfxParticleMode.Flying) flying++;
    expect(flying).toBe(40);
  });

  it('环绕：飞起来后个体围着玩家、不入地、不进墙、速度在巡航附近', () => {
    const sim = new VfxInstanceSim('b', batEffect(), [0, 200, 0], 9, new TestSpace());
    const player: Vec3 = [120, 0, 40];
    run(sim, 6, (t) => ctx([], player, 0, t));
    const p = sim.emitters[0].p;
    let sumD = 0;
    for (let i = 0; i < p.cap; i++) {
      expect(p.alive[i]).toBe(1);
      expect(p.y[i]).toBeGreaterThanOrEqual(11 - 1e-3);           // 半径 11
      expect(p.x[i]).toBeLessThanOrEqual(WALL_X - 11 + 1e-3);     // 墙前
      const spd = Math.hypot(p.vx[i], p.vy[i], p.vz[i]);
      expect(spd).toBeGreaterThan(BAT.cruise * 0.3);
      expect(spd).toBeLessThanOrEqual(BAT.max * 1.16);
      sumD += Math.hypot(p.x[i] - player[0], p.z[i] - player[2]);
    }
    const meanD = sumD / p.cap;
    expect(meanD).toBeGreaterThan(60);
    expect(meanD).toBeLessThan(BAT.orbit.radius * 2.2);
  });

  it('放虫：恐惧脉冲 → 群转 fleeing、远离源；安静后回到 airborne', () => {
    const sim = new VfxInstanceSim('b', batEffect(), [0, 200, 0], 11, new TestSpace());
    const player: Vec3 = [100, 0, 0];
    run(sim, 4, (t) => ctx([], player, 0, t));
    expect(sim.state).toBe('airborne');
    const before = sim.centroid([0, 0, 0]);
    // 恐惧稳态 ≈ 场强 × 权重（衰减 0.6/s 时 λ≈0.92）：轨道半径处场强要明显高于 fleeThreshold
    const bug: VfxFieldDef = { kind: 'fear', tag: 'item:bug', radius: 700, strength: 3, duration: 3 };
    const fields = [createFieldRuntime(bug, player)];
    let firstFlee = -1;
    let t = 4;
    for (let k = 0; k < 64 * 3; k++) {
      sim.step(1 / 64, ctx(fields, player, 0, t));
      fields[0].remaining -= 1 / 64;
      t += 1 / 64;
      if (firstFlee < 0 && sim.state === 'fleeing') firstFlee = t - 4;
    }
    expect(firstFlee).toBeGreaterThan(0);
    expect(firstFlee).toBeLessThan(1.0);
    const after = sim.centroid([0, 0, 0]);
    const dBefore = Math.hypot(before[0] - player[0], before[2] - player[2]);
    const dAfter = Math.hypot(after[0] - player[0], after[2] - player[2]);
    expect(dAfter).toBeGreaterThan(dBefore);
    // 场消失、安静 calmSeconds 后回到环绕
    run(sim, 6, (tt) => ctx([], player, 0, 7 + tt));
    expect(sim.state).toBe('airborne');
  });

  it('玩家离开活动域 → returning → 全部落巢 → roosting', () => {
    const sim = new VfxInstanceSim('b', batEffect(), [0, 200, 0], 13, new TestSpace());
    run(sim, 3, (t) => ctx([], [100, 0, 0], 0, t));
    expect(sim.state).toBe('airborne');
    run(sim, 3, (t) => ctx([], [2500, 0, 0], 0, 3 + t));
    expect(['returning', 'roosting']).toContain(sim.state);
    run(sim, 20, (t) => ctx([], [2500, 0, 0], 0, 6 + t));
    expect(sim.state).toBe('roosting');
    const p = sim.emitters[0].p;
    // 巢**整团沿壳法线推出半个身位**（否则以原点为心的球有一半埋在崖壁里、那些个体永远被遮挡）：
    // 挂点 = 法线 × nestRadius + 半径 0.75·nestRadius 的随机球 ⇒ 离原点最远 1.75 倍。
    const NEST_MAX = BAT.home.nestRadius * 1.75;
    for (let i = 0; i < p.cap; i++) {
      expect(p.mode[i]).toBe(VfxParticleMode.Roosting);
      expect(Math.hypot(p.x[i], p.y[i] - 200, p.z[i])).toBeLessThanOrEqual(NEST_MAX + 1e-3);
      // 测试空间的墙在 x=WALL_X、法线 (−1,0,0)：整团必须偏向法线那一侧（x 变小）
      expect(p.x[i]).toBeLessThan(BAT.home.nestRadius * 0.75 + 1e-3);
    }
  });

  it('崖壁上的巢：挂点全部在壳外（不埋进石头里）', () => {
    const sim = new VfxInstanceSim('b', batEffect(), [WALL_X - 20, 200, 0], 17, new TestSpace());
    const e = sim.emitters[0], p = e.p;
    let inShell = 0;
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      const c = new TestSpace().shellContact(p.x[i], p.y[i], p.z[i])!;
      if (c.penWu > e.radius) inShell++;
    }
    expect(inShell).toBe(0);
  });

  it('大 dt 被封顶：一帧最多 12 子步，不会爆炸', () => {
    const sim = new VfxInstanceSim('b', batEffect(), [0, 200, 0], 1, new TestSpace());
    sim.setFlockState('airborne');
    for (let k = 0; k < 30; k++) sim.step(0.5, ctx([], [100, 0, 0], 0, k * 0.5));
    const p = sim.emitters[0].p;
    for (let i = 0; i < p.cap; i++) {
      expect(Number.isFinite(p.x[i]) && Number.isFinite(p.y[i]) && Number.isFinite(p.z[i])).toBe(true);
      expect(Math.hypot(p.x[i], p.z[i])).toBeLessThan(5000);
    }
  });
});
