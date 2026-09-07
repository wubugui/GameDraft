import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWARM_CONFIG,
  bugAlpha,
  createFlock,
  createSeededRng,
  flapFrameIndex,
  flockStats,
  spawnBugs,
  stepBugs,
  stepFlock,
  toSimPlane,
  type Bird,
  type Bug,
} from './swarmSim';

const cfg = DEFAULT_SWARM_CONFIG;
const DT = 1 / 60;

function run(
  birds: Bird[],
  bugs: Bug[],
  center: { x: number; z: number },
  seconds: number,
  rng = createSeededRng(7),
  t0 = 0,
): { bugs: Bug[]; t: number } {
  let t = t0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    bugs = stepBugs(bugs, DT, cfg, rng);
    stepFlock(birds, bugs, center, DT, cfg, rng, 1, t);
    t += DT;
  }
  return { bugs, t };
}

describe('swarmSim · 鸟群盘旋', () => {
  it('平静时整群稳定在盘旋圈附近，高度贴近盘旋高度，恐惧为 0', () => {
    const rng = createSeededRng(1);
    const center = toSimPlane(500, 400, cfg);
    const birds = createFlock(14, center, cfg, rng, 1);
    run(birds, [], center, 8, rng);
    const s = flockStats(birds, center);
    expect(s.meanFear).toBe(0);
    // 平均到中心距离在半径的 ±45% 内（群体规则会把圈撑开/挤扁一点）
    expect(s.meanDist).toBeGreaterThan(cfg.orbitRadius * 0.55);
    expect(s.meanDist).toBeLessThan(cfg.orbitRadius * 1.45);
    expect(Math.abs(s.meanHeight - cfg.orbitHeight)).toBeLessThan(60);
    for (const b of birds) {
      expect(b.h).toBeGreaterThanOrEqual(cfg.minHeight);
      expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
    }
  });

  it('玩家移动时整群跟着挪过去', () => {
    const rng = createSeededRng(2);
    const c0 = toSimPlane(300, 300, cfg);
    const birds = createFlock(12, c0, cfg, rng, 1);
    run(birds, [], c0, 4, rng);
    const c1 = { x: c0.x + 900, z: c0.z + 200 };
    run(birds, [], c1, 10, rng);
    const s = flockStats(birds, c1);
    expect(s.meanDist).toBeLessThan(cfg.orbitRadius * 1.6);
  });

  it('同一种子两次推进结果完全一致（可复现）', () => {
    const c = toSimPlane(0, 0, cfg);
    const a = createFlock(10, c, cfg, createSeededRng(9), 1);
    const b = createFlock(10, c, cfg, createSeededRng(9), 1);
    run(a, [], c, 3, createSeededRng(11));
    run(b, [], c, 3, createSeededRng(11));
    expect(a).toEqual(b);
  });
});

describe('swarmSim · 放虫驱散', () => {
  it('虫放出后恐惧上升、整群拉远拉高；虫散尽后恐惧回落、再回到盘旋圈', () => {
    const rng = createSeededRng(3);
    const center = toSimPlane(600, 500, cfg);
    const birds = createFlock(14, center, cfg, rng, 1);
    run(birds, [], center, 6, rng);
    const calm = flockStats(birds, center);

    // 从玩家身边放出一把虫
    let bugs = spawnBugs(40, center, cfg, rng);
    let r = run(birds, bugs, center, 2.5, rng);
    bugs = r.bugs;
    const scared = flockStats(birds, center);
    expect(scared.meanFear).toBeGreaterThan(0.5);
    expect(scared.meanDist).toBeGreaterThan(calm.meanDist * 1.5);
    expect(scared.meanHeight).toBeGreaterThan(calm.meanHeight + 40);
    // 惊时不滑翔
    expect(birds.every((b) => !b.gliding)).toBe(true);

    // 等虫全散（寿命上限 7.5s）+ 恐惧退干净（1/0.22 ≈ 4.5s）+ 回巢
    r = run(birds, bugs, center, 22, rng, r.t);
    expect(r.bugs.length).toBe(0);
    const back = flockStats(birds, center);
    expect(back.meanFear).toBe(0);
    expect(back.meanDist).toBeLessThan(cfg.orbitRadius * 1.5);
    expect(Math.abs(back.meanHeight - cfg.orbitHeight)).toBeLessThan(60);
  });

  it('恐惧是连续量：涨得快退得慢，中途不会硬切', () => {
    const rng = createSeededRng(4);
    const center = toSimPlane(0, 0, cfg);
    const birds = createFlock(8, center, cfg, rng, 1);
    run(birds, [], center, 3, rng);
    let bugs = spawnBugs(30, center, cfg, rng);
    let prev = flockStats(birds, center).meanFear;
    let maxJump = 0;
    let t = 0;
    for (let i = 0; i < 60 * 12; i++) {
      bugs = stepBugs(bugs, DT, cfg, rng);
      stepFlock(birds, bugs, center, DT, cfg, rng, 1, t);
      t += DT;
      const f = flockStats(birds, center).meanFear;
      maxJump = Math.max(maxJump, Math.abs(f - prev));
      prev = f;
    }
    // 单帧恐惧变化不超过 fearRise·dt（涨）——没有瞬间置 1 / 置 0
    expect(maxJump).toBeLessThanOrEqual(cfg.fearRise * DT + 1e-9);
  });

  it('虫会散开、寿命到了消失、末秒淡出', () => {
    const rng = createSeededRng(5);
    const center = { x: 0, z: 0 };
    let bugs = spawnBugs(25, center, cfg, rng);
    expect(bugs).toHaveLength(25);
    bugs = run([], bugs, center, 2, rng).bugs;
    expect(bugs.length).toBe(25);
    const spread = bugs.reduce((acc, b) => acc + Math.hypot(b.x, b.z), 0) / bugs.length;
    expect(spread).toBeGreaterThan(30);
    for (const b of bugs) expect(b.h).toBeGreaterThan(0);
    // 淡出：把一只虫推到末 0.5 秒
    const b0 = bugs[0]!;
    b0.age = b0.life - 0.5;
    expect(bugAlpha(b0)).toBeCloseTo(0.5, 5);
    bugs = run([], bugs, center, 8, rng).bugs;
    expect(bugs.length).toBe(0);
  });
});

describe('swarmSim · 扑翼帧', () => {
  it('相位按整周映射到 [0, frames)，负相位也不越界', () => {
    expect(flapFrameIndex(0, 8)).toBe(0);
    expect(flapFrameIndex(Math.PI, 8)).toBe(4);
    expect(flapFrameIndex(Math.PI * 2 - 1e-9, 8)).toBe(7);
    expect(flapFrameIndex(-0.1, 8)).toBeGreaterThanOrEqual(0);
    expect(flapFrameIndex(-0.1, 8)).toBeLessThan(8);
  });
});
