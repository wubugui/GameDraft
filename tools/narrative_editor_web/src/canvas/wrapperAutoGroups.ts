/**
 * wrapper 自动分组（画布呈现层，**不写任何数据**）。
 *
 * 存在的理由：私有信号让「100 个箱子共用一个信号名 + 一张发射端对话图」成立之后，
 * 画布上就会摊开 100 张同构 wrapper 图——**「能创建」和「能看」同等重要**，
 * 铺开就是把主线连同一切淹掉。
 *
 * 与 `editorGroups.ts`（手动分组框）的分工，两套不能互相取代：
 * - 手动分组框：作者自己圈的矩形，成员按**几何**判定，位置/颜色/折叠态落 editor_data 固化。
 * - 本模块：成员按**数据**判定（owner 场景 / 同款模板），不落盘、不需要作者维护，
 *   盖章新增一个箱子就自动进组。几何只用来算框在哪，永远现算。
 *
 * 硬约束（踩过的坑，见 agent_docs editor-tools/mechanisms/narrative-state-editor 契约 8）：
 * - 分组框是**非四向端口**节点（`wrapperGroupFrame` 不在 FOUR_WAY_PORT_NODE_TYPES 里），
 *   连到它的边绝不能写 handle id，否则 error008 整条边不渲染；
 * - 折叠瞬间尺寸以 `style` 为准而非 `measured`（`nodeLayoutSize` 已按框类节点处理）。
 */
import { nodeLayoutSize } from './transitionAnchorLayout';
import type {
  AuthoringCatalogDef,
  CanvasEdge,
  CanvasNode,
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  ValidationTargetDef,
} from '../types';

/** 自动分组口径：不分组 / 按 owner 场景 / 按同款模板（同构拓扑）。 */
export type WrapperGroupMode = 'off' | 'scene' | 'shape';

export const WRAPPER_GROUP_MODE_OPTIONS: Array<{ id: WrapperGroupMode; label: string; hint: string }> = [
  { id: 'off', label: '不分组', hint: '每张 wrapper 图各占一个节点（图少时最直观）' },
  {
    id: 'scene',
    label: '按 owner 场景',
    hint: '同一场景里的实体 wrapper 收成一组：改哪张场景就展开哪一组',
  },
  {
    id: 'shape',
    label: '按同款模板',
    hint: '拓扑一模一样的 wrapper 收成一组（模板盖章出来的 100 个箱子就是同一款）',
  },
];

export const WRAPPER_GROUP_NODE_ID_PREFIX = 'wrapper-group:';

/** 成员少于这个数不成组：把 1 张图包进一个组框，只是多一层壳。 */
export const MIN_GROUP_MEMBERS = 2;

const GROUP_FRAME_PADDING = 28;
const GROUP_HEADER_HEIGHT = 34;
export const COLLAPSED_GROUP_W = 220;
export const COLLAPSED_GROUP_H = 72;

export interface WrapperGroup {
  /** 稳定 key（含口径前缀，换口径不会撞车）。 */
  key: string;
  label: string;
  /** 副标题：这一组是怎么来的（场景名 / 拓扑规模） */
  detail: string;
  elementIds: string[];
}

export function wrapperGroupNodeId(key: string): string {
  return `${WRAPPER_GROUP_NODE_ID_PREFIX}${key}`;
}

export function parseWrapperGroupNodeId(nodeId: string): string | null {
  return nodeId.startsWith(WRAPPER_GROUP_NODE_ID_PREFIX)
    ? nodeId.slice(WRAPPER_GROUP_NODE_ID_PREFIX.length)
    : null;
}

function elementNodeId(elementId: string): string {
  return `element:${elementId}`;
}

/**
 * 「这张图长什么样」的完整指纹：**含信号名与动作类型**，只有真正一模一样的图才相等。
 *
 * 用在校验告警聚合上，故意取严：聚合的前提是「这 N 条报的是同一个问题」，
 * 指纹放松一格就会把两类不同的毛病合并成一条，比刷屏更糟。
 * 状态按插入序编号（盖章产物的插入序一致），转移排序后比较（数组序不该影响同构判定）。
 */
