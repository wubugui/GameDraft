import type {
  ActionDef,
  AuthoringCatalogDef,
  ExtractResponseDef,
  NarrativeCategoriesFileDef,
  NarrativeGraphsFileDef,
  NarrativeTemplatesFileDef,
  ProjectionResult,
  RuntimeDebugSnapshotDef,
  RuntimeSignalRequestDef,
  StampResponseDef,
  TaskIndex,
  ValidationIssueDef,
} from './types';
import { normalizeCategoriesFile } from './editor/categories';
import { emptyCatalog, mergeValidationIssues, validateNarrativeData } from './editorModel';
import {
  loadEditorPreferencesLocal,
  saveEditorPreferencesLocal,
  type EditorPreferences,
} from './utils/editorPreferences';

const DRAFT_STORAGE_KEY = 'narrative-editor-draft';

type QtBridge = {
  getData: (cb: (payload: string) => void) => void;
  saveData: (payload: string, cb?: (result: string) => void) => void;
  getProjection: (payload: string, cb: (result: string) => void) => void;
  get_task_index?: (compositionId: string, cb: (result: string) => void) => void;
  getAuthoringCatalog?: (cb: (result: string) => void) => void;
  validateData?: (payload: string, cb: (result: string) => void) => void;
  getRuntimeSnapshot?: (cb: (result: string) => void) => void;
  emitRuntimeSignal?: (payload: string, cb: (result: string) => void) => void;
  setRuntimeNarrativeState?: (graphId: string, stateId: string, cb: (result: string) => void) => void;
  editActions?: (label: string, payload: string, cb: (result: string) => void) => void;
  editConditions?: (label: string, payload: string, cb: (result: string) => void) => void;
  navigate: (kind: string, id: string) => void;
  getTemplates?: (cb: (result: string) => void) => void;
  saveTemplates?: (payload: string, cb: (result: string) => void) => void;
  extractTemplate?: (payload: string, cb: (result: string) => void) => void;
  stampTemplate?: (payload: string, cb: (result: string) => void) => void;
  getQuest?: (questId: string, cb: (result: string) => void) => void;
  getCategories?: (cb: (result: string) => void) => void;
  saveCategories?: (payload: string, cb: (result: string) => void) => void;
  getEditorPreferences?: (cb: (result: string) => void) => void;
  saveEditorPreferences?: (payload: string, cb: (result: string) => void) => void;
  getCanvasGroups?: (cb: (result: string) => void) => void;
  saveCanvasGroups?: (payload: string, cb: (result: string) => void) => void;
  scanSignalUsages?: (signalId: string, cb: (result: string) => void) => void;
  scanStateUsages?: (graphId: string, stateId: string, cb: (result: string) => void) => void;
  scanGraphUsages?: (graphId: string, cb: (result: string) => void) => void;
  applySignalRefactor?: (payload: string, cb: (result: string) => void) => void;
  undoSignalRefactor?: (cb: (result: string) => void) => void;
};

declare global {
  interface Window {
    qt?: { webChannelTransport: unknown };
    QWebChannel?: new (
      transport: unknown,
      cb: (channel: { objects: { narrativeBridge?: QtBridge } }) => void,
    ) => void;
    __narrativeEditor?: {
      getCurrentDataJson: () => string;
      getCurrentDataHash: () => string;
      isDirty: () => boolean;
      markSaved: () => void;
      refresh?: () => void;
      /** 宿主（PySide 位面面板等）跳转定位：切到含该图的编排并聚焦该状态。返回是否命中。 */
      focusState?: (graphId: string, stateId: string) => boolean;
    };
  }
}

let bridgePromise: Promise<QtBridge | null> | null = null;

function waitForBridge(): Promise<QtBridge | null> {
  if (bridgePromise) return bridgePromise;
  bridgePromise = new Promise((resolve) => {
    if (!window.qt?.webChannelTransport || !window.QWebChannel) {
      resolve(null);
      return;
    }
    new window.QWebChannel(window.qt.webChannelTransport, (channel) => {
      resolve(channel.objects.narrativeBridge ?? null);
    });
  });
  return bridgePromise;
}

const emptyData: NarrativeGraphsFileDef = { schemaVersion: 2, compositions: [] };

