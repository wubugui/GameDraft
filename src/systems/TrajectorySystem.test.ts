/**
 * `TrajectorySystem` —— 烘焙式实体轨迹的播放系统。
 *
 * 这一层的贵处不在插值（插值在 `keyframeSampler`，另有金标锁死），在**三件事**：
 *
 * 1. **通道规范化**：采样器是"哑"的，不懂 `sortY` 缺省 = `y`、`scaleX/scaleY` 缺省 = `scale`。
 *    漏了不报错，只是深度排序锚被当 0 插值——本文件"通道规范化"一节就是为了钉死它。
 * 2. **封口**（norms 律 3）：抢占 / 停止 / 取消 / 系统销毁 / 目标被销毁，五条路各自必须
 *    resolve 恰一次。悬挂的 Promise 是审批红线。
 * 3. **确定性**：只吃传进来的 `dt`，不读挂钟；同一份 def + 同一串 dt ⇒ 逐位相同。
 */
import { describe, expect, it, vi } from 'vitest';
import { Texture, TextureSource } from 'pixi.js';

import { TrajectorySystem, type TrajectoryEndReason, type TrajectoryPlayDef } from './TrajectorySystem';
import { Npc } from '../entities/Npc';
import { Player } from '../entities/Player';
import type { InputManager } from '../core/InputManager';
import type {
  AnimationSetDef,
  GameContext,
  ITrajectoryTarget,
  NpcDef,
  TrajectoryKeyframe,
  TrajectoryPose,
} from '../data/types';

// ═══════════════════════════════════ 脚手架 ═══════════════════════════════════

/** 只记调用序的假目标：所有权/顺序类断言全靠它。 */
class FakeTarget implements ITrajectoryTarget {
  readonly trajectoryKey: string;
  anchor = { x: 0, y: 0 };
  poses: TrajectoryPose[] = [];
  calls: string[] = [];
  private hook: (() => void) | null = null;

  constructor(key = 'player') {
    this.trajectoryKey = key;
  }

  readTrajectoryAnchor(): { x: number; y: number } {
    this.calls.push('anchor');
    return { ...this.anchor };
  }

  beginTrajectory(onPreempt: () => void): void {
    this.calls.push('begin');
    this.hook = onPreempt;
  }

  applyTrajectoryPose(pose: TrajectoryPose): void {
    this.calls.push('pose');
    this.poses.push({ ...pose });
  }

  endTrajectory(reset: boolean): void {
    this.calls.push(`end:${reset}`);
    this.hook = null;
  }

  /** 模拟实体被别人抢走（`moveTo`/`jumpTo`/`destroy`）：**先注销再回调**，与实体实现同构。 */
  firePreempt(): void {
    const cb = this.hook;
    this.hook = null;
    cb?.();
  }

  get hasHook(): boolean {
    return this.hook !== null;
  }

  get lastPose(): TrajectoryPose | undefined {
    return this.poses[this.poses.length - 1];
  }
}

function makeSystem(): { sys: TrajectorySystem; suspendPatrol: ReturnType<typeof vi.fn> } {
  const suspendPatrol = vi.fn<(npcId: string) => void>();
  const sys = new TrajectorySystem({ suspendPatrol });
  sys.init({} as unknown as GameContext);
  return { sys, suspendPatrol };
}

const def = (keyframes: TrajectoryKeyframe[], id = 't1'): TrajectoryPlayDef => ({
  id,
  keyframes,
});

/** 一条带缓动、跨三帧、全通道都在动的轨迹（确定性用）。 */
const RICH = def([
  { atMs: 0, x: 0, y: 0 },
  { atMs: 400, x: 100, y: 50, rotation: 90, scale: 2, alpha: 0.5, easing: 'easeInOut' },
  { atMs: 1000, x: 300, y: -20, rotation: -45, scale: 0.5, alpha: 1 },
]);

const PENDING = Symbol('pending');

/** Promise 是否已封口：用真宏任务兜底，避免微任务竞争把"悬挂"误判成已 resolve。 */
async function outcome(
  p: Promise<TrajectoryEndReason>,
): Promise<TrajectoryEndReason | typeof PENDING> {
  return Promise.race([
    p,
    new Promise<typeof PENDING>((r) => { setTimeout(() => r(PENDING), 0); }),
  ]);
}

// 真实体（抢占矩阵用）
const CELL_W = 32;
const CELL_H = 48;

