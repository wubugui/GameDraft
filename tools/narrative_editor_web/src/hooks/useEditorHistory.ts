import { useCallback, useRef } from 'react';
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

export function useEditorHistory(
  data: NarrativeGraphsFileDef,
  setData: (next: NarrativeGraphsFileDef) => void,
  onRestore?: (next: NarrativeGraphsFileDef) => void,
) {
  const undoStack = useRef<NarrativeGraphsFileDef[]>([]);
  const redoStack = useRef<NarrativeGraphsFileDef[]>([]);
  const lastPushAt = useRef(0);

  const pushSnapshot = useCallback((snapshot: NarrativeGraphsFileDef) => {
    const now = Date.now();
    pushSnapshotWithMergeWindow(undoStack.current, snapshot, now - lastPushAt.current < MERGE_MS);
    redoStack.current = [];
    lastPushAt.current = now;
  }, []);

  const wrapUpdater = useCallback((updater: (next: NarrativeGraphsFileDef) => void) => {
    const before = normalizeFile(data);
    const next = normalizeFile(before);
    // updater 先跑：抛错（如新建信号撞名）时不推快照、不 setData——不留"空转撤销步"。
    updater(next);
    pushSnapshot(before);
    setData(next);
    onRestore?.(next);
  }, [data, onRestore, pushSnapshot, setData]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return false;
    redoStack.current.push(normalizeFile(data));
    const restored = normalizeFile(prev);
    setData(restored);
    onRestore?.(restored);
    return true;
  }, [data, onRestore, setData]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return false;
    undoStack.current.push(normalizeFile(data));
    const restored = normalizeFile(next);
    setData(restored);
    onRestore?.(restored);
    return true;
  }, [data, onRestore, setData]);

  const resetHistory = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
  }, []);

  return { wrapUpdater, undo, redo, resetHistory };
}
