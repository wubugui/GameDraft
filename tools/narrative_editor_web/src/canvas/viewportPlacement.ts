import type { EditorPlacement } from '../editorModel';
import { stateEditorPosition } from '../editorModel';
import type { CompositionElementDef, NarrativeGraphDef } from '../types';
import { SUBGRAPH_CHILD_ORIGIN, computeSubgraphGroupBounds } from './subgraphGroupLayout';
import {
  ELEMENT_NODE_LAYOUT_HEIGHT,
  ELEMENT_NODE_LAYOUT_WIDTH,
  STATE_NODE_LAYOUT_HEIGHT,
  STATE_NODE_LAYOUT_WIDTH,
} from './transitionAnchorLayout';

/**
 * 「新建节点落在当前视口中央」的纯计算层。
 *
 * 画布是 @xyflow：store 里 `width/height` 是容器像素尺寸，`transform=[tx, ty, zoom]` 是
 * 当前平移/缩放。flow 坐标 ↔ 屏幕坐标：screen = flow * zoom + t。
 * 三类落点各有自己的坐标系（见各函数注释），这里统一把「视口中心（flow 坐标）」换算成
 * 对应对象的 meta.editor / element.x,y 该写的值；React 层只负责取 store、传结果。
 */

export type FlowPoint = { x: number; y: number };
export type FlowTransform = readonly [number, number, number];

/** 视口几何中心在 flow 坐标下的位置；容器尚未测量（0 尺寸）或 zoom 非法时返回 null，调用方回退默认落点。 */
export function viewportCenterInFlow(width: number, height: number, transform: FlowTransform): FlowPoint | null {
  const [tx, ty, zoom] = transform;
  if (!(width > 0) || !(height > 0) || !(zoom > 0)) return null;
  return { x: (width / 2 - tx) / zoom, y: (height / 2 - ty) / zoom };
}

/** 节点几何中心对准 center（node.position 是左上角，所以退半个布局尺寸）。 */
export function centerNodeAt(center: FlowPoint, size: { width: number; height: number }): FlowPoint {
  return {
    x: Math.round(center.x - size.width / 2),
    y: Math.round(center.y - size.height / 2),
  };
}

const STATE_SIZE = { width: STATE_NODE_LAYOUT_WIDTH, height: STATE_NODE_LAYOUT_HEIGHT };
const ELEMENT_SIZE = { width: ELEMENT_NODE_LAYOUT_WIDTH, height: ELEMENT_NODE_LAYOUT_HEIGHT };

/** 与已占位置重合时按阶梯错开，避免新节点整个盖在旧节点上、看起来像"没加出来"。 */
export function nudgeAwayFromOccupied(
  pos: FlowPoint,
  occupied: readonly FlowPoint[],
  step = 24,
  maxSteps = 20,
): FlowPoint {
  const taken = new Set(occupied.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  let out = { x: Math.round(pos.x), y: Math.round(pos.y) };
  for (let i = 0; i < maxSteps && taken.has(`${out.x},${out.y}`); i += 1) {
    out = { x: out.x + step, y: out.y + step };
  }
  return out;
}

/** 图内各状态当前的 meta.editor 坐标（缺省者按 buildGraphLayer 同一规则回退），供错开用。 */
export function occupiedStatePositions(graph: NarrativeGraphDef): FlowPoint[] {
  return Object.values(graph.states ?? {}).map((state, index) => stateEditorPosition(state, index));
}

export function occupiedElementPositions(elements: readonly CompositionElementDef[] | undefined): FlowPoint[] {
  return (elements ?? []).map((el) => ({ x: Number(el.x ?? 0), y: Number(el.y ?? 0) }));
}

/** 顶层状态（当前编辑图的直接状态）：node.position 就是 meta.editor，flow 坐标直接写。 */
export function placeTopLevelState(center: FlowPoint, graph: NarrativeGraphDef): EditorPlacement {
  return nudgeAwayFromOccupied(centerNodeAt(center, STATE_SIZE), occupiedStatePositions(graph));
}

/**
 * 展开子图内的状态：节点是 element 分组框的子节点，node.position 相对父节点；
 * meta.editor 再去掉 SUBGRAPH_CHILD_ORIGIN（与 onNodeDragStop 的写回互逆）。
 * 钳到 ≥0 —— 子节点跑到分组框左/上外侧不会被 boundsFromChildNodes 包进框里，
 * 视口中心落在框外时退到框内最近角落，仍是"离视口最近的合法位置"。
 */
export function placeInlineSubgraphState(
  center: FlowPoint,
  element: Pick<CompositionElementDef, 'x' | 'y'>,
  graph: NarrativeGraphDef,
): EditorPlacement {
  const abs = centerNodeAt(center, STATE_SIZE);
  const rel = {
    x: Math.max(0, abs.x - Number(element.x ?? 0) - SUBGRAPH_CHILD_ORIGIN.x),
    y: Math.max(0, abs.y - Number(element.y ?? 0) - SUBGRAPH_CHILD_ORIGIN.y),
  };
  return nudgeAwayFromOccupied(rel, occupiedStatePositions(graph));
}

/**
 * 编排元素（主图上的 wrapper / subgraph / blackbox 节点）：node.position 就是 element.x,y。
 * 带内嵌图且创建即展开的元素（wrapper / scenario）按展开后的分组框尺寸居中，否则按折叠节点尺寸；
 * `others` 是不含它自己的其余元素（错开用）。
 */
export function placeElement(
  center: FlowPoint,
  element: Pick<CompositionElementDef, 'graph'>,
  others: readonly CompositionElementDef[] | undefined,
  expanded: boolean,
): EditorPlacement {
  const size = expanded && element.graph ? computeSubgraphGroupBounds(element.graph) : ELEMENT_SIZE;
  return nudgeAwayFromOccupied(centerNodeAt(center, size), occupiedElementPositions(others));
}
