/** 撤销栈合并窗口语义回归（2026-07-17 审查 W-E3）+ 连发更新串行基线（信号丢失根因）。 */
import { describe, expect, it } from 'vitest';
import { EditorHistoryCore, pushSnapshotWithMergeWindow } from './useEditorHistory';

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

type Doc = { signals: string[]; picked: string };

const cloneDoc = (v: Doc): Doc => structuredClone(v);
const emptyDoc = (): Doc => ({ signals: [], picked: '' });

describe('EditorHistoryCore 连发串行', () => {
  it('同一事件里连打两次更新叠加而非互相覆盖（信号「新建并选用」根因回归）', () => {
    const core = new EditorHistoryCore<Doc>(emptyDoc(), cloneDoc);
    // 第一击：注册作者信号；第二击：把迁移的 signal 指向它。旧实现两击都从渲染期
    // 陈旧快照起算，第二击赢 → 注册行被抹掉，只剩监听端引用。
    core.update((d) => { d.signals.push('新信号'); }, 1000);
    core.update((d) => { d.picked = '新信号'; }, 1000);
    expect(core.latest()).toEqual({ signals: ['新信号'], picked: '新信号' });
  });

  it('连发三次仍逐次叠加', () => {
    const core = new EditorHistoryCore<Doc>(emptyDoc(), cloneDoc);
    core.update((d) => { d.signals.push('a'); }, 1000);
    core.update((d) => { d.signals.push('b'); }, 1050);
    core.update((d) => { d.signals.push('c'); }, 1100);
    expect(core.latest().signals).toEqual(['a', 'b', 'c']);
  });

  it('updater 抛错时基线不动、不推撤销步（撞名新建不留空转步）', () => {
    const core = new EditorHistoryCore<Doc>(emptyDoc(), cloneDoc);
    core.update((d) => { d.signals.push('a'); }, 1000);
    const depthBefore = core.undoDepth;
    expect(() => core.update(() => { throw new Error('Signal already exists'); }, 5000)).toThrow();
    expect(core.latest().signals).toEqual(['a']);
    expect(core.undoDepth).toBe(depthBefore);
  });

  it('撤销/重做推进同一基线，撤销后再编辑基于撤销结果', () => {
    const core = new EditorHistoryCore<Doc>(emptyDoc(), cloneDoc);
    core.update((d) => { d.signals.push('a'); }, 1000);
    core.update((d) => { d.signals.push('b'); }, 5000); // 窗口外 → 独立撤销步
    expect(core.undo()).toEqual({ signals: ['a'], picked: '' });
    expect(core.latest().signals).toEqual(['a']);
    core.update((d) => { d.signals.push('c'); }, 9000);
    expect(core.latest().signals).toEqual(['a', 'c']);
    expect(core.redoDepth).toBe(0); // 新编辑清重做栈
  });

  it('栈空时 undo/redo 返回 null（调用方据此不 setData）', () => {
    const core = new EditorHistoryCore<Doc>(emptyDoc(), cloneDoc);
    expect(core.undo()).toBeNull();
    expect(core.redo()).toBeNull();
  });

  it('sync 追平外部整体替换，后续编辑不把它覆盖回去', () => {
    const core = new EditorHistoryCore<Doc>(emptyDoc(), cloneDoc);
    core.update((d) => { d.signals.push('a'); }, 1000);
    core.sync({ signals: ['来自宿主重构'], picked: '' });
    core.update((d) => { d.picked = 'x'; }, 5000);
    expect(core.latest()).toEqual({ signals: ['来自宿主重构'], picked: 'x' });
  });

  it('update 返回值与 latest 是同一份、且与传入的初值隔离', () => {
    const initial = emptyDoc();
    const core = new EditorHistoryCore<Doc>(initial, cloneDoc);
    const next = core.update((d) => { d.signals.push('a'); }, 1000);
    expect(next).toBe(core.latest());
    expect(initial.signals).toEqual([]); // 构造时已克隆，外部对象不被就地改写
  });
});