function animDef(): AnimationSetDef {
  return {
    spritesheet: 'x.png',
    cols: 2,
    rows: 1,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    worldWidth: 100,
    worldHeight: 150,
    states: { idle: { frames: [0], frameRate: 8, loop: true } },
  };
}

function texture(): Texture {
  return new Texture({ source: new TextureSource({ width: CELL_W * 2, height: CELL_H }) });
}

function makeNpc(id = '门卫'): Npc {
  const npc = new Npc({ id, name: '甲', x: 10, y: 20, interactionRange: 40 } as NpcDef);
  npc.loadSprite(texture(), animDef(), 'idle');
  return npc;
}

function makePlayer(): Player {
  const im = {
    getMovementDirection: () => ({ x: 0, y: 0 }),
    isRunning: () => false,
  } as unknown as InputManager;
  const p = new Player(im);
  p.sprite.loadFromDef(texture(), animDef());
  p.sprite.playAnimation('idle');
  return p;
}

// ═══════════════════════════════════ 确定性 ═══════════════════════════════════

describe('TrajectorySystem · 确定性', () => {
  /** `play` 会当帧落首帧姿态，所以 poses[0] 是 t=0，poses[n] 是第 n 次 update 之后。 */
  function run(dts: number[]): TrajectoryPose[] {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    void sys.play(RICH, t);
    for (const dt of dts) sys.update(dt);
    return t.poses;
  }

  it('同一份 def + 同一串 dt ⇒ 逐位相同（不读任何挂钟）', () => {
    const dts = [1 / 60, 1 / 60, 0.1, 0, 0.25, 1 / 120];
    expect(run(dts)).toEqual(run(dts));
  });

  it('不同帧率走到同一 t：姿态逐位相等', () => {
    // ⚠ 取 1/64 与 1/32 而不是计划书里的 1/60 与 1/30：后者的毫秒累加**不是**二进制精确
    //   （12×(1/60)*1000 = 199.99999999999997，6×(1/30)*1000 = 200.00000000000003），
    //   逐位相等的断言会被浮点累加本身否掉，测不到系统的确定性。1/64、1/32 都是精确二进制小数。
    const fine = run(new Array(8).fill(1 / 64));   // 8 × 15.625ms = 125ms
    const coarse = run(new Array(4).fill(1 / 32)); // 4 × 31.25ms  = 125ms
    expect(fine[8]).toEqual(coarse[4]);
  });

  it('不同帧率的终姿相同（跑到末帧）', () => {
    const a = run(new Array(64).fill(1 / 64));
    const b = run(new Array(32).fill(1 / 32));
    expect(a[a.length - 1]).toEqual(b[b.length - 1]);
    // 末帧就是最后一个关键帧（缩放/透明/旋转都已落到位）
    expect(a[a.length - 1]).toEqual({
      x: 300, y: -20, rotationDeg: -45, scaleX: 0.5, scaleY: 0.5, alpha: 1, sortY: -20,
    });
  });

  it('60/30fps 在浮点误差内一致（帧率无关，非逐位）', () => {
    const fine = run(new Array(12).fill(1 / 60));
    const coarse = run(new Array(6).fill(1 / 30));
    expect(fine[12].x).toBeCloseTo(coarse[6].x, 9);
    expect(fine[12].y).toBeCloseTo(coarse[6].y, 9);
    expect(fine[12].rotationDeg).toBeCloseTo(coarse[6].rotationDeg, 9);
  });

  it('非有限 dt 不推进时间轴（NaN 不许渗进姿态）', () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    void sys.play(RICH, t);
    sys.update(Number.NaN);
    sys.update(Number.POSITIVE_INFINITY);
    expect(t.lastPose).toEqual(t.poses[0]);
    expect(Number.isFinite(t.lastPose!.x)).toBe(true);
  });
});

// ══════════════════════════════ 通道规范化（重灾区）══════════════════════════════

