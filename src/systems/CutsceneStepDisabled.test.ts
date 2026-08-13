import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutsceneManager } from './CutsceneManager';
import type { CutsceneStep, NewCutsceneDef } from '../data/types';

/**
 * 步骤级 `disabled`：数据留着、播放时整步跳过。
 * 三条播放面必须一致——执行、图片预热、跳过终姿；顶层与 parallel 子轨同一判据。
 */

/** node 环境没有 rAF：用宏任务替身，awaitPresentedFrame 的双 rAF 才收得了口。 */
function installRafStub(): void {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

function makeManager() {
  const executeAwait = vi.fn(async (_a: { type: string; params: Record<string, unknown> }) => {
    /* 白名单动作执行入口 */
  });
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const actionExecutor = { executeAwait } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, actionExecutor, {} as any);
  return { mgr, executeAwait, eventBus };
}

const ACTION = (params: Record<string, unknown> = {}): CutsceneStep =>
  ({ kind: 'action', type: 'faceEntity', params });

describe('cutscene step disabled', () => {
  beforeEach(installRafStub);
  afterEach(() => { vi.restoreAllMocks(); });

  it('禁用的 action 步不执行，启用的照常执行', async () => {
    const { mgr, executeAwait } = makeManager();
    const run = (step: CutsceneStep) => (mgr as any).executeOneStep(step, '0', 0);

    await run(ACTION({ target: 'a' }));
    expect(executeAwait).toHaveBeenCalledTimes(1);

    await run({ ...ACTION({ target: 'b' }), disabled: true } as CutsceneStep);
    expect(executeAwait).toHaveBeenCalledTimes(1);
  });

  it('禁用的 parallel 连子轨一起跳过', async () => {
    const { mgr, executeAwait } = makeManager();
    const group: CutsceneStep = {
      kind: 'parallel',
      disabled: true,
      tracks: [ACTION({ target: 'a' }), ACTION({ target: 'b' })],
    };
    await (mgr as any).executeOneStep(group, '0', 0);
    expect(executeAwait).not.toHaveBeenCalled();
  });

  it('parallel 内单轨可单独禁用，其余轨照常', async () => {
    const { mgr, executeAwait } = makeManager();
    const group: CutsceneStep = {
      kind: 'parallel',
      tracks: [
        { ...ACTION({ target: 'a' }), disabled: true } as CutsceneStep,
        ACTION({ target: 'b' }),
      ],
    };
    await (mgr as any).executeOneStep(group, '0', 0);
    expect(executeAwait).toHaveBeenCalledTimes(1);
    expect(executeAwait.mock.calls[0][0]).toMatchObject({ params: { target: 'b' } });
  });

  it('只认真 true：字符串 "true" 照常播放（与校验器的构建期报错配套）', async () => {
    const { mgr, executeAwait } = makeManager();
    const step = { ...ACTION(), disabled: 'true' } as unknown as CutsceneStep;
    await (mgr as any).executeOneStep(step, '0', 0);
    expect(executeAwait).toHaveBeenCalledTimes(1);
  });

  it('禁用的 showImg 不参与图片预热', () => {
    const { mgr } = makeManager();
    const steps: CutsceneStep[] = [
      { kind: 'present', type: 'showImg', image: '/a.png' },
      { kind: 'present', type: 'showImg', image: '/b.png', disabled: true },
      { kind: 'parallel', tracks: [
        { kind: 'present', type: 'showImg', image: '/c.png', disabled: true },
        { kind: 'present', type: 'showImg', image: '/d.png' },
      ] },
      { kind: 'parallel', disabled: true, tracks: [
        { kind: 'present', type: 'showImg', image: '/e.png' },
      ] },
    ];
    const out = new Set<string>();
    (mgr as any).collectImagePathsFromSteps(steps, out);
    expect([...out].sort()).toEqual(['/a.png', '/d.png']);
  });

  it('跳过终姿不采纳禁用步的镜头目标', () => {
    const { mgr } = makeManager();
    const setZoom = vi.fn();
    const snapTo = vi.fn();
    (mgr as any).cameraAccessor = { setZoom, snapTo, getSceneBaseZoom: () => 1 };
    const def: NewCutsceneDef = {
      id: 'c',
      steps: [
        { kind: 'present', type: 'cameraZoom', scale: 1.4, duration: 100 },
        { kind: 'present', type: 'cameraMove', x: 100, y: 200, duration: 100 },
        // 这两步不播 → 终姿必须停在上面那对值上
        { kind: 'present', type: 'cameraZoom', scale: 2.5, duration: 100, disabled: true },
        { kind: 'present', type: 'cameraMove', x: 999, y: 999, duration: 100, disabled: true },
      ],
    };
    (mgr as any).applyFinalCameraPoseForSkip(def);
    expect(setZoom).toHaveBeenCalledWith(1.4);
    expect(snapTo).toHaveBeenCalledWith(100, 200);
  });
});
