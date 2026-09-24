/**
 * 粒子 / 群体模拟核心的行为契约：确定性、不入地、不进墙、惊起 → 惊散 → 回巢、碰撞子发射。
 * 空间用合成的（地面 y=0、x=300 处一堵朝 −x 的墙），不依赖任何场景数据。
 */
import { describe, expect, it } from 'vitest';
import type { VfxEffectDef, VfxFieldDef, VfxFlockBehaviorDef } from '../../data/types';
import type { ShellContact } from '../../utils/depthShellField';
import type { Vec3 } from '../../utils/sceneSpace';
import { VfxInstanceSim, VfxParticleMode, createFieldRuntime, type VfxFieldRuntime, type VfxStepContext } from './vfxSim';
import { SHELL_THICKNESS_WU, ShellSide, thinShellSide, type VfxSpace } from './vfxSpace';
import { resolveSceneWind } from '../../utils/sceneWind';

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
  groundNormal(_x: number, _z: number, out: Vec3): Vec3 { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  metricAt(): number { return 1; }
  surfaceAtScene(x: number, y: number): { p: Vec3; normal: Vec3; kind: 'ground' } {
    return { p: [x, 0, -y], normal: [0, 1, 0], kind: 'ground' };
  }
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

/**
 * 画面上一根柱子挡在远墙前面：画面 x ∈ [100, 140] 处可见面是柱子（深度 `front(x)`），
 * 其余是 z = 1000 的远墙。视线 = +z（深度就是 z），法线朝相机（−z）。
 * 这是"粒子能不能藏到遮挡物背后"的最小现场——此前的判据把面后面全当实心，粒子到不了柱子背后。
 */
const PILLAR_X0 = 100, PILLAR_X1 = 140, FAR_WALL_Z = 1000;

class PillarSpace implements VfxSpace {
  readonly kind = 'field' as const;
  readonly hasShell = true;
  readonly wuPerQ = 1;
  readonly viewDir: Vec3 = [0, 0, 1];
  constructor(private readonly front: (x: number) => number = () => 0) {}
  groundY(): number { return 0; }
  groundObserved(): boolean { return true; }
  shellContact(x: number, y: number, z: number): ShellContact | null {
    void y;
    const d = x >= PILLAR_X0 && x <= PILLAR_X1 ? this.front(x) : FAR_WALL_Z;
    return { penWu: z - d, normal: [0, 0, -1], px: 0, py: 0, groundLike: false };
  }
  shellDepthWu(): number | null { return null; }
  toScene(w: Vec3, out: { x: number; y: number }): void { out.x = w[0]; out.y = -w[2] - w[1]; }
  toQ(w: Vec3, out: Vec3): void { out[0] = w[0]; out[1] = w[1]; out[2] = w[2]; }
  anchorToWorld(a: { x: number; y: number; h?: number }): Vec3 { return [a.x, a.h ?? 0, -a.y]; }
  groundWorldAtScene(x: number, y: number): Vec3 { return [x, 0, -y]; }
  groundNormal(_x: number, _z: number, out: Vec3): Vec3 { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  metricAt(): number { return 1; }
  surfaceAtScene(x: number, y: number): { p: Vec3; normal: Vec3; kind: 'ground' } {
    return { p: [x, 0, -y], normal: [0, 1, 0], kind: 'ground' };
  }
}

/** 一颗匀速直飞、会贴壳滑的粒子（没有重力 / 阻力，轨迹一眼可算） */
function oneMover(dir: Vec3, speed: number): VfxEffectDef {
  return {
    id: 'mover',
    emitters: [{
      id: 'm',
      appearance: { image: 'x', sizeWu: 8 },
      spawn: { max: 1, burst: 1, speed: [speed, speed], direction: dir, spread: 0 },
      life: { seconds: [30, 30] },
      collision: { shell: 'slide', radiusWu: 4 },
    }],
  };
}

describe('vfxSim · 薄壳：遮挡物背后是空处，不是实心', () => {
  it('判据本身：面前 / 贴上 / 背后，背后位滞回', () => {
    expect(thinShellSide(-10, 4, false)).toBe(ShellSide.Front);
    expect(thinShellSide(-3, 4, false)).toBe(ShellSide.Contact);
    expect(thinShellSide(SHELL_THICKNESS_WU - 1, 4, false)).toBe(ShellSide.Contact);
    expect(thinShellSide(SHELL_THICKNESS_WU, 4, false)).toBe(ShellSide.Behind);
    // 已在背后：只要仍在面后就一直是背后（哪怕穿深落回一个壳厚以内）
    expect(thinShellSide(5, 4, true)).toBe(ShellSide.Behind);
    expect(thinShellSide(0, 4, true)).toBe(ShellSide.Behind);
    // 回到面前才解除
    expect(thinShellSide(-2, 4, true)).toBe(ShellSide.Contact);
    expect(thinShellSide(-9, 4, true)).toBe(ShellSide.Front);
  });

  it('侧着飘到柱子背后：不被推到柱子前面，照直穿过去', () => {
    const sim = new VfxInstanceSim('p', oneMover([1, 0, 0], 120), [40, 100, 200], 1, new PillarSpace());
    const p = sim.emitters[0].p;
    let sawBehind = false;
    for (let k = 0; k < 90; k++) {
      sim.step(1 / 64, ctx());
      expect(p.z[0]).toBeCloseTo(200, 6);
      if (p.x[0] > PILLAR_X0 + 1 && p.x[0] < PILLAR_X1 - 1) {
        expect(p.behind[0]).toBe(1);
        sawBehind = true;
      }
    }
    expect(sawBehind).toBe(true);
    expect(p.x[0]).toBeGreaterThan(PILLAR_X1);
    expect(p.behind[0]).toBe(0);               // 出了柱子，远墙在它后面
  });

  it('深度在壳厚以内从侧面进来 = 撞上柱子侧面：推回柱面前，推出量不超过一个壳厚', () => {
    const sim = new VfxInstanceSim('p', oneMover([1, 0, 0], 120), [40, 100, 20], 1, new PillarSpace());
    const p = sim.emitters[0].p;
    for (let k = 0; k < 90; k++) {
      const z0 = p.z[0];
      sim.step(1 / 64, ctx());
      expect(z0 - p.z[0]).toBeLessThanOrEqual(SHELL_THICKNESS_WU + 4 + 1e-3);
    }
    expect(p.z[0]).toBeCloseTo(-4, 3);
  });

  it('正面迎上去：挡在面前，不隧穿', () => {
    const sim = new VfxInstanceSim('p', oneMover([0, 0, 1], 300), [120, 100, -300], 1, new PillarSpace());
    const p = sim.emitters[0].p;
    run(sim, 2, () => ctx());
    expect(p.z[0]).toBeCloseTo(-4, 3);
    expect(p.x[0]).toBeCloseTo(120, 6);
    expect(p.behind[0]).toBe(0);
  });

  it('滞回：在背后横挪到斜面更深处（穿深落回壳厚以内）也不被一把推到前面', () => {
    // 柱面左浅右深：x=100 处深 0、x=140 处深 120
    const sim = new VfxInstanceSim('p', oneMover([1, 0, 0], 120), [40, 100, 100], 1,
      new PillarSpace((x) => (x - PILLAR_X0) * 3));
    const p = sim.emitters[0].p;
    let checked = 0;
    for (let k = 0; k < 60; k++) {
      sim.step(1 / 64, ctx());
      // x=125 处面深 75、穿深 25 < 壳厚：无状态的判据会把它推到 z = 71
      if (p.x[0] > 118 && p.x[0] < 130) { expect(p.z[0]).toBeCloseTo(100, 6); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('出生就在遮挡物背后：原地待着，不被推到前面来', () => {
    const sim = new VfxInstanceSim('p', oneMover([1, 0, 0], 0), [120, 100, 300], 1, new PillarSpace());
    const p = sim.emitters[0].p;
    sim.step(1 / 64, ctx());                    // burst 在第一个子步里发
    expect(p.alive[0]).toBe(1);
    expect(p.behind[0]).toBe(1);
    run(sim, 1, () => ctx());
    expect(p.z[0]).toBeCloseTo(300, 6);
  });

  it('薄片（纸钱）同一条：被风卷着横穿柱子背后时不被推到前面', () => {
    const eff: VfxEffectDef = {
      id: 'paper',
      emitters: [{
        id: 'paper',
        appearance: { image: 'x', sizeWu: 16 },
        spawn: { max: 1, burst: 1, speed: [300, 300], direction: [1, 0, 0], spread: 0 },
        // 终端速度取大（重纸），气动减速小，保证 0.6 s 内横穿柱子
        plate: { size: [16, 16], terminalSpeed: 400, replenish: false },
      }],
    };
    const sim = new VfxInstanceSim('p', eff, [90, 200, 250], 3, new PillarSpace());
    const p = sim.emitters[0].p;
    let minZ = Infinity, crossed = false;
    for (let k = 0; k < 40; k++) {
      sim.step(1 / 64, ctx());
      if (!p.alive[0]) break;
      minZ = Math.min(minZ, p.z[0]);
      if (p.x[0] > PILLAR_X0 && p.x[0] < PILLAR_X1) crossed = true;
    }
    expect(crossed).toBe(true);
    expect(minZ).toBeGreaterThan(150);
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

describe('vfxSim · 实例倍率（手持火把：燃烧强度 / 护火）', () => {
  function puffEffect(): VfxEffectDef {
    return {
      id: 'puff_test',
      emitters: [{
        id: 'puff',
        appearance: { image: 'x', sizeWu: 10 },
        spawn: { max: 400, rate: 60, speed: [0, 0] },
        motion: { drag: 3 },
        life: { seconds: [3, 3] },
      }],
    };
  }
  const alive = (sim: VfxInstanceSim) => sim.emitters[0].p.liveCount;
  const WIND = resolveSceneWind({ direction: [1, 0, 0], speed: 400, gust: { amount: 0 }, veer: 0, turbulence: { intensity: 0 } })!;
  const windy = (t: number): VfxStepContext => ({ fields: [], player: null, time: t, wind: WIND, windTime: t });
  const meanX = (sim: VfxInstanceSim) => {
    const p = sim.emitters[0].p;
    let s = 0, n = 0;
    for (let i = 0; i < p.cap; i++) if (p.alive[i]) { s += p.x[i]; n++; }
    return n ? s / n : 0;
  };

  it('发射率 0 是合法值：不再发，在飞的照样活着（火苗是这样灭的）；负数 / NaN 当 1', () => {
    const sim = new VfxInstanceSim('p', puffEffect(), [0, 100, 0], 1, new TestSpace());
    run(sim, 0.5, () => ctx());
    const before = alive(sim);
    expect(before).toBeGreaterThan(20);
    sim.setRateScale(0);
    run(sim, 0.5, () => ctx());
    expect(alive(sim)).toBe(before);
    sim.setRateScale(Number.NaN);
    run(sim, 0.5, () => ctx());
    expect(alive(sim)).toBeGreaterThan(before);
  });

  it('放完（finished）：有时长的发射器过了时长、只有 burst 的发完、且一颗活的都没有才算；一直发的永远放不完', () => {
    const burst = (): VfxEffectDef => ({
      id: 'once', emitters: [
        { id: 'b', appearance: { image: 'x', sizeWu: 4 }, spawn: { max: 10, burst: 5 }, life: { seconds: [0.3, 0.3] } },
        { id: 'r', appearance: { image: 'x', sizeWu: 4 }, spawn: { max: 20, rate: 20, duration: 0.5 }, life: { seconds: [0.3, 0.3] } },
      ],
    });
    const sim = new VfxInstanceSim('o', burst(), [0, 100, 0], 1, new TestSpace());
    expect(sim.finished).toBe(false);
    run(sim, 0.4, () => ctx());
    expect(sim.liveCount).toBeGreaterThan(0);
    expect(sim.finished).toBe(false);
    run(sim, 1, () => ctx());
    expect(sim.liveCount).toBe(0);
    expect(sim.finished).toBe(true);
    const loop = new VfxInstanceSim('p', puffEffect(), [0, 100, 0], 1, new TestSpace());
    run(loop, 5, () => ctx());
    expect(loop.finished).toBe(false);
  });

  it('挪锚点：在飞的粒子按 followAnchor——none 不动、rig 平移 carry、full 平移锚点整个位移；原点一律跟锚点', () => {
    const three = (): VfxEffectDef => {
      const base = puffEffect().emitters[0]!;
      return {
        id: 'follow_test',
        emitters: [
          { ...base, id: 'none' },
          { ...base, id: 'rig', motion: { ...base.motion, followAnchor: 'rig' } },
          { ...base, id: 'full', motion: { ...base.motion, followAnchor: 'full' } },
        ],
      };
    };
    const sim = new VfxInstanceSim('p', three(), [0, 100, 0], 1, new TestSpace());
    run(sim, 0.25, () => ctx());
    const snap = (k: number) => {
      const p = sim.emitters[k]!.p;
      const m = new Map<number, [number, number, number]>();
      for (let i = 0; i < p.cap; i++) if (p.alive[i]) m.set(i, [p.x[i], p.y[i], p.z[i]]);
      return m;
    };
    const at = (k: number, i: number) => { const p = sim.emitters[k]!.p; return [p.x[i], p.y[i], p.z[i]]; };
    const before = [0, 1, 2].map(snap);
    sim.moveAnchor([-50, 110, 20], [-60, 4, 20]);
    for (const [i, v] of before[0]!) expect(at(0, i)).toEqual(v);
    for (const [i, v] of before[1]!) [-60, 4, 20].forEach((d, c) => expect(at(1, i)[c]).toBeCloseTo(v[c]! + d, 3));
    for (const [i, v] of before[2]!) [-50, 10, 20].forEach((d, c) => expect(at(2, i)[c]).toBeCloseTo(v[c]! + d, 3));
    for (const e of sim.emitters) expect(e.origin).toEqual([-50, 110, 20]);
    // 锚点没动、只有 carry（宿主走了、挂件相对宿主退回原位）：rig 照样带
    const mid = snap(1);
    sim.moveAnchor([-50, 110, 20], [5, 0, 0]);
    for (const [i, v] of mid) expect(at(1, i)[0]).toBeCloseTo(v[0] + 5, 3);
    // 不给 carry：rig 不动
    const last = snap(1);
    sim.moveAnchor([0, 0, 0]);
    for (const [i, v] of last) expect(at(1, i)).toEqual(v);
    // 镜头天气显式保留世界粒子：即使资产为 rig/full，已有粒子也不粘住屏幕。
    const worldParticles = [0, 1, 2].map(snap);
    sim.moveAnchor([100, 200, 300], [50, 60, 70], true);
    for (let k = 0; k < 3; k++) {
      for (const [i, v] of worldParticles[k]!) expect(at(k, i)).toEqual(v);
    }
    for (const e of sim.emitters) expect(e.origin).toEqual([100, 200, 300]);
  });

  it('最远烧到多远：强风里粒子离原点不超过 maxDistance（按距离提前走完寿命）；实例倍率立刻缩短；不写不限', () => {
    const windy = (maxDistance?: number): VfxEffectDef => ({
      id: 'flame_len', emitters: [{
        id: 'core', appearance: { image: 'x', sizeWu: 4 },
        spawn: { max: 200, rate: 80, speed: [0, 0] },
        motion: { wind: [3000, 0, 0], drag: 5, maxSpeed: 400 },
        life: { seconds: [1, 1], ...(maxDistance ? { maxDistance } : {}) },
      }],
    });
    const far = (sim: VfxInstanceSim) => {
      const p = sim.emitters[0]!.p; let m = 0;
      for (let i = 0; i < p.cap; i++) if (p.alive[i]) m = Math.max(m, Math.hypot(p.x[i] - 0, p.y[i] - 100, p.z[i] - 0));
      return m;
    };
    const free = new VfxInstanceSim('a', windy(), [0, 100, 0], 1, new TestSpace());
    run(free, 2, () => ctx());
    expect(far(free)).toBeGreaterThan(200);
    const capped = new VfxInstanceSim('b', windy(40), [0, 100, 0], 1, new TestSpace());
    run(capped, 2, () => ctx());
    expect(far(capped)).toBeLessThanOrEqual(40 + 400 / 64 + 1e-6);
    expect(capped.emitters[0]!.p.liveCount).toBeGreaterThan(5);
    capped.setDistanceScale(0.5);
    run(capped, 1 / 32, () => ctx());
    expect(far(capped)).toBeLessThanOrEqual(20 + 2 * 400 / 64 + 1e-6);
  });

  it('大小倍率只乘新生粒子：已经在飞的不跟着缩', () => {
    const sim = new VfxInstanceSim('p', puffEffect(), [0, 100, 0], 1, new TestSpace());
    run(sim, 0.25, () => ctx());
    const p = sim.emitters[0].p;
    const old = new Map<number, number>();
    for (let i = 0; i < p.cap; i++) if (p.alive[i]) old.set(i, p.size[i]);
    sim.setSizeScale(0.5);
    run(sim, 0.25, () => ctx());
    for (const [i, s] of old) expect(p.size[i]).toBe(s);
    let fresh = 0;
    for (let i = 0; i < p.cap; i++) if (p.alive[i] && !old.has(i)) { expect(p.size[i]).toBeCloseTo(5, 9); fresh++; }
    expect(fresh).toBeGreaterThan(5);
  });

  it('吃风倍率：同一阵风里 0 = 不被吹走、0.2 走得比 1 近得多', () => {
    const drift = (k: number) => {
      const sim = new VfxInstanceSim('p', puffEffect(), [0, 100, 0], 1, new TestSpace());
      sim.setWindScale(k);
      run(sim, 1, windy);
      return meanX(sim);
    };
    const full = drift(1), guard = drift(0.2), none = drift(0);
    expect(full).toBeGreaterThan(50);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(full * 0.3);
    expect(Math.abs(none)).toBeLessThan(1e-9);
  });
});
