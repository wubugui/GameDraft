import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyEditorPreferences,
  DEFAULT_EDITOR_PREFERENCES,
  loadEditorPreferencesLocal,
  normalizeEditorPreferences,
  type EditorPreferences,
} from '../utils/editorPreferences';
import { loadEditorPreferencesRemote, saveEditorPreferencesRemote } from '../bridge';

export function useEditorPreferences() {
  // 首帧先用 localStorage 兜底值（WebEngine 内多为默认值），随后 bridge 异步加载工程文件覆盖。
  const [preferences, setPreferencesState] = useState<EditorPreferences>(() => loadEditorPreferencesLocal());
  // settled = 首次 bridge 加载已落定 **或** 用户已交互。作两件事的闸门：
  // ① settled 前不回写盘（别用兜底默认覆盖磁盘已存偏好）；
  // ② 用户在加载返回前就改了设置时，异步加载不得反过来覆盖用户的改动。
  const settledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadEditorPreferencesRemote().then((raw) => {
      if (cancelled) return;
      if (raw && !settledRef.current) setPreferencesState(normalizeEditorPreferences(raw));
      settledRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 立即应用到 CSS 变量（每次变更都生效，视觉即时）。
  useEffect(() => {
    applyEditorPreferences(preferences);
  }, [preferences]);

  // 持久化到工程文件（apply 即固化）：debounce 落盘，避免拖动滑块时狂写磁盘。
  useEffect(() => {
    if (!settledRef.current) return;
    const id = setTimeout(() => {
      void saveEditorPreferencesRemote(preferences);
    }, 300);
    return () => clearTimeout(id);
  }, [preferences]);

  const setPreferences = useCallback((patch: Partial<EditorPreferences>) => {
    settledRef.current = true; // 用户已交互：允许落盘，且不再被异步加载覆盖
    setPreferencesState((current) => normalizeEditorPreferences({ ...current, ...patch }));
  }, []);

  const resetPreferences = useCallback(() => {
    settledRef.current = true;
    setPreferencesState({ ...DEFAULT_EDITOR_PREFERENCES });
  }, []);

  return { preferences, setPreferences, resetPreferences };
}