export async function loadNarrativeData(): Promise<NarrativeGraphsFileDef> {
  return (await loadNarrativeDataWithSource()).data;
}

export async function loadNarrativeDataWithSource(): Promise<{ data: NarrativeGraphsFileDef; source: string }> {
  const bridge = await waitForBridge();
  if (!bridge) {
    const draft = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (draft) {
      try {
        return { data: JSON.parse(draft) as NarrativeGraphsFileDef, source: 'local draft' };
      } catch {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      }
    }
    try {
      const res = await fetch('/assets/data/narrative_graphs.json');
      return { data: (await res.json()) as NarrativeGraphsFileDef, source: 'runtime file' };
    } catch {
      return { data: emptyData, source: 'empty fallback' };
    }
  }
  return new Promise((resolve) => {
    bridge.getData((payload) => {
      try {
        resolve({ data: JSON.parse(payload) as NarrativeGraphsFileDef, source: 'ProjectModel' });
      } catch {
        resolve({ data: emptyData, source: 'empty fallback' });
      }
    });
  });
}

export function clearLocalNarrativeDraft(): void {
  localStorage.removeItem(DRAFT_STORAGE_KEY);
}

/** 重新加载叙事编辑器页面（Qt 嵌入与纯 Web 均可用） */
export function reloadNarrativeEditorPage(): void {
  window.location.reload();
}

export async function saveNarrativeData(data: NarrativeGraphsFileDef): Promise<string> {
  const bridge = await waitForBridge();
  const payload = JSON.stringify(data);
  const issues = mergeValidationIssues(validateNarrativeData(data), await validateNarrativeDataRemote(data));
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  if (errorCount > 0) return `save blocked: ${errorCount} validation error(s)`;
  if (!bridge) {
    localStorage.setItem(DRAFT_STORAGE_KEY, payload);
    return 'saved locally';
  }
  return new Promise((resolve) => {
    bridge.saveData(payload, (result) => resolve(result || 'saved'));
  });
}

export async function loadProjection(data: NarrativeGraphsFileDef): Promise<ProjectionResult> {
  const bridge = await waitForBridge();
  const fallback: ProjectionResult = { schemaVersion: 1, triggerEdges: [], readEdges: [], stateCommandEdges: [], warnings: [] };
  if (!bridge) return fallback;
  return new Promise((resolve) => {
    bridge.getProjection(JSON.stringify(data), (payload) => {
      try {
        const parsed = JSON.parse(payload) as ProjectionResult;
        resolve({
          schemaVersion: parsed.schemaVersion ?? 1,
          triggerEdges: parsed.triggerEdges ?? [],
          readEdges: parsed.readEdges ?? [],
          stateCommandEdges: parsed.stateCommandEdges ?? [],
          warnings: parsed.warnings ?? [],
        });
      } catch {
        resolve(fallback);
      }
    });
  });
}

function emptyTaskIndex(compositionId: string): TaskIndex {
  return { compositionId, graphIds: [], references: [], planes: [], sceneEntities: [], quests: [] };
}

export async function loadTaskIndex(compositionId: string): Promise<TaskIndex> {
  const bridge = await waitForBridge();
  if (!bridge?.get_task_index || !compositionId) return emptyTaskIndex(compositionId);
  return new Promise((resolve) => {
    bridge.get_task_index!(compositionId, (payload) => {
      try {
        const parsed = JSON.parse(payload) as Partial<TaskIndex>;
        resolve({
          compositionId: parsed.compositionId ?? compositionId,
          graphIds: parsed.graphIds ?? [],
          references: parsed.references ?? [],
          planes: parsed.planes ?? [],
          sceneEntities: parsed.sceneEntities ?? [],
          quests: parsed.quests ?? [],
        });
      } catch {
        resolve(emptyTaskIndex(compositionId));
      }
    });
  });
}

export async function navigateTo(kind: string, id: string): Promise<void> {
  const bridge = await waitForBridge();
  bridge?.navigate(kind, id);
}

export async function loadAuthoringCatalog(): Promise<AuthoringCatalogDef> {
  const bridge = await waitForBridge();
  if (!bridge?.getAuthoringCatalog) return emptyCatalog;
  return new Promise((resolve) => {
    bridge.getAuthoringCatalog!((payload) => {
      try {
        resolve({ ...emptyCatalog, ...(JSON.parse(payload) as Partial<AuthoringCatalogDef>) });
      } catch {
        resolve(emptyCatalog);
      }
    });
  });
}

