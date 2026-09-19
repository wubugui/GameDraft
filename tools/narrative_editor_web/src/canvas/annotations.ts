import type { CanvasNode } from '../types';

/**
 * 画布「注释」：给状态节点 / 迁移 / 分组框打的备注，以及独立的便签节点。
 *
 * **纯编辑器视觉层**，与分组框同一套路：持久化在旁挂文件
 * editor_data/narrative_canvas_annotations.json（Qt 桥立即写盘，不标脏、不进 Save All），
 * 运行时永不加载，**一个字节都不进 narrative_graphs.json**——编排数据的保存路径、校验、
 * 归一化、字节幂等护栏全部原样，注释丢了顶多是备注没了，编排一根毫毛都伤不到。
 *
 * 节点 / 迁移注释按「图 id + 状态 id / 迁移 id」记（同一张图在主画布展开与独占视图里都显示）；
 * 分组框注释与便签按「编排 + 画布」记（分组框本来就是按画布存的）。状态改名 / 删除后
 * 对应注释会变成孤儿（不显示、不报错），与整理分组的取舍相同。
 */

export interface CanvasNoteDef {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
}

export interface CanvasAnnotationsFileDef {
  schemaVersion?: number;
  /** graphId → stateId → 注释 */
  states?: Record<string, Record<string, string>>;
  /** graphId → transitionId → 注释 */
  transitions?: Record<string, Record<string, string>>;
  /** compositionId → graphRef → 分组框 id → 注释 */
  groups?: Record<string, Record<string, Record<string, string>>>;
  /** compositionId → graphRef → 便签 id → 便签 */
  notes?: Record<string, Record<string, Record<string, CanvasNoteDef>>>;
}

export type CanvasAnnotationsFile = Required<CanvasAnnotationsFileDef>;

export const NOTE_NODE_ID_PREFIX = 'editor-note:';

/** 便签底色：都是浅色，黑字在上面看得清；新建按序取色 */
export const NOTE_COLOR_PALETTE = ['#f5d76e', '#f7b267', '#9ad0f5', '#b5e48c', '#e3b5f0', '#f1a7a7'];

const MIN_NOTE_W = 120;
const MIN_NOTE_H = 60;
const DEFAULT_NOTE_W = 240;
const DEFAULT_NOTE_H = 120;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function cleanNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanColor(value: unknown, index: number): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : noteColorForIndex(index);
}

export function noteColorForIndex(index: number): string {
  return NOTE_COLOR_PALETTE[index % NOTE_COLOR_PALETTE.length]!;
}

function normalizeTextMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const text = cleanText(value);
    // 只去掉纯空白：作者写的换行 / 缩进是备注的一部分，不 trim
    if (key.trim() && text.trim()) out[key] = text;
  }
  return out;
}

function normalizeNestedTextMap(raw: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) continue;
    const inner = normalizeTextMap(value);
    if (Object.keys(inner).length) out[key] = inner;
  }
  return out;
}

export function normalizeNote(raw: unknown, index: number): CanvasNoteDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Partial<CanvasNoteDef>;
  return {
    x: Math.round(cleanNumber(n.x, 0)),
    y: Math.round(cleanNumber(n.y, 0)),
    width: Math.max(MIN_NOTE_W, Math.round(cleanNumber(n.width, DEFAULT_NOTE_W))),
    height: Math.max(MIN_NOTE_H, Math.round(cleanNumber(n.height, DEFAULT_NOTE_H))),
    text: cleanText(n.text),
    color: cleanColor(n.color, index),
  };
}

/** 容错归一为标准形状（缺失 / 损坏 → 空表；丢空层级、空注释）。 */
export function normalizeAnnotationsFile(raw: unknown): CanvasAnnotationsFile {
  const src = (raw && typeof raw === 'object' ? raw : {}) as CanvasAnnotationsFileDef;
  const groups: CanvasAnnotationsFile['groups'] = {};
  if (src.groups && typeof src.groups === 'object') {
    for (const [compId, byRef] of Object.entries(src.groups)) {
      if (!compId.trim()) continue;
      const inner = normalizeNestedTextMap(byRef);
      if (Object.keys(inner).length) groups[compId] = inner;
    }
  }
  const notes: CanvasAnnotationsFile['notes'] = {};
  if (src.notes && typeof src.notes === 'object') {
    for (const [compId, byRef] of Object.entries(src.notes)) {
      if (!compId.trim() || !byRef || typeof byRef !== 'object') continue;
      const refsOut: Record<string, Record<string, CanvasNoteDef>> = {};
      for (const [graphRef, byId] of Object.entries(byRef as Record<string, unknown>)) {
        if (!graphRef.trim() || !byId || typeof byId !== 'object') continue;
        const notesOut: Record<string, CanvasNoteDef> = {};
        let index = 0;
        for (const [nid, note] of Object.entries(byId as Record<string, unknown>)) {
          const normalized = normalizeNote(note, index);
          if (nid.trim() && normalized) {
            notesOut[nid] = normalized;
            index += 1;
          }
        }
        if (Object.keys(notesOut).length) refsOut[graphRef] = notesOut;
      }
      if (Object.keys(refsOut).length) notes[compId] = refsOut;
    }
  }
  return {
    schemaVersion: 1,
    states: normalizeNestedTextMap(src.states),
    transitions: normalizeNestedTextMap(src.transitions),
    groups,
    notes,
  };
}

// --------------------------------------------------------------------------- 读

export function stateNote(file: CanvasAnnotationsFileDef, graphId: string, stateId: string): string {
  return file.states?.[graphId]?.[stateId] ?? '';
}

export function transitionNote(file: CanvasAnnotationsFileDef, graphId: string, transitionId: string): string {
  return file.transitions?.[graphId]?.[transitionId] ?? '';
}

