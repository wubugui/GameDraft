import { describe, expect, it } from 'vitest';
import { appliedRefCount, usageLinesFor, type AnyUsages } from './SignalRefactorModal';
import type { GraphUsagesDef } from '../bridge';

/**
 * 重构弹窗的两条纯逻辑（2026-08-05 全盘审查 P2-1）：
 * - 使用点清单必须把只读数据面的命中显式列出来（否则用户不知道为什么执行会被拒）；
 * - 成功提示的"N 处已级联"必须由引擎 summary 推导，不能复用执行前的扫描预览数。
 */

const graphScan = (over: Partial<GraphUsagesDef> = {}): AnyUsages => ({
  kind: 'graph',
  u: {
    graphId: 'wrap_1',
    derivedListeners: 0,
    metaReads: 0,
    narrativeConditions: 0,
    external: [],
    totalRefs: 0,
    ...over,
  },
});

describe('usageLinesFor', () => {
  it('把只读数据面的命中列成显式一行（重构会被宿主拒绝，不能只在按钮上体现）', () => {
    const lines = usageLinesFor(graphScan({
      external: [{ bucket: 'dialogue', itemId: '对话甲', count: 2 }],
      readonlyBlockers: [{ bucket: 'object_examine', itemId: 'corpse', count: 1 }],
      totalRefs: 3,
    }));
    expect(lines).toEqual([
      'dialogue · 对话甲：条件/设状态/对话分支引用 2 处',
      '⛔ 只读数据面 object_examine · corpse：1 处（宿主不保存该域，重构会被拒绝）',
    ]);
  });

  it('无只读命中时不多出 ⛔ 行', () => {
    expect(usageLinesFor(graphScan({ runArchetypes: 1, totalRefs: 1 })))
      .toEqual(['repeatable 任务绑定（runArchetype）：1 处']);
  });
});

describe('appliedRefCount', () => {
  it('renameGraph 汇总引擎 summary 的各通道（含对话图 external）', () => {
    expect(appliedRefCount('renameGraph', {
      derivedListeners: 1,
      metaReads: 1,
      narrativeConditions: 2,
      external: [{ bucket: 'scene', itemId: 'sc', count: 1 }, { bucket: 'dialogue', itemId: 'd', count: 2 }],
      metaCommands: 1,
      metaEmits: 0,
      runArchetypes: 1,
    })).toBe(9);
  });

  it('renameState / rename / delete 各按自己的 summary 形状汇总', () => {
    expect(appliedRefCount('renameState', {
      internalEndpoints: 2, derivedListeners: 1, narrativeConditions: 0,
      external: [{ bucket: 'dialogue', itemId: 'd', count: 2 }], metaCommands: 0, metaEmits: 0,
    })).toBe(5);
    expect(appliedRefCount('rename', {
      narrative: { transitions: 2, actionEmits: 1, metaEmits: 1 },
      assets: [{ bucket: 'scene', itemId: 'sc', count: 1 }],
      dialogues: [{ graphId: 'd', count: 2 }],
    })).toBe(7);
    expect(appliedRefCount('delete', { cleaned: 4 })).toBe(4);
  });

  it('拿不到 summary 时返回 null（调用方退回预览数并标注，不谎报精确值）', () => {
    expect(appliedRefCount('renameGraph', undefined)).toBeNull();
    expect(appliedRefCount('未知op', { cleaned: 3 })).toBeNull();
  });
});
