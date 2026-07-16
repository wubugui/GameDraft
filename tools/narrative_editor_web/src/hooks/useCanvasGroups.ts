import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCanvasGroupsRemote, saveCanvasGroupsRemote } from '../bridge';
import {
  normalizeCanvasGroupsFile,
  type CanvasGroupsFileDef,
} from '../canvas/editorGroups';

/**
 * 画布分组框注册表：Qt 宿主经 bridge 落工程文件 editor_data/narrative_canvas_groups.json，
 * 改动即（debounce）落盘、重启不丢；纯 Web 开发态兜底 localStorage。
 * 与 useEditorPreferences 同一套 settled 闸门防竞态。
 */
export function useCanvasGroups() {
  const [file, setFile] = useState<Required<CanvasGroupsFileDef>>(() => normalizeCanvasGroupsFile(null));
  // settled = 首次 bridge 加载已落定 **或** 用户已改动：
  // ① settled 前不回写盘（别用空表覆盖磁盘已存分组）；
  // ② 加载返回前用户已建组时，异步加载不得反过来覆盖用户改动。
  const settledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadCanvasGroupsRemote().then((raw) => {
      if (cancelled) return;
      if (raw && !settledRef.current) setFile(normalizeCanvasGroupsFile(raw));
      settledRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settledRef.current) return;
    const id = setTimeout(() => {
      void saveCanvasGroupsRemote(file);
    }, 400);
    return () => clearTimeout(id);
  }, [file]);

  const updateFile = useCallback((updater: (current: Required<CanvasGroupsFileDef>) => CanvasGroupsFileDef) => {
    settledRef.current = true;
    setFile((current) => normalizeCanvasGroupsFile(updater(current)));
  }, []);

  return { file, updateFile };
}
