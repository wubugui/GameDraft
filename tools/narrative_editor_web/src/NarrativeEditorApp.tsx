import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  type Connection,
  type EdgeProps,
  type NodeProps,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import {
  emitRuntimeSignal,
  editActionsNative,
  getRuntimeSnapshot,
  loadAuthoringCatalog,
  loadNarrativeData,
  loadProjection,
  navigateTo,
  saveNarrativeData,
  setRuntimeNarrativeState,
  validateNarrativeDataRemote,
} from './bridge';
import {
  collectKnownSignals,
  compileGraphs,
  createComposition,
  createElement,
  createState,
  createTransition,
  defaultFile,
  endpointInputValue,
  endpointLabel,
  emptyCatalog,
  getComposition,
  getEditableGraph,
  getElementByGraphRef,
  getElementByNodeId,
  graphLabel,
  isSubgraphElement,
  normalizeFile,
  parseEndpointInput,
  parseExternalSignalKey,
  renameElement,
  renameStateInGraph,
  renameTransition,
  setStateEditorPosition,
  simulateSignalImpact,
  stateEditorPosition,
  resolveEndpoint,
  type GraphRef,
  type SimulationResult,
} from './editorModel';
import type {
  ActionDef,
  AuthoringCatalogDef,
  CanvasEdge,
  CanvasNode,
  CompositionElementDef,
  ElementKind,
  NarrativeEndpointDef,
  NarrativeCompositionDef,
  NarrativeGraphsFileDef,
  NarrativeGraphDef,
  NarrativeStateNodeDef,
  NarrativeTransitionDef,
  ProjectionEdgeDef,
  ProjectionResult,
  RuntimeDebugSnapshotDef,
  ValidationIssueDef,
} from './types';

const nodeTypes = {
  state: StateNode,
  graphAnchor: AnchorNode,
  projectionAnchor: AnchorNode,
  transitionAnchor: TransitionAnchorNode,
  wrapperGraph: ElementNode,
  scenarioSubgraph: ElementNode,
  dialogueBlackbox: ElementNode,
  zoneBlackbox: ElementNode,
  minigameBlackbox: ElementNode,
  cutsceneBlackbox: ElementNode,
};

const edgeTypes = {
  transition: StyledEdge,
  projection: StyledEdge,
};

const elementKinds: ElementKind[] = [
  'wrapperGraph',
  'scenarioSubgraph',
  'dialogueBlackbox',
  'zoneBlackbox',
  'minigameBlackbox',
  'cutsceneBlackbox',
];

const wrapperOwnerTypes = ['npc', 'hotspot', 'zone', 'quest', 'dialogue', 'minigame', 'cutscene', 'scenario', 'system'];