const emptyTemplatesFile: NarrativeTemplatesFileDef = { schemaVersion: 1, templates: [] };

export async function loadTemplates(): Promise<NarrativeTemplatesFileDef> {
  const bridge = await waitForBridge();
  if (!bridge?.getTemplates) {
    // 纯 Web 开发态：直读运行时永不加载的编辑器专用文件。
    try {
      const res = await fetch('/assets/data/narrative_templates.json');
      const parsed = (await res.json()) as NarrativeTemplatesFileDef;
      return { schemaVersion: parsed.schemaVersion ?? 1, templates: parsed.templates ?? [] };
    } catch {
      return emptyTemplatesFile;
    }
  }
  return new Promise((resolve) => {
    bridge.getTemplates!((payload) => {
      try {
        const parsed = JSON.parse(payload) as NarrativeTemplatesFileDef;
        resolve({ schemaVersion: parsed.schemaVersion ?? 1, templates: parsed.templates ?? [] });
      } catch {
        resolve(emptyTemplatesFile);
      }
    });
  });
}

export async function saveTemplatesRemote(
  file: NarrativeTemplatesFileDef,
): Promise<{ ok: boolean; reason?: string; templates?: NarrativeTemplatesFileDef }> {
  const bridge = await waitForBridge();
  if (!bridge?.saveTemplates) {
    return { ok: false, reason: '模板保存只在主编辑器（Qt 宿主）内可用' };
  }
  return new Promise((resolve) => {
    bridge.saveTemplates!(JSON.stringify(file), (payload) => {
      try {
        resolve(JSON.parse(payload) as { ok: boolean; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析保存响应：${String(e)}` });
      }
    });
  });
}

export async function extractTemplateRemote(payload: Record<string, unknown>): Promise<ExtractResponseDef> {
  const bridge = await waitForBridge();
  if (!bridge?.extractTemplate) {
    return { ok: false, reason: '模板抽取只在主编辑器（Qt 宿主）内可用' };
  }
  return new Promise((resolve) => {
    bridge.extractTemplate!(JSON.stringify(payload), (result) => {
      try {
        resolve(JSON.parse(result) as ExtractResponseDef);
      } catch (e) {
        resolve({ ok: false, reason: `无法解析抽取响应：${String(e)}` });
      }
    });
  });
}

export async function stampTemplateRemote(payload: Record<string, unknown>): Promise<StampResponseDef> {
  const bridge = await waitForBridge();
  if (!bridge?.stampTemplate) {
    return { ok: false, reason: '模板盖章只在主编辑器（Qt 宿主）内可用' };
  }
  return new Promise((resolve) => {
    bridge.stampTemplate!(JSON.stringify(payload), (result) => {
      try {
        resolve(JSON.parse(result) as StampResponseDef);
      } catch (e) {
        resolve({ ok: false, reason: `无法解析盖章响应：${String(e)}` });
      }
    });
  });
}

const CATEGORIES_DRAFT_STORAGE_KEY = 'narrative-editor-categories-draft';

/**
 * 「整理分组」标签：编辑器专用，运行时永不加载，绝不进 narrative_graphs.json。
 * 主路径走 Qt 宿主（ProjectModel 旁挂文件 narrative_categories.json）；纯 Web 开发态
 * 兜底到 localStorage 草稿 / 直读文件（仅 dev 便利，主路径仍是文件）。
 */
export async function loadCategories(): Promise<NarrativeCategoriesFileDef> {
  const bridge = await waitForBridge();
  if (!bridge?.getCategories) {
    const draft = localStorage.getItem(CATEGORIES_DRAFT_STORAGE_KEY);
    if (draft) {
      try {
        return normalizeCategoriesFile(JSON.parse(draft));
      } catch {
        localStorage.removeItem(CATEGORIES_DRAFT_STORAGE_KEY);
      }
    }
    try {
      const res = await fetch('/assets/data/narrative_categories.json');
      return normalizeCategoriesFile(await res.json());
    } catch {
      return normalizeCategoriesFile(null);
    }
  }
  return new Promise((resolve) => {
    bridge.getCategories!((payload) => {
      try {
        resolve(normalizeCategoriesFile(JSON.parse(payload)));
      } catch {
        resolve(normalizeCategoriesFile(null));
      }
    });
  });
}

export async function saveCategoriesRemote(
  file: NarrativeCategoriesFileDef,
): Promise<{ ok: boolean; reason?: string; categories?: NarrativeCategoriesFileDef }> {
  const bridge = await waitForBridge();
  const normalized = normalizeCategoriesFile(file);
  if (!bridge?.saveCategories) {
    // 纯 Web 开发态：落 localStorage 草稿（主路径是 Qt 宿主旁挂文件）。
    try {
      localStorage.setItem(CATEGORIES_DRAFT_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      /* 存储不可用时静默降级为内存态 */
    }
    return { ok: true, categories: normalized };
  }
  return new Promise((resolve) => {
    bridge.saveCategories!(JSON.stringify(normalized), (payload) => {
      try {
        resolve(JSON.parse(payload) as { ok: boolean; reason?: string; categories?: NarrativeCategoriesFileDef });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析分组保存响应：${String(e)}` });
      }
    });
  });
}