export function groupNote(file: CanvasAnnotationsFileDef, compositionId: string, graphRef: string, gid: string): string {
  return file.groups?.[compositionId]?.[graphRef]?.[gid] ?? '';
}

export function notesForCanvas(file: CanvasAnnotationsFileDef, compositionId: string, graphRef: string): Record<string, CanvasNoteDef> {
  return file.notes?.[compositionId]?.[graphRef] ?? {};
}

// --------------------------------------------------------------------------- 写（不可变，返回新 file）

function withTextMap(
  map: Record<string, Record<string, string>>,
  outer: string,
  inner: string,
  text: string,
): Record<string, Record<string, string>> {
  const next = { ...map };
  const bucket = { ...(next[outer] ?? {}) };
  if (text.trim()) bucket[inner] = text; else delete bucket[inner];
  if (Object.keys(bucket).length) next[outer] = bucket; else delete next[outer];
  return next;
}

export function setStateNote(file: CanvasAnnotationsFileDef, graphId: string, stateId: string, text: string): CanvasAnnotationsFile {
  const next = normalizeAnnotationsFile(file);
  next.states = withTextMap(next.states, graphId, stateId, text);
  return normalizeAnnotationsFile(next);
}

export function setTransitionNote(file: CanvasAnnotationsFileDef, graphId: string, transitionId: string, text: string): CanvasAnnotationsFile {
  const next = normalizeAnnotationsFile(file);
  next.transitions = withTextMap(next.transitions, graphId, transitionId, text);
  return normalizeAnnotationsFile(next);
}

export function setGroupNote(
  file: CanvasAnnotationsFileDef,
  compositionId: string,
  graphRef: string,
  gid: string,
  text: string,
): CanvasAnnotationsFile {
  const next = normalizeAnnotationsFile(file);
  const byRef = { ...(next.groups[compositionId] ?? {}) };
  const updated = withTextMap(byRef, graphRef, gid, text);
  if (Object.keys(updated).length) next.groups[compositionId] = updated; else delete next.groups[compositionId];
  return normalizeAnnotationsFile(next);
}

/** 整画布覆盖写便签（空表时剪掉该层级保持文件精简）。 */
export function setNotesForCanvas(
  file: CanvasAnnotationsFileDef,
  compositionId: string,
  graphRef: string,
  notes: Record<string, CanvasNoteDef>,
): CanvasAnnotationsFile {
  const next = normalizeAnnotationsFile(file);
  const byRef = { ...(next.notes[compositionId] ?? {}) };
  if (Object.keys(notes).length) byRef[graphRef] = notes; else delete byRef[graphRef];
  if (Object.keys(byRef).length) next.notes[compositionId] = byRef; else delete next.notes[compositionId];
  return normalizeAnnotationsFile(next);
}

export function newNoteId(existing: Record<string, CanvasNoteDef>): string {
  let n = Object.keys(existing).length + 1;
  while (existing[`n_${n}`]) n += 1;
  return `n_${n}`;
}

export function newNote(existing: Record<string, CanvasNoteDef>, x: number, y: number, text = ''): CanvasNoteDef {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: DEFAULT_NOTE_W,
    height: DEFAULT_NOTE_H,
    text,
    color: noteColorForIndex(Object.keys(existing).length),
  };
}

// --------------------------------------------------------------------------- 画布节点

export function noteNodeId(noteId: string): string {
  return `${NOTE_NODE_ID_PREFIX}${noteId}`;
}

export function parseNoteNodeId(nodeId: string): string | null {
  return nodeId.startsWith(NOTE_NODE_ID_PREFIX) ? nodeId.slice(NOTE_NODE_ID_PREFIX.length) : null;
}

export function buildNoteNodes(notes: Record<string, CanvasNoteDef>): CanvasNode[] {
  return Object.entries(notes).map(([nid, note]) => ({
    id: noteNodeId(nid),
    type: 'annotationNote',
    position: { x: note.x, y: note.y },
    style: { width: note.width, height: note.height },
    // 在分组框之上、状态节点之下：便签是旁注，不该把节点盖住
    zIndex: 5,
    // 禁走 React Flow 的 Delete 键删除（那条路会进模型删除）：删便签只走它自己的 × 按钮
    deletable: false,
    data: {
      label: note.text,
      subtitle: '',
      kind: 'annotationNote' as const,
      noteText: note.text,
      noteColor: note.color,
    },
  }));
}

/** 把 nodes 状态里的便签节点与注释数据对齐（增 / 删 / 更新，保留其它节点引用不变）。 */
export function reconcileNoteNodes(nodes: CanvasNode[], notes: Record<string, CanvasNoteDef>): CanvasNode[] {
  const wanted = new Map(buildNoteNodes(notes).map((n) => [n.id, n]));
  const out: CanvasNode[] = [];
  let changed = false;
  for (const node of nodes) {
    const nid = parseNoteNodeId(node.id);
    if (!nid) {
      out.push(node);
      continue;
    }
    const target = wanted.get(node.id);
    if (!target) {
      changed = true;
      continue;
    }
    wanted.delete(node.id);
    const same = node.position.x === target.position.x
      && node.position.y === target.position.y
      && node.style?.width === target.style?.width
      && node.style?.height === target.style?.height
      && node.data.noteText === target.data.noteText
      && node.data.noteColor === target.data.noteColor;
    if (same) {
      out.push(node);
    } else {
      changed = true;
      out.push({ ...node, position: target.position, style: target.style, data: { ...node.data, ...target.data } });
    }
  }
  if (wanted.size) {
    changed = true;
    out.push(...wanted.values());
  }
  return changed ? out : nodes;
}
