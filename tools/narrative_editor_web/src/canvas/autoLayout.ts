import dagre from '@dagrejs/dagre';
import { isSubgraphElement, setStateEditorPosition } from '../editorModel';
import { SUBGRAPH_CHILD_ORIGIN } from './subgraphGroupLayout';
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

export interface LayoutOptions {
  direction?: 'LR' | 'TB';
}

const LAYOUT_NODESEP = 60;
const LAYOUT_RANKSEP = 200;
const ELEMENT_ABOVE_OFFSET = 120;
const ELEMENT_STACK_GAP = 90;
const UNRELATED_ELEMENT_X_OFFSET = 300;

export function layoutComposition(
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
  options?: LayoutOptions,
): void {
  const direction = options?.direction ?? 'LR';

  layoutGraph(comp.mainGraph, direction);
  layoutElements(comp, direction);
  layoutExpandedSubgraphs(comp, expandedElementIds, direction);
}

export function layoutGraph(graph: NarrativeGraphDef, direction: 'LR' | 'TB' = 'LR'): void {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: LAYOUT_NODESEP, ranksep: LAYOUT_RANKSEP, marginx: 24, marginy: 24 });

  const stateIds = Object.keys(graph.states ?? {});

  for (const stateId of stateIds) {
    g.setNode(stateId, { width: STATE_NODE_LAYOUT_WIDTH, height: STATE_NODE_LAYOUT_HEIGHT });
  }

  const addedEdges = new Set<string>();
  for (const t of graph.transitions ?? []) {
    if (!t.from || !t.to) continue;
    const key = `${t.from}|${t.to}`;
    if (addedEdges.has(key)) continue;
    if (!graph.states[t.from] || !graph.states[t.to]) continue;
    addedEdges.add(key);
    g.setEdge(t.from, t.to);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const stateId of stateIds) {
    const node = g.node(stateId);
    if (node) {
      positions.set(stateId, {
        x: Math.round(node.x - STATE_NODE_LAYOUT_WIDTH / 2),
        y: Math.round(node.y - STATE_NODE_LAYOUT_HEIGHT / 2),
      });
    }
  }

  for (const [stateId, pos] of positions) {
    const state = graph.states[stateId];
    if (state) setStateEditorPosition(state, pos.x, pos.y);
  }
}

function layoutElements(comp: NarrativeCompositionDef, _direction: 'LR' | 'TB'): void {
  const elements = comp.elements ?? [];
  if (!elements.length) return;

  const mainPositions = new Map<string, { x: number; y: number }>();
  for (const [stateId, state] of Object.entries(comp.mainGraph.states ?? {})) {
    const editor = (state.meta?.editor ?? {}) as { x?: number; y?: number };
    const x = Number(editor.x ?? 0);
    const y = Number(editor.y ?? 0);
    if (x || y) mainPositions.set(stateId, { x, y });
  }

  const signalToFromState = new Map<string, string>();
  for (const t of comp.mainGraph.transitions ?? []) {
    if (t.signal && t.from) signalToFromState.set(t.signal, t.from);
  }

  const elementsByState = new Map<string, CompositionElementDef[]>();
  const unrelated: CompositionElementDef[] = [];

  for (const el of elements) {
    const meta = el.meta as ElementMetaDef | undefined;
    const relatedState = findRelatedState(el, meta, signalToFromState, mainPositions);

    if (relatedState && mainPositions.has(relatedState)) {
      const list = elementsByState.get(relatedState) ?? [];
      list.push(el);
      elementsByState.set(relatedState, list);
    } else {
      unrelated.push(el);
    }
  }

  for (const [stateId, elList] of elementsByState) {
    const basePos = mainPositions.get(stateId)!;
    for (let i = 0; i < elList.length; i++) {
      elList[i].x = Math.round(basePos.x);
      elList[i].y = Math.round(basePos.y - ELEMENT_ABOVE_OFFSET - i * ELEMENT_STACK_GAP);
    }
  }

  if (unrelated.length) {
    const maxMainX = mainPositions.size
      ? Math.max(...[...mainPositions.values()].map((p) => p.x))
      : 0;
    const baseX = maxMainX + STATE_NODE_LAYOUT_WIDTH + UNRELATED_ELEMENT_X_OFFSET;
    for (let i = 0; i < unrelated.length; i++) {
      unrelated[i].x = Math.round(baseX);
      unrelated[i].y = Math.round(60 + i * ELEMENT_STACK_GAP);
    }
  }
}

function findRelatedState(
  el: CompositionElementDef,
  meta: ElementMetaDef | undefined,
  signalToFromState: Map<string, string>,
  mainPositions: Map<string, { x: number; y: number }>,
): string | null {
  const emits = meta?.emits ?? [];
  for (const signal of emits) {
    const fromState = signalToFromState.get(signal);
    if (fromState && mainPositions.has(fromState)) return fromState;
  }

  const reads = meta?.reads ?? [];
  if (reads.length > 0 && mainPositions.size > 0) {
    const firstState = [...mainPositions.keys()][0];
    if (firstState) return firstState;
  }

  return null;
}

function layoutExpandedSubgraphs(
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
  direction: 'LR' | 'TB',
): void {
  for (const el of comp.elements ?? []) {
    if (!expandedElementIds.includes(el.id)) continue;
    if (!isSubgraphElement(el) || !el.graph) continue;

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: direction, nodesep: LAYOUT_NODESEP, ranksep: LAYOUT_RANKSEP, marginx: 12, marginy: 12 });

    const stateIds = Object.keys(el.graph.states ?? {});
    for (const stateId of stateIds) {
      g.setNode(stateId, { width: STATE_NODE_LAYOUT_WIDTH, height: STATE_NODE_LAYOUT_HEIGHT });
    }

    const addedEdges = new Set<string>();
    for (const t of el.graph.transitions ?? []) {
      if (!t.from || !t.to) continue;
      const key = `${t.from}|${t.to}`;
      if (addedEdges.has(key)) continue;
      if (!el.graph.states[t.from] || !el.graph.states[t.to]) continue;
      addedEdges.add(key);
      g.setEdge(t.from, t.to);
    }

    dagre.layout(g);

    for (const stateId of stateIds) {
      const node = g.node(stateId);
      if (!node) continue;
      const state = el.graph.states[stateId];
      if (!state) continue;
      setStateEditorPosition(
        state,
        Math.round(node.x - STATE_NODE_LAYOUT_WIDTH / 2),
        Math.round(node.y - STATE_NODE_LAYOUT_HEIGHT / 2),
      );
    }
  }
}
