import type { CanvasEdge, CanvasNode } from '../types';

/**
 * 画布「编辑器分组框」：纯编辑器视觉整理层，与图对话编辑器的分组框同一套心智模型——
 * 命名/配色的矩形框、节点中心落在框内即归组（重叠取最小框）、可折叠成紧凑节点
 * （成员隐藏、跨组连线改接到框——**只是画布呈现**，narrative_graphs.json 分毫不动）。
 *
 * 持久化在旁挂文件 editor_data/narrative_canvas_groups.json（Qt 桥立即写盘，不标脏、
 * 不进 Save All），运行时永不加载。成员关系不持久化——永远按几何现算。
 */

export interface CanvasGroupFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasGroupDef {
  name: string;
  color: string;
  collapsed?: boolean;
  frame: CanvasGroupFrameRect;
}

/** canvases[compositionId][graphRef] → { gid: group }。嵌套结构避免拼 key 分隔符冲突。 */
export interface CanvasGroupsFileDef {
  schemaVersion?: number;
  canvases?: Record<string, Record<string, Record<string, CanvasGroupDef>>>;
}

export const GROUP_NODE_ID_PREFIX = 'editor-group:';

/** 与图对话编辑器同思路的确定性调色板：新建分组按序取色，一眼区分。 */
export const GROUP_COLOR_PALETTE = [
  '#4a6fa8', '#7a5ba8', '#3f8f6b', '#a8712f',
  '#a84a5f', '#3e7fa0', '#6f7f37', '#8a5a44',
];

const MIN_FRAME_SIZE = 80;
// 与几何归属的节点尺寸粗估（节点未 measure 时的兜底），量级同图对话编辑器。
const EST_NODE_W = 220;
const EST_NODE_H = 90;

export function groupColorForIndex(index: number): string {
  return GROUP_COLOR_PALETTE[index % GROUP_COLOR_PALETTE.length];
}

export function groupFrameNodeId(gid: string): string {
  return `${GROUP_NODE_ID_PREFIX}${gid}`;
}

export function parseGroupFrameNodeId(nodeId: string): string | null {
  return nodeId.startsWith(GROUP_NODE_ID_PREFIX) ? nodeId.slice(GROUP_NODE_ID_PREFIX.length) : null;
}

function cleanNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeGroup(raw: unknown, index: number): CanvasGroupDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<CanvasGroupDef>;
  const frame = (g.frame && typeof g.frame === 'object' ? g.frame : {}) as Partial<CanvasGroupFrameRect>;
  return {
    name: (typeof g.name === 'string' && g.name.trim()) ? g.name.trim() : '分组',
    color: (typeof g.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.color)) ? g.color : groupColorForIndex(index),
    ...(g.collapsed === true ? { collapsed: true } : {}),
    frame: {
      x: Math.round(cleanNumber(frame.x, 0)),
      y: Math.round(cleanNumber(frame.y, 0)),
      width: Math.max(MIN_FRAME_SIZE, Math.round(cleanNumber(frame.width, 320))),
      height: Math.max(MIN_FRAME_SIZE, Math.round(cleanNumber(frame.height, 220))),
    },
  };
}

/** 容错归一为标准形状（缺失/损坏 → 空注册表；丢空层级）。 */
export function normalizeCanvasGroupsFile(raw: unknown): Required<CanvasGroupsFileDef> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as CanvasGroupsFileDef;
  const canvases: Required<CanvasGroupsFileDef>['canvases'] = {};
  if (src.canvases && typeof src.canvases === 'object') {
    for (const [compId, byRef] of Object.entries(src.canvases)) {
      if (!compId.trim() || !byRef || typeof byRef !== 'object') continue;
      const refsOut: Record<string, Record<string, CanvasGroupDef>> = {};
      for (const [graphRef, groups] of Object.entries(byRef)) {
        if (!graphRef.trim() || !groups || typeof groups !== 'object') continue;
        const groupsOut: Record<string, CanvasGroupDef> = {};
        let index = 0;
        for (const [gid, g] of Object.entries(groups)) {
          const normalized = normalizeGroup(g, index);
          if (gid.trim() && normalized) {
            groupsOut[gid] = normalized;
            index += 1;
          }
        }
        if (Object.keys(groupsOut).length) refsOut[graphRef] = groupsOut;
      }
      if (Object.keys(refsOut).length) canvases[compId] = refsOut;
    }
  }
  return { schemaVersion: 1, canvases };
}

