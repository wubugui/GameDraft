import { transitionAnchorId } from './anchorCodec';
import type {
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  NarrativeGraphsFileDef,
  NarrativeTransitionDef,
  ValidationIssueDef,
  ValidationTargetDef,
} from './types';

export type GraphRef = 'main' | `element:${string}`;

export type FocusIssueContext = {
  compositionId: string;
  setCompositionId: (id: string) => void;
  setGraphRef: (ref: GraphRef) => void;
  setExpandedElementIds: (fn: (ids: string[]) => string[]) => void;
  setSelectedId: (id: string) => void;
};

export type FocusIssueResult = {
  compositionId: string;
  graphRef: GraphRef;
  selectedId: string;
  nodeIds: string[];
  collapseExpandedElementId?: string;
};

function isSubgraphElement(el: CompositionElementDef | undefined): boolean {
  return Boolean(el?.graph && (el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph'));
}

export function pickFocusFitNodeIds(nodeIds: string[]): string[] {
  return nodeIds.filter((id) => (
    id.startsWith('transition-anchor:')
    || id.startsWith('state:')
    || id.startsWith('element:')
    || id.startsWith('graph:')
  ));
}

type GraphOwner = {
  graph: NarrativeGraphDef;
  element?: CompositionElementDef;
};

function subgraphGraphRef(element: CompositionElementDef): GraphRef {
  return `element:${element.id}`;
}

function findGraphOwner(comp: NarrativeCompositionDef, graphId: string): GraphOwner | null {
  if (comp.mainGraph.id === graphId) return { graph: comp.mainGraph };
  for (const el of comp.elements ?? []) {
    if (el.graph?.id === graphId) return { graph: el.graph, element: el };
  }
  return null;
}

function parseGraphScopedItemId(itemId: string): null | { graphId: string; localId: string } {
  const dot = itemId.indexOf('.');
  if (dot <= 0 || dot >= itemId.length - 1) return null;
  return { graphId: itemId.slice(0, dot), localId: itemId.slice(dot + 1) };
}

function transitionFocusNodeIds(graph: NarrativeGraphDef, transition: NarrativeTransitionDef): string[] {
  const toState = transition.to ? String(transition.to) : '';
  return [
    transitionAnchorId(graph.id, transition.id),
    `state:${transition.from}`,
    ...(toState ? [`state:${toState}`] : []),
  ];
}

function resolveTransitionFocus(
  comp: NarrativeCompositionDef,
  owner: GraphOwner,
  transition: NarrativeTransitionDef,
): FocusIssueResult {
  const nodeIds = transitionFocusNodeIds(owner.graph, transition);
  if (owner.element && isSubgraphElement(owner.element)) {
    return {
      compositionId: comp.id,
      graphRef: subgraphGraphRef(owner.element),
      selectedId: `transition:${transition.id}`,
      nodeIds,
      collapseExpandedElementId: owner.element.id,
    };
  }
  return {
    compositionId: comp.id,
    graphRef: 'main',
    selectedId: `transition:${transition.id}`,
    nodeIds,
  };
}

function resolveStateFocus(
  comp: NarrativeCompositionDef,
  owner: GraphOwner,
  stateId: string,
): FocusIssueResult {
  const nodeIds = [`state:${stateId}`];
  if (owner.element && isSubgraphElement(owner.element)) {
    return {
      compositionId: comp.id,
      graphRef: subgraphGraphRef(owner.element),
      selectedId: `state:${stateId}`,
      nodeIds,
      collapseExpandedElementId: owner.element.id,
    };
  }
  return {
    compositionId: comp.id,
    graphRef: 'main',
    selectedId: `state:${stateId}`,
    nodeIds,
  };
}

function resolveElementFocus(comp: NarrativeCompositionDef, el: CompositionElementDef): FocusIssueResult {
  return {
    compositionId: comp.id,
    graphRef: 'main',
    selectedId: `element:${el.id}`,
    nodeIds: [`element:${el.id}`],
  };
}

function resolveSubgraphGraphFocus(comp: NarrativeCompositionDef, el: CompositionElementDef): FocusIssueResult {
  const graphId = el.graph?.id ?? el.id;
  return {
    compositionId: comp.id,
    graphRef: subgraphGraphRef(el),
    selectedId: `graph:${graphId}`,
    nodeIds: [`graph:${graphId}`],
    collapseExpandedElementId: el.id,
  };
}

function resolveMainGraphFocus(comp: NarrativeCompositionDef): FocusIssueResult {
  return {
    compositionId: comp.id,
    graphRef: 'main',
    selectedId: `graph:${comp.mainGraph.id}`,
    nodeIds: [`graph:${comp.mainGraph.id}`],
  };
}

function graphOwnerFromTarget(data: NarrativeGraphsFileDef, target: Extract<ValidationTargetDef, { graphId: string }>): null | {
  comp: NarrativeCompositionDef;
  owner: GraphOwner;
} {
  const comp = (data.compositions ?? []).find((item) => item.id === target.compositionId);
  if (!comp) return null;
  if (target.elementId) {
    const element = (comp.elements ?? []).find((item) => item.id === target.elementId);
    if (!element?.graph || element.graph.id !== target.graphId) return null;
    return { comp, owner: { graph: element.graph, element } };
  }
  if (comp.mainGraph.id === target.graphId) {
    return { comp, owner: { graph: comp.mainGraph } };
  }
  const owner = findGraphOwner(comp, target.graphId);
  return owner ? { comp, owner } : null;
}

function resolveTargetFocus(target: ValidationTargetDef | undefined, data: NarrativeGraphsFileDef): FocusIssueResult | null {
  if (!target) return null;
  if (target.kind === 'signal') return null;
  const comp = (data.compositions ?? []).find((item) => item.id === target.compositionId);
  if (!comp) return null;
  if (target.kind === 'composition') return resolveMainGraphFocus(comp);
  if (target.kind === 'element') {
    const element = (comp.elements ?? []).find((item) => item.id === target.elementId);
    return element ? resolveElementFocus(comp, element) : null;
  }
  const scoped = graphOwnerFromTarget(data, target);
  if (!scoped) return null;
  if (target.kind === 'graph') {
    if (scoped.owner.element && isSubgraphElement(scoped.owner.element)) {
      return resolveSubgraphGraphFocus(scoped.comp, scoped.owner.element);
    }
    return resolveMainGraphFocus(scoped.comp);
  }
  if (target.kind === 'state') {
    return scoped.owner.graph.states?.[target.stateId]
      ? resolveStateFocus(scoped.comp, scoped.owner, target.stateId)
      : null;
  }
  const transition = scoped.owner.graph.transitions?.find((item) => item.id === target.transitionId);
  return transition ? resolveTransitionFocus(scoped.comp, scoped.owner, transition) : null;
}

function issueTargetMatchesActiveGraph(target: ValidationTargetDef, graphRef: GraphRef): boolean {
  if (graphRef === 'main') {
    if (target.kind === 'composition' || target.kind === 'element') return true;
    if (target.kind === 'graph' || target.kind === 'state' || target.kind === 'transition') {
      return !target.elementId;
    }
    return false;
  }

  const activeElementId = graphRef.slice('element:'.length);
  if (target.kind === 'composition') return false;
  if (target.kind === 'element') return target.elementId === activeElementId;
  if (target.kind === 'graph' || target.kind === 'state' || target.kind === 'transition') {
    return target.elementId === activeElementId;
  }
  return false;
}

function resolveIssueGraphScopeFromPath(
  path: string,
  data: NarrativeGraphsFileDef,
): { compositionId: string; elementId?: string; isCompositionRoot?: boolean } | null {
  const compIndexMatch = /^compositions\[(\d+)\]/.exec(path);
  if (!compIndexMatch) return null;
  const comp = (data.compositions ?? [])[Number(compIndexMatch[1])];
  if (!comp) return null;

  if (/^compositions\[\d+\]\.id\b/.test(path)) {
    return { compositionId: comp.id, isCompositionRoot: true };
  }

  const elementGraphMatch = /^compositions\[\d+\]\.elements\[(\d+)\]\.graph/.exec(path);
  if (elementGraphMatch) {
    const el = comp.elements?.[Number(elementGraphMatch[1])];
    return el ? { compositionId: comp.id, elementId: el.id } : { compositionId: comp.id };
  }

  const elementMatch = /^compositions\[\d+\]\.elements\[(\d+)\]/.exec(path);
  if (elementMatch) {
    const el = comp.elements?.[Number(elementMatch[1])];
    return el ? { compositionId: comp.id, elementId: el.id } : { compositionId: comp.id };
  }

  if (/^compositions\[\d+\]\.mainGraph/.test(path)) {
    return { compositionId: comp.id };
  }

  return { compositionId: comp.id };
}

function pathScopeMatchesActiveGraph(
  scope: { compositionId: string; elementId?: string; isCompositionRoot?: boolean },
  compositionId: string,
  graphRef: GraphRef,
): boolean {
  if (scope.compositionId !== compositionId) return false;
  if (graphRef === 'main') {
    if (scope.isCompositionRoot) return true;
    return !scope.elementId;
  }
  const activeElementId = graphRef.slice('element:'.length);
  return scope.elementId === activeElementId;
}

export function issueBelongsToActiveGraph(
  issue: ValidationIssueDef,
  compositionId: string,
  graphRef: GraphRef,
  data: NarrativeGraphsFileDef,
): boolean {
  const target = issue.target;
  if (target && 'compositionId' in target && target.compositionId) {
    if (target.compositionId !== compositionId) return false;
    return issueTargetMatchesActiveGraph(target, graphRef);
  }

  const pathScope = issue.path ? resolveIssueGraphScopeFromPath(issue.path, data) : null;
  if (pathScope) {
    return pathScopeMatchesActiveGraph(pathScope, compositionId, graphRef);
  }

  return false;
}

/** @deprecated use issueBelongsToActiveGraph with graphRef `'main'` */
export function issueBelongsToComposition(
  issue: ValidationIssueDef,
  compositionId: string,
  data: NarrativeGraphsFileDef,
): boolean {
  return issueBelongsToActiveGraph(issue, compositionId, 'main', data);
}

export function validationTargetSummary(issue: ValidationIssueDef): string {
  const target = issue.target;
  if (!target) return issue.path ?? issue.itemId ?? issue.code;
  if (target.kind === 'composition') return `composition:${target.compositionId}${target.field ? `.${target.field}` : ''}`;
  if (target.kind === 'element') return `element:${target.compositionId}/${target.elementId}${target.field ? `.${target.field}` : ''}`;
  if (target.kind === 'graph') return `graph:${target.compositionId}/${target.graphId}${target.field ? `.${target.field}` : ''}`;
  if (target.kind === 'state') return `state:${target.compositionId}/${target.graphId}.${target.stateId}${target.field ? `.${target.field}` : ''}`;
  if (target.kind === 'transition') return `transition:${target.compositionId}/${target.graphId}.${target.transitionId}${target.field ? `.${target.field}` : ''}`;
  return `signal:${target.signalId}${target.field ? `.${target.field}` : ''}`;
}

function matchElementOnlyIndex(path: string): number | null {
  const exact = /elements\[(\d+)\]$/.exec(path);
  if (exact) return Number(exact[1]);
  const field = /elements\[(\d+)\]\.(ownerType|ownerId|id|kind|label|refId|meta\b)/.exec(path);
  if (field) return Number(field[1]);
  return null;
}

export function applyFocusIssueResult(result: FocusIssueResult, ctx: FocusIssueContext): void {
  ctx.setCompositionId(result.compositionId);
  ctx.setGraphRef(result.graphRef);
  if (result.collapseExpandedElementId) {
    ctx.setExpandedElementIds((ids) => ids.filter((id) => id !== result.collapseExpandedElementId));
  }
  ctx.setSelectedId(result.selectedId);
}

/**
 * 从校验 path 的 `states.` 之后的尾串里解析出真正的 state id。
 *
 * state id 是作者自由字符串，可含 `.`/`[`/`]`；而 path 尾串可能还带字段后缀
 * （如 `<stateId>.onEnterActions[0]`）。旧写法用 `([^.[\]]+)` 一遇到 `.` 就截断，
 * 会把 `s.1` 截成 `s` 导致聚焦失败。这里从完整尾串起、逐段剥掉尾部字段，
 * 取第一个在图里真实存在的 state id（兼顾"带点的 id"与"带字段后缀"两种情况）。
 */
function resolveStateIdFromPathTail(graph: NarrativeGraphDef, tail: string): string | null {
  let candidate = tail;
  while (candidate) {
    if (graph.states?.[candidate]) return candidate;
    const cut = candidate.lastIndexOf('.');
    if (cut < 0) return null;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

/** 策略一：按校验器给出的 JSON path 定位（compositions[i].mainGraph.states.x 等）。 */
function resolveFocusByPath(path: string, compositions: NarrativeCompositionDef[]): FocusIssueResult | null {
  const compIndexMatch = /compositions\[(\d+)\]/.exec(path);
  if (!compIndexMatch) return null;
  const comp = compositions[Number(compIndexMatch[1])];
  if (!comp) return null;

  const mainTransitionMatch = /mainGraph\.transitions\[(\d+)\]/.exec(path);
  if (mainTransitionMatch) {
    const transition = comp.mainGraph.transitions?.[Number(mainTransitionMatch[1])];
    if (transition) return resolveTransitionFocus(comp, { graph: comp.mainGraph }, transition);
  }
  const elementTransitionMatch = /elements\[(\d+)\]\.graph\.transitions\[(\d+)\]/.exec(path);
  if (elementTransitionMatch) {
    const element = comp.elements?.[Number(elementTransitionMatch[1])];
    const transition = element?.graph?.transitions?.[Number(elementTransitionMatch[2])];
    if (element?.graph && transition) {
      return resolveTransitionFocus(comp, { graph: element.graph, element }, transition);
    }
  }
  const mainStateMatch = /mainGraph\.states\.(.+)$/.exec(path);
  if (mainStateMatch) {
    const sid = resolveStateIdFromPathTail(comp.mainGraph, mainStateMatch[1]!);
    if (sid) return resolveStateFocus(comp, { graph: comp.mainGraph }, sid);
  }
  const elementStateMatch = /elements\[(\d+)\]\.graph\.states\.(.+)$/.exec(path);
  if (elementStateMatch) {
    const element = comp.elements?.[Number(elementStateMatch[1])];
    if (element?.graph) {
      const sid = resolveStateIdFromPathTail(element.graph, elementStateMatch[2]!);
      if (sid) return resolveStateFocus(comp, { graph: element.graph, element }, sid);
    }
  }
  const elementGraphFieldMatch = /elements\[(\d+)\]\.graph\.(initialState|entryState|exitStates|ownerType|ownerId|id|projectFlags)/.exec(path);
  if (elementGraphFieldMatch) {
    const element = comp.elements?.[Number(elementGraphFieldMatch[1])];
    if (element?.graph && isSubgraphElement(element)) {
      return resolveSubgraphGraphFocus(comp, element);
    }
  }
  const elementOnlyIndex = matchElementOnlyIndex(path);
  if (elementOnlyIndex !== null) {
    const element = comp.elements?.[elementOnlyIndex];
    if (element) return resolveElementFocus(comp, element);
  }
  return null;
}

/** 策略二：按 itemId 定位——先图作用域（graphId.localId），再跨编排全局扫描。 */
function resolveFocusByItemId(itemId: string, compositions: NarrativeCompositionDef[]): FocusIssueResult | null {
  const scoped = itemId ? parseGraphScopedItemId(itemId) : null;
  if (scoped) {
    for (const comp of compositions) {
      const owner = findGraphOwner(comp, scoped.graphId);
      if (!owner) continue;
      const transition = owner.graph.transitions?.find((t) => t.id === scoped.localId);
      if (transition) return resolveTransitionFocus(comp, owner, transition);
      if (owner.graph.states?.[scoped.localId]) {
        return resolveStateFocus(comp, owner, scoped.localId);
      }
    }
  }

  for (const comp of compositions) {
    if (itemId && comp.id === itemId) {
      return {
        compositionId: comp.id,
        graphRef: 'main',
        selectedId: `graph:${comp.mainGraph.id}`,
        nodeIds: [`graph:${comp.mainGraph.id}`],
      };
    }
    if (comp.mainGraph.id === itemId) {
      return {
        compositionId: comp.id,
        graphRef: 'main',
        selectedId: `graph:${comp.mainGraph.id}`,
        nodeIds: [`graph:${comp.mainGraph.id}`],
      };
    }
    for (const el of comp.elements ?? []) {
      if (el.id === itemId) {
        return resolveElementFocus(comp, el);
      }
      if (el.graph?.id === itemId) {
        return isSubgraphElement(el) ? resolveSubgraphGraphFocus(comp, el) : resolveElementFocus(comp, el);
      }
    }
    for (const el of comp.elements ?? []) {
      if (!el.graph) continue;
      for (const t of el.graph.transitions ?? []) {
        if (itemId === `${el.graph.id}.${t.id}`) {
          return resolveTransitionFocus(comp, { graph: el.graph, element: el }, t);
        }
      }
    }
    for (const t of comp.mainGraph.transitions ?? []) {
      if (itemId === `${comp.mainGraph.id}.${t.id}`) {
        return resolveTransitionFocus(comp, { graph: comp.mainGraph }, t);
      }
    }
    if (itemId) {
      for (const el of comp.elements ?? []) {
        if (!el.graph) continue;
        const transition = el.graph.transitions?.find((t) => t.id === itemId);
        if (transition) return resolveTransitionFocus(comp, { graph: el.graph, element: el }, transition);
        const stateId = Object.keys(el.graph.states ?? {}).find((sid) => sid === itemId);
        if (stateId) return resolveStateFocus(comp, { graph: el.graph, element: el }, stateId);
      }
      const mainTransition = comp.mainGraph.transitions?.find((t) => t.id === itemId);
      if (mainTransition) return resolveTransitionFocus(comp, { graph: comp.mainGraph }, mainTransition);
      if (comp.mainGraph.states?.[itemId]) {
        return resolveStateFocus(comp, { graph: comp.mainGraph }, itemId);
      }
    }
  }
  return null;
}

export function resolveValidationIssueFocus(issue: ValidationIssueDef, data: NarrativeGraphsFileDef): FocusIssueResult | null {
  const targetResult = resolveTargetFocus(issue.target, data);
  if (targetResult) return targetResult;

  const itemId = issue.itemId?.trim() ?? '';
  const path = issue.path?.trim() ?? '';
  const compositions = data.compositions ?? [];

  // 顺序不变：先按 path 定位，未命中再按 itemId 定位。
  return resolveFocusByPath(path, compositions) ?? resolveFocusByItemId(itemId, compositions);
}

export function focusValidationIssue(issue: ValidationIssueDef, data: NarrativeGraphsFileDef, ctx: FocusIssueContext): FocusIssueResult | null {
  const result = resolveValidationIssueFocus(issue, data);
  if (result) applyFocusIssueResult(result, ctx);
  return result;
}
