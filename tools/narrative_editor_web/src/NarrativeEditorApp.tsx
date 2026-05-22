import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import {
  applyFocusIssueResult,
  issueBelongsToActiveGraph,
  pickFocusFitNodeIds,
  resolveValidationIssueFocus,
  validationTargetSummary,
} from './focusIssueResolution';
import { buildCanvasEdges, buildCanvasNodes, stateEndpointFromNodeIdForView } from './canvas/buildCanvasModel';
import { resolveActiveGraphView } from './canvas/activeGraphView';
import { flowEdgeTypes } from './canvas/flowEdges';
import { flowNodeTypes } from './canvas/flowNodes';
import { applyCanvasSelection } from './canvas/canvasSelection';
import { NarrativeCanvasActionsProvider } from './canvas/canvasActionsContext';
import {
  expandParentsForPositionChanges,
  findTransitionByAnchorId,
  resizeSubgraphParents,
  SUBGRAPH_CHILD_ORIGIN,
} from './canvas/subgraphGroupLayout';
import { layoutComposition, layoutGraph } from './canvas/autoLayout';
import {
  shouldSnapTransitionAnchors,
  snapTransitionAnchorsToEdges,
} from './canvas/transitionAnchorLayout';
import { parseTransitionAnchorId, transitionAnchorId } from './anchorCodec';
import {
  inlineSubgraphStateId,
  inlineSubgraphTransitionId,
  parseInlineSubgraphId,
  prefixInlineSelection,
  projectionEndpointLabel,
} from './canvas/canvasIds';
import { ToolbarMenuDropdown, type ToolbarMenuItem } from './components/ToolbarMenuDropdown';
import { SettingsMenu } from './components/SettingsMenu';
import { ToolbarPopover } from './components/ToolbarPopover';
import { ConditionBuilder } from './components/ConditionBuilder';
import { SignalChipsField } from './components/SignalChipsField';
import { SignalPickerModal } from './components/SignalPickerModal';
import { DEFAULT_DRAFT_SIGNAL } from './signalConstants';
import {
  elementSubtitle,
  extractActiveStates,
  findGraphById,
  findProjectionEdge,
  isSelectionDeletable,
  navigationForElement,
  ownerChoicesFor,
  ownerChoicesForGraph,
  removeTransitionsReferencingState,
  transitionIn,
  updateElement,
} from './editor/appHelpers';
import { canvasModeLabel, kindLabel } from './editor/labels';
import { useDeferredWorkspace } from './hooks/useDeferredWorkspace';
import { useEditorHistory } from './hooks/useEditorHistory';
import { useEditorPreferences } from './hooks/useEditorPreferences';
import { usePanelResize } from './hooks/usePanelResize';
import { loadPanelLayout, savePanelLayout } from './utils/layoutStorage';
import { stableHash } from './utils/stableHash';
import type { CanvasMode, InspectorTab, IssueFilter } from './types/canvas';
import {
  clearLocalNarrativeDraft,
  reloadNarrativeEditorPage,
  emitRuntimeSignal,
  editActionsNative,
  getRuntimeSnapshot,
  loadAuthoringCatalog,
  loadNarrativeDataWithSource,
  navigateTo,
  saveNarrativeData,
  setRuntimeNarrativeState,
  validateNarrativeDataRemote,
} from './bridge';
import {
  collectKnownSignals,
  blockingValidationErrors,
  compileGraphs,
  createComposition,
  createElement,
  createState,
  createTransition,
  defaultFile,
  endpointLabel,
  emptyCatalog,
  getComposition,
  getEditableGraph,
  getElementByGraphRef,
  getElementByNodeId,
  graphLabel,
  isSubgraphElement,
  mergeValidationIssues,
  normalizeFile,
  parseExternalSignalKey,
  renameGraph,
  renameElement,
  renameStateInGraph,
  renameTransition,
  setStateEditorPosition,
  simulateSignalImpact,
  stateEditorPosition,
  stateEnteredSignalKey,
  validateNarrativeData,
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
  return (
    <ReactFlowProvider>
      <NarrativeEditorInner />
    </ReactFlowProvider>
  );
}

