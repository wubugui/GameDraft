/** 撤销栈合并窗口语义回归（2026-07-17 审查 W-E3）。 */
import { describe, expect, it } from 'vitest';
import { pushSnapshotWithMergeWindow } from './useEditorHistory';

describe('pushSnapshotWithMergeWindow', () => {
  it('合并窗口内保留栈顶（连发起点前的快照），不被后续击键覆盖', () => {
    const stack: string[] = [];
    pushSnapshotWithMergeWindow(stack, 'S0', false); // 连发第一击：入栈"编辑前"
    pushSnapshotWithMergeWindow(stack, 'S1', true);  // 300ms 内第二击：不动栈顶
    pushSnapshotWithMergeWindow(stack, 'S2', true);  // 第三击：仍不动
    expect(stack).toEqual(['S0']); // 撤销一次应回到连发起点前，而不是只回退最后一击
  });

  it('窗口外正常入栈为独立撤销步', () => {
    const stack: string[] = [];
    pushSnapshotWithMergeWindow(stack, 'S0', false);
    pushSnapshotWithMergeWindow(stack, 'S1', false);
    expect(stack).toEqual(['S0', 'S1']);
  });

  it('空栈时即便处于合并窗口也入栈（首个编辑不可丢）', () => {
    const stack: string[] = [];
    pushSnapshotWithMergeWindow(stack, 'S0', true);
    expect(stack).toEqual(['S0']);
  });

  it('超出容量裁剪最旧快照', () => {
    const stack: string[] = [];
    for (let i = 0; i < 5; i += 1) pushSnapshotWithMergeWindow(stack, `S${i}`, false, 3);
    expect(stack).toEqual(['S2', 'S3', 'S4']);
  });
});
