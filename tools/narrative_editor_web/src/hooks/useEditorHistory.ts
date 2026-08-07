import { useCallback, useEffect, useRef } from 'react';
import { normalizeFile } from '../editorModel';
import type { NarrativeGraphsFileDef } from '../types';

const MAX_HISTORY = 50;
const MERGE_MS = 300;

/**
 * 撤销栈推入（纯函数，供测试锁定语义）：合并窗口内**不动栈顶**——栈顶保留"连发起点前"
 * 的快照；窗口外正常入栈并裁剪容量。旧实现在合并时用本次快照覆盖栈顶（=上次编辑后），
 * 导致连发时 Ctrl+Z 只回退最后一击、连发起点永不可达（2026-07-17 审查 W-E3）。
 */
export function pushSnapshotWithMergeWindow<T>(
  stack: T[],
  snapshot: T,
  mergeWithPrevious: boolean,
  maxHistory = MAX_HISTORY,
): void {
  if (mergeWithPrevious && stack.length > 0) {
    return;
  }
  stack.push(snapshot);
  if (stack.length > maxHistory) stack.shift();
}

/**
 * 撤销栈 + 「当前数据」基线的纯逻辑核（不依赖 React，供测试直接驱动）。
 *
 * **为什么必须有自己的 current 基线**：旧实现的 `wrapUpdater` 直接读渲染期闭包里的
 * `data`，于是同一个事件里连打两次更新（典型：信号弹窗「新建并选用」= 先写
 * `data.signals` 注册行、再写 `transition.signal`）两次都从**同一份陈旧数据**起算，
 * React 批处理后第二次赢——注册行被静默丢弃，只剩监听端引用，表现为"新建的信号没保存、
 * 却又一直在目录里（那是从监听端反推的幽灵条目）"。核持有 current 并在每次 update 后
 * 立刻推进，连发因此串行叠加而不是互相覆盖。
 */
export class EditorHistoryCore<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private lastPushAt = Number.NEGATIVE_INFINITY;
  private current: T;

  constructor(
    initial: T,
    private readonly clone: (value: T) => T,
    private readonly maxHistory: number = MAX_HISTORY,
  ) {
    this.current = clone(initial);
  }

  /** 当前基线（= 最近一次 update/undo/redo/sync 的结果）。 */
  latest(): T {
    return this.current;
  }

  /**
   * 外部整体替换数据后追平基线（初次加载、重构采纳、宿主盖章等不走撤销栈的路径）。
   * 不入撤销栈、不清栈——是否清栈由调用方用 reset() 显式决定。
   */
  sync(next: T): void {
    this.current = next;
  }

  /**
   * 应用一次编辑并返回新数据。updater 抛错（如新建信号撞名）时不推快照、不动基线，
   * 异常原样冒泡给调用方——不留"空转撤销步"。
   */
  update(updater: (draft: T) => void, now: number): T {
    const before = this.clone(this.current);
    const next = this.clone(before);
    updater(next);
    pushSnapshotWithMergeWindow(
      this.undoStack,
      before,
      now - this.lastPushAt < MERGE_MS,
      this.maxHistory,
    );
    this.redoStack = [];
    this.lastPushAt = now;
    this.current = next;
    return next;
  }

  /** 撤销一步；栈空返回 null（调用方据此不 setData）。 */
  undo(): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this.clone(this.current));
    const restored = this.clone(prev);
    this.current = restored;
    return restored;
  }

  /** 重做一步；栈空返回 null。 */
  redo(): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.clone(this.current));
    const restored = this.clone(next);
    this.current = restored;
    return restored;
  }

  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }
}

export function useEditorHistory(
  data: NarrativeGraphsFileDef,
  setData: (next: NarrativeGraphsFileDef) => void,
  onRestore?: (next: NarrativeGraphsFileDef) => void,
) {
  const coreRef = useRef<EditorHistoryCore<NarrativeGraphsFileDef> | null>(null);
  if (coreRef.current === null) {
    coreRef.current = new EditorHistoryCore(data, normalizeFile);
  }
  const core = coreRef.current;

  // 兜底追平：任何绕过 wrapUpdater 直接 setData 的路径（初次加载、adoptRefactoredNarrative）
  // 提交渲染后把基线拉齐。同 tick 内的直改另有 syncExternalData 显式调用，不依赖本 effect 时序。
  useEffect(() => {
    core.sync(data);
  }, [core, data]);

  const wrapUpdater = useCallback((updater: (next: NarrativeGraphsFileDef) => void) => {
    const next = core.update(updater, Date.now());
    setData(next);
    onRestore?.(next);
  }, [core, onRestore, setData]);

  const undo = useCallback(() => {
    const restored = core.undo();
    if (restored === null) return false;
    setData(restored);
    onRestore?.(restored);
    return true;
  }, [core, onRestore, setData]);

  const redo = useCallback(() => {
    const restored = core.redo();
    if (restored === null) return false;
    setData(restored);
    onRestore?.(restored);
    return true;
  }, [core, onRestore, setData]);

  const resetHistory = useCallback(() => {
    core.reset();
  }, [core]);

  /** 直接 setData 的路径必须同步调用它，否则下一次编辑会拿旧基线把外部替换覆盖回去。 */
  const syncExternalData = useCallback((next: NarrativeGraphsFileDef) => {
    core.sync(next);
  }, [core]);

  return { wrapUpdater, undo, redo, resetHistory, syncExternalData };
}
