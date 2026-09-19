import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCanvasAnnotationsRemote, saveCanvasAnnotationsRemote } from '../bridge';
import {
  normalizeAnnotationsFile,
  type CanvasAnnotationsFile,
  type CanvasAnnotationsFileDef,
} from '../canvas/annotations';

/**
 * 画布注释注册表：Qt 宿主经 bridge 落工程文件 editor_data/narrative_canvas_annotations.json，
 * 改动即（debounce）落盘、重启不丢；纯 Web 开发态兜底 localStorage。
 * 与 useCanvasGroups 同一套 settled 闸门防竞态：
 * ① settled 前不回写盘（别用空表覆盖磁盘已存注释）；
 * ② 加载返回前用户已写注释时，异步加载不得反过来覆盖用户改动。
 */
export function useCanvasAnnotations() {
  const [file, setFile] = useState<CanvasAnnotationsFile>(() => normalizeAnnotationsFile(null));
  const settledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadCanvasAnnotationsRemote().then((raw) => {
      if (cancelled) return;
      if (raw && !settledRef.current) setFile(normalizeAnnotationsFile(raw));
      settledRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settledRef.current) return;
    const id = setTimeout(() => {
      void saveCanvasAnnotationsRemote(file);
    }, 400);
    return () => clearTimeout(id);
  }, [file]);

  const updateFile = useCallback((updater: (current: CanvasAnnotationsFile) => CanvasAnnotationsFileDef) => {
    settledRef.current = true;
    setFile((current) => normalizeAnnotationsFile(updater(current)));
  }, []);

  return { file, updateFile };
}
