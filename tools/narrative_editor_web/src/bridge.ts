import type {
  ActionDef,
  AuthoringCatalogDef,
  NarrativeGraphsFileDef,
  ProjectionResult,
  RuntimeDebugSnapshotDef,
  RuntimeSignalRequestDef,
  ValidationIssueDef,
} from './types';
import { emptyCatalog, mergeValidationIssues, validateNarrativeData } from './editorModel';

const DRAFT_STORAGE_KEY = 'narrative-editor-draft';

type QtBridge = {
  getData: (cb: (payload: string) => void) => void;
  saveData: (payload: string, cb?: (result: string) => void) => void;
  getProjection: (payload: string, cb: (result: string) => void) => void;
  getAuthoringCatalog?: (cb: (result: string) => void) => void;
  validateData?: (payload: string, cb: (result: string) => void) => void;
  getRuntimeSnapshot?: (cb: (result: string) => void) => void;
  emitRuntimeSignal?: (payload: string, cb: (result: string) => void) => void;
  setRuntimeNarrativeState?: (graphId: string, stateId: string, cb: (result: string) => void) => void;
  editActions?: (label: string, payload: string, cb: (result: string) => void) => void;
  navigate: (kind: string, id: string) => void;
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

function parseRuntimeResult(payload: string): RuntimeDebugSnapshotDef {
  try {
    const parsed = JSON.parse(payload) as RuntimeDebugSnapshotDef;
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'Invalid runtime bridge response' };
  } catch (e) {
    return { ok: false, reason: `Invalid runtime bridge response: ${String(e)}` };
  }
}