export function groupsForCanvas(
  file: CanvasGroupsFileDef,
  compositionId: string,
  graphRef: string,
): Record<string, CanvasGroupDef> {
  return file.canvases?.[compositionId]?.[graphRef] ?? {};
}

/** 整画布覆盖写入（不可变，返回新 file；空组表时剪掉该层级保持文件精简）。 */
export function setGroupsForCanvas(
  file: CanvasGroupsFileDef,
  compositionId: string,
  graphRef: string,
  groups: Record<string, CanvasGroupDef>,
): Required<CanvasGroupsFileDef> {
  const next = normalizeCanvasGroupsFile(file);
  const byRef = { ...(next.canvases[compositionId] ?? {}) };
  if (Object.keys(groups).length) {
    byRef[graphRef] = groups;
  } else {
    delete byRef[graphRef];
  }
  if (Object.keys(byRef).length) {
    next.canvases[compositionId] = byRef;
  } else {
    delete next.canvases[compositionId];
  }
  return normalizeCanvasGroupsFile(next);
}

export function newGroupId(existing: Record<string, CanvasGroupDef>): string {
  let n = Object.keys(existing).length + 1;
  while (existing[`g_${n}`]) n += 1;
  return `g_${n}`;
}

/** 参与几何归属的实体节点：排除锚点、分组框自身、及带 parentId 的子图内嵌子节点
 *（子节点坐标是相对父容器的，且它们随子图容器整体归组更符合直觉）。 */
function isGroupableNode(node: CanvasNode): boolean {
  if (node.parentId) return false;
  const kind = node.data?.kind;
  return kind !== 'graphAnchor' && kind !== 'projectionAnchor'
    && kind !== 'transitionAnchor' && kind !== 'editorGroupFrame';
}

function nodeCenter(node: CanvasNode): { cx: number; cy: number } {
  const w = node.measured?.width ?? (Number(node.style?.width) || EST_NODE_W);
  const h = node.measured?.height ?? (Number(node.style?.height) || EST_NODE_H);
  return { cx: node.position.x + w / 2, cy: node.position.y + h / 2 };
}

/** 节点中心落在框内即归组；多框重叠取面积最小者（与图对话编辑器同规则）。 */
export function computeGroupMembership(
  nodes: CanvasNode[],
  groups: Record<string, CanvasGroupDef>,
): Map<string, string> {
  const rects = Object.entries(groups).map(([gid, g]) => ({
    gid,
    ...g.frame,
    area: g.frame.width * g.frame.height,
  }));
  const out = new Map<string, string>();
  if (!rects.length) return out;
  for (const node of nodes) {
    if (!isGroupableNode(node)) continue;
    const { cx, cy } = nodeCenter(node);
    let best: { gid: string; area: number } | null = null;
    for (const r of rects) {
      if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) {
        if (!best || r.area < best.area) best = { gid: r.gid, area: r.area };
      }
    }
    if (best) out.set(node.id, best.gid);
  }
  return out;
}

/** 按 groups 构建分组框节点（垫底、可拖、可选中；宽高走 style 供 NodeResizer 接管）。 */
export function buildGroupFrameNodes(
  groups: Record<string, CanvasGroupDef>,
  memberCounts?: Map<string, number>,
): CanvasNode[] {
  return Object.entries(groups).map(([gid, g]) => ({
    id: groupFrameNodeId(gid),
    type: 'editorGroupFrame',
    position: { x: g.frame.x, y: g.frame.y },
    style: { width: g.frame.width, height: g.frame.height },
    zIndex: -20,
    // 禁走 React Flow 的 Delete 键删除：折叠时跨组连线 id 是真实迁移 id，
    // 级联删边会误删真数据。删除分组框只走标题栏 × 按钮（纯改分组注册表）。
    deletable: false,
    data: {
      label: g.name,
      subtitle: '',
      kind: 'editorGroupFrame' as const,
      groupColor: g.color,
      groupCollapsed: g.collapsed === true,
      groupMemberCount: memberCounts?.get(gid) ?? 0,
    },
  }));
}

