import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutsceneManager, type CutsceneTrajectoryController } from './CutsceneManager';
import type { CutsceneStep } from '../data/types';

/**
 * 过场 × 轨迹的两个接缝：
 *
 * 1. **跳过 = 一步落终态**（轨迹是纯烘焙回放，没有"补跑一遍"的成本）；
 * 2. **dev 快进进出透传**——不透传的话建场阶段的轨迹会按真实时长慢慢爬，
 *    "从第 N 步开播"的瞬时到位前提整条打掉。
 *
 * 轨迹只驱动实体（NPC / 玩家），不驱动相机，所以跳过终姿的相机竞争里没有它——
 * 本文件顺带钉住"playTrajectory 步不碰镜头"。
 */

/** node 环境没有 rAF：用宏任务替身，awaitPresentedFrame 的双 rAF 才收得了口。 */
function installRafStub(): void {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

function makeManager() {
  const executeAwait = vi.fn(async () => { /* 白名单动作执行入口 */ });
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const actionExecutor = { executeAwait } as any;
  const abortCutsceneOps = vi.fn();
  const cutsceneRenderer = { abortCutsceneOps } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, actionExecutor, cutsceneRenderer);

  const finishAll = vi.fn();
  const setFastForward = vi.fn();
  const controller: CutsceneTrajectoryController = { finishAll, setFastForward };
  mgr.setTrajectoryController(controller);

  const setZoom = vi.fn();
  const snapTo = vi.fn();
  (mgr as any).cameraAccessor = { setZoom, snapTo, getSceneBaseZoom: () => 1.2 };
  return { mgr, finishAll, setFastForward, abortCutsceneOps, setZoom, snapTo, executeAwait };
}

const PLAY = (params: Record<string, unknown>): CutsceneStep =>
  ({ kind: 'action', type: 'playTrajectory', params });

describe('过场跳过：轨迹一步落终态', () => {
  beforeEach(installRafStub);
  afterEach(() => { vi.restoreAllMocks(); });

  it('skip() 调 finishAll，且排在 abortCutsceneOps 之后', () => {
    const { mgr, finishAll, abortCutsceneOps } = makeManager();
    (mgr as any).playing = true;
    mgr.skip();
    expect(finishAll).toHaveBeenCalledTimes(1);
    // 先掐渲染侧在途补间，再把轨迹落到终姿——顺序反了会被在途 tween 的最后一帧盖回去
    expect(abortCutsceneOps.mock.invocationCallOrder[0]!)
      .toBeLessThan(finishAll.mock.invocationCallOrder[0]!);
  });

  it('没在播时 skip() 是 no-op（不误落别处的轨迹）', () => {
    const { mgr, finishAll } = makeManager();
    mgr.skip();
    expect(finishAll).not.toHaveBeenCalled();
  });

  it('没注入控制器时 skip() 照常工作（组装可裁剪）', () => {
    const { mgr } = makeManager();
    mgr.setTrajectoryController(null);
    (mgr as any).playing = true;
    expect(() => mgr.skip()).not.toThrow();
  });
});

describe('dev 快进：进出都透传给轨迹系统', () => {
  beforeEach(installRafStub);
  afterEach(() => { vi.restoreAllMocks(); });

  it('前 N 步快进、到第 N 步复位，各透传一次', async () => {
    const { mgr, setFastForward } = makeManager();
    const steps: CutsceneStep[] = [
      PLAY({ trajectoryId: '轨迹_张三入场', target: 'npc_张三' }),
      PLAY({ trajectoryId: '轨迹_张三入场', target: 'npc_张三' }),
      PLAY({ trajectoryId: '轨迹_张三入场', target: 'npc_张三' }),
    ];
    await (mgr as any).executeSteps(steps, 0, 2);
    expect(setFastForward.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('不快进时一次都不发（免得每步给控制器发同值）', async () => {
    const { mgr, setFastForward } = makeManager();
    await (mgr as any).executeSteps([PLAY({ trajectoryId: '轨迹_张三入场', target: 'npc_张三' })], 0, 0);
    expect(setFastForward).not.toHaveBeenCalled();
  });
});

describe('跳过终姿：playTrajectory 步不碰镜头', () => {
  beforeEach(installRafStub);
  afterEach(() => { vi.restoreAllMocks(); });

  const apply = (mgr: CutsceneManager, steps: CutsceneStep[]) =>
    (mgr as any).applyFinalCameraPoseForSkip({ id: 'c', steps } as any);

  it('轨迹步夹在 cameraMove / cameraZoom 之间：镜头终姿只由 present 步决定', () => {
    const { mgr, setZoom, snapTo } = makeManager();
    apply(mgr, [
      { kind: 'present', type: 'cameraZoom', scale: 1.4, duration: 100 },
      { kind: 'present', type: 'cameraMove', x: 10, y: 20, duration: 100 },
      PLAY({ trajectoryId: '轨迹_张三入场', target: 'npc_张三' }),
      { kind: 'parallel', tracks: [PLAY({ trajectoryId: '轨迹_张三入场', target: 'player' })] },
    ]);
    expect(setZoom).toHaveBeenCalledWith(1.4);
    expect(snapTo).toHaveBeenCalledWith(10, 20);
  });

  it('只有轨迹步时一根手指都不碰镜头', () => {
    const { mgr, snapTo, setZoom } = makeManager();
    apply(mgr, [PLAY({ trajectoryId: '轨迹_张三入场', target: 'npc_张三' })]);
    expect(snapTo).not.toHaveBeenCalled();
    expect(setZoom).not.toHaveBeenCalled();
  });
});
