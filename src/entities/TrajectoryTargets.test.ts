/**
 * `Npc` / `Player` 的轨迹驱动适配（`ITrajectoryTarget`）。
 *
 * 这一层的贵处不在数学，在**所有权**：
 * - `entitySortFootY` 轨迹期间必须由轨迹独占（`_syncSortFootY` 在"未旋转"时会把它 delete 掉，
 *   而位置 setter / 透视刷新 / applyInstanceTransform 三条路都会走到那里）——**不靠调用顺序**；
 * - 一实体一驱动：`moveTo`/`jumpTo`/`destroy` 抢走实体时抢占回调必须触发**恰一次**；
 * - `beginTrajectory` 掐断在途位移时不许留悬挂的 Promise（norms 不变量 3）；
 * - 玩家的位置写入平时晚一帧（`Player.x` 只是 `sprite.x` 字段），轨迹必须当帧落位。
 */
import { describe, expect, it, vi } from 'vitest';
import { Container, Texture, TextureSource } from 'pixi.js';

import { Npc } from './Npc';
import { Player } from './Player';
import type { InputManager } from '../core/InputManager';
import type { AnimationSetDef, NpcDef, TrajectoryPose } from '../data/types';

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

function makeNpc(over: Partial<NpcDef> = {}): Npc {
  const def: NpcDef = {
    id: 'n1', name: '甲', x: 10, y: 20, interactionRange: 40, ...over,
  } as NpcDef;
  const npc = new Npc(def);
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

const pose = (over: Partial<TrajectoryPose> = {}): TrajectoryPose => ({
  x: 300, y: 400, rotationDeg: 30, scaleX: 1.5, scaleY: 0.8, alpha: 0.6, sortY: 555, ...over,
});

/** 容器上的排序接地锚（Renderer.sortEntityLayer 读的就是它） */
const footY = (c: Container): number | undefined =>
  (c as Container & { entitySortFootY?: number }).entitySortFootY;

// ═════════════════════════════════════ Npc ═════════════════════════════════════

describe('Npc · ITrajectoryTarget', () => {
  it('trajectoryKey 是 npc:<id>；锚点读当前 x/y', () => {
    const npc = makeNpc({ id: '门卫', x: 12, y: 34 });
    expect(npc.trajectoryKey).toBe('npc:门卫');
    expect(npc.readTrajectoryAnchor()).toEqual({ x: 12, y: 34 });
  });

  it('applyTrajectoryPose：位置 / 排序锚 / 叠加量一次到位', () => {
    const npc = makeNpc();
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose());
    expect(npc.x).toBe(300);
    expect(npc.y).toBe(400);
    expect(npc.container.x).toBe(300);
    expect(npc.container.y).toBe(400);
    expect(footY(npc.container)).toBe(555);
    const ov = npc.spriteEntity!.getTrajectoryOverlay();
    expect(ov.active).toBe(true);
    expect(ov.rotRad).toBeCloseTo((30 * Math.PI) / 180, 8);
    expect(ov.scaleX).toBe(1.5);
    expect(ov.scaleY).toBe(0.8);
    expect(ov.alpha).toBeCloseTo(0.6, 8);
  });

  it('朝左时叠加旋转取反（镜像在外层容器，也就是在 sprite 旋转的外面）', () => {
    const npc = makeNpc({ initialFacing: 'left' });
    expect(npc.getFacing()).toBe(-1);
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose({ rotationDeg: 30 }));
    expect(npc.spriteEntity!.getTrajectoryOverlay().rotRad).toBeCloseTo(-(30 * Math.PI) / 180, 8);
  });

  it('排序锁：轨迹期间位置变化 / 实例 transform 重派生都不许清掉 sortY', () => {
    const npc = makeNpc();
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose({ sortY: 777 }));
    // 这三条路平时都会走到 _syncSortFootY（未旋转时它会 delete 掉这个键）
    npc.x = 999;
    npc.y = 111;
    npc.applyInstanceTransform();
    npc.setFacing(-1, 0);
    expect(footY(npc.container)).toBe(777);
  });

  it('beginTrajectory 掐断在途 moveTo 并 resolve 它的 Promise（不留悬挂）', async () => {
    const npc = makeNpc();
    let settled = false;
    const p = npc.moveTo(500, 500, 100).then(() => { settled = true; });
    npc.beginTrajectory(() => {});
    await p;
    expect(settled).toBe(true);
    // 掐断之后 cutsceneUpdate 不再推进旧目标
    npc.applyTrajectoryPose(pose({ x: 1, y: 2 }));
    npc.cutsceneUpdate(1);
    expect(npc.x).toBe(1);
    expect(npc.y).toBe(2);
  });

  it('beginTrajectory 掐断在途 jumpTo 并复位视觉抬升', async () => {
    const npc = makeNpc();
    const p = npc.jumpTo(500, 500, 600, 80, undefined, null);
    npc.cutsceneUpdate(0.3);
    expect(npc.spriteEntity!.getDebugVisualState().visualLiftY).not.toBe(0);
    npc.beginTrajectory(() => {});
    await p;
    expect(npc.spriteEntity!.getDebugVisualState().visualLiftY).toBe(0);
  });

  it('moveTo 触发抢占回调**恰一次**（第二次 moveTo 不再触发）', () => {
    const npc = makeNpc();
    const onPreempt = vi.fn();
    npc.beginTrajectory(onPreempt);
    npc.moveTo(200, 200, 100);
    npc.moveTo(300, 300, 100);
    expect(onPreempt).toHaveBeenCalledTimes(1);
  });

  it('jumpTo 同样触发抢占', () => {
    const npc = makeNpc();
    const onPreempt = vi.fn();
    npc.beginTrajectory(onPreempt);
    npc.jumpTo(200, 200, 300, 40);
    expect(onPreempt).toHaveBeenCalledTimes(1);
  });

  it('destroy 触发抢占（不让驱动方抱着一个已销毁的实体继续写姿态）', () => {
    const npc = makeNpc();
    const onPreempt = vi.fn();
    npc.beginTrajectory(onPreempt);
    npc.destroy();
    expect(onPreempt).toHaveBeenCalledTimes(1);
  });

  it('抢占回调里回调 endTrajectory 不会重入自触发', () => {
    const npc = makeNpc();
    let calls = 0;
    npc.beginTrajectory(() => { calls++; npc.endTrajectory(true); });
    npc.moveTo(200, 200, 100);
    npc.moveTo(210, 210, 100);
    expect(calls).toBe(1);
    expect(npc.spriteEntity!.getTrajectoryOverlay().active).toBe(false);
  });

  it('endTrajectory(false)：保留终姿（叠加量与排序锚都还在）', () => {
    const npc = makeNpc();
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose());
    npc.endTrajectory(false);
    expect(npc.spriteEntity!.getTrajectoryOverlay().active).toBe(true);
    expect(footY(npc.container)).toBe(555);
  });

  it('endTrajectory(true)：清干净并把排序接地线交还给实例 transform', () => {
    const npc = makeNpc();
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose());
    npc.endTrajectory(true);
    const ov = npc.spriteEntity!.getTrajectoryOverlay();
    expect(ov).toEqual({ active: false, rotRad: 0, scaleX: 1, scaleY: 1, alpha: 1 });
    expect(npc.container.alpha).toBe(1);
    // 未旋转的实体不写这个键 → 回落容器锚点 y
    expect(footY(npc.container)).toBeUndefined();
  });

  it('endTrajectory(true) 后带实例旋转的实体重新算出自己的接地线', () => {
    const npc = makeNpc({ rotation: 40, scale: 1 } as Partial<NpcDef>);
    const own = footY(npc.container);
    expect(typeof own).toBe('number');
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose({ x: npc.x, y: npc.y, sortY: 12345 }));
    expect(footY(npc.container)).toBe(12345);
    npc.endTrajectory(true);
    expect(footY(npc.container)).toBeCloseTo(own!, 8);
  });

  it('endTrajectory 之后 moveTo 不再触发已注销的回调', () => {
    const npc = makeNpc();
    const onPreempt = vi.fn();
    npc.beginTrajectory(onPreempt);
    npc.endTrajectory(true);
    npc.moveTo(200, 200, 100);
    expect(onPreempt).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════ Player ═══════════════════════════════════

describe('Player · ITrajectoryTarget', () => {
  it("trajectoryKey 恒为 'player'；锚点读 sprite 当前 x/y", () => {
    const p = makePlayer();
    p.x = 7;
    p.y = 8;
    expect(p.trajectoryKey).toBe('player');
    expect(p.readTrajectoryAnchor()).toEqual({ x: 7, y: 8 });
  });

  it('applyTrajectoryPose 当帧就把位置落到容器上（不等 update，否则整条轨迹晚一帧）', () => {
    const p = makePlayer();
    p.beginTrajectory(() => {});
    p.applyTrajectoryPose(pose({ x: 640, y: 360 }));
    expect(p.sprite.container.x).toBe(640);
    expect(p.sprite.container.y).toBe(360);
    expect(footY(p.sprite.container)).toBe(555);
  });

  it('玩家没有实例 transform：叠加量直接就是最终量，朝左也**不**取反', () => {
    const p = makePlayer();
    p.setFacing(-1, 0);
    expect(p.facingDirection).toBe('left');
    p.beginTrajectory(() => {});
    p.applyTrajectoryPose(pose({ rotationDeg: 30 }));
    // 镜像住在 sprite.scale.x 的符号里、在旋转的**内层** → 不需要补偿
    expect(p.sprite.getTrajectoryOverlay().rotRad).toBeCloseTo((30 * Math.PI) / 180, 8);
  });

  it('beginTrajectory 掐断在途 moveTo 并 resolve', async () => {
    const p = makePlayer();
    let settled = false;
    const pr = p.moveTo(500, 500, 100).then(() => { settled = true; });
    p.beginTrajectory(() => {});
    await pr;
    expect(settled).toBe(true);
    expect(p.hasActiveMotion()).toBe(false);
  });

  it('moveTo / jumpTo 触发抢占回调恰一次', () => {
    const a = makePlayer();
    const fa = vi.fn();
    a.beginTrajectory(fa);
    a.moveTo(1, 1, 10);
    a.moveTo(2, 2, 10);
    expect(fa).toHaveBeenCalledTimes(1);

    const b = makePlayer();
    const fb = vi.fn();
    b.beginTrajectory(fb);
    b.jumpTo(1, 1, 300, 20);
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it('endTrajectory(false) 保留终姿；(true) 清干净', () => {
    const p = makePlayer();
    p.beginTrajectory(() => {});
    p.applyTrajectoryPose(pose());
    p.endTrajectory(false);
    expect(p.sprite.getTrajectoryOverlay().active).toBe(true);
    expect(footY(p.sprite.container)).toBe(555);

    p.beginTrajectory(() => {});
    p.applyTrajectoryPose(pose());
    p.endTrajectory(true);
    expect(p.sprite.getTrajectoryOverlay()).toEqual({
      active: false, rotRad: 0, scaleX: 1, scaleY: 1, alpha: 1,
    });
    expect(p.sprite.container.alpha).toBe(1);
    expect(footY(p.sprite.container)).toBeUndefined();
  });

  it('轨迹期间 update() 不会被自由移动分支改写姿态（位置由驱动方独占）', () => {
    const p = makePlayer();
    p.beginTrajectory(() => {});
    p.applyTrajectoryPose(pose({ x: 42, y: 43 }));
    p.update(0.016);
    expect(p.x).toBe(42);
    expect(p.y).toBe(43);
    expect(p.sprite.getTrajectoryOverlay().active).toBe(true);
  });
});

// ═══════════════════════ 接地点跟落点（透视 / 影子按 sortY 算）═══════════════════════

describe('轨迹期间接地 y = pose.sortY（飞在空中的物件按落点算透视 / 影子）', () => {
  it('Npc：applyTrajectoryPose 后 contactY = sortY；endTrajectory 后回到按位置派生', () => {
    const npc = makeNpc({ x: 10, y: 20 });
    expect(npc.contactY).toBe(20);
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose({ x: 300, y: 100, sortY: 555 }));
    expect(npc.y).toBe(100);
    expect(npc.contactY).toBe(555);          // 空中：接地 y 是落点，不是空中位置
    expect(npc.contactX).toBe(300);
    npc.endTrajectory(false);
    expect(npc.contactY).toBe(100);          // 交还后按位置派生（缺省锚点 = y）
  });

  it('Npc：透视系数按落点采样（铜钱抛起来不该越飞越小）', () => {
    const npc = makeNpc({ x: 10, y: 20 });
    const seen: Array<[number, number]> = [];
    npc.setPerspectiveScale({
      scaleAt: (fx: number, fy: number) => { seen.push([fx, fy]); return fy > 500 ? 1 : 0.5; },
      affectsSpeed: false,
    } as any);
    seen.length = 0;
    npc.beginTrajectory(() => {});
    npc.applyTrajectoryPose(pose({ x: 300, y: 100, sortY: 600 }));
    // 位置 setter 触发的透视刷新必须已经看到落点 y，而不是空中的 100
    expect(seen.some(([, fy]) => fy === 600)).toBe(true);
    expect(seen.some(([, fy]) => fy === 100)).toBe(false);
    expect(npc.spriteEntity!.getDepthScaleFactor()).toBe(1);
  });

  it('Player：contactY 同样跟落点，endTrajectory 后复原', () => {
    const p = makePlayer();
    p.x = 7;
    p.y = 8;
    expect(p.contactY).toBe(8);
    p.beginTrajectory(() => {});
    p.applyTrajectoryPose(pose({ x: 640, y: 360, sortY: 555 }));
    expect(p.contactY).toBe(555);
    p.endTrajectory(true);
    expect(p.contactY).toBe(360);
  });
});
