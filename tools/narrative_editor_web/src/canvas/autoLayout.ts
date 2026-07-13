import dagre from '@dagrejs/dagre';
import { isSubgraphElement, setStateEditorPosition } from '../editorModel';
import { computeSubgraphGroupBounds } from './subgraphGroupLayout';
import {
  STATE_NODE_LAYOUT_WIDTH,
  STATE_NODE_LAYOUT_HEIGHT,
  ELEMENT_NODE_LAYOUT_WIDTH,
  ELEMENT_NODE_LAYOUT_HEIGHT,
} from './transitionAnchorLayout';
import type {
  NarrativeCompositionDef,
  NarrativeGraphDef,
  CompositionElementDef,
  ElementMetaDef,
} from '../types';

/**
 * 自动布局：**只算坐标**，产出写进既有的编辑器专用位置字段（state.meta.editor.x/y、element.x/y）。
 * 这些字段运行时完全忽略（src/ 从不读 meta.editor），因此换算法零运行时影响、不改任何数据语义。
 *
 * 引擎换成 ELK 的 `layered`（Sugiyama 进阶版，KIELER/ELK 正是做状态机自动布局的工程级实现）：
 * 相比原 dagre，它能可控地断环、最小化交叉、给迁移标签留位、按连通性摆放子图元素——正好治
 * 「有环状态机被排得乱七八糟」的病。ELK 是异步的，所以对外拆成 `computeXxx`(async 只算) +
 * `applyXxx`(sync 写回) 两步：先算好一份纯坐标 plan，再在调用方的 updateData 里同步写入，保持
 * 原有脏态/撤销流程不变。ELK 万一抛错则回退到 dagre，按钮永不失效。
 *
 * ELK 只在编辑器网页里 **动态 import**，不会进 src/ 游戏运行时 bundle。
 */

export type LayoutDirection = 'LR' | 'TB';

export interface LayoutOptions {
  direction?: LayoutDirection;
}

export type LayoutPositions = Map<string, { x: number; y: number }>;

export interface CompositionLayoutPlan {
  /** 主图状态（画布绝对坐标） */
  states: LayoutPositions;
  /** 元素节点（画布绝对坐标） */
  elements: LayoutPositions;
  /** 展开的子图 elementId → 其内部状态（父相对前的布局本地坐标） */
  subgraphs: Map<string, LayoutPositions>;
}

// --------------------------------------------------------------------------- //
// ELK 引擎（惰性动态 import，编辑器专用，绝不进运行时 bundle）
// --------------------------------------------------------------------------- //
type ElkLabel = { text?: string; width?: number; height?: number };
type ElkEdge = { id: string; sources: string[]; targets: string[]; labels?: ElkLabel[] };
type ElkGraphNode = {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkGraphNode[];
  edges?: ElkEdge[];
  layoutOptions?: Record<string, string>;
};
type ElkEngine = { layout(graph: ElkGraphNode): Promise<ElkGraphNode> };

let elkPromise: Promise<ElkEngine> | null = null;
async function getElk(): Promise<ElkEngine> {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((mod) => {
      const ElkClass = (mod as unknown as { default: new () => ElkEngine }).default;
      return new ElkClass();
    });
  }
  return elkPromise;
}

function baseLayoutOptions(direction: LayoutDirection): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction === 'TB' ? 'DOWN' : 'RIGHT',
    // 紧凑但不拥挤：层间 90（原 dagre ranksep 200 太散），同层 48。
    'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    'elk.spacing.nodeNode': '48',
    // 断环：GREEDY 反转最少的边，避免长回边横穿全图（原 dagre 任意断环的元凶）。
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    // 断开的元素/子机各自成块整齐并排，不再糊成一坨。
    'elk.separateConnectedComponents': 'true',
    'elk.spacing.componentComponent': '56',
    // 给迁移标签留出走线空间，标签不再压节点。
    'elk.spacing.edgeLabel': '8',
  };
}

function estimateLabelWidth(text: string): number {
  // 中英文混排的粗略估宽，够 ELK 预留层间空间即可。
  return Math.min(Math.max(text.length * 9, 24), 180);
}

