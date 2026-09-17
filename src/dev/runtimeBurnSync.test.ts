/**
 * 燃烧联动（工作台 → 游戏）：工作态每个 rev 只套一次、不套自己写的；探针第一次看到槽只记序号（刷新页面不重放上一次的点火）；
 * 换了写者序号清零；太旧的槽不套；站位判定只在对的场景里判、每个序号判一次；拆掉时撤回工作态。
 */
import { describe, expect, it, vi } from 'vitest';

import { burnDocShapeError } from './runtimeBurnApiPlugin';
import { RuntimeBurnSync, isBurnDocStale, shouldApplyBurnDoc, type BurnSyncDoc, type RuntimeBurnSyncDeps } from './runtimeBurnSync';

function make(sceneId = 'sA') {
  const applyPreview = vi.fn<RuntimeBurnSyncDeps['applyPreview']>();
  const probe = vi.fn<RuntimeBurnSyncDeps['probe']>(() => true);
  const walkable = vi.fn((x: number) => x < 100);
  let scene: string | null = sceneId;
  const deps: RuntimeBurnSyncDeps = {
    applyPreview, probe, walkable,
    getSceneId: () => scene,
    getStatus: () => ({ sceneId: scene ?? undefined, hotspots: [], states: {}, stats: { items: 0, burning: 0, lights: 0, particles: 0, simMs: 0, clock: 0 } }) as never,
    log: () => {},
  };
  const s = new RuntimeBurnSync(deps, 'game-1');
  return { s, applyPreview, probe, walkable, setScene: (id: string | null) => { scene = id; } };
}

const doc = (over: Partial<BurnSyncDoc>): BurnSyncDoc => ({ rev: 1, writer: 'wb', ...over });

describe('燃烧联动', () => {
  it('要不要套工作态：有内容、比见过的新、不是自己写的', () => {
    expect(shouldApplyBurnDoc(doc({ rev: 2, burnables: {} }), 'game-1', 1)).toBe(true);
    expect(shouldApplyBurnDoc(doc({ rev: 2, burnables: {} }), 'game-1', 2)).toBe(false);
    expect(shouldApplyBurnDoc(doc({ rev: 3, writer: 'game-1', burnables: {} }), 'game-1', 1)).toBe(false);
    expect(shouldApplyBurnDoc(doc({ rev: 3, probe: { seq: 1, action: 'ignite', target: 'h' } }), 'game-1', 1)).toBe(false);
    expect(isBurnDocStale(5 * 60 * 1000 + 1)).toBe(true);
    expect(isBurnDocStale(null)).toBe(false);
  });

  it('工作态每个 rev 只套一次；拆掉时撤回', () => {
    const h = make();
    const d = doc({ rev: 4, burnables: { a: {} } });
    h.s.handleDoc(d, 10);
    h.s.handleDoc(d, 500);
    expect(h.applyPreview).toHaveBeenCalledTimes(1);
    h.s.stop();
    expect(h.applyPreview).toHaveBeenLastCalledWith(null);
  });

  it('🔴 探针：第一次看到槽只记序号（刷新页面不重放上一次的点火），之后每个新序号做一次', () => {
    const h = make();
    h.s.handleDoc(doc({ rev: 1, probe: { seq: 7, action: 'ignite', target: 'h' } }), 10);
    expect(h.probe).not.toHaveBeenCalled();
    h.s.handleDoc(doc({ rev: 2, probe: { seq: 8, action: 'extinguish', target: 'h' } }), 10);
    h.s.handleDoc(doc({ rev: 2, probe: { seq: 8, action: 'extinguish', target: 'h' } }), 10);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith('extinguish', 'h', undefined, undefined);
    // 手上的挂件：socket 一路带到游戏
    h.s.handleDoc(doc({ rev: 2, probe: { seq: 9, action: 'ignite', target: 'player', socket: 'right_hand', point: 'p1' } }), 10);
    expect(h.probe).toHaveBeenLastCalledWith('ignite', 'player', 'right_hand', 'p1');
    // 换了一个工作台实例（序号从 1 重来）
    h.s.handleDoc(doc({ rev: 3, writer: 'wb2', probe: { seq: 1, action: 'reset', target: 'h' } }), 10);
    expect(h.probe).toHaveBeenCalledTimes(3);
  });

  it('太旧的槽（>5 分钟）不套、不做探针', () => {
    const h = make();
    h.s.handleDoc(doc({ rev: 1, burnables: {}, probe: { seq: 1, action: 'ignite', target: 'h' } }), 6 * 60 * 1000);
    h.s.handleDoc(doc({ rev: 1, burnables: {}, probe: { seq: 1, action: 'ignite', target: 'h' } }), 6 * 60 * 1000);
    expect(h.applyPreview).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('站位判定：场景对得上才判，每个序号判一次，结果按点排成位串', () => {
    const h = make('sA');
    h.s.handleDoc(doc({ rev: 1, walkProbe: { seq: 1, sceneId: 'sB', points: [[1, 1]] } }), 10);
    expect(h.walkable).not.toHaveBeenCalled();
    h.s.handleDoc(doc({ rev: 2, walkProbe: { seq: 2, sceneId: 'sA', points: [[10, 0], [200, 0], [Number.NaN, 0]] } }), 10);
    h.s.handleDoc(doc({ rev: 2, walkProbe: { seq: 2, sceneId: 'sA', points: [[10, 0], [200, 0], [Number.NaN, 0]] } }), 10);
    expect(h.walkable).toHaveBeenCalledTimes(2);
    const st = (h.s as unknown as { walkResult: unknown }).walkResult;
    expect(st).toEqual({ seq: 2, sceneId: 'sA', bits: '100' });
  });

  it('开发服闸门：形状不对的直接拒（不认识的字段不会被悄悄剥掉）', () => {
    expect(burnDocShapeError({ writer: 'wb', burnables: [] })).toMatch(/burnables/);
    expect(burnDocShapeError({ writer: 'wb', library: { scenes: {} } })).toMatch(/library 已废弃/);
    expect(burnDocShapeError({ writer: 'wb', probe: { seq: 1, action: 'ignite', target: 'player', socket: 3 } })).toMatch(/probe/);
    expect(burnDocShapeError({ writer: 'wb', probe: { seq: 1, action: 'boom', target: 'h' } })).toMatch(/probe/);
    expect(burnDocShapeError({ writer: 'wb', walkProbe: { seq: 1, sceneId: 'a', points: new Array(300).fill([0, 0]) } })).toMatch(/walkProbe/);
    expect(burnDocShapeError({ writer: 'wb', walkProbe: { seq: 1, sceneId: 'a', points: [[0, 0]] }, probe: { seq: 2, action: 'reset', target: 'h' } })).toBeNull();
    expect(burnDocShapeError({})).toMatch(/writer/);
  });
});