describe('TrajectorySystem · 通道规范化', () => {
  function poseAt(kf: TrajectoryKeyframe[], tMs: number): TrajectoryPose {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    void sys.play(def(kf), t);
    if (tMs > 0) sys.update(tMs / 1000);
    return t.lastPose!;
  }

  it('帧上不写 sortY ⇒ sortY 恒等于该时刻的 y（不是 0）', () => {
    const kf: TrajectoryKeyframe[] = [
      { atMs: 0, x: 0, y: 200 },
      { atMs: 100, x: 0, y: 400 },
    ];
    expect(poseAt(kf, 0).sortY).toBe(200);
    expect(poseAt(kf, 50).sortY).toBe(300);
    expect(poseAt(kf, 100).sortY).toBe(400);
    // 与 y 同值不是巧合：缺省就是"接地锚 = 脚点"
    expect(poseAt(kf, 50).y).toBe(300);
  });

  it('sortY 缺省是**逐帧**取该帧的 y（不是整条轨迹一个常数）', () => {
    // 首帧显式写了很低的接地锚（飞在空中的物件落点在下方），末帧不写 ⇒ 末帧取自己的 y
    const kf: TrajectoryKeyframe[] = [
      { atMs: 0, x: 0, y: 0, sortY: -1000 },
      { atMs: 100, x: 0, y: 100 },
    ];
    expect(poseAt(kf, 0).sortY).toBe(-1000);
    expect(poseAt(kf, 100).sortY).toBe(100);
    // 中点在 -1000 → 100 之间线性插值，而不是在 0 → 100 之间
    expect(poseAt(kf, 50).sortY).toBe(-450);
    expect(poseAt(kf, 50).y).toBe(50);
  });

  it('scaleX/scaleY 缺省取 scale；单轴写了只覆盖该轴', () => {
    const kf: TrajectoryKeyframe[] = [
      { atMs: 0, x: 0, y: 0, scale: 2 },
      { atMs: 100, x: 0, y: 0, scale: 4, scaleY: 10 },
    ];
    expect(poseAt(kf, 0)).toMatchObject({ scaleX: 2, scaleY: 2 });
    expect(poseAt(kf, 100)).toMatchObject({ scaleX: 4, scaleY: 10 });
    expect(poseAt(kf, 50)).toMatchObject({ scaleX: 3, scaleY: 6 });
  });

  it('scale 全缺省 ⇒ 1；rotation ⇒ 0；alpha ⇒ 1', () => {
    const p = poseAt([{ atMs: 0, x: 7, y: 8 }, { atMs: 100, x: 7, y: 8 }], 50);
    expect(p).toEqual({ x: 7, y: 8, rotationDeg: 0, scaleX: 1, scaleY: 1, alpha: 1, sortY: 8 });
  });

  it('非有限值被消毒成缺省（NaN 不许进插值）', () => {
    const kf = [
      { atMs: 0, x: 0, y: 0, scale: Number.NaN, alpha: Number.POSITIVE_INFINITY },
      { atMs: 100, x: 100, y: 100 },
    ] as unknown as TrajectoryKeyframe[];
    const p = poseAt(kf, 0);
    expect(p).toEqual({ x: 0, y: 0, rotationDeg: 0, scaleX: 1, scaleY: 1, alpha: 1, sortY: 0 });
  });
});

// ═══════════════════════════════════ 锚点 ═══════════════════════════════════

describe('TrajectorySystem · 锚点（帧是相对偏移）', () => {
  const KF: TrajectoryKeyframe[] = [
    { atMs: 0, x: 10, y: 20 },
    { atMs: 100, x: 110, y: 120, sortY: 0 },
  ];

  it('缺省锚点 = 目标此刻位置：x / y / sortY 三处都加上它', () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    t.anchor = { x: 500, y: 300 };
    void sys.play(def(KF), t);
    expect(t.calls).toContain('anchor');
    expect(t.poses[0]).toMatchObject({ x: 510, y: 320, sortY: 320 });
    sys.update(0.1);
    expect(t.lastPose).toMatchObject({ x: 610, y: 420, sortY: 300 });
  });

  it('显式锚点顶掉目标位置，且不读目标位置', () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    t.anchor = { x: 500, y: 300 };
    void sys.play(def(KF), t, { anchor: { x: 1000, y: 2000 } });
    expect(t.calls).not.toContain('anchor');
    expect(t.poses[0]).toMatchObject({ x: 1010, y: 2020, sortY: 2020 });
    sys.update(0.1);
    expect(t.lastPose).toMatchObject({ x: 1110, y: 2120, sortY: 2000 });
  });

  it('锚点在同键旧轨迹被收掉**之后**读：接着上一条的终姿播', () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    t.anchor = { x: 0, y: 0 };
    void sys.play(def([{ atMs: 0, x: 0, y: 0 }, { atMs: 100, x: 50, y: 60 }]), t);
    sys.update(0.1);
    // 模拟实体位置已经是上一条的终姿（真实体的 applyTrajectoryPose 会写 x/y）
    t.anchor = { x: 50, y: 60 };
    void sys.play(def(KF), t);
    expect(t.lastPose).toMatchObject({ x: 60, y: 80, sortY: 80 });
  });

  it('锚点非有限数一律按 0（不让 NaN 渗进插值）', () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    t.anchor = { x: Number.NaN, y: Number.POSITIVE_INFINITY };
    void sys.play(def(KF), t);
    expect(t.poses[0]).toMatchObject({ x: 10, y: 20, sortY: 20 });
  });
});