/**
 * 叙事编辑器 UI 偏好（字体/缩放/画布点阵…）：编辑器专用，运行时永不加载。
 * 主路径走 Qt 宿主 bridge → 工程文件 editor_data/narrative_editor_preferences.json，
 * apply 即立即落盘、重启不丢；纯 Web 开发态兜底到 localStorage（见 debug-ui-persistence 范式）。
 */
export async function loadEditorPreferencesRemote(): Promise<Partial<EditorPreferences> | null> {
  const bridge = await waitForBridge();
  if (!bridge?.getEditorPreferences) {
    return loadEditorPreferencesLocal();
  }
  return new Promise((resolve) => {
    bridge.getEditorPreferences!((payload) => {
      try {
        const parsed = JSON.parse(payload || '{}') as Partial<EditorPreferences>;
        resolve(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function saveEditorPreferencesRemote(
  preferences: EditorPreferences,
): Promise<{ ok: boolean; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.saveEditorPreferences) {
    saveEditorPreferencesLocal(preferences);
    return { ok: true };
  }
  return new Promise((resolve) => {
    bridge.saveEditorPreferences!(JSON.stringify(preferences), (payload) => {
      try {
        resolve(JSON.parse(payload) as { ok: boolean; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析偏好保存响应：${String(e)}` });
      }
    });
  });
}

const CANVAS_GROUPS_DRAFT_STORAGE_KEY = 'narrative-editor-canvas-groups-draft';

/**
 * 画布分组框（编辑器视觉整理层）：编辑器专用，运行时永不加载，绝不进 narrative_graphs.json。
 * 主路径走 Qt 宿主 bridge → 工程文件 editor_data/narrative_canvas_groups.json，改动即落盘、
 * 重启不丢；纯 Web 开发态兜底 localStorage（见 canvas/editorGroups.ts）。
 */
export async function loadCanvasGroupsRemote(): Promise<unknown> {
  const bridge = await waitForBridge();
  if (!bridge?.getCanvasGroups) {
    try {
      const draft = localStorage.getItem(CANVAS_GROUPS_DRAFT_STORAGE_KEY);
      return draft ? (JSON.parse(draft) as unknown) : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    bridge.getCanvasGroups!((payload) => {
      try {
        const parsed = JSON.parse(payload || '{}') as unknown;
        resolve(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function saveCanvasGroupsRemote(file: unknown): Promise<{ ok: boolean; reason?: string }> {
  const bridge = await waitForBridge();
  const payload = JSON.stringify(file);
  if (!bridge?.saveCanvasGroups) {
    try {
      localStorage.setItem(CANVAS_GROUPS_DRAFT_STORAGE_KEY, payload);
    } catch {
      /* 存储不可用时静默降级为内存态 */
    }
    return { ok: true };
  }
  return new Promise((resolve) => {
    bridge.saveCanvasGroups!(payload, (result) => {
      try {
        resolve(JSON.parse(result) as { ok: boolean; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析分组保存响应：${String(e)}` });
      }
    });
  });
}

export async function getQuestRemote(questId: string): Promise<{ ok: boolean; quest?: Record<string, unknown>; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.getQuest) return { ok: false, reason: '任务读取只在主编辑器（Qt 宿主）内可用' };
  return new Promise((resolve) => {
    bridge.getQuest!(questId, (result) => {
      try {
        resolve(JSON.parse(result) as { ok: boolean; quest?: Record<string, unknown>; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析任务读取响应：${String(e)}` });
      }
    });
  });
}

export async function validateNarrativeDataRemote(data: NarrativeGraphsFileDef): Promise<ValidationIssueDef[]> {
  const bridge = await waitForBridge();
  if (!bridge?.validateData) return validateNarrativeData(data);
  return new Promise((resolve) => {
    bridge.validateData!(JSON.stringify(data), (payload) => {
      try {
        const parsed = JSON.parse(payload) as ValidationIssueDef[];
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve(validateNarrativeData(data));
      }
    });
  });
}

export async function getRuntimeSnapshot(): Promise<RuntimeDebugSnapshotDef> {
  const bridge = await waitForBridge();
  if (!bridge?.getRuntimeSnapshot) return { ok: false, reason: 'Qt runtime bridge is unavailable' };
  return new Promise((resolve) => {
    bridge.getRuntimeSnapshot!((payload) => resolve(parseRuntimeResult(payload)));
  });
}

export async function emitRuntimeSignal(signal: RuntimeSignalRequestDef): Promise<RuntimeDebugSnapshotDef> {
  const bridge = await waitForBridge();
  if (!bridge?.emitRuntimeSignal) return { ok: false, reason: 'Qt runtime bridge is unavailable' };
  return new Promise((resolve) => {
    bridge.emitRuntimeSignal!(JSON.stringify(signal), (payload) => resolve(parseRuntimeResult(payload)));
  });
}

export async function setRuntimeNarrativeState(graphId: string, stateId: string): Promise<RuntimeDebugSnapshotDef> {
  const bridge = await waitForBridge();
  if (!bridge?.setRuntimeNarrativeState) return { ok: false, reason: 'Qt runtime bridge is unavailable' };
  return new Promise((resolve) => {
    bridge.setRuntimeNarrativeState!(graphId, stateId, (payload) => resolve(parseRuntimeResult(payload)));
  });
}

export async function editActionsNative(
  label: string,
  actions: ActionDef[],
): Promise<{ ok: boolean; actions?: ActionDef[]; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.editActions) {
    return { ok: false, reason: '原生 ActionEditor 只在主 PySide 编辑器内可用' };
  }
  return new Promise((resolve) => {
    bridge.editActions!(label, JSON.stringify(actions ?? []), (payload) => {
      try {
        const parsed = JSON.parse(payload) as { ok: boolean; actions?: ActionDef[]; reason?: string };
        resolve(parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'Invalid ActionEditor response' });
      } catch (e) {
        resolve({ ok: false, reason: `Invalid ActionEditor response: ${String(e)}` });
      }
    });
  });
}

export async function editConditionsNative(
  label: string,
  conditions: unknown[],
): Promise<{ ok: boolean; conditions?: unknown[]; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.editConditions) {
    return { ok: false, reason: '原生条件编辑器只在主 PySide 编辑器内可用' };
  }
  return new Promise((resolve) => {
    bridge.editConditions!(label, JSON.stringify(conditions ?? []), (payload) => {
      try {
        const parsed = JSON.parse(payload) as { ok: boolean; conditions?: unknown[]; reason?: string };
        resolve(parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'Invalid ConditionEditor response' });
      } catch (e) {
        resolve({ ok: false, reason: `Invalid ConditionEditor response: ${String(e)}` });
      }
    });
  });
}

// --------------------------------------------------------------------------- //
// 信号重构（改名/删除）：宿主引擎全项目级联，零磁盘写入，落盘只经主编辑器 Save All。
// --------------------------------------------------------------------------- //

export type SignalUsagesDef = {
  signalId: string;
  registryIndex: number;
  listeners: Array<{ graphId: string; transitionId: string }>;
  actionEmits: number;
  metaEmits: Array<{ compositionId: string; elementId: string }>;
  dialogues: Array<{ graphId: string; count: number }>;
  assets: Array<{ bucket: string; attr: string; itemId: string; count: number }>;
  totalRefs: number;
};

export type StateUsagesDef = {
  graphId: string;
  stateId: string;
  internalEndpoints: number;
  derivedListeners: Array<{ graphId: string; transitionId: string }>;
  narrativeConditions: number;
  external: Array<{ bucket: string; itemId: string; count: number }>;
  totalRefs: number;
};

export type GraphUsagesDef = {
  graphId: string;
  derivedListeners: number;
  metaReads: number;
  narrativeConditions: number;
  external: Array<{ bucket: string; itemId: string; count: number }>;
  totalRefs: number;
};

export type SignalRefactorResultDef = {
  ok: boolean;
  reason?: string;
  summary?: Record<string, unknown>;
  description?: string;
  narrative?: NarrativeGraphsFileDef;
  journalSize?: number;
};

const REFACTOR_HOST_ONLY = '重构需要工程文件后端，只在主编辑器（Qt 宿主）内可用；独立网页开发模式没有工程数据可级联';

export async function scanSignalUsagesRemote(
  signalId: string,
): Promise<{ ok: boolean; usages?: SignalUsagesDef; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.scanSignalUsages) return { ok: false, reason: REFACTOR_HOST_ONLY };
  return new Promise((resolve) => {
    bridge.scanSignalUsages!(signalId, (payload) => {
      try {
        resolve(JSON.parse(payload) as { ok: boolean; usages?: SignalUsagesDef; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析扫描响应：${String(e)}` });
      }
    });
  });
}

export async function scanStateUsagesRemote(
  graphId: string,
  stateId: string,
): Promise<{ ok: boolean; usages?: StateUsagesDef; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.scanStateUsages) return { ok: false, reason: REFACTOR_HOST_ONLY };
  return new Promise((resolve) => {
    bridge.scanStateUsages!(graphId, stateId, (payload) => {
      try {
        resolve(JSON.parse(payload) as { ok: boolean; usages?: StateUsagesDef; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析扫描响应：${String(e)}` });
      }
    });
  });
}

export async function scanGraphUsagesRemote(
  graphId: string,
): Promise<{ ok: boolean; usages?: GraphUsagesDef; reason?: string }> {
  const bridge = await waitForBridge();
  if (!bridge?.scanGraphUsages) return { ok: false, reason: REFACTOR_HOST_ONLY };
  return new Promise((resolve) => {
    bridge.scanGraphUsages!(graphId, (payload) => {
      try {
        resolve(JSON.parse(payload) as { ok: boolean; usages?: GraphUsagesDef; reason?: string });
      } catch (e) {
        resolve({ ok: false, reason: `无法解析扫描响应：${String(e)}` });
      }
    });
  });
}

export async function applySignalRefactorRemote(payload: {
  op: 'rename' | 'delete' | 'renameState' | 'renameGraph';
  oldId?: string;
  newId?: string;
  signalId?: string;
  force?: boolean;
  graphId?: string;
  oldStateId?: string;
  newStateId?: string;
  oldGraphId?: string;
  newGraphId?: string;
  data: NarrativeGraphsFileDef;
}): Promise<SignalRefactorResultDef> {
  const bridge = await waitForBridge();
  if (!bridge?.applySignalRefactor) return { ok: false, reason: REFACTOR_HOST_ONLY };
  return new Promise((resolve) => {
    bridge.applySignalRefactor!(JSON.stringify(payload), (result) => {
      try {
        resolve(JSON.parse(result) as SignalRefactorResultDef);
      } catch (e) {
        resolve({ ok: false, reason: `无法解析重构响应：${String(e)}` });
      }
    });
  });
}

export async function undoSignalRefactorRemote(): Promise<SignalRefactorResultDef> {
  const bridge = await waitForBridge();
  if (!bridge?.undoSignalRefactor) return { ok: false, reason: REFACTOR_HOST_ONLY };
  return new Promise((resolve) => {
    bridge.undoSignalRefactor!((result) => {
      try {
        resolve(JSON.parse(result) as SignalRefactorResultDef);
      } catch (e) {
        resolve({ ok: false, reason: `无法解析撤销响应：${String(e)}` });
      }
    });
  });
}

function parseRuntimeResult(payload: string): RuntimeDebugSnapshotDef {
  try {
    const parsed = JSON.parse(payload) as RuntimeDebugSnapshotDef;
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'Invalid runtime bridge response' };
  } catch (e) {
    return { ok: false, reason: `Invalid runtime bridge response: ${String(e)}` };
  }
}
