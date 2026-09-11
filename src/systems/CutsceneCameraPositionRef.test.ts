import { describe, expect, it, vi } from 'vitest';
import { CutsceneManager } from './CutsceneManager';
import type { CutsceneStep } from '../data/types';

/**
 * `cameraMove` 的可选 `at`（位置引用：数字 / 实体此刻位置 / 曲线插槽 / 曲线上的点）。
 *
 * 两条路都要按它求值，否则"镜头摆到铜钱落点"只在其中一条成立：
 * 1. **正常播**：`executePresent` 的 cameraMove；
 * 2. **跳过**（`restoreState:false`）：`applyFinalCameraPoseForSkip` 落终姿。
 *
 * 语义边界（写在这里免得下次又被当成跟随）：`at` 是**一次性求值**——镜头摆过去就不动了。
 * 要镜头跟着动的东西走是 `cameraFollowActor`（每帧按 id 重解析实体位置）。
 */

function makeManager() {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const actionExecutor = { executeAwait: vi.fn(async () => {}) } as any;
  const cameraMove = vi.fn(async () => {});
  const cutsceneRenderer = { abortCutsceneOps: vi.fn(), cameraMove } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, actionExecutor, cutsceneRenderer);
  const snapTo = vi.fn();
  const setZoom = vi.fn();
  (mgr as any).cameraAccessor = { snapTo, setZoom, getSceneBaseZoom: () => 1 };
  return { mgr, cameraMove, snapTo, setZoom };
}

const MOVE = (extra: Record<string, unknown>): CutsceneStep =>
  ({ kind: 'present', type: 'cameraMove', duration: 100, ...extra } as unknown as CutsceneStep);

describe('cameraMove · 位置引用 at', () => {
  it('正常播：at 解析出来就覆盖 x/y', async () => {
    const { mgr, cameraMove } = makeManager();
    mgr.setPositionRefResolver(async (raw) => {
      expect(raw).toEqual({ kind: 'curve', trajectoryId: 'coin', point: 'end' });
      return { x: 777, y: 888 };
    });
    await (mgr as any).executePresent(MOVE({ x: 1, y: 2, at: { kind: 'curve', trajectoryId: 'coin', point: 'end' } }));
    expect(cameraMove).toHaveBeenCalledWith(777, 888, 100, undefined);
  });

  it('正常播：没给 at 就用 x/y（老数据一行都不用改）', async () => {
    const { mgr, cameraMove } = makeManager();
    const resolver = vi.fn(async () => ({ x: 0, y: 0 }));
    mgr.setPositionRefResolver(resolver);
    await (mgr as any).executePresent(MOVE({ x: 12, y: 34 }));
    expect(cameraMove).toHaveBeenCalledWith(12, 34, 100, undefined);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('正常播：at 解析不出来 → warn 并退回 x/y 快照（运镜不炸）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mgr, cameraMove } = makeManager();
    mgr.setPositionRefResolver(async () => null);
    await (mgr as any).executePresent(MOVE({ x: 5, y: 6, at: { kind: 'entity', id: '没有这个' } }));
    expect(cameraMove).toHaveBeenCalledWith(5, 6, 100, undefined);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('没注入求值口时也不炸（组装可裁剪）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mgr, cameraMove } = makeManager();
    await (mgr as any).executePresent(MOVE({ x: 9, y: 9, at: { kind: 'point', x: 1, y: 1 } }));
    expect(cameraMove).toHaveBeenCalledWith(9, 9, 100, undefined);
    warn.mockRestore();
  });

  it('跳过落终姿：最后一个 cameraMove 的 at 也要求值（与自然播完同一处）', async () => {
    const { mgr, snapTo } = makeManager();
    mgr.setPositionRefResolver(async (raw: any) => (raw?.id === 'coin_1' ? { x: 300, y: 400 } : null));
    const def = {
      id: 'c', steps: [
        MOVE({ x: 1, y: 1 }),
        MOVE({ x: 2, y: 2, at: { kind: 'entity', id: 'coin_1' } }),
      ],
    } as any;
    await (mgr as any).applyFinalCameraPoseForSkip(def);
    expect(snapTo).toHaveBeenCalledWith(300, 400);
  });

  it('跳过落终姿：禁用的步不贡献终姿（与既有语义一致）', async () => {
    const { mgr, snapTo } = makeManager();
    mgr.setPositionRefResolver(async () => ({ x: 999, y: 999 }));
    const def = {
      id: 'c', steps: [
        MOVE({ x: 1, y: 1 }),
        MOVE({ x: 2, y: 2, at: { kind: 'entity', id: 'coin_1' }, disabled: true }),
      ],
    } as any;
    await (mgr as any).applyFinalCameraPoseForSkip(def);
    expect(snapTo).toHaveBeenCalledWith(1, 1);
  });
});