function buildStateEdges(graph: NarrativeGraphDef, idOf: (stateId: string) => string): ElkEdge[] {
  const edges: ElkEdge[] = [];
  const seen = new Set<string>();
  for (const t of graph.transitions ?? []) {
    if (!t.from || !t.to) continue;
    if (!graph.states[t.from] || !graph.states[t.to]) continue;
    const key = `${t.from}|${t.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String(t.signal ?? '').trim();
    edges.push({
      id: `e${edges.length}`,
      sources: [idOf(t.from)],
      targets: [idOf(t.to)],
      labels: label ? [{ text: label, width: estimateLabelWidth(label), height: 16 }] : undefined,
    });
  }
  return edges;
}

async function elkLayoutStates(
  graph: NarrativeGraphDef,
  direction: LayoutDirection,
): Promise<LayoutPositions> {
  const stateIds = Object.keys(graph.states ?? {});
  const children: ElkGraphNode[] = stateIds.map((id) => ({
    id,
    width: STATE_NODE_LAYOUT_WIDTH,
    height: STATE_NODE_LAYOUT_HEIGHT,
  }));
  const edges = buildStateEdges(graph, (id) => id);
  const elk = await getElk();
  const result = await elk.layout({
    id: 'root',
    layoutOptions: baseLayoutOptions(direction),
    children,
    edges,
  });
  const positions: LayoutPositions = new Map();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) });
  }
  return positions;
}

// --------------------------------------------------------------------------- //
// dagre 兜底（ELK 异常时保按钮不失效；纯算坐标，输出与 ELK 同形）
// --------------------------------------------------------------------------- //
function dagreLayoutStates(graph: NarrativeGraphDef, direction: LayoutDirection): LayoutPositions {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 120, marginx: 24, marginy: 24 });
  const stateIds = Object.keys(graph.states ?? {});
  for (const id of stateIds) {
    g.setNode(id, { width: STATE_NODE_LAYOUT_WIDTH, height: STATE_NODE_LAYOUT_HEIGHT });
  }
  const seen = new Set<string>();
  for (const t of graph.transitions ?? []) {
    if (!t.from || !t.to) continue;
    if (!graph.states[t.from] || !graph.states[t.to]) continue;
    const key = `${t.from}|${t.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    g.setEdge(t.from, t.to);
  }
  dagre.layout(g);
  const positions: LayoutPositions = new Map();
  for (const id of stateIds) {
    const node = g.node(id);
    if (node) {
      positions.set(id, {
        x: Math.round(node.x - STATE_NODE_LAYOUT_WIDTH / 2),
        y: Math.round(node.y - STATE_NODE_LAYOUT_HEIGHT / 2),
      });
    }
  }
  return positions;
}

// --------------------------------------------------------------------------- //
// 对外：compute（async 只算） + apply（sync 写回既有位置字段）
// --------------------------------------------------------------------------- //
export async function computeGraphLayout(
  graph: NarrativeGraphDef,
  options?: LayoutOptions,
): Promise<LayoutPositions> {
  const direction = options?.direction ?? 'LR';
  try {
    return await elkLayoutStates(graph, direction);
  } catch (err) {
    console.warn('[autoLayout] ELK failed, falling back to dagre', err);
    return dagreLayoutStates(graph, direction);
  }
}

function relatedStateForElement(
  el: CompositionElementDef,
  signalToFromState: Map<string, string>,
  states: Record<string, unknown>,
): string | null {
  const meta = el.meta as ElementMetaDef | undefined;
  for (const signal of meta?.emits ?? []) {
    const from = signalToFromState.get(signal);
    if (from && states[from]) return from;
  }
  // 只 reads 的元素：按信号名匹配到监听它的迁移的 from 态；匹配不到就留作断开节点，
  // 让 ELK 把它整齐并排（而非旧实现无脑全堆到「第一个状态」头顶互相重叠）。
  for (const signal of meta?.reads ?? []) {
    const from = signalToFromState.get(signal);
    if (from && states[from]) return from;
  }
  return null;
}

export async function computeCompositionLayout(
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
  options?: LayoutOptions,
): Promise<CompositionLayoutPlan> {
  const direction = options?.direction ?? 'LR';
  const main = comp.mainGraph;
  const elements = comp.elements ?? [];
  const stateIds = Object.keys(main.states ?? {});

  const children: ElkGraphNode[] = [];
  for (const id of stateIds) {
    children.push({ id: `s:${id}`, width: STATE_NODE_LAYOUT_WIDTH, height: STATE_NODE_LAYOUT_HEIGHT });
  }
  for (const el of elements) {
    let width = ELEMENT_NODE_LAYOUT_WIDTH;
    let height = ELEMENT_NODE_LAYOUT_HEIGHT;
    // 展开的子图占位为其分组框尺寸，ELK 才能给整块预留空间、不与别的东西压叠。
    if (isSubgraphElement(el) && el.graph && expandedElementIds.includes(el.id)) {
      const bounds = computeSubgraphGroupBounds(el.graph);
      width = bounds.width;
      height = bounds.height;
    }
    children.push({ id: `el:${el.id}`, width, height });
  }

  const edges = buildStateEdges(main, (id) => `s:${id}`);
  const signalToFromState = new Map<string, string>();
  for (const t of main.transitions ?? []) {
    if (t.signal && t.from) signalToFromState.set(t.signal, t.from);
  }
  for (const el of elements) {
    const related = relatedStateForElement(el, signalToFromState, main.states ?? {});
    if (related) {
      edges.push({ id: `x${edges.length}`, sources: [`el:${el.id}`], targets: [`s:${related}`] });
    }
  }

  const states: LayoutPositions = new Map();
  const elementPositions: LayoutPositions = new Map();
  try {
    const elk = await getElk();
    const result = await elk.layout({
      id: 'root',
      layoutOptions: baseLayoutOptions(direction),
      children,
      edges,
    });
    for (const child of result.children ?? []) {
      const pos = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) };
      if (child.id.startsWith('s:')) states.set(child.id.slice(2), pos);
      else if (child.id.startsWith('el:')) elementPositions.set(child.id.slice(3), pos);
    }
  } catch (err) {
    console.warn('[autoLayout] ELK composition layout failed, falling back to dagre', err);
    const dagrePositions = dagreLayoutStates(main, direction);
    for (const [id, pos] of dagrePositions) states.set(id, pos);
    // 兜底：元素退回主图右侧一列（比不摆好），只在 ELK 完全不可用时才走到这。
    const maxX = states.size ? Math.max(...[...states.values()].map((p) => p.x)) : 0;
    let i = 0;
    for (const el of elements) {
      elementPositions.set(el.id, { x: maxX + STATE_NODE_LAYOUT_WIDTH + 300, y: 60 + i * 90 });
      i += 1;
    }
  }

  const subgraphs = new Map<string, LayoutPositions>();
  for (const el of elements) {
    if (isSubgraphElement(el) && el.graph && expandedElementIds.includes(el.id)) {
      subgraphs.set(el.id, await computeGraphLayout(el.graph, { direction }));
    }
  }

  return { states, elements: elementPositions, subgraphs };
}

/** 写回：把算好的坐标同步写进既有位置字段（不碰任何其它键/数据）。 */
export function applyGraphLayout(graph: NarrativeGraphDef, positions: LayoutPositions): void {
  for (const [id, pos] of positions) {
    const state = graph.states?.[id];
    if (state) setStateEditorPosition(state, pos.x, pos.y);
  }
}

export function applyCompositionLayout(
  comp: NarrativeCompositionDef,
  plan: CompositionLayoutPlan,
): void {
  for (const [id, pos] of plan.states) {
    const state = comp.mainGraph.states?.[id];
    if (state) setStateEditorPosition(state, pos.x, pos.y);
  }
  for (const el of comp.elements ?? []) {
    const pos = plan.elements.get(el.id);
    if (pos) {
      el.x = pos.x;
      el.y = pos.y;
    }
  }
  for (const [elementId, positions] of plan.subgraphs) {
    const el = comp.elements?.find((e) => e.id === elementId);
    if (el?.graph) applyGraphLayout(el.graph, positions);
  }
}