// ══════════════════════════════ 封口矩阵（律 3）══════════════════════════════

describe('TrajectorySystem · 封口矩阵（每条路 resolve 恰一次）', () => {
  const D = def([{ atMs: 0, x: 0, y: 0 }, { atMs: 100, x: 100, y: 100 }]);

  it('正常播完 ⇒ completed，且终姿留在实体上（endTrajectory(false)）', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    sys.update(0.05);
    expect(await outcome(p)).toBe(PENDING);
    sys.update(0.05);
    expect(await outcome(p)).toBe('completed');
    expect(t.lastPose).toMatchObject({ x: 100, y: 100, sortY: 100 });
    expect(t.calls).toContain('end:false');
    expect(sys.isDriving('player')).toBe(false);
  });

  it('同键第二条 play ⇒ 第一条 preempted，且旧的不再收到 pose', async () => {
    const { sys } = makeSystem();
    const a = new FakeTarget('player');
    const b = new FakeTarget('player'); // 同键、不同实例（换了个适配也算同一个目标）
    const p = sys.play(D, a);
    sys.update(0.02);
    const before = a.poses.length;
    void sys.play(D, b);
    expect(await outcome(p)).toBe('preempted');
    sys.update(0.05);
    expect(a.poses.length).toBe(before);
    expect(b.poses.length).toBeGreaterThan(0);
  });

  it('目标被抢走（moveTo/jumpTo/destroy 的抢占钩子）⇒ preempted，并解掉排序锁', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    const before = t.poses.length;
    t.firePreempt();
    expect(await outcome(p)).toBe('preempted');
    expect(t.calls).toContain('end:false');   // 必须解锁，否则新所有者的排序锚永远派生不出来
    sys.update(0.05);
    expect(t.poses.length).toBe(before);      // 抢占之后一帧都不许再写
  });

  it('stopFor ⇒ stopped；重复停返回 false 且不再产生第二次 resolve', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    let settles = 0;
    const p = sys.play(D, t);
    void p.then(() => { settles += 1; });
    expect(sys.stopFor('player')).toBe(true);
    expect(await outcome(p)).toBe('stopped');
    expect(sys.stopFor('player')).toBe(false);
    sys.cancelAll();
    sys.destroy();
    await Promise.resolve();
    expect(settles).toBe(1);
  });

  it('cancelAll ⇒ cancelled，且**不落姿**、还原叠加量', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    const before = t.poses.length;
    sys.cancelAll();
    expect(await outcome(p)).toBe('cancelled');
    expect(t.poses.length).toBe(before);      // 不落终姿
    expect(t.calls).toContain('end:true');    // 还原（玩家跨场景长活，不还原就一直顶着叠加量）
    expect(sys.isDriving('player')).toBe(false);
  });

  it('destroy ⇒ 在途全部 cancelled，无悬挂', async () => {
    const { sys } = makeSystem();
    const a = new FakeTarget('player');
    const b = new FakeTarget('npc:甲');
    const pa = sys.play(D, a);
    const pb = sys.play(D, b);
    sys.destroy();
    expect(await outcome(pa)).toBe('cancelled');
    expect(await outcome(pb)).toBe('cancelled');
  });

  it('deserialize（读档）⇒ 在途全部 cancelled', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    expect(sys.serialize()).toEqual({});     // 轨迹是表演态，不入档
    sys.deserialize({});
    expect(await outcome(p)).toBe('cancelled');
  });

  it('目标解析失败 / 空关键帧也必须封口（不许静默悬挂）', async () => {
    const { sys } = makeSystem();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await outcome(sys.play(D, null))).toBe('cancelled');
    expect(await outcome(sys.play(def([]), new FakeTarget()))).toBe('finished');
    warn.mockRestore();
  });
});