export function graphShapeFingerprint(graph: NarrativeGraphDef): string {
  const stateIds = Object.keys(graph.states ?? {});
  const indexOf = new Map(stateIds.map((id, i) => [id, i]));
  const states = stateIds.map((id) => {
    const s = graph.states?.[id];
    return [
      s?.broadcastOnEnter === true ? '1' : '0',
      String(s?.activePlane ?? ''),
      (s?.onEnterActions ?? []).map((a) => a?.type ?? '').join(','),
      (s?.onExitActions ?? []).map((a) => a?.type ?? '').join(','),
    ].join('|');
  });
  const transitions = (graph.transitions ?? []).map((t) => [
    indexOf.get(String(t?.from)) ?? -1,
    indexOf.get(String(t?.to)) ?? -1,
    t?.trigger ?? 'signal',
    String(t?.signal ?? ''),
    (t?.conditions ?? []).length,
  ].join('|')).sort();
  return JSON.stringify({
    init: indexOf.get(String(graph.initialState)) ?? -1,
    states,
    transitions,
  });
}

/**
 * 「拓扑同款」指纹：只看状态数与转移的连法，**不看信号名、不看动作**。
 *
 * 分组用它而不用完整指纹：模板盖章后作者常给每个实例换一条信号名或补一个动作，
 * 那些实例在视觉上仍是同一款，硬按完整指纹分会碎成一堆单元素组（等于没分）。
 */
export function graphTopologyFingerprint(graph: NarrativeGraphDef): string {
  const stateIds = Object.keys(graph.states ?? {});
  const indexOf = new Map(stateIds.map((id, i) => [id, i]));
  const transitions = (graph.transitions ?? []).map((t) => [
    indexOf.get(String(t?.from)) ?? -1,
    indexOf.get(String(t?.to)) ?? -1,
    t?.trigger ?? 'signal',
  ].join('|')).sort();
  return JSON.stringify({ n: stateIds.length, init: indexOf.get(String(graph.initialState)) ?? -1, transitions });
}

/**
 * 这个 wrapper 属于哪张场景。
 *
 * npc/hotspot/zone 的 ownerId 写的是**裸实体 id**（运行时按裸 id 查 wrapper owner，
 * 见 narrative_state_editor 的 add_reference 注释），场景要靠目录里的 `qualifiedId`
 * （`场景:实体`）反查；目录取不到（纯 web 调试态 / 该实体已删）时如实返回空，
 * 绝不猜一个场景出来。
 */
export function resolveOwnerScene(el: CompositionElementDef, catalog: AuthoringCatalogDef): string {
  const ownerType = (el.ownerType ?? '').trim();
  const ownerId = (el.ownerId ?? '').trim();
  if (!ownerId) return '';
  if (ownerType === 'scene') return ownerId;
  if (ownerId.includes(':')) return ownerId.slice(0, ownerId.indexOf(':'));
  const entry = (catalog.referenceEntries ?? []).find(
    (row) => row.kind === ownerType && (row.id === ownerId || (row.aliases ?? []).includes(ownerId)),
  );
  const qualified = (entry?.qualifiedId ?? '').trim();
  return qualified.includes(':') ? qualified.slice(0, qualified.indexOf(':')) : '';
}

function sceneLabel(sceneId: string, catalog: AuthoringCatalogDef): string {
  const entry = (catalog.referenceEntries ?? []).find((row) => row.kind === 'scene' && row.id === sceneId);
  const label = (entry?.label ?? '').trim();
  return label && label !== sceneId ? `${label}（${sceneId}）` : sceneId;
}

/** 只有实体包装图参与自动分组：黑盒没有图、scenario 子图是一张张手写的，不是盖章产物。 */
export function isGroupableWrapper(el: CompositionElementDef): boolean {
  return el.kind === 'wrapperGraph' && Boolean(el.graph);
}

