export type EditorFontFamilyId = 'system' | 'yahei' | 'inter' | 'mono';

export type EditorPreferences = {
  /** 侧栏、工具栏等 UI 基础字号 (px) */
  uiFontSize: number;
  fontFamily: EditorFontFamilyId;
  /** 画布节点标题/副标题缩放 (%) */
  canvasLabelScale: number;
  /** 迁移/投影边标签缩放 (%) */
  edgeLabelScale: number;
  /** 检查器 JSON 区域字号 (px) */
  inspectorJsonFontSize: number;
  canvasShowGrid: boolean;
  reduceMotion: boolean;
  /** 进入接线/调试模式时默认勾选小地图 */
  defaultShowMiniMap: boolean;
  /** 画布信号显示模式：'label'=显示注册表中文名（默认），'id'=显示原始信号 id */
  canvasSignalDisplay: 'label' | 'id';
};

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  uiFontSize: 13,
  fontFamily: 'system',
  canvasLabelScale: 100,
  edgeLabelScale: 100,
  inspectorJsonFontSize: 12,
  canvasShowGrid: true,
  reduceMotion: false,
  defaultShowMiniMap: false,
  canvasSignalDisplay: 'label',
};

const STORAGE_KEY = 'narrative-editor-preferences-v1';

export const EDITOR_FONT_FAMILY_OPTIONS: {
  id: EditorFontFamilyId;
  label: string;
  stack: string;
}[] = [
  {
    id: 'system',
    label: '系统默认',
    stack: 'Inter, "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
  },
  {
    id: 'yahei',
    label: '微软雅黑',
    stack: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: 'Inter, "Segoe UI", system-ui, sans-serif',
  },
  {
    id: 'mono',
    label: '等宽',
    stack: '"Cascadia Code", "Consolas", "Microsoft YaHei", monospace',
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function fontFamilyStack(id: EditorFontFamilyId): string {
  return EDITOR_FONT_FAMILY_OPTIONS.find((item) => item.id === id)?.stack
    ?? EDITOR_FONT_FAMILY_OPTIONS[0].stack;
}

export function normalizeEditorPreferences(raw: Partial<EditorPreferences> | null | undefined): EditorPreferences {
  const base = DEFAULT_EDITOR_PREFERENCES;
  if (!raw || typeof raw !== 'object') return { ...base };
  const fontFamily = EDITOR_FONT_FAMILY_OPTIONS.some((item) => item.id === raw.fontFamily)
    ? raw.fontFamily!
    : base.fontFamily;
  return {
    uiFontSize: clamp(Math.round(Number(raw.uiFontSize) || base.uiFontSize), 11, 18),
    fontFamily,
    canvasLabelScale: clamp(Math.round(Number(raw.canvasLabelScale) || base.canvasLabelScale), 80, 140),
    edgeLabelScale: clamp(Math.round(Number(raw.edgeLabelScale) || base.edgeLabelScale), 80, 140),
    inspectorJsonFontSize: clamp(Math.round(Number(raw.inspectorJsonFontSize) || base.inspectorJsonFontSize), 10, 18),
    canvasShowGrid: raw.canvasShowGrid !== false,
    reduceMotion: raw.reduceMotion === true,
    defaultShowMiniMap: raw.defaultShowMiniMap === true,
    canvasSignalDisplay: raw.canvasSignalDisplay === 'id' ? 'id' : 'label',
  };
}

/**
 * localStorage 读写只作**纯 Web 开发态兜底**——主路径是 Qt 宿主经 bridge 落工程文件
 * （见 bridge.ts loadEditorPreferencesRemote / saveEditorPreferencesRemote）。
 * WebEngine 内嵌时 localStorage 可能不落盘，故绝不作为唯一持久化（debug-ui-persistence 范式）。
 */
export function loadEditorPreferencesLocal(): EditorPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EDITOR_PREFERENCES };
    return normalizeEditorPreferences(JSON.parse(raw) as Partial<EditorPreferences>);
  } catch {
    return { ...DEFAULT_EDITOR_PREFERENCES };
  }
}

export function saveEditorPreferencesLocal(preferences: EditorPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeEditorPreferences(preferences)));
  } catch {
    /* WebEngine 可能禁 localStorage 写入——静默降级，主路径已落工程文件 */
  }
}

export function applyEditorPreferences(preferences: EditorPreferences): void {
  const prefs = normalizeEditorPreferences(preferences);
  const root = document.documentElement;
  const canvasScale = prefs.canvasLabelScale / 100;
  const edgeScale = prefs.edgeLabelScale / 100;

  root.style.setProperty('--editor-font-family', fontFamilyStack(prefs.fontFamily));
  root.style.setProperty('--editor-ui-font-size', `${prefs.uiFontSize}px`);
  root.style.setProperty('--editor-canvas-label-scale', String(canvasScale));
  root.style.setProperty('--editor-edge-label-scale', String(edgeScale));
  root.style.setProperty('--editor-inspector-json-font-size', `${prefs.inspectorJsonFontSize}px`);
  root.dataset.reduceMotion = prefs.reduceMotion ? '1' : '0';
  root.dataset.canvasGrid = prefs.canvasShowGrid ? '1' : '0';
}