export function NarrativeEditorApp() {
  const [data, setData] = useState<NarrativeGraphsFileDef>(defaultFile);
  const [projection, setProjection] = useState<ProjectionResult>({ triggerEdges: [], readEdges: [], stateCommandEdges: [] });
  const [catalog, setCatalog] = useState<AuthoringCatalogDef>(emptyCatalog);
  const [validationIssues, setValidationIssues] = useState<ValidationIssueDef[]>([]);
  const [compositionId, setCompositionId] = useState('');
  const [graphRef, setGraphRef] = useState<GraphRef>('main');
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedJson, setSelectedJson] = useState('');
  const [showTrigger, setShowTrigger] = useState(true);
  const [showRead, setShowRead] = useState(true);
  const [showCommand, setShowCommand] = useState(true);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [expandedElementIds, setExpandedElementIds] = useState<string[]>([]);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [signalKey, setSignalKey] = useState('');
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeDebugSnapshotDef>({ ok: false, reason: 'Runtime not queried yet' });

  const compositions = data.compositions ?? [];
  const composition = useMemo(() => getComposition(data, compositionId), [data, compositionId]);
  const graph = useMemo(() => getEditableGraph(composition, graphRef), [composition, graphRef]);
  const activeStates = useMemo(() => extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? {}, [runtimeSnapshot, simulation]);
  const knownSignals = useMemo(() => collectKnownSignals(data), [data]);
  const selectedObject = useMemo(
    () => getSelectedSummary(composition, graph, graphRef, selectedId),
    [composition, graph, graphRef, selectedId],
  );

  useEffect(() => {
    void loadNarrativeData().then(async (loaded) => {
      const next = normalizeFile(loaded);
      setData(next);
      setCompositionId(next.compositions?.[0]?.id ?? '');
      setSignalKey(collectKnownSignals(next)[0] ?? '');
      setCatalog(await loadAuthoringCatalog());
      setValidationIssues(await validateNarrativeDataRemote(next));
      setStatus('Loaded');
    });
  }, []);

  useEffect(() => {
    void refreshProjectionAndValidation(data);
  }, [compositionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!composition || !graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(toNodes(composition, graph, graphRef, activeStates, projection, showTrigger, showRead, showCommand, expandedElementIds, selectedId));
    setEdges(toEdges(composition, graph, graphRef, projection, showTrigger, showRead, showCommand, expandedElementIds, selectedId));
  }, [composition, graph, graphRef, projection, showTrigger, showRead, showCommand, expandedElementIds, selectedId, activeStates]);

  const refreshProjectionAndValidation = useCallback(async (nextData = data) => {
    const normalized = normalizeFile(nextData);
    setProjection(await loadProjection(normalized));
    setValidationIssues(await validateNarrativeDataRemote(normalized));
  }, [data]);

  const updateData = useCallback((updater: (next: NarrativeGraphsFileDef) => void) => {
    setData((old) => {
      const next = normalizeFile(old);
      updater(next);
      void refreshProjectionAndValidation(next);
      return next;
    });
  }, [refreshProjectionAndValidation]);

  const updateCurrentGraph = useCallback((updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => {
    updateData((next) => {
      const comp = getComposition(next, composition?.id ?? compositionId);
      const target = getEditableGraph(comp, graphRef);
      if (target) updater(target, next);
    });
  }, [composition?.id, compositionId, graphRef, updateData]);

  const toggleExpandedElement = useCallback((elementId: string) => {
    setExpandedElementIds((ids) => (
      ids.includes(elementId) ? ids.filter((id) => id !== elementId) : [...ids, elementId]
    ));
  }, []);

  const removeModelObjects = useCallback((ids: string[]) => {
    const targets = ids.filter((id) => isSelectionDeletable(id, graphRef));
    if (!targets.length) {
      setStatus('Nothing deletable selected');
      return;
    }
    let expectedRemoved = 0;
    let blockedLastState = false;
    let remainingStateCount = Object.keys(graph?.states ?? {}).length;
    const countedStates = new Set<string>();
    const countedTransitions = new Set<string>();
    const countedElements = new Set<string>();
    const inlineStateCounts = new Map<string, number>();
    for (const id of targets) {
      const inline = parseInlineSubgraphId(id);
      if (inline?.kind === 'state') {
        const el = composition?.elements?.find((item) => item.id === inline.elementId);
        if (!el?.graph?.states[inline.objectId] || countedStates.has(id)) continue;
        const count = inlineStateCounts.get(inline.elementId) ?? Object.keys(el.graph.states).length;
        if (count <= 1) {
          blockedLastState = true;
          continue;
        }
        inlineStateCounts.set(inline.elementId, count - 1);
        countedStates.add(id);
        expectedRemoved += 1;
      } else if (inline?.kind === 'transition') {
        const el = composition?.elements?.find((item) => item.id === inline.elementId);
        if (el?.graph?.transitions.some((t) => t.id === inline.objectId) && !countedTransitions.has(id)) {
          countedTransitions.add(id);
          expectedRemoved += 1;
        }
      } else if (id.startsWith('state:')) {
        const sid = id.slice('state:'.length);
        if (!graph?.states[sid] || countedStates.has(sid)) continue;
        if (remainingStateCount <= 1) {
          blockedLastState = true;
          continue;
        }
        countedStates.add(sid);
        remainingStateCount -= 1;
        expectedRemoved += 1;
      } else if (id.startsWith('transition:')) {
        const tid = id.slice('transition:'.length);
        if (graph?.transitions.some((t) => t.id === tid) && !countedTransitions.has(tid)) {
          countedTransitions.add(tid);
          expectedRemoved += 1;
        }
      } else if (id.startsWith('element:') && graphRef === 'main') {
        const eid = id.slice('element:'.length);
        if (composition?.elements?.some((el) => el.id === eid) && !countedElements.has(eid)) {
          countedElements.add(eid);
          expectedRemoved += 1;
        }
      }
    }
    updateData((next) => {
      const comp = getComposition(next, composition?.id ?? compositionId);
      const g = getEditableGraph(comp, graphRef);
      if (!comp || !g) return;
      for (const id of targets) {
        const inline = parseInlineSubgraphId(id);
        if (inline?.kind === 'state') {
          const el = comp.elements?.find((item) => item.id === inline.elementId);
          const subgraph = el?.graph;
          const sid = inline.objectId;
          if (!subgraph?.states[sid]) continue;
          if (Object.keys(subgraph.states).length <= 1) {
            blockedLastState = true;
            continue;
          }
          delete subgraph.states[sid];
          removeTransitionsReferencingState(comp, subgraph.id, sid);
          if (subgraph.initialState === sid) subgraph.initialState = Object.keys(subgraph.states)[0] ?? '';
          if (subgraph.entryState === sid) subgraph.entryState = Object.keys(subgraph.states)[0] ?? '';
          subgraph.exitStates = subgraph.exitStates?.filter((exitId) => exitId !== sid);
        } else if (inline?.kind === 'transition') {
          const el = comp.elements?.find((item) => item.id === inline.elementId);
          if (el?.graph) el.graph.transitions = el.graph.transitions.filter((t) => t.id !== inline.objectId);
        } else if (id.startsWith('state:')) {
          const sid = id.slice('state:'.length);
          if (!g.states[sid]) continue;
          if (Object.keys(g.states).length <= 1) {
            blockedLastState = true;
            continue;
          }
          delete g.states[sid];
          removeTransitionsReferencingState(comp, g.id, sid);
          if (g.initialState === sid) g.initialState = Object.keys(g.states)[0] ?? '';
          if (g.entryState === sid) g.entryState = Object.keys(g.states)[0] ?? '';
          g.exitStates = g.exitStates?.filter((exitId) => exitId !== sid);
        } else if (id.startsWith('transition:')) {
          const tid = id.slice('transition:'.length);
          g.transitions = g.transitions.filter((t) => t.id !== tid);
        } else if (id.startsWith('element:') && graphRef === 'main') {
          const eid = id.slice('element:'.length);
          comp.elements = (comp.elements ?? []).filter((el) => el.id !== eid);
        }
      }
    });
    if (targets.includes(selectedId)) {
      setSelectedId('');
      setSelectedJson('');
    }
    setStatus(blockedLastState ? 'At least one state must remain' : expectedRemoved ? `Deleted ${expectedRemoved} object(s)` : 'Nothing deleted');
  }, [composition, compositionId, graph, graphRef, selectedId, updateData]);

  const onNodesChange: OnNodesChange<CanvasNode> = useCallback((changes) => {
    const removedNodeIds = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removedNodeIds.length) removeModelObjects(removedNodeIds);
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, [removeModelObjects]);

  const onEdgesChange: OnEdgesChange<CanvasEdge> = useCallback((changes) => {
    const removedEdgeIds = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removedEdgeIds.length) removeModelObjects(removedEdgeIds);
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, [removeModelObjects]);

  const onConnect: OnConnect = useCallback((conn: Connection) => {
    if (!composition || !graph || graphRef !== 'main') {
      const from = conn.source?.startsWith('state:') ? conn.source.slice('state:'.length) : '';
      const to = conn.target?.startsWith('state:') ? conn.target.slice('state:'.length) : '';
      if (!from || !to) {
        setStatus('Only state nodes can create transitions');
        return;
      }
      let created: NarrativeTransitionDef | null = null;
      updateCurrentGraph((g) => {
        created = createTransition(g, from, to);
      });
      if (created) {
        setSelectedId(`transition:${created.id}`);
        setSelectedJson(JSON.stringify(created, null, 2));
        setStatus(`Created transition ${created.id}`);
      }
      return;
    }

    const source = stateEndpointFromNodeId(conn.source ?? '', composition, graph);
    const target = stateEndpointFromNodeId(conn.target ?? '', composition, graph);
    if (!source || !target) {
      setStatus('Only state nodes can create transitions');
      return;
    }
    const decision = canConnectStateEndpoints(composition, source, target);
    if (!decision.ok) {
      setStatus(decision.reason);
      return;
    }
    let created: NarrativeTransitionDef | null = null;
    updateData((next) => {
      const comp = getComposition(next, composition.id);
      const sourceGraph = findGraphById(comp, source.graphId);
      if (!sourceGraph) return;
      const fromEndpoint: NarrativeEndpointDef = source.stateId;
      const toEndpoint: NarrativeEndpointDef = source.graphId === target.graphId
        ? target.stateId
        : { graphId: target.graphId, stateId: target.stateId };
      created = createTransition(sourceGraph, fromEndpoint, toEndpoint);
    });
    if (created) {
      const edgeId = source.elementId ? inlineSubgraphTransitionId(source.elementId, created.id) : `transition:${created.id}`;
      setEdges((eds) => addEdge({
        ...conn,
        id: edgeId,
        type: 'transition',
        label: created!.signal,
        data: { edgeKind: 'transition', label: created!.signal, detail: created!.id },
        markerEnd: { type: MarkerType.ArrowClosed },
      }, eds));
      setSelectedId(edgeId);
      setSelectedJson(JSON.stringify(created, null, 2));
      setStatus(`Created transition ${created.id}`);
    }
  }, [composition, graph, graphRef, updateCurrentGraph, updateData]);

  const onNodeDragStop = useCallback((_event: unknown, node: CanvasNode) => {
    const inline = parseInlineSubgraphId(node.id);
    if (inline?.kind === 'state') {
      updateData((next) => {
        const comp = getComposition(next, composition?.id ?? compositionId);
        const element = comp?.elements?.find((el) => el.id === inline.elementId);
        const state = element?.graph?.states[inline.objectId];
        if (!element || !state) return;
        const base = inlineSubgraphBase(element);
        setStateEditorPosition(state, node.position.x - base.x, node.position.y - base.y);
      });
      return;
    }
    if (node.id.startsWith('state:')) {
      updateCurrentGraph((g) => {
        const state = g.states[node.id.slice('state:'.length)];
        if (state) setStateEditorPosition(state, node.position.x, node.position.y);
      });
      return;
    }
    if (node.id.startsWith('element:') && graphRef === 'main') {
      updateData((next) => {
        const comp = getComposition(next, composition?.id ?? compositionId);
        const element = comp?.elements?.find((el) => `element:${el.id}` === node.id);
        if (!element) return;
        element.x = Math.round(node.position.x);
        element.y = Math.round(node.position.y);
      });
    }
  }, [composition?.id, compositionId, graphRef, updateCurrentGraph, updateData]);

  const selectNode = useCallback((_event: unknown, node: CanvasNode) => {
    setSelectedId(node.id);
    setSelectedJson(JSON.stringify(getNodeObject(composition, graph, node.id), null, 2));
  }, [composition, graph]);

  const selectEdge = useCallback((_event: unknown, edge: CanvasEdge) => {
    setSelectedId(edge.id);
    const inline = parseInlineSubgraphId(edge.id);
    if (inline?.kind === 'transition') {
      const element = composition?.elements?.find((el) => el.id === inline.elementId);
      setSelectedJson(JSON.stringify(element?.graph?.transitions.find((t) => t.id === inline.objectId) ?? {}, null, 2));
    } else if (edge.id.startsWith('transition:')) {
      setSelectedJson(JSON.stringify(graph?.transitions.find((t) => `transition:${t.id}` === edge.id) ?? {}, null, 2));
    } else {
      const projectionObject = findProjectionEdge(projection, edge.id.replace('projection:', ''));
      setSelectedJson(JSON.stringify(projectionObject ?? edge.data ?? {}, null, 2));
    }
  }, [composition, graph, projection]);

  const addState = useCallback(() => {
    let newId = '';
    let inlineElementId = '';
    const inline = parseInlineSubgraphId(selectedId);
    if (inline) inlineElementId = inline.elementId;
    if (!inlineElementId && selectedId.startsWith('element:')) {
      const eid = selectedId.slice('element:'.length);
      const element = composition?.elements?.find((el) => el.id === eid);
      if (element && isSubgraphElement(element) && expandedElementIds.includes(eid)) inlineElementId = eid;
    }
    if (inlineElementId && graphRef === 'main') {
      updateData((next) => {
        const comp = getComposition(next, composition?.id ?? compositionId);
        const element = comp?.elements?.find((el) => el.id === inlineElementId);
        if (element?.graph) newId = createState(element.graph);
      });
      if (newId) {
        setSelectedId(inlineSubgraphStateId(inlineElementId, newId));
        setStatus(`Created subgraph state ${newId}`);
      }
      return;
    }
    updateCurrentGraph((g) => { newId = createState(g); });
    if (newId) {
      setSelectedId(`state:${newId}`);
      setStatus(`Created state ${newId}`);
    }
  }, [composition, compositionId, expandedElementIds, graphRef, selectedId, updateCurrentGraph, updateData]);

  const addCompositionAction = useCallback(() => {
    let compId = '';
    updateData((next) => {
      const comp = createComposition(next);
      compId = comp.id;
    });
    setCompositionId(compId);
    setGraphRef('main');
    setSelectedId('');
    setSelectedJson('');
    setExpandedElementIds([]);
  }, [updateData]);

  const addElementAction = useCallback((kind: ElementKind) => {
    if (!composition || graphRef !== 'main') return;
    let id = '';
    updateData((next) => {
      const comp = getComposition(next, composition.id);
      if (!comp) return;
      id = createElement(comp, kind).id;
    });
    if (id) {
      setSelectedId(`element:${id}`);
      if (kind === 'wrapperGraph' || kind === 'scenarioSubgraph') {
        setExpandedElementIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
      }
    }
  }, [composition, graphRef, updateData]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    removeModelObjects([selectedId]);
  }, [removeModelObjects, selectedId]);

  const applySelectedJson = useCallback(async () => {
    if (!selectedId || selectedId.startsWith('projection:')) {
      setStatus('Projection edges are readonly');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(selectedJson);
    } catch (e) {
      setStatus(`JSON parse failed: ${String(e)}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus('Selected object must be a JSON object');
      return;
    }
    try {
      updateData((next) => {
        const comp = getComposition(next, composition?.id ?? compositionId);
        const g = getEditableGraph(comp, graphRef);
        if (!comp || !g) return;
        const inline = parseInlineSubgraphId(selectedId);
        if (inline?.kind === 'state') {
          const el = comp.elements?.find((item) => item.id === inline.elementId);
          if (!el?.graph) return;
          const nextState = parsed as NarrativeStateNodeDef;
          const newId = renameStateInGraph(next, el.graph, inline.objectId, String(nextState.id || inline.objectId));
          el.graph.states[newId] = { ...nextState, id: newId };
          setSelectedId(inlineSubgraphStateId(inline.elementId, newId));
        } else if (inline?.kind === 'transition') {
          const el = comp.elements?.find((item) => item.id === inline.elementId);
          if (!el?.graph) return;
          const idx = el.graph.transitions.findIndex((t) => t.id === inline.objectId);
          if (idx >= 0) {
            const transition = parsed as NarrativeTransitionDef;
            const newId = renameTransition(el.graph, inline.objectId, String(transition.id || inline.objectId));
            el.graph.transitions[el.graph.transitions.findIndex((t) => t.id === newId)] = { ...transition, id: newId };
            setSelectedId(inlineSubgraphTransitionId(inline.elementId, newId));
          }
        } else if (selectedId.startsWith('state:')) {
          const oldId = selectedId.slice('state:'.length);
          const nextState = parsed as NarrativeStateNodeDef;
          const newId = renameStateInGraph(next, g, oldId, String(nextState.id || oldId));
          g.states[newId] = { ...nextState, id: newId };
          setSelectedId(`state:${newId}`);
        } else if (selectedId.startsWith('transition:')) {
          const oldId = selectedId.slice('transition:'.length);
          const idx = g.transitions.findIndex((t) => t.id === oldId);
          if (idx >= 0) {
            const transition = parsed as NarrativeTransitionDef;
            const newId = renameTransition(g, oldId, String(transition.id || oldId));
            g.transitions[g.transitions.findIndex((t) => t.id === newId)] = { ...transition, id: newId };
            setSelectedId(`transition:${newId}`);
          }
        } else if (selectedId.startsWith('element:') && graphRef === 'main') {
          const oldId = selectedId.slice('element:'.length);
          const nextElement = parsed as CompositionElementDef;
          const newId = renameElement(comp, oldId, String(nextElement.id || oldId));
          const idx = (comp.elements ?? []).findIndex((e) => e.id === newId);
          if (idx >= 0) comp.elements![idx] = { ...nextElement, id: newId };
          setSelectedId(`element:${newId}`);
        }
      });
      setStatus('Applied JSON');
    } catch (e) {
      setStatus(String(e));
    }
  }, [composition?.id, compositionId, graphRef, selectedId, selectedJson, updateData]);

  const save = useCallback(async () => {
    const normalized = normalizeFile(data);
    const issues = await validateNarrativeDataRemote(normalized);
    setValidationIssues(issues);
    const errors = issues.filter((issue) => issue.severity === 'error');
    if (errors.length) {
      setStatus(`Save blocked: ${errors.length} validation error(s)`);
      return;
    }
    setStatus(await saveNarrativeData(normalized));
  }, [data]);

  const runLocalSimulation = useCallback(() => {
    const key = signalKey.trim();
    if (!key) {
      setStatus('Signal is empty');
      return;
    }
    const result = simulateSignalImpact(data, key);
    setSimulation(result);
    setRuntimeSnapshot({ ok: false, reason: 'Showing local simulation' });
    setStatus(`Simulated ${result.recentTransitions.length} transition(s)`);
  }, [data, signalKey]);

  const pullRuntimeSnapshot = useCallback(async () => {
    const result = await getRuntimeSnapshot();
    setRuntimeSnapshot(result);
    setStatus(result.ok ? 'Runtime snapshot loaded' : `Runtime unavailable: ${result.reason}`);
  }, []);

  const emitRuntime = useCallback(async () => {
    const request = parseExternalSignalKey(signalKey.trim());
    const result = await emitRuntimeSignal(request);
    setRuntimeSnapshot(result);
    if (!result.ok) {
      runLocalSimulation();
      setStatus(`Runtime unavailable, simulated locally: ${result.reason}`);
    } else {
      setStatus('Runtime signal emitted');
    }
  }, [runLocalSimulation, signalKey]);

  const errorCount = validationIssues.filter((issue) => issue.severity === 'error').length;
  const warningCount = validationIssues.filter((issue) => issue.severity === 'warning').length;

  return (
    <div className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="pane-head">
          <div className="brand">叙事状态机</div>
          <button type="button" onClick={() => setLeftCollapsed(true)}>收起</button>
        </div>
        <button className="primary" onClick={addCompositionAction}>New Composition</button>
        <div className="section-title">Compositions</div>
        <div className="composition-list">
          {compositions.map((comp) => (
            <button
              key={comp.id}
              className={comp.id === composition?.id ? 'composition active' : 'composition'}
              onClick={() => {
                setCompositionId(comp.id);
                setGraphRef('main');
                setSelectedId('');
              }}
            >
              <span>{comp.label || comp.id}</span>
              <small>{comp.mainGraph.id}</small>
            </button>
          ))}
        </div>

        {composition && (
          <>
            <div className="section-title">Graph Navigation</div>
            <button className={graphRef === 'main' ? 'composition active' : 'composition'} onClick={() => setGraphRef('main')}>
              <span>Main Graph</span>
              <small>{composition.mainGraph.id}</small>
            </button>
            {(composition.elements ?? []).filter((el) => isSubgraphElement(el)).map((el) => (
              <button
                key={el.id}
                className={graphRef === `element:${el.id}` ? 'composition active' : 'composition'}
                onClick={() => setGraphRef(`element:${el.id}`)}
              >
                <span>{el.label || el.id}</span>
                <small>{el.graph?.id}</small>
              </button>
            ))}
          </>
        )}

        <div className="section-title">Validation</div>
        <div className={errorCount ? 'validation-pill error' : warningCount ? 'validation-pill warn' : 'validation-pill ok'}>
          {errorCount} errors / {warningCount} warnings
        </div>
        <div className="issue-list">
          {validationIssues.slice(0, 8).map((issue, index) => (
            <button key={`${issue.code}-${index}`} className={`issue ${issue.severity}`} title={issue.path}>
              <b>{issue.severity}</b>
              <span>{issue.message}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="workspace">
        <header className="toolbar">
          <div>
            <strong>{composition?.label || 'No Composition'}</strong>
            <span className="muted"> / {graphLabel(composition, graphRef)}</span>
          </div>
          <div className="toolbar-actions">
            <button type="button" onClick={() => setLeftCollapsed((v) => !v)}>
              {leftCollapsed ? '展开导航' : '收起导航'}
            </button>
            <button type="button" onClick={() => setRightCollapsed((v) => !v)}>
              {rightCollapsed ? '展开属性' : '收起属性'}
            </button>
            <button onClick={addState} disabled={!graph}>State</button>
            {graphRef === 'main' && elementKinds.map((kind) => (
              <button key={kind} onClick={() => addElementAction(kind)}>{kindLabel(kind)}</button>
            ))}
            <label className="toggle"><input type="checkbox" checked={showTrigger} onChange={(e) => setShowTrigger(e.target.checked)} /> 外部触发 ({projection.triggerEdges.length})</label>
            <label className="toggle"><input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} /> 外部读取 ({projection.readEdges.length})</label>
            <label className="toggle"><input type="checkbox" checked={showCommand} onChange={(e) => setShowCommand(e.target.checked)} /> 强制设状态 ({projection.stateCommandEdges?.length ?? 0})</label>
            <label className="toggle"><input type="checkbox" checked={showMiniMap} onChange={(e) => setShowMiniMap(e.target.checked)} /> MiniMap</label>
            <button onClick={deleteSelected} disabled={!isSelectionDeletable(selectedId, graphRef)}>Delete</button>
            <button onClick={() => refreshProjectionAndValidation(data)}>Refresh</button>
            <button className="primary" onClick={save}>Save</button>
          </div>
        </header>

        <section className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={selectNode}
            onEdgeClick={selectEdge}
            onNodeDragStop={onNodeDragStop}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background />
            {showMiniMap && <MiniMap pannable zoomable className="narrative-minimap" />}
            <Controls />
          </ReactFlow>
        </section>
        <footer className="status">
          <span>{status}</span>
          <span>{runtimeSnapshot.ok ? 'Runtime connected' : runtimeSnapshot.reason}</span>
        </footer>
      </main>

      <aside className="inspector">
        <div className="pane-head">
          <div className="section-title">Inspector</div>
          <button type="button" onClick={() => setRightCollapsed(true)}>收起</button>
        </div>
        <div className="summary">
          <strong>{selectedObject.title}</strong>
          <span>{selectedObject.subtitle}</span>
        </div>
        <StructuredInspector
          data={data}
          composition={composition}
          graph={graph}
          graphRef={graphRef}
          selectedId={selectedId}
          catalog={catalog}
          knownSignals={knownSignals}
          updateData={updateData}
          updateCurrentGraph={updateCurrentGraph}
          setSelectedId={setSelectedId}
          setSelectedJson={setSelectedJson}
          setGraphRef={setGraphRef}
          setStatus={setStatus}
          setRuntimeSnapshot={setRuntimeSnapshot}
          expandedElementIds={expandedElementIds}
          toggleExpandedElement={toggleExpandedElement}
          deleteSelected={deleteSelected}
          projection={projection}
        />
        <div className="inspector-actions">
          <button onClick={deleteSelected} disabled={!isSelectionDeletable(selectedId, graphRef)}>Delete</button>
          <button onClick={() => selectedObject.navigate && navigateTo(selectedObject.navigate.kind, selectedObject.navigate.id)} disabled={!selectedObject.navigate}>
            Navigate
          </button>
        </div>

        <div className="section-title">Signal Impact / Runtime</div>
        <div className="field">
          <label>triggerKey</label>
          <input list="knownSignals" value={signalKey} onChange={(e) => setSignalKey(e.target.value)} />
          <datalist id="knownSignals">{knownSignals.map((sig) => <option key={sig} value={sig} />)}</datalist>
        </div>
        <div className="inspector-actions">
          <button onClick={runLocalSimulation}>Simulate</button>
          <button onClick={pullRuntimeSnapshot}>Pull Runtime</button>
          <button onClick={emitRuntime}>Emit Runtime</button>
        </div>
        <PreviewPanel simulation={simulation} runtimeSnapshot={runtimeSnapshot} />

        <details className="advanced-json">
          <summary>Advanced JSON</summary>
          <textarea value={selectedJson} onChange={(e) => setSelectedJson(e.target.value)} readOnly={selectedId.startsWith('projection:')} />
          <div className="inspector-actions">
            <button onClick={applySelectedJson} disabled={!selectedId || selectedId.startsWith('projection:')}>Apply JSON</button>
          </div>
        </details>
      </aside>
    </div>
  );
}

function StructuredInspector(props: {
  data: NarrativeGraphsFileDef;
  composition?: NarrativeCompositionDef;
  graph?: NarrativeGraphDef;
  graphRef: GraphRef;
  selectedId: string;
  catalog: AuthoringCatalogDef;
  knownSignals: string[];
  updateData: (updater: (next: NarrativeGraphsFileDef) => void) => void;
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setSelectedId: (id: string) => void;
  setSelectedJson: (json: string) => void;
  setGraphRef: (ref: GraphRef) => void;
  setStatus: (status: string) => void;
  setRuntimeSnapshot: (snapshot: RuntimeDebugSnapshotDef) => void;
  expandedElementIds: string[];
  toggleExpandedElement: (elementId: string) => void;
  deleteSelected: () => void;
  projection: ProjectionResult;
}) {
  const { composition, graph, graphRef, selectedId } = props;
  if (!composition || !graph) return <p className="muted">No composition selected.</p>;
  if (!selectedId) return <GraphInspector {...props} graph={graph} />;
  if (selectedId.startsWith('graph:') || selectedId.startsWith('projection-anchor:') || selectedId.startsWith('transition-anchor:')) {
    return <GraphInspector {...props} graph={graph} />;
  }
  const inline = parseInlineSubgraphId(selectedId);
  if (inline) {
    const element = composition.elements?.find((el) => el.id === inline.elementId);
    const subgraph = element?.graph;
    if (!element || !subgraph) return <p className="muted">Missing expanded subgraph.</p>;
    const updateInlineGraph = (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => {
      props.updateData((next) => {
        const comp = getComposition(next, composition.id);
        const el = comp?.elements?.find((item) => item.id === inline.elementId);
        if (el?.graph) updater(el.graph, next);
      });
    };
    if (inline.kind === 'state') {
      const state = subgraph.states[inline.objectId];
      return state ? (
        <StateInspector
          {...props}
          graph={subgraph}
          state={state}
          stateId={inline.objectId}
          updateCurrentGraph={updateInlineGraph}
          setSelectedId={(id) => props.setSelectedId(prefixInlineSelection(inline.elementId, id))}
        />
      ) : <p className="muted">Missing subgraph state.</p>;
    }
    const transition = subgraph.transitions.find((t) => t.id === inline.objectId);
    return transition ? (
      <TransitionInspector
        {...props}
        graph={subgraph}
        transition={transition}
        updateCurrentGraph={updateInlineGraph}
        setSelectedId={(id) => props.setSelectedId(prefixInlineSelection(inline.elementId, id))}
      />
    ) : <p className="muted">Missing subgraph transition.</p>;
  }
  if (selectedId.startsWith('state:')) {
    const stateId = selectedId.slice('state:'.length);
    const state = graph.states[stateId];
    return state ? <StateInspector {...props} state={state} stateId={stateId} graph={graph} /> : <p className="muted">Missing state.</p>;
  }
  if (selectedId.startsWith('transition:')) {
    const transitionId = selectedId.slice('transition:'.length);
    const transition = graph.transitions.find((t) => t.id === transitionId);
    return transition ? <TransitionInspector {...props} transition={transition} graph={graph} /> : <p className="muted">Missing transition.</p>;
  }
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const element = getElementByNodeId(composition, selectedId);
    return element ? <ElementInspector {...props} element={element} /> : <p className="muted">Missing element.</p>;
  }
  if (selectedId.startsWith('projection:')) {
    const edge = findProjectionEdge(props.projection, selectedId.replace('projection:', ''));
    return edge ? <ExternalWiringInspector edge={edge} /> : <p className="muted">Missing external wiring edge.</p>;
  }
  return <GraphInspector {...props} graph={graph} />;
}

function GraphInspector(props: {
  data: NarrativeGraphsFileDef;
  composition?: NarrativeCompositionDef;
  graph: NarrativeGraphDef;
  graphRef: GraphRef;
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
}) {
  const { graph, updateCurrentGraph } = props;
  return (
    <div className="form-grid">
      <TextField label="graph id" value={graph.id} onChange={(value) => updateCurrentGraph((g) => { g.id = value; })} />
      <TextField label="ownerType" value={graph.ownerType} onChange={(value) => updateCurrentGraph((g) => { g.ownerType = value; })} />
      <TextField label="ownerId" value={graph.ownerId ?? ''} onChange={(value) => updateCurrentGraph((g) => { g.ownerId = value; })} />
      <SelectField label="initialState" value={graph.initialState} values={Object.keys(graph.states)} onChange={(value) => updateCurrentGraph((g) => { g.initialState = value; })} />
      {(graph.ownerType === 'scenario' || graph.entryState || graph.exitStates?.length) && (
        <>
          <SelectField label="scenario entryState" value={graph.entryState ?? ''} values={Object.keys(graph.states)} onChange={(value) => updateCurrentGraph((g) => { g.entryState = value; })} />
          <StringListField label="scenario exitStates" value={graph.exitStates ?? []} onChange={(value) => updateCurrentGraph((g) => { g.exitStates = value; })} />
          <div className="property-line">Scenario 只有 entryState / exitStates 可以和外部图直接连线；内部状态只在展开后编辑。</div>
        </>
      )}
      <label className="toggle"><input type="checkbox" checked={graph.projectFlags === true} onChange={(e) => updateCurrentGraph((g) => { g.projectFlags = e.target.checked; })} /> projectFlags</label>
      <div className="property-line">{Object.keys(graph.states).length} states / {graph.transitions.length} transitions</div>
    </div>
  );
}

function StateInspector(props: {
  data: NarrativeGraphsFileDef;
  graph: NarrativeGraphDef;
  state: NarrativeStateNodeDef;
  stateId: string;
  catalog: AuthoringCatalogDef;
  knownSignals: string[];
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setSelectedId: (id: string) => void;
  setSelectedJson: (json: string) => void;
  setRuntimeSnapshot: (snapshot: RuntimeDebugSnapshotDef) => void;
  setStatus: (status: string) => void;
}) {
  const { graph, state, stateId, updateCurrentGraph } = props;
  return (
    <div className="form-grid">
      <TextField
        label="id"
        value={state.id}
        commitOnBlur
        onChange={(value) => updateCurrentGraph((g, next) => {
          try {
            const newId = renameStateInGraph(next, g, stateId, value);
            props.setSelectedId(`state:${newId}`);
          } catch (e) {
            props.setStatus(String(e));
          }
        })}
      />
      <TextField label="label" value={state.label ?? ''} onChange={(value) => updateCurrentGraph((g) => { g.states[stateId].label = value; })} />
      <TextAreaField label="description" value={state.description ?? ''} onChange={(value) => updateCurrentGraph((g) => { g.states[stateId].description = value; })} />
      <label className="toggle">
        <input type="checkbox" checked={graph.initialState === stateId} onChange={(e) => e.target.checked && updateCurrentGraph((g) => { g.initialState = stateId; })} />
        initialState
      </label>
      <ActionListField
        label="onEnterActions"
        actions={state.onEnterActions ?? []}
        catalog={props.catalog}
        knownSignals={props.knownSignals}
        onChange={(actions) => updateCurrentGraph((g) => { g.states[stateId].onEnterActions = actions; })}
      />
      <ActionListField
        label="onExitActions"
        actions={state.onExitActions ?? []}
        catalog={props.catalog}
        knownSignals={props.knownSignals}
        onChange={(actions) => updateCurrentGraph((g) => { g.states[stateId].onExitActions = actions; })}
      />
      <div className="inspector-actions">
        <button onClick={async () => {
          const result = await setRuntimeNarrativeState(graph.id, stateId);
          props.setRuntimeSnapshot(result);
          props.setStatus(result.ok ? `Runtime set ${graph.id}.${stateId}` : `Runtime unavailable: ${result.reason}`);
        }}>Runtime setState</button>
      </div>
    </div>
  );
}

function TransitionInspector(props: {
  data: NarrativeGraphsFileDef;
  composition?: NarrativeCompositionDef;
  graph: NarrativeGraphDef;
  transition: NarrativeTransitionDef;
  knownSignals: string[];
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setSelectedId: (id: string) => void;
  setStatus: (status: string) => void;
  deleteSelected: () => void;
}) {
  const { graph, transition, updateCurrentGraph } = props;
  const endpointChoices = allEndpointChoices(props.data);
  const graphIds = compileGraphs(props.data).map((item) => item.graph.id);
  return (
    <div className="form-grid">
      <TextField
        label="id"
        value={transition.id}
        commitOnBlur
        onChange={(value) => updateCurrentGraph((g) => {
          try {
            const newId = renameTransition(g, transition.id, value);
            props.setSelectedId(`transition:${newId}`);
          } catch (e) {
            props.setStatus(String(e));
          }
        })}
      />
      <TextField
        label="from"
        value={endpointInputValue(transition.from, graph.id)}
        datalistValues={endpointChoices}
        onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).from = parseEndpointInput(value, g.id, graphIds); })}
      />
      <TextField
        label="to"
        value={endpointInputValue(transition.to, graph.id)}
        datalistValues={endpointChoices}
        onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).to = parseEndpointInput(value, g.id, graphIds); })}
      />
      <div className="property-line">Endpoint 可写本图 stateId，或跨图 graphId.stateId。跨图 transition 必须存放在 from 所属图里。</div>
      <TextField label="signal" value={transition.signal} datalistId="knownSignals" onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).signal = value; })} />
      <NumberField label="priority" value={transition.priority ?? 0} onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).priority = value; })} />
      <JsonValueField label="conditions" value={transition.conditions ?? []} onApply={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).conditions = Array.isArray(value) ? value : []; })} />
      <div className="inspector-actions">
        <button type="button" onClick={props.deleteSelected}>断开迁移边</button>
      </div>
    </div>
  );
}

function ElementInspector(props: {
  composition?: NarrativeCompositionDef;
  element: CompositionElementDef;
  catalog: AuthoringCatalogDef;
  updateData: (updater: (next: NarrativeGraphsFileDef) => void) => void;
  setSelectedId: (id: string) => void;
  setGraphRef: (ref: GraphRef) => void;
  setStatus: (status: string) => void;
  expandedElementIds: string[];
  toggleExpandedElement: (elementId: string) => void;
}) {
  const { composition, element, catalog, updateData } = props;
  const ownerChoices = ownerChoicesFor(element, catalog);
  const isSubgraph = isSubgraphElement(element);
  const expanded = props.expandedElementIds.includes(element.id);
  return (
    <div className="form-grid">
      <TextField
        label="id"
        value={element.id}
        commitOnBlur
        onChange={(value) => updateData((next) => {
          const comp = getComposition(next, composition?.id ?? '');
          if (!comp) return;
          try {
            const newId = renameElement(comp, element.id, value);
            props.setSelectedId(`element:${newId}`);
          } catch (e) {
            props.setStatus(String(e));
          }
        })}
      />
      <div className="property-line">{kindLabel(element.kind)}</div>
      <TextField label="label" value={element.label ?? ''} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.label = value; })} />
      {element.kind === 'wrapperGraph' ? (
        <>
          <SelectField label="绑定类型" value={element.ownerType ?? 'npc'} values={wrapperOwnerTypes} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.ownerType = value; if (el.graph) el.graph.ownerType = value; })} />
          <TextField label="绑定实体/NPC ownerId" value={element.ownerId ?? ''} datalistValues={ownerChoices} onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
            el.ownerId = value;
            if (el.graph) el.graph.ownerId = value;
          })} />
          <div className="property-line">绑定后运行时可通过 ownerType/ownerId 将该 wrapper 图归属到对应实体。</div>
        </>
      ) : element.kind === 'scenarioSubgraph' ? (
        <>
          <TextField label="scenarioId" value={element.refId || element.ownerId || ''} datalistValues={ownerChoices} onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
            el.refId = value;
            el.ownerId = value;
            el.ownerType = 'scenario';
            if (el.graph) {
              el.graph.ownerType = 'scenario';
              el.graph.ownerId = value;
            }
          })} />
          {element.graph && (
            <>
              <SelectField label="entryState" value={element.graph.entryState ?? ''} values={Object.keys(element.graph.states)} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { if (el.graph) el.graph.entryState = value; })} />
              <StringListField label="exitStates" value={element.graph.exitStates ?? []} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { if (el.graph) el.graph.exitStates = value; })} />
            </>
          )}
          <div className="property-line">Scenario 是有边界的局部子图：外部只能连 entryState，只有 exitStates 能连回外部。</div>
        </>
      ) : (
        <>
          <TextField label="source type" value={element.ownerType ?? ''} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.ownerType = value; })} />
          <TextField label="refId" value={element.refId ?? ''} datalistValues={ownerChoices} onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
            el.refId = value;
          })} />
        </>
      )}
      <StringListField label="emits" value={element.meta?.emits ?? []} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.emits = value; })} />
      <StringListField label="reads" value={element.meta?.reads ?? []} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.reads = value; })} />
      {isSubgraph && (
        <div className="inspector-actions">
          <button type="button" onClick={() => props.toggleExpandedElement(element.id)}>{expanded ? '在主画布收起子图' : '在主画布展开子图'}</button>
          <button type="button" onClick={() => props.setGraphRef(`element:${element.id}`)}>Open Subgraph</button>
        </div>
      )}
    </div>
  );
}

function ExternalWiringInspector({ edge }: { edge: ProjectionEdgeDef }) {
  const title = edge.kind === 'trigger'
    ? '外部触发'
    : edge.kind === 'read'
      ? '外部读取'
      : '强制设状态';
  return (
    <div className="form-grid">
      <div className="property-line">
        <b>{title}</b>
        <div className="muted">只读接线，不会保存为叙事图的一部分。</div>
      </div>
      <ReadOnlyField label="source" value={edge.source} />
      <ReadOnlyField label="target" value={edge.target} />
      <ReadOnlyField label="label" value={edge.label || ''} />
      <ReadOnlyField label="detail" value={edge.detail || ''} />
      <div className="property-line">
        {edge.kind === 'trigger'
          ? '含义：source 发出的信号会触发 target 指向的迁移。'
          : edge.kind === 'read'
            ? '含义：source 的叙事状态会被 target 对应的外部系统读取。'
            : '含义：source 对应的外部 action 会直接设置 target 指向的叙事状态。'}
      </div>
    </div>
  );
}

function PreviewPanel({ simulation, runtimeSnapshot }: { simulation: SimulationResult | null; runtimeSnapshot: RuntimeDebugSnapshotDef }) {
  const activeStates = extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? {};
  return (
    <div className="preview-panel">
      <div className="section-title">Active States</div>
      <pre>{Object.keys(activeStates).length ? JSON.stringify(activeStates, null, 2) : '(none)'}</pre>
      {simulation && (
        <>
          <div className="section-title">Simulation Log</div>
          <div className="timeline">
            {simulation.log.slice(-8).map((line, index) => <div key={`${line}-${index}`} className="log">{line}</div>)}
          </div>
        </>
      )}
    </div>
  );
}

function StateNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div className={`node state-node ${data.boundary ? `boundary-${data.boundary}` : ''} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
      {data.boundary && <div className="node-detail">{data.boundary === 'entryExit' ? 'Scenario entry / exit' : `Scenario ${data.boundary}`}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ElementNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div className={`node element-node ${data.kind} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
      {data.detail && <div className="node-detail">{data.detail}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function AnchorNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div className={`node anchor-node ${data.kind} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
      {data.detail && <div className="node-detail">{data.detail}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function TransitionAnchorNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`transition-anchor ${selected ? 'selected' : ''}`}
      title={data.detail || 'Transition trigger point'}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function StyledEdge(props: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const kind = props.data?.edgeKind ?? 'transition';
  const selected = props.selected === true;
  const showLabel = kind === 'transition';
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={props.markerEnd}
        style={{
          stroke: edgeColor(kind),
          strokeWidth: selected ? 4 : kind === 'transition' ? 2.4 : 2.2,
          strokeDasharray: kind === 'transition' ? undefined : kind === 'stateCommand' ? '2 5' : '6 5',
          filter: selected ? `drop-shadow(0 0 5px ${edgeColor(kind)})` : undefined,
        }}
      />
      {showLabel && props.label && (
        <foreignObject width={220} height={44} x={labelX - 110} y={labelY - 22} className="edge-label-wrap">
          <div className={`edge-label ${kind}`}>{String(props.label)}</div>
        </foreignObject>
      )}
    </>
  );
}

function toNodes(
  comp: NarrativeCompositionDef,
  graph: NarrativeGraphDef,
  graphRef: GraphRef,
  activeStates: Record<string, string>,
  projection: ProjectionResult,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
  expandedElementIds: string[],
  selectedId: string,
): CanvasNode[] {
  const states: CanvasNode[] = Object.entries(graph.states ?? {}).map(([sid, state], index) => ({
    id: `state:${sid}`,
    type: 'state',
    position: stateEditorPosition(state, index),
    zIndex: 20,
    deletable: true,
    selected: selectedId === `state:${sid}`,
    data: {
      label: state.label || sid,
      subtitle: `State / ${sid}`,
      kind: 'state' as const,
      boundary: scenarioBoundaryKind(graph, sid),
      active: activeStates[graph.id] === sid,
    },
  }));
  if (graphRef !== 'main') return states;
  const graphAnchor: CanvasNode = {
    id: `graph:${graph.id}`,
    type: 'graphAnchor',
    position: { x: -260, y: -80 },
    zIndex: 20,
    draggable: false,
    deletable: false,
    selected: selectedId === `graph:${graph.id}`,
    data: {
      label: graph.label || graph.id,
      subtitle: 'Main Graph',
      kind: 'graphAnchor',
      detail: graph.id,
      active: Boolean(activeStates[graph.id]),
    },
  };
  const elements: CanvasNode[] = (comp.elements ?? []).map((el, index) => ({
    id: `element:${el.id}`,
    type: el.kind,
    position: { x: Number(el.x ?? 120 + index * 220), y: Number(el.y ?? 40) },
    zIndex: 20,
    deletable: true,
    selected: selectedId === `element:${el.id}`,
    data: {
      label: el.label || el.id,
      subtitle: elementSubtitle(el),
      kind: el.kind,
      detail: el.refId || el.ownerId || el.graph?.id || '',
      active: Boolean(el.graph && activeStates[el.graph.id] && activeStates[el.graph.id] !== el.graph.initialState),
    },
  }));
  const inlineNodes: CanvasNode[] = [];
  for (const el of comp.elements ?? []) {
    if (!expandedElementIds.includes(el.id) || !isSubgraphElement(el) || !el.graph) continue;
    const base = inlineSubgraphBase(el);
    for (const [sid, state] of Object.entries(el.graph.states ?? {})) {
      const pos = stateEditorPosition(state, inlineNodes.length);
      const boundary = scenarioBoundaryKind(el.graph, sid);
      inlineNodes.push({
        id: inlineSubgraphStateId(el.id, sid),
        type: 'state',
        position: { x: base.x + pos.x, y: base.y + pos.y },
        zIndex: 20,
        deletable: true,
        selected: selectedId === inlineSubgraphStateId(el.id, sid),
        data: {
          label: state.label || sid,
          subtitle: `${el.label || el.id} / ${sid}`,
          kind: 'state' as const,
          boundary,
          detail: el.graph.id,
          active: activeStates[el.graph.id] === sid,
        },
      });
    }
  }
  const transitionAnchors = buildTransitionAnchorNodes(comp, graph, expandedElementIds, selectedId);
  const baseNodes = [graphAnchor, ...states, ...elements, ...inlineNodes, ...transitionAnchors];
  const knownIds = new Set(baseNodes.map((node) => node.id));
  const anchors: CanvasNode[] = [];
  const visibleExternalEdges = visibleProjectionEdgesForComposition(comp, projection, showTrigger, showRead, showCommand);
  for (const edge of visibleExternalEdges) {
    for (const endpoint of [edge.source, edge.target]) {
      if (!endpoint || knownIds.has(endpoint)) continue;
      knownIds.add(endpoint);
      const index = anchors.length;
      anchors.push({
        id: endpoint,
        type: endpoint.startsWith('transition-anchor:') ? 'transitionAnchor' : 'projectionAnchor',
        position: { x: 760 + (index % 2) * 210, y: 120 + Math.floor(index / 2) * 96 },
        draggable: false,
        deletable: false,
        selected: selectedId === endpoint,
        data: {
          label: projectionEndpointLabel(endpoint),
          subtitle: 'Projection Endpoint',
          kind: 'projectionAnchor',
          detail: endpoint,
        },
      });
    }
  }
  return [...baseNodes, ...anchors];
}

function toEdges(
  comp: NarrativeCompositionDef,
  graph: NarrativeGraphDef,
  graphRef: GraphRef,
  projection: ProjectionResult,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
  expandedElementIds: string[],
  selectedId: string,
): CanvasEdge[] {
  const transitionEdges: CanvasEdge[] = (graph.transitions ?? []).map((t) => ({
    id: `transition:${t.id}`,
    source: nodeIdForEndpoint(t.from, graph.id, comp, expandedElementIds),
    target: nodeIdForEndpoint(t.to, graph.id, comp, expandedElementIds),
    type: 'transition',
    label: t.signal,
    selected: selectedId === `transition:${t.id}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { edgeKind: 'transition', label: t.signal, detail: `${graph.id}.${t.id}` },
  }));
  if (graphRef !== 'main') return transitionEdges;
  const inlineTransitionEdges: CanvasEdge[] = [];
  for (const el of comp.elements ?? []) {
    if (!expandedElementIds.includes(el.id) || !isSubgraphElement(el) || !el.graph) continue;
    for (const t of el.graph.transitions ?? []) {
      inlineTransitionEdges.push({
        id: inlineSubgraphTransitionId(el.id, t.id),
        source: nodeIdForEndpoint(t.from, el.graph.id, comp, expandedElementIds),
        target: nodeIdForEndpoint(t.to, el.graph.id, comp, expandedElementIds),
        type: 'transition',
        label: t.signal,
        selected: selectedId === inlineSubgraphTransitionId(el.id, t.id),
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'transition', label: t.signal, detail: `${el.graph.id}.${t.id}` },
      });
    }
  }
  const projectionEdges = visibleProjectionEdgesForComposition(comp, projection, showTrigger, showRead, showCommand).map((edge) => ({
    ...toProjectionEdge(edge, edge.kind),
    selected: selectedId === `projection:${edge.id}`,
  }));
  return [...transitionEdges, ...inlineTransitionEdges, ...projectionEdges.filter((edge) => edge.source && edge.target)];
}

function toProjectionEdge(edge: ProjectionEdgeDef, kind: 'trigger' | 'read' | 'stateCommand'): CanvasEdge {
  const color = edgeColor(kind);
  return {
    id: `projection:${edge.id}`,
    source: edge.source,
    target: edge.target,
    type: 'projection',
    label: edge.label,
    selectable: true,
    deletable: false,
    interactionWidth: 8,
    zIndex: 0,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    data: { edgeKind: kind, label: edge.label, detail: edge.detail ?? edge.id },
  };
}

function visibleProjectionEdges(
  projection: ProjectionResult,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
): ProjectionEdgeDef[] {
  return [
    ...(showTrigger ? projection.triggerEdges : []),
    ...(showRead ? projection.readEdges : []),
    ...(showCommand ? projection.stateCommandEdges ?? [] : []),
  ];
}

function visibleProjectionEdgesForComposition(
  comp: NarrativeCompositionDef,
  projection: ProjectionResult,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
): ProjectionEdgeDef[] {
  const scoped = visibleProjectionEdges(projection, showTrigger, showRead, showCommand)
    .filter((edge) => edge.compositionId === comp.id);
  if (scoped.length > 0) return scoped;

  const elementNodeIds = new Set((comp.elements ?? []).map((el) => `element:${el.id}`));
  const transitionAnchorIds = new Set<string>();
  for (const graph of [
    comp.mainGraph,
    ...(comp.elements ?? []).map((el) => el.graph).filter((graph): graph is NarrativeGraphDef => Boolean(graph)),
  ]) {
    for (const transition of graph.transitions ?? []) {
      transitionAnchorIds.add(transitionAnchorId(graph.id, transition.id));
    }
  }
  return visibleProjectionEdges(projection, showTrigger, showRead, showCommand).filter((edge) => {
    if (edge.compositionId && edge.compositionId !== comp.id) return false;
    if (elementNodeIds.has(edge.source) || elementNodeIds.has(edge.target)) return true;
    if (transitionAnchorIds.has(edge.source) || transitionAnchorIds.has(edge.target)) return true;
    return false;
  });
}

function projectionEndpointLabel(endpoint: string): string {
  if (endpoint.startsWith('graph:')) return endpoint.slice('graph:'.length);
  if (endpoint.startsWith('state:')) return endpoint.slice('state:'.length);
  if (endpoint.startsWith('transition-anchor:')) return endpoint.replace(/^transition-anchor:/, '').replace(/:/g, '.');
  if (endpoint.startsWith('element:')) return endpoint.slice('element:'.length);
  return endpoint.replace(/^projection-anchor:/, '').replace(/^external:/, '');
}

function getNodeObject(comp: NarrativeCompositionDef | undefined, graph: NarrativeGraphDef | undefined, nodeId: string) {
  if (!comp || !graph) return null;
  const inline = parseInlineSubgraphId(nodeId);
  if (inline?.kind === 'state') {
    return comp.elements?.find((el) => el.id === inline.elementId)?.graph?.states[inline.objectId] ?? null;
  }
  if (inline?.kind === 'transition') {
    return comp.elements?.find((el) => el.id === inline.elementId)?.graph?.transitions.find((t) => t.id === inline.objectId) ?? null;
  }
  if (nodeId.startsWith('graph:') || nodeId.startsWith('projection-anchor:') || nodeId.startsWith('transition-anchor:')) return graph;
  if (nodeId.startsWith('state:')) return graph.states[nodeId.slice('state:'.length)];
  if (nodeId.startsWith('element:')) return getElementByNodeId(comp, nodeId);
  return graph;
}

function getSelectedSummary(comp: NarrativeCompositionDef | undefined, graph: NarrativeGraphDef | undefined, graphRef: GraphRef, selectedId: string) {
  if (!selectedId || !comp || !graph) return { title: graph?.id ?? 'Nothing selected', subtitle: 'Graph inspector', navigate: null as null | { kind: string; id: string } };
  const inline = parseInlineSubgraphId(selectedId);
  if (inline) {
    const element = comp.elements?.find((el) => el.id === inline.elementId);
    return {
      title: inline.objectId,
      subtitle: `${element?.label || inline.elementId} inline ${inline.kind}`,
      navigate: null,
    };
  }
  if (selectedId.startsWith('graph:')) return { title: selectedId.slice('graph:'.length), subtitle: 'Graph anchor', navigate: null };
  if (selectedId.startsWith('transition-anchor:')) return { title: projectionEndpointLabel(selectedId), subtitle: 'Transition trigger anchor', navigate: null };
  if (selectedId.startsWith('projection-anchor:')) return { title: projectionEndpointLabel(selectedId), subtitle: 'Projection endpoint', navigate: null };
  if (selectedId.startsWith('state:')) return { title: selectedId.slice(6), subtitle: `State in ${graph.id}`, navigate: null };
  if (selectedId.startsWith('transition:')) return { title: selectedId.slice(11), subtitle: `Transition in ${graph.id}`, navigate: null };
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const el = getElementByNodeId(comp, selectedId);
    return { title: el?.label || selectedId.slice(8), subtitle: elementSubtitle(el), navigate: navigationForElement(el) };
  }
  return { title: selectedId, subtitle: 'Readonly projection edge', navigate: null };
}

function isSelectionDeletable(selectedId: string, graphRef: GraphRef): boolean {
  return (
    parseInlineSubgraphId(selectedId) !== null
    || selectedId.startsWith('state:')
    || selectedId.startsWith('transition:')
    || (graphRef === 'main' && selectedId.startsWith('element:'))
  );
}

function inlineSubgraphStateId(elementId: string, stateId: string): string {
  return `subgraph:${elementId}:state:${stateId}`;
}

function inlineSubgraphTransitionId(elementId: string, transitionId: string): string {
  return `subgraph:${elementId}:transition:${transitionId}`;
}

function parseInlineSubgraphId(id: string): null | { elementId: string; kind: 'state' | 'transition'; objectId: string } {
  const match = /^subgraph:([^:]+):(state|transition):(.+)$/.exec(id);
  if (!match) return null;
  return { elementId: match[1], kind: match[2] as 'state' | 'transition', objectId: match[3] };
}

function prefixInlineSelection(elementId: string, id: string): string {
  if (id.startsWith('state:')) return inlineSubgraphStateId(elementId, id.slice('state:'.length));
  if (id.startsWith('transition:')) return inlineSubgraphTransitionId(elementId, id.slice('transition:'.length));
  return id;
}

function inlineSubgraphBase(element: CompositionElementDef): { x: number; y: number } {
  return {
    x: Number(element.x ?? 0) + 24,
    y: Number(element.y ?? 0) + 150,
  };
}

function transitionAnchorId(graphId: string, transitionId: string): string {
  return `transition-anchor:${graphId}:${transitionId}`;
}

function nodeIdForEndpoint(
  endpoint: NarrativeEndpointDef,
  ownerGraphId: string,
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
): string {
  const resolved = resolveEndpoint(endpoint, ownerGraphId);
  if (resolved.graphId === comp.mainGraph.id) return `state:${resolved.stateId}`;
  const element = comp.elements?.find((el) => el.graph?.id === resolved.graphId);
  if (!element) return `projection-anchor:${resolved.graphId}.${resolved.stateId}`;
  if (expandedElementIds.includes(element.id)) return inlineSubgraphStateId(element.id, resolved.stateId);
  return `element:${element.id}`;
}

function buildTransitionAnchorNodes(
  comp: NarrativeCompositionDef,
  mainGraph: NarrativeGraphDef,
  expandedElementIds: string[],
  selectedId: string,
): CanvasNode[] {
  const out: CanvasNode[] = [];
  const addGraphAnchors = (graph: NarrativeGraphDef, element?: CompositionElementDef) => {
    const graphBase = element ? inlineSubgraphBase(element) : { x: 0, y: 0 };
    for (const [index, transition] of (graph.transitions ?? []).entries()) {
      const from = resolveEndpoint(transition.from, graph.id);
      const to = resolveEndpoint(transition.to, graph.id);
      const fromPos = from.graphId === graph.id ? stateEditorPosition(graph.states[from.stateId] ?? { id: from.stateId }, index) : null;
      const toPos = to.graphId === graph.id ? stateEditorPosition(graph.states[to.stateId] ?? { id: to.stateId }, index) : null;
      const x = graphBase.x + (fromPos && toPos ? (fromPos.x + toPos.x) / 2 : 160 + index * 36);
      const y = graphBase.y + (fromPos && toPos ? (fromPos.y + toPos.y) / 2 - 54 : 72 + index * 42);
      out.push({
        id: transitionAnchorId(graph.id, transition.id),
        type: 'transitionAnchor',
        position: { x, y },
        draggable: false,
        deletable: false,
        selectable: true,
        selected: selectedId === transitionAnchorId(graph.id, transition.id),
        data: {
          label: '',
          subtitle: 'Trigger point',
          kind: 'transitionAnchor',
          detail: transition.signal,
        },
      });
    }
  };
  addGraphAnchors(mainGraph);
  for (const element of comp.elements ?? []) {
    if (expandedElementIds.includes(element.id) && isSubgraphElement(element) && element.graph) {
      addGraphAnchors(element.graph, element);
    }
  }
  return out;
}

function stateEndpointFromNodeId(
  nodeId: string,
  comp: NarrativeCompositionDef,
  mainGraph: NarrativeGraphDef,
): null | { graphId: string; stateId: string; elementId?: string; elementKind?: ElementKind } {
  if (nodeId.startsWith('state:')) {
    return { graphId: mainGraph.id, stateId: nodeId.slice('state:'.length) };
  }
  const inline = parseInlineSubgraphId(nodeId);
  if (inline?.kind !== 'state') return null;
  const element = comp.elements?.find((el) => el.id === inline.elementId);
  if (!element?.graph) return null;
  return { graphId: element.graph.id, stateId: inline.objectId, elementId: element.id, elementKind: element.kind };
}

function canConnectStateEndpoints(
  comp: NarrativeCompositionDef,
  source: { graphId: string; stateId: string; elementKind?: ElementKind },
  target: { graphId: string; stateId: string; elementKind?: ElementKind },
): { ok: true } | { ok: false; reason: string } {
  if (source.graphId === target.graphId) return { ok: true };
  const sourceGraph = findGraphById(comp, source.graphId);
  const targetGraph = findGraphById(comp, target.graphId);
  const sourceKind = graphElementKind(comp, source.graphId);
  const targetKind = graphElementKind(comp, target.graphId);
  if (sourceKind === 'wrapperGraph' || targetKind === 'wrapperGraph') {
    return { ok: false, reason: 'Wrapper graph 不能和外部 state 直接连线，请通过 owner/signal/action 接入。' };
  }
  if ((targetKind === 'scenarioSubgraph' || targetGraph?.ownerType === 'scenario') && target.stateId !== targetGraph?.entryState) {
    return { ok: false, reason: '外部只能连接到 scenario 的 entryState。' };
  }
  if ((sourceKind === 'scenarioSubgraph' || sourceGraph?.ownerType === 'scenario') && !(sourceGraph?.exitStates ?? []).includes(source.stateId)) {
    return { ok: false, reason: 'scenario 只能从 exitStates 连接到外部。' };
  }
  return { ok: true };
}

function findGraphById(comp: NarrativeCompositionDef | undefined, graphId: string): NarrativeGraphDef | undefined {
  if (!comp) return undefined;
  if (comp.mainGraph.id === graphId) return comp.mainGraph;
  return comp.elements?.find((el) => el.graph?.id === graphId)?.graph;
}

function graphElementKind(comp: NarrativeCompositionDef, graphId: string): ElementKind | undefined {
  return comp.elements?.find((el) => el.graph?.id === graphId)?.kind;
}

function removeTransitionsReferencingState(comp: NarrativeCompositionDef, targetGraphId: string, stateId: string): void {
  const graphs = [
    comp.mainGraph,
    ...(comp.elements ?? []).map((el) => el.graph).filter((graph): graph is NarrativeGraphDef => Boolean(graph)),
  ];
  for (const graph of graphs) {
    graph.transitions = (graph.transitions ?? []).filter((transition) => {
      const from = resolveEndpoint(transition.from, graph.id);
      const to = resolveEndpoint(transition.to, graph.id);
      return !(from.graphId === targetGraphId && from.stateId === stateId) &&
        !(to.graphId === targetGraphId && to.stateId === stateId);
    });
  }
}

function scenarioBoundaryKind(graph: NarrativeGraphDef, stateId: string): 'entry' | 'exit' | 'entryExit' | undefined {
  if (graph.ownerType !== 'scenario' && !graph.entryState && !graph.exitStates?.length) return undefined;
  const isEntry = graph.entryState === stateId;
  const isExit = (graph.exitStates ?? []).includes(stateId);
  if (isEntry && isExit) return 'entryExit';
  if (isEntry) return 'entry';
  if (isExit) return 'exit';
  return undefined;
}

function navigationForElement(el?: CompositionElementDef) {
  if (!el) return null;
  if (el.kind === 'dialogueBlackbox' && el.refId) return { kind: 'dialogue', id: el.refId };
  if (el.kind === 'scenarioSubgraph' && (el.refId || el.ownerId)) return { kind: 'scenario', id: el.refId || el.ownerId! };
  if (el.kind === 'zoneBlackbox' && el.refId) return { kind: 'sceneEntity', id: el.refId };
  if (el.kind === 'minigameBlackbox' && el.refId) return { kind: 'minigame', id: el.refId };
  if (el.kind === 'cutsceneBlackbox' && el.refId) return { kind: 'cutscene', id: el.refId };
  if (el.kind === 'wrapperGraph' && el.ownerType === 'quest' && el.ownerId) return { kind: 'quest', id: el.ownerId };
  if (el.kind === 'wrapperGraph' && el.ownerId) return { kind: 'sceneEntity', id: el.ownerId };
  return null;
}

function elementSubtitle(el?: CompositionElementDef) {
  if (!el) return '';
  if (el.kind === 'wrapperGraph') return `Wrapper / ${el.ownerType || 'entity'}`;
  if (el.kind === 'scenarioSubgraph') return 'Scenario subgraph';
  return el.kind.replace('Blackbox', ' blackbox');
}

function updateElement(
  updateData: (updater: (next: NarrativeGraphsFileDef) => void) => void,
  composition: NarrativeCompositionDef | undefined,
  elementId: string,
  updater: (element: CompositionElementDef) => void,
) {
  updateData((next) => {
    const comp = getComposition(next, composition?.id ?? '');
    const element = comp?.elements?.find((el) => el.id === elementId);
    if (element) updater(element);
  });
}

function transitionIn(graph: NarrativeGraphDef, transitionId: string): NarrativeTransitionDef {
  const transition = graph.transitions.find((t) => t.id === transitionId);
  if (!transition) throw new Error(`Transition not found: ${transitionId}`);
  return transition;
}

function findProjectionEdge(projection: ProjectionResult, edgeId: string): ProjectionEdgeDef | undefined {
  return [...projection.triggerEdges, ...projection.readEdges, ...(projection.stateCommandEdges ?? [])].find((edge) => edge.id === edgeId);
}

function extractActiveStates(runtimeSnapshot: RuntimeDebugSnapshotDef): Record<string, string> | null {
  if (!runtimeSnapshot.ok || !runtimeSnapshot.snapshot || typeof runtimeSnapshot.snapshot !== 'object') return null;
  const snap = runtimeSnapshot.snapshot as { narrativeState?: { activeStates?: Record<string, string> } };
  return snap.narrativeState?.activeStates ?? null;
}

function ownerChoicesFor(element: CompositionElementDef, catalog: AuthoringCatalogDef): string[] {
  if (element.kind === 'dialogueBlackbox') return catalog.dialogueGraphIds;
  if (element.kind === 'scenarioSubgraph') return catalog.scenarioIds;
  if (element.kind === 'zoneBlackbox') return catalog.zoneRefs;
  if (element.kind === 'minigameBlackbox') return catalog.minigameIds;
  if (element.kind === 'cutsceneBlackbox') return catalog.cutsceneIds;
  if (element.ownerType === 'quest') return catalog.questIds;
  if (element.ownerType === 'dialogue') return catalog.dialogueGraphIds;
  if (element.ownerType === 'minigame') return catalog.minigameIds;
  if (element.ownerType === 'cutscene') return catalog.cutsceneIds;
  if (element.ownerType === 'zone') return catalog.zoneRefs;
  if (element.ownerType === 'scenario') return catalog.scenarioIds;
  return catalog.sceneEntityRefs;
}

function allEndpointChoices(data: NarrativeGraphsFileDef): string[] {
  const out: string[] = [];
  for (const { graph } of compileGraphs(data)) {
    for (const stateId of Object.keys(graph.states ?? {})) out.push(`${graph.id}.${stateId}`);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function kindLabel(kind: ElementKind): string {
  if (kind === 'wrapperGraph') return 'Wrapper';
  if (kind === 'scenarioSubgraph') return 'Scenario';
  if (kind === 'dialogueBlackbox') return 'Dialogue';
  if (kind === 'zoneBlackbox') return 'Zone';
  if (kind === 'minigameBlackbox') return 'Minigame';
  return 'Cutscene';
}

function edgeColor(kind: string): string {
  if (kind === 'transition') return '#d9a441';
  if (kind === 'trigger') return '#45a8e5';
  if (kind === 'read') return '#79b65d';
  return '#d782d9';
}

function actionArray(value: unknown): ActionDef[] {
  return Array.isArray(value) ? value as ActionDef[] : [];
}

function TextField({ label, value, onChange, commitOnBlur, datalistId, datalistValues }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  commitOnBlur?: boolean;
  datalistId?: string;
  datalistValues?: string[];
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const listId = datalistId || (datalistValues?.length ? `${label.replace(/\W/g, '_')}_choices` : undefined);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        list={listId}
        value={commitOnBlur ? draft : value}
        onChange={(e) => commitOnBlur ? setDraft(e.target.value) : onChange(e.target.value)}
        onBlur={() => commitOnBlur && onChange(draft)}
      />
      {datalistValues && listId && <datalist id={listId}>{datalistValues.map((item) => <option key={item} value={item} />)}</datalist>}
    </div>
  );
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <textarea className="small-textarea" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
    </div>
  );
}

function SelectField({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {values.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
  );
}

function StringListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <textarea className="small-textarea" value={value.join('\n')} onChange={(e) => onChange(e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))} />
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="readonly-field">{value || '(none)'}</div>
    </div>
  );
}

function ActionListField({
  label,
  actions,
  catalog,
  knownSignals,
  onChange,
}: {
  label: string;
  actions: ActionDef[];
  catalog: AuthoringCatalogDef;
  knownSignals: string[];
  onChange: (actions: ActionDef[]) => void;
}) {
  const [editError, setEditError] = useState('');
  const editInNativeActionEditor = async () => {
    const result = await editActionsNative(label, actions);
    if (result.ok && Array.isArray(result.actions)) {
      setEditError('');
      onChange(result.actions);
      return;
    }
    if (result.reason !== 'cancelled') {
      setEditError(result.reason ?? 'Native ActionEditor did not return actions');
    }
  };
  return (
    <div className="action-editor native-action-editor">
      <div className="action-editor-title">
        <b>{label}</b>
        <span>使用与主编辑器一致的原生 ActionEditor。</span>
      </div>
      <div className="action-summary-list">
        {actions.length === 0 ? (
          <div className="action-empty-params">暂无 Action。</div>
        ) : actions.map((action, index) => {
          const params = action.params && typeof action.params === 'object' ? action.params : {};
          const summary = Object.entries(params)
            .slice(0, 4)
            .map(([key, value]) => `${key}: ${formatActionParamValue(value)}`)
            .join(' | ');
          const persistence = catalog.actionPersistence[action.type] === 'save' ? 'save' : 'memory';
          return (
            <div className="action-summary-row" key={`${index}-${action.type}`}>
              <span className={`save-dot ${persistence}`} title={persistence === 'save' ? '会修改持久化数据' : '运行时或演出 Action'} />
              <b>{index + 1}. {action.type || '(空 Action)'}</b>
              <span>{summary || '无参数'}</span>
            </div>
          );
        })}
      </div>
      <div className="inspector-actions">
        <button type="button" onClick={editInNativeActionEditor}>打开原生 ActionEditor</button>
      </div>
      {editError && <span className="field-error">{editError}</span>}
    </div>
  );

  const actionTypes = catalog.actionTypes.length ? catalog.actionTypes : ['setFlag', 'emitNarrativeSignal', 'setNarrativeState'];
  const updateAt = (index: number, action: ActionDef) => {
    const next = actions.slice();
    next[index] = action;
    onChange(next);
  };
  const move = (index: number, delta: number) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= actions.length) return;
    const next = actions.slice();
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="action-editor">
      <div className="action-editor-title"><b>{label}</b></div>
      <div className="action-row-list">
        {actions.map((action, index) => (
          <details className="action-row" key={`${index}-${action.type}`} defaultOpen={actions.length <= 1}>
            <summary>
              <select
                value={action.type || actionTypes[0]}
                onChange={(event) => {
                  const type = event.target.value;
                  updateAt(index, { type, params: defaultParamsForAction(type, catalog) });
                }}
              >
                {actionTypes.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <span className={`save-dot ${catalog.actionPersistence[action.type] === 'save' ? 'save' : 'memory'}`} title={catalog.actionPersistence[action.type] === 'save' ? '修改或影响持久化数据' : '运行时演出或瞬时状态'} />
              <button type="button" title="上移" disabled={index === 0} onClick={(event) => { event.preventDefault(); move(index, -1); }}>↑</button>
              <button type="button" title="下移" disabled={index === actions.length - 1} onClick={(event) => { event.preventDefault(); move(index, 1); }}>↓</button>
              <button type="button" title="删除" onClick={(event) => { event.preventDefault(); onChange(actions.filter((_a, i) => i !== index)); }}>−</button>
            </summary>
            <ActionParamsEditor
              action={action}
              catalog={catalog}
              knownSignals={knownSignals}
              onChange={(nextAction) => updateAt(index, nextAction)}
            />
          </details>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...actions, { type: 'setFlag', params: defaultParamsForAction('setFlag', catalog) }])}>
        + {label}
      </button>
    </div>
  );
}

function formatActionParamValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ActionParamsEditor({
  action,
  catalog,
  knownSignals,
  onChange,
}: {
  action: ActionDef;
  catalog: AuthoringCatalogDef;
  knownSignals: string[];
  onChange: (action: ActionDef) => void;
}) {
  const schema = catalog.actionParamSchemas[action.type] ?? [];
  if (schema.length === 0) {
    return <div className="action-empty-params">该 Action 没有可配置参数。</div>;
  }
  const params = action.params ?? {};
  return (
    <div className="action-params">
      {schema.map(([name, kind]) => (
        <ActionParamField
          key={name}
          actionType={action.type}
          name={name}
          kind={kind}
          value={params[name]}
          catalog={catalog}
          knownSignals={knownSignals}
          onChange={(value) => {
            onChange({ ...action, params: { ...params, [name]: value } });
          }}
        />
      ))}
    </div>
  );
}

function ActionParamField({
  actionType,
  name,
  kind,
  value,
  catalog,
  knownSignals,
  onChange,
}: {
  actionType: string;
  name: string;
  kind: string;
  value: unknown;
  catalog: AuthoringCatalogDef;
  knownSignals: string[];
  onChange: (value: unknown) => void;
}) {
  const choices = paramChoices(actionType, name, catalog, knownSignals);
  if (kind === 'bool') {
    return (
      <label className="action-param bool">
        <span>{name}</span>
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  if (kind === 'int' || kind === 'float') {
    return (
      <label className="action-param">
        <span>{name}</span>
        <input
          type="number"
          step={kind === 'int' ? 1 : 'any'}
          value={typeof value === 'number' ? value : 0}
          onChange={(event) => {
            const raw = Number(event.target.value);
            onChange(kind === 'int' ? Math.trunc(raw || 0) : raw || 0);
          }}
        />
      </label>
    );
  }
  const listId = choices.length ? `${actionType}_${name}_choices`.replace(/\W/g, '_') : undefined;
  return (
    <label className="action-param">
      <span>{name}</span>
      <input
        list={listId}
        value={typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''}
        onChange={(event) => onChange(coerceParamValue(event.target.value, kind))}
      />
      {listId && <datalist id={listId}>{choices.map((item) => <option key={item} value={item} />)}</datalist>}
    </label>
  );
}

function defaultParamsForAction(type: string, catalog: AuthoringCatalogDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, kind] of catalog.actionParamSchemas[type] ?? []) {
    if (kind === 'bool') out[name] = false;
    else if (kind === 'int' || kind === 'float') out[name] = 0;
    else out[name] = '';
  }
  return out;
}

function coerceParamValue(value: string, kind: string): unknown {
  if (kind === 'flag_val') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    const num = Number(value);
    if (value.trim() !== '' && Number.isFinite(num)) return num;
  }
  return value;
}

function paramChoices(actionType: string, name: string, catalog: AuthoringCatalogDef, knownSignals: string[]): string[] {
  if (name === 'sourceType') return ['dialogue', 'zone', 'minigame', 'cutscene', 'quest', 'action', 'entity', 'state', 'system'];
  if (name === 'graphId') return catalog.graphIds;
  if (name === 'signal') return knownSignals.map((sig) => sig.split(':').slice(3).join(':')).filter(Boolean);
  if (name === 'sourceId' && actionType === 'emitNarrativeSignal') return [...catalog.dialogueGraphIds, ...catalog.zoneRefs, ...catalog.minigameIds, ...catalog.cutsceneIds, ...catalog.questIds, ...catalog.sceneEntityRefs];
  if (name === 'id') {
    if (actionType === 'startCutscene') return catalog.cutsceneIds;
    if (actionType === 'startWaterMinigame' || actionType === 'startSugarWheelMinigame' || actionType === 'startPaperCraftMinigame') return catalog.minigameIds;
    if (actionType === 'updateQuest') return catalog.questIds;
    if (actionType === 'startDialogueGraph') return catalog.dialogueGraphIds;
  }
  if (name === 'target' || name === 'npcId' || name === 'entityId') return catalog.sceneEntityRefs;
  return [];
}

function JsonValueField({ label, value, onApply }: { label: string; value: unknown; onApply: (value: unknown) => void }) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(JSON.stringify(value, null, 2));
    setError('');
  }, [value]);
  return (
    <div className="field">
      <label>{label}</label>
      <textarea className="json-mini" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => {
        try {
          onApply(JSON.parse(draft));
          setError('');
        } catch (e) {
          setError(String(e));
        }
      }}>Apply {label}</button>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