// ═══════════════════════════════ finish / 快进 ═══════════════════════════════

describe('TrajectorySystem · finishAll / 快进', () => {
  const D = def([
    { atMs: 0, x: 0, y: 0 },
    { atMs: 1000, x: 100, y: 200, rotation: 45, scale: 3, alpha: 0.25 },
  ]);

  it('finishAll 落终姿并 resolve finished', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    sys.update(0.1);
    sys.finishAll();
    expect(await outcome(p)).toBe('finished');
    expect(t.lastPose).toEqual({
      x: 100, y: 200, rotationDeg: 45, scaleX: 3, scaleY: 3, alpha: 0.25, sortY: 200,
    });
    expect(sys.activeCount).toBe(0);
  });

  it('setFastForward(true) 后 play 立即落终姿并返回 finished（不进 map）', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    sys.setFastForward(true);
    const p = sys.play(D, t);
    expect(await outcome(p)).toBe('finished');
    expect(t.poses.length).toBe(1);
    expect(t.lastPose).toMatchObject({ x: 100, y: 200, sortY: 200 });
    expect(sys.isDriving('player')).toBe(false);
    expect(t.hasHook).toBe(false);            // 生命周期对称：登记过就必须注销
  });

  it('setFastForward(true) 把在途的也一步落到终态', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    sys.update(0.1);
    sys.setFastForward(true);
    expect(await outcome(p)).toBe('finished');
    expect(t.lastPose).toMatchObject({ x: 100, y: 200 });
    expect(sys.isFastForward()).toBe(true);
    sys.setFastForward(false);
    expect(sys.isFastForward()).toBe(false);
  });

  it('immediate 与零时长轨迹同样一步到终态', async () => {
    const { sys } = makeSystem();
    const a = new FakeTarget('player');
    expect(await outcome(sys.play(D, a, { immediate: true }))).toBe('finished');
    expect(a.lastPose).toMatchObject({ x: 100, y: 200 });

    const b = new FakeTarget('npc:甲');
    const zero = def([{ atMs: 0, x: 5, y: 6 }]);
    expect(await outcome(sys.play(zero, b))).toBe('finished');
    expect(b.lastPose).toMatchObject({ x: 5, y: 6, sortY: 6 });
  });

  it('stopFor(toEnd) 落终姿；stopFor(reset) 把还原意图透传给目标', async () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    const p = sys.play(D, t);
    sys.update(0.1);
    sys.stopFor('player', 'stopped', { toEnd: true, reset: true });
    expect(await outcome(p)).toBe('stopped');
    expect(t.lastPose).toMatchObject({ x: 100, y: 200 });
    expect(t.calls).toContain('end:true');
  });
});

// ═══════════════════════════════ 巡逻抑制 ═══════════════════════════════