/** 把 nodes 状态里的分组框节点与 groups 数据对齐（增/删/更新，保留其它节点引用不变）。 */
export function reconcileGroupFrameNodes(
  nodes: CanvasNode[],
  groups: Record<string, CanvasGroupDef>,
): CanvasNode[] {
  const wanted = new Map(buildGroupFrameNodes(groups).map((n) => [n.id, n]));
  const out: CanvasNode[] = [];
  for (const node of nodes) {
    if (node.data?.kind !== 'editorGroupFrame') {
      out.push(node);
      continue;
    }
    const next = wanted.get(node.id);
    if (!next) continue; // 组已删除
    wanted.delete(node.id);
    // 保留 selected 等运行态；几何/数据以 groups 为准
    out.push({ ...node, position: next.position, style: { ...node.style, ...next.style }, data: next.data });
  }
  out.push(...wanted.values());
  return out;
}

const COLLAPSED_FRAME_W = 200;
const COLLAPSED_FRAME_H = 68;

/**
 * 折叠呈现变换（只作用于 display 拷贝，不动 nodes/edges 状态本身）：
 * 折叠组的成员节点隐藏、组内连线隐藏、跨组连线改接到分组框节点；框缩为紧凑节点。
 * 同时给每个框节点补 groupMemberCount。
 */
export function applyEditorGroupDisplay(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  groups: Record<string, CanvasGroupDef>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (!Object.keys(groups).length) return { nodes, edges };
  const membership = computeGroupMembership(nodes, groups);
  const counts = new Map<string, number>();
  for (const gid of membership.values()) counts.set(gid, (counts.get(gid) ?? 0) + 1);

  const collapsedGids = new Set(
    Object.entries(groups).filter(([, g]) => g.collapsed === true).map(([gid]) => gid),
  );
  // 折叠组的成员（含 parentId 挂在成员下的子节点，随父一起隐藏）
  const hiddenNodeIds = new Set<string>();
  if (collapsedGids.size) {
    for (const node of nodes) {
      const gid = membership.get(node.id);
      if (gid && collapsedGids.has(gid)) hiddenNodeIds.add(node.id);
    }
    for (const node of nodes) {
      if (node.parentId && hiddenNodeIds.has(node.parentId)) hiddenNodeIds.add(node.id);
    }
  }

  const outNodes = nodes.map((node) => {
    if (node.data?.kind === 'editorGroupFrame') {
      const gid = parseGroupFrameNodeId(node.id) ?? '';
      const collapsed = collapsedGids.has(gid);
      return {
        ...node,
        style: collapsed
          ? { ...node.style, width: COLLAPSED_FRAME_W, height: COLLAPSED_FRAME_H }
          : node.style,
        zIndex: collapsed ? 0 : -20,
        data: { ...node.data, groupCollapsed: collapsed, groupMemberCount: counts.get(gid) ?? 0 },
      };
    }
    if (hiddenNodeIds.has(node.id)) return { ...node, hidden: true };
    return node;
  });

  if (!collapsedGids.size) return { nodes: outNodes, edges };

  const collapsedGidOfNode = (nodeId: string): string | null => {
    const gid = membership.get(nodeId);
    return gid && collapsedGids.has(gid) ? gid : null;
  };
  const outEdges = edges.map((edge) => {
    const sourceGid = collapsedGidOfNode(edge.source);
    const targetGid = collapsedGidOfNode(edge.target);
    if (!sourceGid && !targetGid) return edge;
    if (sourceGid && sourceGid === targetGid) return { ...edge, hidden: true };
    return {
      ...edge,
      source: sourceGid ? groupFrameNodeId(sourceGid) : edge.source,
      target: targetGid ? groupFrameNodeId(targetGid) : edge.target,
    };
  });
  return { nodes: outNodes, edges: outEdges };
}