/**
 * 按口径把本编排的 wrapper 元素分组。
 * 少于 MIN_GROUP_MEMBERS 的桶直接丢弃（不成组 = 元素照常单独显示）。
 */
export function computeWrapperGroups(
  comp: NarrativeCompositionDef | undefined,
  mode: WrapperGroupMode,
  catalog: AuthoringCatalogDef,
): WrapperGroup[] {
  if (!comp || mode === 'off') return [];
  const buckets = new Map<string, { label: string; detail: string; elementIds: string[] }>();

  for (const el of comp.elements ?? []) {
    if (!isGroupableWrapper(el)) continue;
    const graph = el.graph!;
    let key = '';
    let label = '';
    let detail = '';
    if (mode === 'scene') {
      const scene = resolveOwnerScene(el, catalog);
      if (!scene) continue; // 场景查不出来的（flow/quest/scenario owner）不硬塞进"未知"桶
      key = `scene:${scene}`;
      label = sceneLabel(scene, catalog);
      detail = '同一场景的实体包装';
    } else {
      const fingerprint = graphTopologyFingerprint(graph);
      key = `shape:${fingerprint}`;
      const category = (graph.category ?? '').trim();
      const stateCount = Object.keys(graph.states ?? {}).length;
      label = category || `${stateCount} 态 wrapper 同款`;
      detail = `${stateCount} 态 / ${(graph.transitions ?? []).length} 转移，拓扑一致`;
    }
    const bucket = buckets.get(key) ?? { label, detail, elementIds: [] };
    bucket.elementIds.push(el.id);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .filter(([, b]) => b.elementIds.length >= MIN_GROUP_MEMBERS)
    .map(([key, b]) => ({ key, label: b.label, detail: b.detail, elementIds: b.elementIds }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

interface Rect { x: number; y: number; width: number; height: number }

function boundsOf(nodes: CanvasNode[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const size = nodeLayoutSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface WrapperGroupDisplayInput {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: WrapperGroup[];
  /** 展开的组 key。**记展开而不是记折叠**：新盖章出来的组默认就是折叠的。 */
  expandedKeys: ReadonlySet<string>;
  /** 组内成员各自的校验问题数（elementId → 条数）；折叠态靠它显示「组里有没有事」。 */
  issueCountByElementId?: ReadonlyMap<string, number>;
}

/**
 * 折叠/成框呈现变换（**只作用于 display 拷贝**，nodes/edges 状态与 narrative_graphs.json 分毫不动）。
 *
 * 折叠：成员及其子节点整体隐藏、组内连线隐藏、跨组连线改接到组节点；组节点缩成紧凑块。
 * 展开：只在成员外圈画一个垫底的框（zIndex 更低于手动分组框），成员照常可见可编辑。
 */
export function applyWrapperGroupDisplay(
  input: WrapperGroupDisplayInput,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const { nodes, edges, groups, expandedKeys } = input;
  if (!groups.length) return { nodes, edges };

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const groupOfNode = new Map<string, string>();
  const frameNodes: CanvasNode[] = [];
  const collapsedKeys = new Set<string>();
  const hiddenNodeIds = new Set<string>();

  for (const group of groups) {
    const memberNodes = group.elementIds
      .map((eid) => nodeById.get(elementNodeId(eid)))
      .filter((n): n is CanvasNode => Boolean(n));
    if (memberNodes.length < MIN_GROUP_MEMBERS) continue;

    const collapsed = !expandedKeys.has(group.key);
    if (collapsed) collapsedKeys.add(group.key);
    for (const node of memberNodes) groupOfNode.set(node.id, group.key);

    const bounds = boundsOf(memberNodes);
    if (!bounds) continue;
    const issueCount = group.elementIds.reduce(
      (sum, eid) => sum + (input.issueCountByElementId?.get(eid) ?? 0), 0,
    );

    frameNodes.push({
      id: wrapperGroupNodeId(group.key),
      type: 'wrapperGroupFrame',
      position: collapsed
        ? { x: bounds.x, y: bounds.y }
        : { x: bounds.x - GROUP_FRAME_PADDING, y: bounds.y - GROUP_FRAME_PADDING - GROUP_HEADER_HEIGHT },
      style: collapsed
        ? { width: COLLAPSED_GROUP_W, height: COLLAPSED_GROUP_H }
        : {
          width: bounds.width + GROUP_FRAME_PADDING * 2,
          height: bounds.height + GROUP_FRAME_PADDING * 2 + GROUP_HEADER_HEIGHT,
        },
      // 折叠态是真节点（要能被连线指到）；展开态垫在最底下，别挡住成员
      zIndex: collapsed ? 15 : -30,
      draggable: false,
      selectable: false,
      deletable: false,
      data: {
        label: group.label,
        subtitle: group.detail,
        kind: 'wrapperGroupFrame' as const,
        detail: group.key,
        groupCollapsed: collapsed,
        groupMemberCount: memberNodes.length,
        groupIssueCount: issueCount,
      },
    });

    if (collapsed) {
      for (const node of memberNodes) hiddenNodeIds.add(node.id);
    }
  }

  if (!frameNodes.length) return { nodes, edges };

  // 折叠成员的内嵌子节点（展开子图时的状态节点挂在成员下）跟着父一起藏
  if (hiddenNodeIds.size) {
    for (const node of nodes) {
      if (node.parentId && hiddenNodeIds.has(node.parentId)) hiddenNodeIds.add(node.id);
    }
  }

  const outNodes: CanvasNode[] = nodes.map((node) => (
    hiddenNodeIds.has(node.id) ? { ...node, hidden: true } : node
  ));
  outNodes.push(...frameNodes);

  if (!collapsedKeys.size) return { nodes: outNodes, edges };

  const collapsedGroupOf = (nodeId: string): string | null => {
    const key = groupOfNode.get(nodeId);
    if (key && collapsedKeys.has(key)) return key;
    // 折叠成员的子节点（内嵌状态）：连线也要改接到组节点，否则边指向隐藏节点等于凭空消失
    const parentId = nodeById.get(nodeId)?.parentId;
    if (!parentId) return null;
    const parentKey = groupOfNode.get(parentId);
    return parentKey && collapsedKeys.has(parentKey) ? parentKey : null;
  };

  const outEdges = edges.map((edge) => {
    const sourceKey = collapsedGroupOf(edge.source);
    const targetKey = collapsedGroupOf(edge.target);
    if (!sourceKey && !targetKey) return edge;
    if (sourceKey && sourceKey === targetKey) return { ...edge, hidden: true };
    return {
      ...edge,
      source: sourceKey ? wrapperGroupNodeId(sourceKey) : edge.source,
      target: targetKey ? wrapperGroupNodeId(targetKey) : edge.target,
    };
  });

  return { nodes: outNodes, edges: outEdges };
}

/**
 * 校验问题落到哪个元素上（折叠组的「有没有事」徽章靠它）。
 * target 直接带 elementId 的最准；只带 graphId 的按 element.graph.id 反查。
 */
export function countIssuesByElement(
  comp: NarrativeCompositionDef | undefined,
  issues: ReadonlyArray<{ target?: ValidationTargetDef }>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!comp) return out;
  const elementByGraphId = new Map<string, string>();
  for (const el of comp.elements ?? []) {
    if (el.graph?.id) elementByGraphId.set(el.graph.id, el.id);
  }
  for (const issue of issues) {
    const target = issue.target;
    // signal 目标没有编排落点（它不长在任何一张图上），本来就轮不到分组徽章
    if (!target || target.kind === 'signal') continue;
    if (target.compositionId !== comp.id) continue;
    const graphId = 'graphId' in target ? target.graphId : undefined;
    const elementId = ('elementId' in target ? target.elementId : undefined)
      || (graphId ? elementByGraphId.get(graphId) : undefined);
    if (!elementId) continue;
    out.set(elementId, (out.get(elementId) ?? 0) + 1);
  }
  return out;
}
