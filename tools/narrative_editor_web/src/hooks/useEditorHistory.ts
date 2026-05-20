import { useCallback, useRef } from 'react';
import { normalizeFile } from '../editorModel';
import type { NarrativeGraphsFileDef } from '../types';

const MAX_HISTORY = 50;
const MERGE_MS = 300;

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
    if (now - lastPushAt.current < MERGE_MS && undoStack.current.length > 0) {
      undoStack.current[undoStack.current.length - 1] = snapshot;
    } else {
      undoStack.current.push(snapshot);
      if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    }
    redoStack.current = [];
    lastPushAt.current = now;
  }, []);

  const wrapUpdater = useCallback((updater: (next: NarrativeGraphsFileDef) => void) => {
    const before = normalizeFile(data);
    pushSnapshot(before);
    const next = normalizeFile(before);
    updater(next);
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