function NarrativeEditorInner() {
  const [data, setDataInternal] = useState<NarrativeGraphsFileDef>(defaultFile);
  const workspace = useDeferredWorkspace();
  const { projection, validationIssues, remoteSyncing, scheduleRemoteSync, flushRemoteSync, applyLocalValidation } = workspace;
  const [catalog, setCatalog] = useState<AuthoringCatalogDef>(emptyCatalog);
  const [compositionId, setCompositionId] = useState('');
  const [graphRef, setGraphRef] = useState<GraphRef>('main');
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedJson, setSelectedJson] = useState('');
  const [canvasMode, setCanvasMode] = useState<CanvasMode>('edit');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('properties');
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('all');
  const [showTrigger, setShowTrigger] = useState(false);
  const [showRead, setShowRead] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const { preferences, setPreferences, resetPreferences } = useEditorPreferences();
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [expandedElementIds, setExpandedElementIds] = useState<string[]>([]);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [validationCollapsed, setValidationCollapsed] = useState(false);
  const [panelLayout, setPanelLayout] = useState(loadPanelLayout);
  const [status, setStatus] = useState('就绪');
  const [fitViewRev, setFitViewRev] = useState(0);
  const [fitTargetNodeIds, setFitTargetNodeIds] = useState<string[]>([]);
  const pendingFitNodeIdsRef = useRef<string[] | null>(null);
  const { startLeft, startRight, startValidation } = usePanelResize({ setLayout: setPanelLayout, leftCollapsed, rightCollapsed });
  const [signalKey, setSignalKey] = useState('');
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeDebugSnapshotDef>({ ok: false, reason: 'Runtime not queried yet' });
  const [dirty, setDirty] = useState(false);
  const [savedDataHash, setSavedDataHash] = useState('');
  const [dataSource, setDataSource] = useState('');

  const { wrapUpdater, undo, redo, resetHistory } = useEditorHistory(data, setDataInternal, (next) => {
    scheduleRemoteSync(next);
  });

  const updateData = useCallback((updater: (next: NarrativeGraphsFileDef) => void) => {
    wrapUpdater(updater);
    setDirty(true);
  }, [wrapUpdater]);

  const compositions = data.compositions ?? [];
  const currentDataJson = useMemo(() => JSON.stringify(normalizeFile(data)), [data]);
  const currentDataHash = useMemo(() => stableHash(currentDataJson), [currentDataJson]);
  const editorDirty = dirty || (savedDataHash !== '' && currentDataHash !== savedDataHash);
  const composition = useMemo(() => getComposition(data, compositionId), [data, compositionId]);
  const graph = useMemo(() => getEditableGraph(composition, graphRef), [composition, graphRef]);
  const activeStates = useMemo(() => extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? {}, [runtimeSnapshot, simulation]);
  const knownSignals = useMemo(() => collectKnownSignals(data), [data]);
  const selectedObject = useMemo(
    () => getSelectedSummary(composition, graph, graphRef, selectedId),
    [composition, graph, graphRef, selectedId],
  );

  const refreshProjectionAndValidation = useCallback(async (nextData = data) => {
    await flushRemoteSync(normalizeFile(nextData));
  }, [data, flushRemoteSync]);

  useEffect(() => {
    void loadNarrativeDataWithSource().then(async (loaded) => {
      const next = normalizeFile(loaded.data);
      setDataInternal(next);
      setCompositionId(next.compositions?.[0]?.id ?? '');
      setSignalKey(collectKnownSignals(next)[0] ?? '');
      setCatalog(await loadAuthoringCatalog());
      await flushRemoteSync(next);
      setDataSource(loaded.source);
      setSavedDataHash(stableHash(JSON.stringify(next)));
      setDirty(false);
      resetHistory();
      setStatus(`已加载：${loaded.source}`);
    });
  }, []);

  useEffect(() => {
    const api = {
      getCurrentDataJson: () => currentDataJson,
      getCurrentDataHash: () => currentDataHash,
      isDirty: () => editorDirty,
      markSaved: () => {
        setSavedDataHash(currentDataHash);
        setDirty(false);
      },
      refresh: () => { void refreshProjectionAndValidation(data); },
    };
    window.__narrativeEditor = api;
    return () => {
      if (window.__narrativeEditor === api) {
        delete window.__narrativeEditor;
      }
    };
  }, [currentDataHash, currentDataJson, editorDirty, data, refreshProjectionAndValidation]);

  useEffect(() => {
    void flushRemoteSync(data);
  }, [compositionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (canvasMode === 'debug') setInspectorTab('debug');
  }, [canvasMode]);

  const canvasStructureInput = useMemo(() => {
    if (!composition || !graph) return null;
    return {
      comp: composition,
      graph,
      graphRef,
      activeStates,
      projection,
      canvasMode,
      showTrigger,
      showRead,
      showCommand,
      expandedElementIds,
    };
  }, [composition, graph, graphRef, activeStates, projection, canvasMode, showTrigger, showRead, showCommand, expandedElementIds]);

  const canvasStructureKey = useMemo(
    () => (canvasStructureInput ? JSON.stringify(canvasStructureInput) : ''),
    [canvasStructureInput],
  );

  useEffect(() => {
    if (!canvasStructureInput) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const builtEdges = buildCanvasEdges(canvasStructureInput);
    let builtNodes = buildCanvasNodes(canvasStructureInput);
    builtNodes = resizeSubgraphParents(builtNodes);
    setNodes(builtNodes);
    setEdges(builtEdges);

    let raf2 = 0;
    let raf3 = 0;
    const pendingFit = pendingFitNodeIdsRef.current;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setNodes((current) => {
          const snapped = snapTransitionAnchorsToEdges(current, builtEdges);
          return resizeSubgraphParents(snapped ?? current);
        });
        if (pendingFit?.length) {
          pendingFitNodeIdsRef.current = null;
          raf3 = requestAnimationFrame(() => {
            setFitTargetNodeIds(pendingFit);
            setFitViewRev((v) => v + 1);
          });
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      if (raf3) window.cancelAnimationFrame(raf3);
    };
  }, [canvasStructureKey]); // eslint-disable-line react-hooks/exhaustive-deps -- key encodes canvasStructureInput

  const { nodes: displayNodes, edges: displayEdges } = useMemo(
    () => applyCanvasSelection(nodes, edges, selectedId),
    [nodes, edges, selectedId],
  );

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

  const canvasActions = useMemo(() => ({
    toggleSubgraphElement: (elementId: string) => {
      const el = composition?.elements?.find((item) => item.id === elementId);
      if (!el || !isSubgraphElement(el)) return;
      toggleExpandedElement(elementId);
    },
  }), [composition, toggleExpandedElement]);

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
    const snapAnchors = shouldSnapTransitionAnchors(changes);
    setNodes((nds) => {
      let next = expandParentsForPositionChanges(nds, changes);
      next = applyNodeChanges(changes, next);
      const needsResize = changes.some((change) => {
        if (change.type !== 'position' && change.type !== 'dimensions') return false;
        if (change.id.startsWith('element:')) return true;
        return change.id.startsWith('subgraph:');
      });
      if (needsResize) next = resizeSubgraphParents(next);
      if (snapAnchors) {
        const snapped = snapTransitionAnchorsToEdges(next, edges);
        if (snapped) next = snapped;
      }
      return next;
    });
  }, [removeModelObjects, edges]);

  const onEdgesChange: OnEdgesChange<CanvasEdge> = useCallback((changes) => {
    const removedEdgeIds = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removedEdgeIds.length) removeModelObjects(removedEdgeIds);
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, [removeModelObjects]);

  const onConnect: OnConnect = useCallback((conn: Connection) => {
    if (!composition || !graph) return;
    const view = resolveActiveGraphView(composition, graphRef);
    if (!view) return;

    const source = stateEndpointFromNodeIdForView(conn.source ?? '', view);
    const target = stateEndpointFromNodeIdForView(conn.target ?? '', view);
    if (!source || !target) {
      setStatus('Only state nodes can create transitions');
      return;
    }
    if (source.graphId !== target.graphId) {
      setStatus('Cross-graph relationships must use signals, state broadcasts, or projection metadata, not cross-graph transitions.');
      return;
    }

    if (view.kind === 'graphExclusive') {
      let createdTransition: NarrativeTransitionDef | null = null;
      updateCurrentGraph((g) => {
        createdTransition = createTransition(g, source.stateId, target.stateId);
      });
      if (createdTransition) {
        setSelectedId(view.scope.transitionEdgeId(createdTransition.id));
        setSelectedJson(JSON.stringify(createdTransition, null, 2));
        setStatus(`Created transition ${createdTransition.id}`);
      }
      return;
    }

    let createdTransition: NarrativeTransitionDef | null = null;
    updateData((next) => {
      const comp = getComposition(next, composition.id);
      const sourceGraph = findGraphById(comp, source.graphId);
      if (!sourceGraph) return;
      createdTransition = createTransition(sourceGraph, source.stateId, target.stateId);
    });
    if (createdTransition) {
      const edgeId = source.elementId ? inlineSubgraphTransitionId(source.elementId, createdTransition.id) : `transition:${createdTransition.id}`;
      setSelectedId(edgeId);
      setSelectedJson(JSON.stringify(createdTransition, null, 2));
      setStatus(`Created transition ${createdTransition.id}`);
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
        setStateEditorPosition(
          state,
          node.position.x - SUBGRAPH_CHILD_ORIGIN.x,
          node.position.y - SUBGRAPH_CHILD_ORIGIN.y,
        );
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
    if (node.id.startsWith('transition-anchor:') && composition) {
      const parsed = parseTransitionAnchorId(node.id);
      if (parsed) {
        if (graph && parsed.graphId === graph.id) {
          const transition = graph.transitions.find((t) => t.id === parsed.transitionId);
          if (transition) {
            setSelectedId(`transition:${parsed.transitionId}`);
            setSelectedJson(JSON.stringify(transition, null, 2));
            return;
          }
        }
        const found = findTransitionByAnchorId(composition, node.id);
        if (found) {
          setSelectedId(inlineSubgraphTransitionId(found.element.id, found.transition.id));
          setSelectedJson(JSON.stringify(found.transition, null, 2));
          return;
        }
      }
    }
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

  const selectionDeletable = isSelectionDeletable(selectedId, graphRef);

  const applyAutoLayout = useCallback(() => {
    if (!composition) return;
    updateData((next) => {
      const comp = getComposition(next, compositionId);
      if (!comp) return;
      if (graphRef === 'main') {
        layoutComposition(comp, expandedElementIds);
      } else {
        const target = getEditableGraph(comp, graphRef);
        if (target) layoutGraph(target);
      }
    });
    setFitTargetNodeIds([]);
    setFitViewRev((v) => v + 1);
    setStatus('已应用自动布局');
  }, [composition, compositionId, expandedElementIds, graphRef, updateData]);

  const fitCanvas = useCallback(() => {
    setFitTargetNodeIds([]);
    setFitViewRev((v) => v + 1);
  }, []);

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
      const candidate = normalizeFile(data);
      const nextSelectedId = applySelectedObjectJson(candidate, composition?.id ?? compositionId, graphRef, selectedId, parsed as Record<string, unknown>);
      if (!nextSelectedId) {
        setStatus('Selected object no longer exists');
        return;
      }
      const normalized = normalizeFile(candidate);
      applyLocalValidation(normalized);
      await flushRemoteSync(normalized);
      const issues = mergeValidationIssues(validateNarrativeData(normalized), await validateNarrativeDataRemote(normalized));
      const errors = blockingValidationErrors(issues);
      if (errors.length) {
        setStatus(`JSON 应用被拦截：${errors.length} 个错误`);
        return;
      }
      setDataInternal(normalized);
      setDirty(true);
      setSelectedId(nextSelectedId);
      setSelectedJson(JSON.stringify(getObjectForSelection(normalized, composition?.id ?? compositionId, graphRef, nextSelectedId), null, 2));
      setStatus('Applied JSON');
    } catch (e) {
      setStatus(String(e));
    }
  }, [composition?.id, compositionId, data, graphRef, refreshProjectionAndValidation, selectedId, selectedJson]);

  const save = useCallback(async () => {
    const normalized = normalizeFile(data);
    await flushRemoteSync(normalized);
    const issues = mergeValidationIssues(validateNarrativeData(normalized), await validateNarrativeDataRemote(normalized));
    const errors = blockingValidationErrors(issues);
    if (errors.length) {
      setStatus(`保存被拦截：${errors.length} 个校验错误`);
      return;
    }
    const result = await saveNarrativeData(normalized);
    if (!/^save blocked:/i.test(result) && !/^invalid /i.test(result)) {
      setSavedDataHash(stableHash(JSON.stringify(normalized)));
      setDirty(false);
    }
    setStatus(result);
  }, [data, flushRemoteSync]);

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
  const filteredIssues = useMemo(() => validationIssues.filter((issue) => {
    if (issueFilter === 'error') return issue.severity === 'error';
    if (issueFilter === 'warning') return issue.severity === 'warning';
    if (issueFilter === 'composition' && composition) {
      return issueBelongsToActiveGraph(issue, composition.id, graphRef, data);
    }
    return true;
  }), [validationIssues, issueFilter, composition, graphRef, data]);

  const statesByGraph = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { graph: g } of compileGraphs(data)) out[g.id] = Object.keys(g.states ?? {});
    return out;
  }, [data]);

  const changeCanvasMode = useCallback((mode: CanvasMode) => {
    setCanvasMode(mode);
    if (mode === 'wiring' || mode === 'debug') {
      setShowTrigger(true);
      setShowRead(true);
      setShowCommand(true);
      if (preferences.defaultShowMiniMap) setShowMiniMap(true);
    }
    if (mode === 'debug') setInspectorTab('debug');
  }, [preferences.defaultShowMiniMap]);

  useEffect(() => {
    if ((canvasMode === 'wiring' || canvasMode === 'debug') && preferences.defaultShowMiniMap) {
      setShowMiniMap(true);
    }
  }, [canvasMode, preferences.defaultShowMiniMap]);

  const focusIssue = useCallback((issue: ValidationIssueDef) => {
    const result = resolveValidationIssueFocus(issue, data);
    if (!result) return;
    applyFocusIssueResult(result, {
      compositionId,
      setCompositionId,
      setGraphRef,
      setExpandedElementIds,
      setSelectedId,
    });
    const comp = getComposition(data, result.compositionId);
    const g = getEditableGraph(comp, result.graphRef);
    const anchorId = result.nodeIds.find((id) => id.startsWith('transition-anchor:'));
    if (anchorId && g) {
      const parsed = parseTransitionAnchorId(anchorId);
      const transition = parsed ? g.transitions.find((t) => t.id === parsed.transitionId) : undefined;
      if (transition) setSelectedJson(JSON.stringify(transition, null, 2));
    } else if (result.selectedId.startsWith('transition:') && g) {
      const tid = result.selectedId.slice('transition:'.length);
      const transition = g.transitions.find((t) => t.id === tid);
      if (transition) setSelectedJson(JSON.stringify(transition, null, 2));
    } else {
      const nodeId = result.nodeIds.find((id) => id.startsWith('state:') || id.startsWith('element:')) ?? result.selectedId;
      const obj = getNodeObject(comp, g, nodeId);
      if (obj) setSelectedJson(JSON.stringify(obj, null, 2));
    }
    const fitIds = pickFocusFitNodeIds(result.nodeIds);
    if (!fitIds.length) return;
    pendingFitNodeIdsRef.current = fitIds;
    setFitTargetNodeIds(fitIds);
    setFitViewRev((v) => v + 1);
  }, [compositionId, data]);

  const breadcrumbs = useMemo(() => {
    if (!composition) return [] as { label: string; onClick?: () => void }[];
    const crumbs: { label: string; onClick?: () => void }[] = [
      {
        label: composition.label || composition.id,
        onClick: () => {
          setGraphRef('main');
          setSelectedId('');
          setSelectedJson('');
        },
      },
      {
        label: graphRef === 'main' ? `主图 ${composition.mainGraph.id}` : graphLabel(composition, graphRef),
        onClick: graphRef !== 'main' ? () => {
          setGraphRef('main');
          setSelectedId('');
          setSelectedJson('');
        } : undefined,
      },
    ];
    if (graphRef === 'main') {
      for (const eid of expandedElementIds) {
        const el = composition.elements?.find((item) => item.id === eid);
        if (el) {
          crumbs.push({
            label: `${el.label || el.id}（内联）`,
            onClick: () => toggleExpandedElement(eid),
          });
        }
      }
    }
    return crumbs;
  }, [composition, expandedElementIds, graphRef, toggleExpandedElement]);

  const modeMenuItems = useMemo((): ToolbarMenuItem[] => (
    (['edit', 'wiring', 'debug'] as CanvasMode[]).map((mode) => ({
      id: mode,
      label: canvasModeLabel[mode],
      onSelect: () => changeCanvasMode(mode),
    }))
  ), [changeCanvasMode]);

  const fileMenuItems = useMemo((): ToolbarMenuItem[] => [
    { id: 'save', label: '保存  Ctrl+S', onSelect: () => { void save(); } },
    {
      id: 'refresh',
      label: '刷新投影',
      onSelect: () => { void refreshProjectionAndValidation(data); },
    },
    { id: 'reload', label: '重载页面  F5', onSelect: reloadNarrativeEditorPage },
  ], [data, refreshProjectionAndValidation, save]);

  const canvasMenuItems = useMemo((): ToolbarMenuItem[] => [
    {
      id: 'delete',
      label: '删除选中  Del',
      disabled: !selectionDeletable,
      onSelect: deleteSelected,
    },
    {
      id: 'autolayout',
      label: '自动布局',
      disabled: !composition,
      onSelect: applyAutoLayout,
    },
    { id: 'fit', label: '适应画布  F', onSelect: fitCanvas },
  ], [applyAutoLayout, composition, deleteSelected, fitCanvas, selectionDeletable]);

  const addMenuItems = useMemo((): ToolbarMenuItem[] => {
    const items: ToolbarMenuItem[] = [
      { id: 'state', label: '状态', disabled: !graph, onSelect: addState },
    ];
    if (graphRef === 'main') {
      for (const kind of elementKinds) {
        items.push({
          id: kind,
          label: kindLabel(kind),
          onSelect: () => addElementAction(kind),
        });
      }
    }
    return items;
  }, [addElementAction, addState, graph, graphRef]);

  const shellStyle = {
    gridTemplateColumns: `${leftCollapsed ? 0 : panelLayout.leftWidth}px minmax(480px, 1fr) ${rightCollapsed ? 0 : panelLayout.rightWidth}px`,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const inTextField = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);

      if (e.key === 'Delete' && !inTextField && selectionDeletable) {
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !inTextField) {
        setFitTargetNodeIds([]);
        setFitViewRev((v) => v + 1);
      }
      if (e.key === 'F5') {
        e.preventDefault();
        reloadNarrativeEditorPage();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected, redo, save, selectionDeletable, undo]);

  return (
    <NarrativeCanvasActionsProvider value={canvasActions}>
    <div
      className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}${preferences.reduceMotion ? ' reduce-motion' : ''}`}
      style={shellStyle}
    >
      <aside className="sidebar">
        <div className="pane-head">
          <div className="brand">叙事状态机</div>
          <button type="button" onClick={() => setLeftCollapsed(true)}>收起</button>
        </div>
        <button className="primary" onClick={addCompositionAction}>新建编排</button>
        <div className="section-title">编排列表</div>
        <div className="composition-list">
          {compositions.map((comp) => (
            <button
              key={comp.id}
              className={comp.id === composition?.id ? 'composition active' : 'composition'}
              onClick={() => {
                setCompositionId(comp.id);
                setGraphRef('main');
                setSelectedId('');
                setSelectedJson('');
              }}
            >
              <span>{comp.label || comp.id}</span>
              <small>{comp.mainGraph.id}</small>
            </button>
          ))}
        </div>

        {composition && (
          <>
            <div className="section-title">子图导航</div>
            <button type="button" className={graphRef === 'main' ? 'composition active' : 'composition'} onClick={() => {
              setGraphRef('main');
              setSelectedId('');
              setSelectedJson('');
            }}>
              <span>主图</span>
              <small>{composition.mainGraph.id}</small>
            </button>
            {(composition.elements ?? []).filter((el) => isSubgraphElement(el)).map((el) => (
              <button
                key={el.id}
                type="button"
                className={graphRef === `element:${el.id}` ? 'composition active' : 'composition'}
                onClick={() => {
                  setGraphRef(`element:${el.id}`);
                  setSelectedId('');
                  setSelectedJson('');
                }}
              >
                <span>{el.label || el.id}</span>
                <small>{el.graph?.id} · 独占</small>
              </button>
            ))}
          </>
        )}

        <div className="panel-resizer" onMouseDown={startLeft} aria-hidden />
      </aside>

      <main className="workspace">
        <header className="workspace-topbar">
          <div className="topbar-row topbar-cluster topbar-actions">
            <ToolbarMenuDropdown
              label={canvasModeLabel[canvasMode]}
              items={modeMenuItems}
              activeItemId={canvasMode}
            />
            <ToolbarMenuDropdown label="文件" items={fileMenuItems} />
            <ToolbarMenuDropdown label="画布" items={canvasMenuItems} />
            <ToolbarMenuDropdown label="添加" items={addMenuItems} />
            <span className="topbar-sep" aria-hidden />
            <button type="button" className="toolbar-btn" onClick={() => setLeftCollapsed((v) => !v)} title={leftCollapsed ? '展开左侧导航' : '收起左侧导航'}>
              {leftCollapsed ? '导航+' : '导航−'}
            </button>
            <button type="button" className="toolbar-btn" onClick={() => setRightCollapsed((v) => !v)} title={rightCollapsed ? '展开右侧属性' : '收起右侧属性'}>
              {rightCollapsed ? '属性+' : '属性−'}
            </button>
            <button type="button" className="toolbar-btn" onClick={() => setValidationCollapsed((v) => !v)} title={validationCollapsed ? '展开校验面板' : '收起校验面板'}>
              {validationCollapsed ? '校验+' : '校验−'}
            </button>
            {(canvasMode === 'wiring' || canvasMode === 'debug') && (
              <ToolbarPopover label="图层" panelClassName="layers-popover-panel">
                <label className="toggle compact-toggle">
                  <input type="checkbox" checked={showTrigger} onChange={(e) => setShowTrigger(e.target.checked)} />
                  外部触发 ({projection.triggerEdges.length})
                </label>
                <label className="toggle compact-toggle">
                  <input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} />
                  外部读取 ({projection.readEdges.length})
                </label>
                <label className="toggle compact-toggle">
                  <input type="checkbox" checked={showCommand} onChange={(e) => setShowCommand(e.target.checked)} />
                  强制设状态 ({projection.stateCommandEdges?.length ?? 0})
                </label>
                <label className="toggle compact-toggle">
                  <input type="checkbox" checked={showMiniMap} onChange={(e) => setShowMiniMap(e.target.checked)} />
                  小地图
                </label>
              </ToolbarPopover>
            )}
            <SettingsMenu
              preferences={preferences}
              onChange={setPreferences}
              onReset={resetPreferences}
            />
          </div>
        </header>

        <div className="workspace-body">
          <section className="canvas">
            <NarrativeFlowCanvas
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={selectNode}
              onEdgeClick={selectEdge}
              onNodeDragStop={onNodeDragStop}
              onNodeDoubleClick={(_event, node) => {
                if (!node.id.startsWith('element:')) return;
                const eid = node.id.slice('element:'.length);
                canvasActions.toggleSubgraphElement(eid);
              }}
              showMiniMap={showMiniMap}
              canvasShowGrid={preferences.canvasShowGrid}
              reduceMotion={preferences.reduceMotion}
              fitViewRev={fitViewRev}
              fitTargetNodeIds={fitTargetNodeIds}
              compositionId={compositionId}
              graphRef={graphRef}
            />
          </section>

          <aside
            className={`validation-dock${validationCollapsed ? ' collapsed' : ''}`}
            style={validationCollapsed ? undefined : { height: panelLayout.validationHeight }}
          >
            <div className="panel-resizer panel-resizer-top" onMouseDown={startValidation} aria-hidden />
            <div className="validation-dock-head">
              <span className="validation-dock-title">校验</span>
              <button
                type="button"
                className={errorCount ? 'validation-pill error' : warningCount ? 'validation-pill warn' : 'validation-pill ok'}
              >
                {errorCount} 错误 / {warningCount} 警告{remoteSyncing ? ' · 同步中…' : ''}
              </button>
              <button type="button" className="validation-dock-toggle" onClick={() => setValidationCollapsed((v) => !v)}>
                {validationCollapsed ? '展开' : '收起'}
              </button>
            </div>
            {!validationCollapsed && (
              <>
                <div className="issue-filters">
                  {(['all', 'error', 'warning', 'composition'] as IssueFilter[]).map((f) => (
                    <button key={f} type="button" className={issueFilter === f ? 'active' : ''} onClick={() => setIssueFilter(f)}>
                      {f === 'all' ? '全部' : f === 'error' ? '错误' : f === 'warning' ? '警告' : '当前编排'}
                    </button>
                  ))}
                </div>
                <div className="issue-list issue-list-dock">
                  {filteredIssues.length === 0 ? (
                    <div className="validation-dock-empty muted">无校验问题</div>
                  ) : (
                    filteredIssues.map((issue, index) => (
                      <button key={`${issue.code}-${issue.path}-${index}`} type="button" className={`issue ${issue.severity}`} title={issue.path || validationTargetSummary(issue)} onClick={() => focusIssue(issue)}>
                        <b>{issue.severity === 'error' ? '错' : '警'}</b>
                        <span>{issue.message}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
        <nav className="workspace-path-bar topbar-path-row topbar-path" aria-label="画布路径">
          {graphRef !== 'main' && (
            <span className="topbar-tag" title="独占编辑子图；主画布可双击子图元素展开或收起">独占</span>
          )}
          <div className="topbar-path-scroll">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="breadcrumb-item">
                {index > 0 && <span className="breadcrumb-sep">›</span>}
                {crumb.onClick ? <button type="button" className="topbar-path-btn" onClick={crumb.onClick}>{crumb.label}</button> : <span className="topbar-path-text">{crumb.label}</span>}
              </span>
            ))}
          </div>
          {graphRef !== 'main' && (
            <button
              type="button"
              className="toolbar-btn topbar-path-back"
              onClick={() => { setGraphRef('main'); setSelectedId(''); setSelectedJson(''); }}
            >
              主画布
            </button>
          )}
        </nav>
        <footer className="status">
          <span>{editorDirty ? `${status} *` : status}</span>
          <span>{dataSource || '来源未知'}</span>
          <span>{runtimeSnapshot.ok ? '运行时已连接' : runtimeSnapshot.reason}</span>
        </footer>
      </main>

      <aside className="inspector">
        <div className="pane-head">
          <div className="inspector-tabs">
            {(['properties', 'transitions', 'debug', 'advanced'] as InspectorTab[]).map((tab) => (
              <button key={tab} type="button" className={inspectorTab === tab ? 'active' : ''} onClick={() => setInspectorTab(tab)}>
                {tab === 'properties' ? '属性' : tab === 'transitions' ? '迁移' : tab === 'debug' ? '调试' : '高级'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setRightCollapsed(true)}>收起</button>
        </div>
        <div className="summary">
          <strong>{selectedObject.title}</strong>
          <span>{selectedObject.subtitle}</span>
        </div>
        {inspectorTab === 'properties' && (
          <>
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
              <button type="button" onClick={deleteSelected} disabled={!isSelectionDeletable(selectedId, graphRef)}>删除</button>
              <button type="button" onClick={() => selectedObject.navigate && navigateTo(selectedObject.navigate.kind, selectedObject.navigate.id)} disabled={!selectedObject.navigate}>
                跳转资源
              </button>
            </div>
          </>
        )}
        {inspectorTab === 'transitions' && graph && (
          <div className="transition-table">
            {(graph.transitions ?? []).map((tr) => (
              <button
                key={tr.id}
                type="button"
                className={`transition-row${selectedId === `transition:${tr.id}` ? ' active' : ''}`}
                onClick={() => {
                  setSelectedId(`transition:${tr.id}`);
                  setSelectedJson(JSON.stringify(tr, null, 2));
                  setFitTargetNodeIds([
                    transitionAnchorId(graph.id, tr.id),
                    `state:${String(tr.from)}`,
                  ]);
                  setFitViewRev((v) => v + 1);
                }}
              >
                <span>{String(tr.from)} → {String(tr.to)}</span>
                <small>{tr.signal === DEFAULT_DRAFT_SIGNAL ? '(草稿)' : (tr.signal || '(草稿)')}</small>
              </button>
            ))}
          </div>
        )}
        {inspectorTab === 'debug' && (
          <>
            <div className="field">
              <label>triggerKey</label>
              <input list="knownSignals" value={signalKey} onChange={(e) => setSignalKey(e.target.value)} />
              <datalist id="knownSignals">{knownSignals.map((sig) => <option key={sig} value={sig} />)}</datalist>
            </div>
            <div className="inspector-actions">
              <button type="button" onClick={runLocalSimulation}>本地模拟</button>
              <button type="button" onClick={pullRuntimeSnapshot}>拉取运行时</button>
              <button type="button" className="danger" onClick={emitRuntime}>发送运行时信号</button>
            </div>
            <PreviewPanel simulation={simulation} runtimeSnapshot={runtimeSnapshot} />
            {graph && selectedId.startsWith('state:') && (
              <div className="inspector-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    const stateId = selectedId.slice('state:'.length);
                    const result = await setRuntimeNarrativeState(graph.id, stateId);
                    setRuntimeSnapshot(result);
                    setStatus(result.ok ? `运行时已设为 ${graph.id}.${stateId}` : `运行时不可用：${result.reason}`);
                  }}
                >
                  强制设置运行时状态
                </button>
              </div>
            )}
          </>
        )}
        {inspectorTab === 'advanced' && (
          <details className="advanced-json" open>
            <summary>选中对象 JSON</summary>
            <textarea className="advanced-json-area" value={selectedJson} onChange={(e) => setSelectedJson(e.target.value)} readOnly={selectedId.startsWith('projection:')} />
            <div className="inspector-actions">
              <button type="button" onClick={applySelectedJson} disabled={!selectedId || selectedId.startsWith('projection:')}>应用 JSON</button>
            </div>
          </details>
        )}
        <div className="panel-resizer panel-resizer-right" onMouseDown={startRight} aria-hidden />
      </aside>
    </div>
    </NarrativeCanvasActionsProvider>
  );
}

function NarrativeFlowCanvas(props: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodesChange: OnNodesChange<CanvasNode>;
  onEdgesChange: OnEdgesChange<CanvasEdge>;
  onConnect: OnConnect;
  onNodeClick: (event: unknown, node: CanvasNode) => void;
  onEdgeClick: (event: unknown, edge: CanvasEdge) => void;
  onNodeDragStop: (event: unknown, node: CanvasNode) => void;
  onNodeDoubleClick: (event: unknown, node: CanvasNode) => void;
  showMiniMap: boolean;
  canvasShowGrid: boolean;
  reduceMotion: boolean;
  fitViewRev: number;
  fitTargetNodeIds: string[];
  compositionId: string;
  graphRef: GraphRef;
}) {
  const { fitView } = useReactFlow();
  const lastFit = useRef('');

  useEffect(() => {
    const key = `${props.compositionId}|${props.graphRef}|${props.fitViewRev}|${props.fitTargetNodeIds.join(',')}`;
    if (lastFit.current === key && props.fitViewRev === 0) return;
    lastFit.current = key;
    const duration = props.reduceMotion ? 0 : 220;
    const t = window.setTimeout(() => {
      if (props.fitTargetNodeIds.length) {
        const existing = new Set(props.nodes.map((node) => node.id));
        const targets = props.fitTargetNodeIds.filter((id) => existing.has(id));
        if (targets.length) {
          void fitView({ nodes: targets.map((id) => ({ id })), padding: 0.35, duration, maxZoom: 1.25 });
        }
      } else {
        void fitView({ padding: 0.2, duration: props.reduceMotion ? 0 : 200 });
      }
    }, 80);
    return () => window.clearTimeout(t);
  }, [props.compositionId, props.graphRef, props.fitViewRev, props.fitTargetNodeIds, props.nodes, props.reduceMotion, fitView, props.nodes.length]);

  return (
    <ReactFlow
      nodes={props.nodes}
      edges={props.edges}
      nodeTypes={flowNodeTypes}
      edgeTypes={flowEdgeTypes}
      defaultEdgeOptions={{ zIndex: 25 }}
      onNodesChange={props.onNodesChange}
      onEdgesChange={props.onEdgesChange}
      onConnect={props.onConnect}
      onNodeClick={props.onNodeClick}
      onEdgeClick={props.onEdgeClick}
      onNodeDragStop={props.onNodeDragStop}
      onNodeDoubleClick={props.onNodeDoubleClick}
      elevateNodesOnSelect
      selectionOnDrag
      panOnDrag={[1, 2]}
      multiSelectionKeyCode="Shift"
      deleteKeyCode={['Backspace', 'Delete']}
    >
      {props.canvasShowGrid ? <Background gap={18} size={1} /> : null}
      {props.showMiniMap && <MiniMap pannable zoomable className="narrative-minimap" />}
      <Controls />
    </ReactFlow>
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
  const statesByGraph = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { graph: g } of compileGraphs(props.data)) out[g.id] = Object.keys(g.states ?? {});
    return out;
  }, [props.data]);
  if (!composition || !graph) return <p className="muted">未选择编排。</p>;
  if (!selectedId) return <GraphInspector {...props} graph={graph} />;
  if (selectedId.startsWith('graph:') || selectedId.startsWith('projection-anchor:')) {
    return <GraphInspector {...props} graph={graph} />;
  }
  if (selectedId.startsWith('transition-anchor:')) {
    const parsed = parseTransitionAnchorId(selectedId);
    if (parsed) {
      if (parsed.graphId === graph.id) {
        const transition = graph.transitions.find((t) => t.id === parsed.transitionId);
        if (transition) {
          return (
            <TransitionInspector
              {...props}
              transition={transition}
              graph={graph}
              graphIds={Object.keys(statesByGraph)}
              statesByGraph={statesByGraph}
              knownSignals={props.knownSignals}
            />
          );
        }
      }
      const element = composition.elements?.find((el) => el.graph?.id === parsed.graphId);
      const subgraph = element?.graph;
      const transition = subgraph?.transitions.find((t) => t.id === parsed.transitionId);
      if (element && subgraph && transition) {
        const updateInlineGraph = (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => {
          props.updateData((next) => {
            const comp = getComposition(next, composition.id);
            const el = comp?.elements?.find((item) => item.id === element.id);
            if (el?.graph) updater(el.graph, next);
          });
        };
        return (
          <TransitionInspector
            {...props}
            graph={subgraph}
            transition={transition}
            graphIds={Object.keys(statesByGraph)}
            statesByGraph={statesByGraph}
            knownSignals={props.knownSignals}
            updateCurrentGraph={updateInlineGraph}
            setSelectedId={(id) => props.setSelectedId(prefixInlineSelection(element.id, id))}
          />
        );
      }
    }
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
        graphIds={Object.keys(statesByGraph)}
        statesByGraph={statesByGraph}
        knownSignals={props.knownSignals}
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
      return transition ? (
        <TransitionInspector
          {...props}
          transition={transition}
          graph={graph}
          graphIds={Object.keys(statesByGraph)}
          statesByGraph={statesByGraph}
          knownSignals={props.knownSignals}
        />
      ) : <p className="muted">Missing transition.</p>;
  }
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const element = getElementByNodeId(composition, selectedId);
    return element ? <ElementInspector {...props} element={element} knownSignals={props.knownSignals} /> : <p className="muted">Missing element.</p>;
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
  catalog: AuthoringCatalogDef;
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setStatus?: (status: string) => void;
}) {
  const { graph, updateCurrentGraph, catalog, composition, graphRef } = props;
  const ownerChoices = ownerChoicesForGraph(graph, catalog);
  const parentElement = graphRef !== 'main' ? getElementByGraphRef(composition, graphRef) : undefined;
  const parentMeta = parentElement?.meta;
  return (
    <div className="form-grid">
      {parentElement && (
        <>
          <div className="property-line">父元素：{parentElement.label || parentElement.id}（{elementSubtitle(parentElement)}）</div>
          {(parentElement.ownerType || parentElement.ownerId) && (
            <div className="property-line">绑定：{parentElement.ownerType || 'entity'} / {parentElement.ownerId || '—'}</div>
          )}
          {(parentMeta?.emits?.length ?? 0) > 0 && (
            <div className="property-line">emits：{(parentMeta?.emits ?? []).join(', ')}</div>
          )}
          {(parentMeta?.reads?.length ?? 0) > 0 && (
            <div className="property-line">reads：{(parentMeta?.reads ?? []).join(', ')}</div>
          )}
        </>
      )}
      <TextField
        label="graph id"
        value={graph.id}
        commitOnBlur
        onChange={(value) => updateCurrentGraph((g, next) => {
          try {
            renameGraph(next, g, value);
          } catch (e) {
            props.setStatus?.(String(e));
          }
        })}
      />
      <TextField label="ownerType" value={graph.ownerType} onChange={(value) => updateCurrentGraph((g) => { g.ownerType = value; })} />
      <TextField label="ownerId" value={graph.ownerId ?? ''} datalistValues={ownerChoices} onChange={(value) => updateCurrentGraph((g) => { g.ownerId = value; })} />
      <SelectField label="initialState" value={graph.initialState} values={Object.keys(graph.states)} onChange={(value) => updateCurrentGraph((g) => { g.initialState = value; })} />
      {(graph.ownerType === 'scenario' || graph.entryState || graph.exitStates?.length) && (
        <>
          <SelectField label="scenario entryState" value={graph.entryState ?? ''} values={Object.keys(graph.states)} onChange={(value) => updateCurrentGraph((g) => { g.entryState = value; })} />
          <StringListField label="scenario exitStates" value={graph.exitStates ?? []} onChange={(value) => updateCurrentGraph((g) => { g.exitStates = value; })} />
          <div className="property-line">Scenario 只有 entryState / exitStates 可以和外部图直接连线；内部状态只在展开后编辑。</div>
        </>
      )}
      {graph.projectFlags === true && (
        <div className="property-line danger">projectFlags is deprecated; new graphs should use explicit narrative state reads.</div>
      )}
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
      <label className="toggle">
        <input
          type="checkbox"
          checked={state.broadcastOnEnter === true}
          onChange={(e) => updateCurrentGraph((g) => { g.states[stateId].broadcastOnEnter = e.target.checked; })}
        />
        进入时广播派生信号
      </label>
      {state.broadcastOnEnter === true && (
        <ReadOnlyField label="derived signal" value={stateEnteredSignalKey(graph.id, stateId)} />
      )}
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
    </div>
  );
}

function TransitionInspector(props: {
  data: NarrativeGraphsFileDef;
  composition?: NarrativeCompositionDef;
  graph: NarrativeGraphDef;
  transition: NarrativeTransitionDef;
  knownSignals: string[];
  graphIds: string[];
  statesByGraph: Record<string, string[]>;
  updateData: (updater: (next: NarrativeGraphsFileDef) => void) => void;
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setSelectedId: (id: string) => void;
  setStatus: (status: string) => void;
  deleteSelected: () => void;
}) {
  const { graph, transition, updateCurrentGraph } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const stateChoices = Object.keys(graph.states);
  const legacyEndpoint = typeof transition.from !== 'string' || typeof transition.to !== 'string';
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
      <SelectField
        label="from"
        value={typeof transition.from === 'string' ? transition.from : ''}
        values={stateChoices}
        onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).from = value; })}
      />
      <SelectField
        label="to"
        value={typeof transition.to === 'string' ? transition.to : ''}
        values={stateChoices}
        onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).to = value; })}
      />
      <div className="property-line">
        {legacyEndpoint
          ? 'Unsupported legacy cross-graph endpoint. Choose local states; express graph-to-graph effects with signals, state broadcasts, or projection metadata.'
          : 'Transitions only move between states inside this graph.'}
      </div>
      <div className="property-line">
        <label>signal</label>
        <div className="signal-field-row">
          <input readOnly value={transition.signal || DEFAULT_DRAFT_SIGNAL} />
          <button type="button" onClick={() => setPickerOpen(true)}>选择信号…</button>
        </div>
      </div>
      <SignalPickerModal
        open={pickerOpen}
        data={props.data}
        currentSignal={transition.signal}
        onClose={() => setPickerOpen(false)}
        onSelect={(signalId) => updateCurrentGraph((g) => { transitionIn(g, transition.id).signal = signalId; })}
        onDataChange={props.updateData}
      />
      <NumberField label="priority" value={transition.priority ?? 0} onChange={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).priority = value; })} />
      <ConditionBuilder
        value={transition.conditions ?? []}
        graphIds={props.graphIds}
        statesByGraph={props.statesByGraph}
        onApply={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).conditions = Array.isArray(value) ? value : value ? [value] : []; })}
      />
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
  knownSignals: string[];
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
          <div className="property-line">绑定后 DialogueGraph 的 OwnerStateNode 才能读取该 wrapper 的 activeState；ContextStateNode 应读取 flow/scenario 图，不能选 npc wrapper。</div>
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
      <SignalChipsField
        label="emits"
        value={element.meta?.emits ?? []}
        options={props.knownSignals}
        onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.emits = value; })}
      />
      <SignalChipsField
        label="reads"
        value={element.meta?.reads ?? []}
        options={props.knownSignals}
        onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.reads = value; })}
      />
      {isSubgraph && (
        <div className="inspector-actions">
          <button type="button" onClick={() => props.toggleExpandedElement(element.id)}>{expanded ? '在主画布收起子图' : '在主画布展开子图'}</button>
          <button type="button" className="secondary" onClick={() => props.setGraphRef(`element:${element.id}`)}>独占打开子图</button>
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


function getNodeObject(comp: NarrativeCompositionDef | undefined, graph: NarrativeGraphDef | undefined, nodeId: string) {
  if (!comp || !graph) return null;
  const inline = parseInlineSubgraphId(nodeId);
  if (inline?.kind === 'state') {
    return comp.elements?.find((el) => el.id === inline.elementId)?.graph?.states[inline.objectId] ?? null;
  }
  if (inline?.kind === 'transition') {
    return comp.elements?.find((el) => el.id === inline.elementId)?.graph?.transitions.find((t) => t.id === inline.objectId) ?? null;
  }
  if (nodeId.startsWith('transition-anchor:')) {
    const parsed = parseTransitionAnchorId(nodeId);
    if (parsed?.graphId === graph.id) {
      return graph.transitions.find((t) => t.id === parsed.transitionId) ?? graph;
    }
    const found = findTransitionByAnchorId(comp, nodeId);
    if (found) return found.transition;
    return graph;
  }
  if (nodeId.startsWith('graph:') || nodeId.startsWith('projection-anchor:')) return graph;
  if (nodeId.startsWith('state:')) return graph.states[nodeId.slice('state:'.length)];
  if (nodeId.startsWith('element:')) return getElementByNodeId(comp, nodeId);
  return graph;
}

function getObjectForSelection(
  data: NarrativeGraphsFileDef,
  compositionId: string,
  graphRef: GraphRef,
  selectedId: string,
): unknown {
  const comp = getComposition(data, compositionId);
  const graph = getEditableGraph(comp, graphRef);
  return getNodeObject(comp, graph, selectedId);
}

function applySelectedObjectJson(
  data: NarrativeGraphsFileDef,
  compositionId: string,
  graphRef: GraphRef,
  selectedId: string,
  parsed: Record<string, unknown>,
): string | null {
  const comp = getComposition(data, compositionId);
  const g = getEditableGraph(comp, graphRef);
  if (!comp || !g) return null;
  const inline = parseInlineSubgraphId(selectedId);
  if (inline?.kind === 'state') {
    const el = comp.elements?.find((item) => item.id === inline.elementId);
    if (!el?.graph) return null;
    const nextState = parsed as unknown as NarrativeStateNodeDef;
    const newId = renameStateInGraph(data, el.graph, inline.objectId, String(nextState.id || inline.objectId));
    el.graph.states[newId] = { ...nextState, id: newId };
    return inlineSubgraphStateId(inline.elementId, newId);
  }
  if (inline?.kind === 'transition') {
    const el = comp.elements?.find((item) => item.id === inline.elementId);
    if (!el?.graph || !el.graph.transitions.some((t) => t.id === inline.objectId)) return null;
    const transition = parsed as unknown as NarrativeTransitionDef;
    const newId = renameTransition(el.graph, inline.objectId, String(transition.id || inline.objectId));
    const idx = el.graph.transitions.findIndex((t) => t.id === newId);
    if (idx >= 0) el.graph.transitions[idx] = { ...transition, id: newId };
    return inlineSubgraphTransitionId(inline.elementId, newId);
  }
  if (selectedId.startsWith('state:')) {
    const oldId = selectedId.slice('state:'.length);
    if (!g.states[oldId]) return null;
    const nextState = parsed as unknown as NarrativeStateNodeDef;
    const newId = renameStateInGraph(data, g, oldId, String(nextState.id || oldId));
    g.states[newId] = { ...nextState, id: newId };
    return `state:${newId}`;
  }
  if (selectedId.startsWith('transition:')) {
    const oldId = selectedId.slice('transition:'.length);
    if (!g.transitions.some((t) => t.id === oldId)) return null;
    const transition = parsed as unknown as NarrativeTransitionDef;
    const newId = renameTransition(g, oldId, String(transition.id || oldId));
    const idx = g.transitions.findIndex((t) => t.id === newId);
    if (idx >= 0) g.transitions[idx] = { ...transition, id: newId };
    return `transition:${newId}`;
  }
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const oldId = selectedId.slice('element:'.length);
    const elements = comp.elements ?? [];
    const oldElement = elements.find((e) => e.id === oldId);
    if (!oldElement) return null;
    const nextElement = parsed as unknown as CompositionElementDef;
    const oldGraphId = oldElement.graph?.id;
    const desiredGraphId = nextElement.graph?.id;
    const newId = renameElement(comp, oldId, String(nextElement.id || oldId));
    const idx = elements.findIndex((e) => e.id === newId);
    if (idx < 0) return null;
    const replacement: CompositionElementDef = { ...nextElement, id: newId };
    if (oldGraphId && desiredGraphId && replacement.graph && desiredGraphId !== oldGraphId) {
      replacement.graph = { ...replacement.graph, id: oldGraphId };
    }
    elements[idx] = replacement;
    if (oldGraphId && desiredGraphId && replacement.graph && desiredGraphId !== oldGraphId) {
      renameGraph(data, replacement.graph, desiredGraphId);
    }
    return `element:${newId}`;
  }
  if (selectedId.startsWith('graph:') || selectedId.startsWith('transition-anchor:')) {
    const desiredGraphId = String((parsed as Partial<NarrativeGraphDef>).id || g.id);
    const replacement: NarrativeGraphDef = { ...(parsed as unknown as NarrativeGraphDef), id: g.id };
    if (graphRef === 'main') {
      comp.mainGraph = replacement;
    } else {
      const element = getElementByGraphRef(comp, graphRef);
      if (!element) return null;
      element.graph = replacement;
    }
    if (desiredGraphId !== g.id) renameGraph(data, replacement, desiredGraphId);
    return `graph:${replacement.id}`;
  }
  return null;
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
          const unsafeStateCommand = action.type === 'setNarrativeState';
          return (
            <div className={`action-summary-row${unsafeStateCommand ? ' danger' : ''}`} key={`${index}-${action.type}`}>
              <span className={`save-dot ${persistence}`} title={persistence === 'save' ? '会修改持久化数据' : '运行时或演出 Action'} />
              <b>{index + 1}. {action.type || '(空 Action)'}{unsafeStateCommand ? ' — 强制设状态：绕过状态机因果链' : ''}</b>
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