describe('TrajectorySystem · suspendPatrol', () => {
  const D = def([{ atMs: 0, x: 0, y: 0 }, { atMs: 100, x: 1, y: 1 }]);

  it('NPC 目标开播调 suspendPatrol 恰一次，参数是 npc id', () => {
    const { sys, suspendPatrol } = makeSystem();
    void sys.play(D, new FakeTarget('npc:门卫'));
    expect(suspendPatrol).toHaveBeenCalledTimes(1);
    expect(suspendPatrol).toHaveBeenCalledWith('门卫');
  });

  it('player / 其它非 npc: 前缀的目标不调 suspendPatrol', () => {
    const { sys, suspendPatrol } = makeSystem();
    void sys.play(D, new FakeTarget('player'));
    void sys.play(D, new FakeTarget('other:甲'));
    expect(suspendPatrol).not.toHaveBeenCalled();
  });

  it('每次 play 各调一次（第二条同键轨迹也要重新停巡逻）', () => {
    const { sys, suspendPatrol } = makeSystem();
    void sys.play(D, new FakeTarget('npc:门卫'));
    void sys.play(D, new FakeTarget('npc:门卫'));
    expect(suspendPatrol).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════ 真实体抢占矩阵 ═══════════════════════════════

describe('TrajectorySystem · 真实体抢占', () => {
  const D = def([{ atMs: 0, x: 0, y: 0 }, { atMs: 1000, x: 500, y: 500 }]);

  it('Npc.moveTo 抢走实体 ⇒ 轨迹 preempted 并停手', async () => {
    const { sys } = makeSystem();
    const npc = makeNpc();
    const p = sys.play(D, npc);
    expect(sys.isDriving('npc:门卫')).toBe(true);
    void npc.moveTo(999, 999, 100);
    expect(await outcome(p)).toBe('preempted');
    expect(sys.isDriving('npc:门卫')).toBe(false);
    npc.cancelActiveMove();                 // 收掉 moveTo 的 Promise，不留悬挂
    const at = { x: npc.x, y: npc.y };
    sys.update(0.5);
    expect({ x: npc.x, y: npc.y }).toEqual(at);
  });

  it('Npc.destroy 抢走实体 ⇒ 轨迹 preempted', async () => {
    const { sys } = makeSystem();
    const npc = makeNpc('乙');
    const p = sys.play(D, npc);
    npc.destroy();
    expect(await outcome(p)).toBe('preempted');
    expect(sys.activeCount).toBe(0);
    sys.update(0.5);                        // 已销毁实体上一帧都不许再写（不抛即通过）
  });

  it('Player.moveTo 抢走玩家 ⇒ 轨迹 preempted', async () => {
    const { sys } = makeSystem();
    const player = makePlayer();
    const p = sys.play(D, player);
    expect(player.trajectoryKey).toBe('player');
    void player.moveTo(999, 999, 100);
    expect(await outcome(p)).toBe('preempted');
    player.cancelMotion();
  });

});

// ═══════════════════════════════ 生命周期对称 ═══════════════════════════════

describe('TrajectorySystem · 生命周期对称（律 5）', () => {
  const D = def([{ atMs: 0, x: 0, y: 0 }, { atMs: 100, x: 100, y: 100 }]);

  it('destroy 后 play 不启动、立即 cancelled；再 init 行为与首次一致', async () => {
    const { sys, suspendPatrol } = makeSystem();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const t1 = new FakeTarget('npc:门卫');
    const p1 = sys.play(D, t1);
    sys.update(0.05);
    const firstRunPoses = [...t1.poses];

    sys.destroy();
    expect(await outcome(p1)).toBe('cancelled');

    const dead = new FakeTarget('npc:门卫');
    expect(await outcome(sys.play(D, dead))).toBe('cancelled');
    expect(dead.calls).toEqual([]);           // 一根手指都没碰目标
    expect(sys.activeCount).toBe(0);
    warn.mockRestore();

    // 重新 init：与首次启动逐位一致
    suspendPatrol.mockClear();
    sys.init({} as unknown as GameContext);
    const t2 = new FakeTarget('npc:门卫');
    const p2 = sys.play(D, t2);
    sys.update(0.05);
    expect(t2.poses).toEqual(firstRunPoses);
    expect(suspendPatrol).toHaveBeenCalledTimes(1);
    sys.finishAll();
    expect(await outcome(p2)).toBe('finished');
  });

  it('destroy 后 update 不再写任何目标（旧时间线不写新状态，律 4）', () => {
    const { sys } = makeSystem();
    const t = new FakeTarget();
    void sys.play(D, t);
    const before = t.poses.length;
    sys.destroy();
    sys.update(0.05);
    sys.update(0.05);
    expect(t.poses.length).toBe(before);
  });

  it('endTrajectory 抛错不连坐整批作废', async () => {
    const { sys } = makeSystem();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = new FakeTarget('npc:炸');
    bad.endTrajectory = () => { throw new Error('半死的实体'); };
    const good = new FakeTarget('player');
    const pb = sys.play(D, bad);
    const pg = sys.play(D, good);
    sys.cancelAll();
    expect(await outcome(pb)).toBe('cancelled');
    expect(await outcome(pg)).toBe('cancelled');
    expect(good.calls).toContain('end:true');
    warn.mockRestore();
  });

  it('多目标并行互不干扰，且各自独立封口', async () => {
    const { sys } = makeSystem();
    const a = new FakeTarget('player');
    const b = new FakeTarget('npc:甲');
    const c = new FakeTarget('npc:乙');
    const pa = sys.play(D, a);
    const pb = sys.play(D, b);
    const pc = sys.play(D, c);
    expect(sys.activeCount).toBe(3);
    sys.stopFor('npc:甲');
    expect(await outcome(pb)).toBe('stopped');
    expect(await outcome(pa)).toBe(PENDING);
    sys.update(0.1);
    expect(await outcome(pa)).toBe('completed');
    expect(await outcome(pc)).toBe('completed');
  });
});
