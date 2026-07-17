import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { deriveGraphInterface } from './graphInterface';
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
import {
  applyCompositionLayout,
  applyGraphLayout,
  computeCompositionLayout,
  computeGraphLayout,
} from './canvas/autoLayout';
import {
  shouldSnapTransitionAnchors,
  snapTransitionAnchorsToEdges,
} from './canvas/transitionAnchorLayout';
import { parseTransitionAnchorId, transitionAnchorId } from './anchorCodec';
import {
  applyEditorGroupDisplay,
  buildGroupFrameNodes,
  groupColorForIndex,
  groupsForCanvas,
  newGroupId,
  parseGroupFrameNodeId,
  reconcileGroupFrameNodes,
  setGroupsForCanvas,
  type CanvasGroupDef,
} from './canvas/editorGroups';
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
import { applySignalDisplayToEdges, buildSignalLabelMap } from './signalDisplay';
import { SignalRefactorModal, type NarrativeRefactorRequest } from './components/SignalRefactorModal';
import {
  elementSubtitle,
  extractActiveStates,
  findGraphById,
  findProjectionEdge,
  isSelectionDeletable,
  navigationForElement,
  ownerChoicesFor,
  ownerChoicesForGraph,
  WRAPPER_OWNER_TYPES,
  removeTransitionsReferencingState,
  transitionIn,
  updateElement,
} from './editor/appHelpers';
import { canvasModeLabel, kindLabel } from './editor/labels';
import { useCanvasGroups } from './hooks/useCanvasGroups';
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
  loadCategories,
  loadNarrativeDataWithSource,
  loadTaskIndex,
  loadTemplates,
  navigateTo,
  refactorJournalSizeRemote,
  saveCategoriesRemote,
  saveNarrativeData,
  setRuntimeNarrativeState,
  undoSignalRefactorRemote,
  validateNarrativeDataRemote,
  type SignalRefactorResultDef,
} from './bridge';
import {
  distinctCompositionCategories,
  distinctSubgraphCategories,
  getCompositionCategory,
  getSubgraphCategory,
  groupCompositions,
  groupSubgraphElements,
  normalizeCategoriesFile,
  pruneOrphans,
  setCompositionCategory,
  setSubgraphCategory,
  type CategoryGroup,
} from './editor/categories';
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
  graphDisplayName,
  graphLabel,
  graphReferenceLabel,
  isSubgraphElement,
  mergeValidationIssues,
  normalizeFile,
  parseExternalSignalKey,
  setKnownPlaneIdsForValidation,
  setStateEditorPosition,
  emptySimulationRunLayer,
  simulateRunLifecycle,
  simulateSignalImpact,
  stateEditorPosition,
  stateReferenceLabel,
  stateEnteredSignalKey,
  validateNarrativeData,
  resolveEndpoint,
  type GraphRef,
  type SimulationResult,
  type SimulationRunLayer,
  type SimulationRunOp,
} from './editorModel';
import type {
  ActionDef,
  AuthoringCatalogDef,
  CanvasEdge,
  CanvasNode,
  CompositionElementDef,
  ElementKind,
  NarrativeCategoriesFileDef,
  NarrativeEndpointDef,
  NarrativeCompositionDef,
  NarrativeGraphsFileDef,
  NarrativeGraphDef,
  NarrativeStateNodeDef,
  NarrativeTransitionDef,
  ProjectionEdgeDef,
  ProjectionResult,
  RuntimeDebugSnapshotDef,
  NarrativeTemplateDef,
  StampSummaryDef,
  TaskIndex,
  TaskIssueDef,
  ValidationIssueDef,
} from './types';
import { TaskBusPanel } from './TaskBusPanel';
import { TemplatesPanel } from './TemplatesPanel';

const elementKinds: ElementKind[] = [
  'wrapperGraph',
  'scenarioSubgraph',
  'dialogueBlackbox',
  'zoneBlackbox',
  'minigameBlackbox',
  'cutsceneBlackbox',
];

type DialogueRelationRead = {
  graphId: string;
  summary: string;
};

type DialogueRelationWrite = {
  graphId: string;
  summary: string;
};

type DialogueRelationEmit = {
  signal: string;
  summary: string;
};

type DialogueRelationIndex = {
  reads: DialogueRelationRead[];
  writes: DialogueRelationWrite[];
  emits: DialogueRelationEmit[];
};

const emptyDialogueRelationIndex: DialogueRelationIndex = { reads: [], writes: [], emits: [] };

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
  const [entityPanelOpen, setEntityPanelOpen] = useState(false);
  const [selectedEntityOwnerKey, setSelectedEntityOwnerKey] = useState('');
  const [taskBusOpen, setTaskBusOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templates, setTemplates] = useState<NarrativeTemplateDef[]>([]);
  // 「整理分组」标签：编辑器专用，运行时永不加载，绝不进 narrative_graphs.json。
  const [categories, setCategories] = useState<NarrativeCategoriesFileDef>(() => normalizeCategoriesFile(null));
  const [taskIndex, setTaskIndex] = useState<TaskIndex>({ compositionId: '', graphIds: [], references: [], planes: [], sceneEntities: [], quests: [] });
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('all');
  const [showTrigger, setShowTrigger] = useState(false);
  const [showRead, setShowRead] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const { preferences, setPreferences, resetPreferences } = useEditorPreferences();
  // 画布分组框：编辑器视觉整理层（旁挂文件即时落盘），绝不进 narrative_graphs.json。
  const { file: canvasGroupsFile, updateFile: updateCanvasGroupsFile } = useCanvasGroups();
  const currentGroups = useMemo(
    () => groupsForCanvas(canvasGroupsFile, compositionId, graphRef),
    [canvasGroupsFile, compositionId, graphRef],
  );
  // 结构重建 effect 经 ref 取分组（分组不进结构 key，避免每次拖框都整画布重建）。
  const currentGroupsRef = useRef(currentGroups);
  currentGroupsRef.current = currentGroups;
  const updateCurrentGroups = useCallback(
    (updater: (groups: Record<string, CanvasGroupDef>) => Record<string, CanvasGroupDef>) => {
      updateCanvasGroupsFile((file) => setGroupsForCanvas(
        file, compositionId, graphRef, updater(groupsForCanvas(file, compositionId, graphRef)),
      ));
    },
    [compositionId, graphRef, updateCanvasGroupsFile],
  );
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [expandedElementIds, setExpandedElementIds] = useState<string[]>([]);
  // 侧栏整理分组的折叠态（临时 UI 态，不落盘）。key 带前缀防串：comp:<catKey> / sub:<compId>:<catKey>。
  const [collapsedCatGroups, setCollapsedCatGroups] = useState<Set<string>>(() => new Set());
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [validationCollapsed, setValidationCollapsed] = useState(false);
  const [panelLayout, setPanelLayout] = useState(loadPanelLayout);
  const [status, setStatus] = useState('就绪');
  const [fitViewRev, setFitViewRev] = useState(0);
  const [fitTargetNodeIds, setFitTargetNodeIds] = useState<string[]>([]);
  const pendingFitNodeIdsRef = useRef<string[] | null>(null);
  /** focusIssue 的 ref 转接：供声明顺序在其之前的宿主 API effect 调用（focusState）。 */
  const focusIssueRef = useRef<((issue: ValidationIssueDef) => void) | null>(null);
  const { startLeft, startRight, startValidation } = usePanelResize({ setLayout: setPanelLayout, leftCollapsed, rightCollapsed });
  const [signalKey, setSignalKey] = useState('');
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  /** 活计运行层模拟状态：跨多次「本地模拟」持续（接单→推进→结算的循环干跑靠它） */
  const [simRunLayer, setSimRunLayer] = useState<SimulationRunLayer>(emptySimulationRunLayer);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeDebugSnapshotDef>({ ok: false, reason: 'Runtime not queried yet' });
  const [dirty, setDirty] = useState(false);
  const [savedDataHash, setSavedDataHash] = useState('');
  const [dataSource, setDataSource] = useState('');
  const [dialogueRelations, setDialogueRelations] = useState<DialogueRelationIndex>(emptyDialogueRelationIndex);

  const { wrapUpdater, undo, redo, resetHistory } = useEditorHistory(data, setDataInternal, (next) => {
    scheduleRemoteSync(next);
  });

  const updateData = useCallback((updater: (next: NarrativeGraphsFileDef) => void) => {
    wrapUpdater(updater);
    setDirty(true);
  }, [wrapUpdater]);

  // 整理分组提交：即刻入模型（saveCategories → mark_dirty），由主编辑器 Save All / 关窗询问兜底
  // ——不与 narrative_graphs 的 flush 草稿路径耦合。顺手 prune 掉悬垂 id（对当前内存数据），保持整洁。
  const persistCategories = useCallback((next: NarrativeCategoriesFileDef) => {
    const pruned = pruneOrphans(next, data);
    setCategories(pruned);
    void saveCategoriesRemote(pruned);
  }, [data]);
  const setCompositionCategoryFor = useCallback((compId: string, name: string) => {
    persistCategories(setCompositionCategory(categories, compId, name));
  }, [categories, persistCategories]);
  const setSubgraphCategoryFor = useCallback((compId: string, elId: string, name: string) => {
    persistCategories(setSubgraphCategory(categories, compId, elId, name));
  }, [categories, persistCategories]);

  // 模板盖章成功（全有全无）：宿主已把合并后的 narrative + 镜像 quest + 对话桩**一并暂存**进
  // ProjectModel（零磁盘写入），Save All 一次性落盘。这里整体采纳回传的 narrative 并把编辑器
  // 标为「已保存到模型」（与点「保存」同语义——模型里已是这份数据），选中新作曲、刷新目录。
  const handleStamped = useCallback((narrative: NarrativeGraphsFileDef, summary: StampSummaryDef) => {
    updateData((next) => {
      next.schemaVersion = narrative.schemaVersion ?? next.schemaVersion;
      next.compositions = narrative.compositions ?? [];
      next.signals = narrative.signals ?? [];
    });
    // 与 adoptRefactoredNarrative 同款保护：盖章是跨文件三产物（narrative+镜像 quest+对话桩）
    // 一体暂存，画布 Ctrl+Z 只回退 narrative 会击穿「全有全无」——Save All 落盘出劈叉三件套
    // （有 quest/桩、没对应作曲）。整体放弃 = 主编辑器放弃暂存，不走画布撤销（审查 W-E2）。
    resetHistory();
    setSavedDataHash(stableHash(JSON.stringify(normalizeFile(narrative))));
    setDirty(false);
    setCompositionId(summary.compositionId);
    void loadAuthoringCatalog().then((c) => {
      setCatalog(c);
      setKnownPlaneIdsForValidation(c.planeIds ?? null);
    });
    const bits = [`作曲 ${summary.compositionId}`];
    if (summary.questStaged) bits.push(`任务 ${summary.questId}`);
    if (summary.stubsStaged.length) bits.push(`对话桩 ${summary.stubsStaged.length} 个`);
    setStatus(`已盖章暂存：${bits.join('，')}——主编辑器 Save All 一次性落盘全部（放弃则全都不写盘）。`);
  }, [resetHistory, updateData]);

  // ---- 叙事重构（信号/状态/图id）：宿主引擎全项目级联，采纳返回数据并清画布撤销栈 ----
  const [signalRefactor, setSignalRefactor] = useState<NarrativeRefactorRequest | null>(null);
  const [refactorJournalSize, setRefactorJournalSize] = useState(0);

  const adoptRefactoredNarrative = useCallback((narrative: NarrativeGraphsFileDef, journalSize: number, message: string) => {
    const normalized = normalizeFile(narrative);
    // 不走 updateData/history：跨文件重构不允许被画布 Ctrl+Z「半撤销」（叙事回退而对话图/场景
    // 不回退 = 数据劈叉）；整体回退一律走「撤销重构」（宿主反向操作，全项目一体）。
    setDataInternal(normalized);
    resetHistory();
    scheduleRemoteSync(normalized);
    setSavedDataHash(stableHash(JSON.stringify(normalized)));
    setDirty(false);
    setRefactorJournalSize(journalSize);
    setStatus(message);
    void loadAuthoringCatalog().then((c) => {
      setCatalog(c);
      setKnownPlaneIdsForValidation(c.planeIds ?? null);
    });
  }, [resetHistory, scheduleRemoteSync]);

  const handleSignalRefactored = useCallback((result: SignalRefactorResultDef, description: string) => {
    if (!result.narrative) return;
    adoptRefactoredNarrative(
      result.narrative,
      result.journalSize ?? 0,
      `${description}——改动已暂存进主编辑器（未落盘）：Save All 应用，或「撤销重构」整体回退。`,
    );
  }, [adoptRefactoredNarrative]);

  const compositions = data.compositions ?? [];
  const currentDataJson = useMemo(() => JSON.stringify(normalizeFile(data)), [data]);
  const currentDataHash = useMemo(() => stableHash(currentDataJson), [currentDataJson]);
  const editorDirty = dirty || (savedDataHash !== '' && currentDataHash !== savedDataHash);

  // 撤销重构（P1-08）：画布有未暂存编辑时先确认——adoptRefactoredNarrative 会整体覆盖
  // 画布并清空撤销栈，不问就等于把重构之后的手工编辑静默扔掉（正向重构路径会先把画布
  // data 交宿主暂存，撤销路径没有对应机会，只能显式询问）。
  const undoRefactor = useCallback(() => {
    if (editorDirty) {
      const ok = window.confirm(
        '画布上有未暂存的修改（未按 Ctrl+S 暂存进工程模型）。\n'
        + '撤销重构会用回退后的全项目数据整体覆盖当前画布，这些修改将丢失且无法找回。\n\n'
        + '仍要撤销重构吗？（可先取消，Ctrl+S 暂存后再撤销）',
      );
      if (!ok) return;
    }
    void undoSignalRefactorRemote().then((result) => {
      if (!result.ok || !result.narrative) {
        setStatus(`撤销重构失败：${result.reason ?? '未知错误'}`);
        return;
      }
      adoptRefactoredNarrative(
        result.narrative,
        result.journalSize ?? 0,
        `${result.description ?? '已撤销重构'}（全项目一体回退，仍未落盘）。`,
      );
    });
  }, [adoptRefactoredNarrative, editorDirty]);

  // 重载页面统一入口（P0-2）：有未暂存草稿必须先确认（明说丢什么），确认后临时旁路
  // beforeunload 兜底守卫避免二次弹窗。菜单「重载页面」与 F5 都走这里。
  const bypassUnloadGuardRef = useRef(false);
  const confirmDiscardAndReload = useCallback(() => {
    if (editorDirty) {
      const ok = window.confirm(
        '画布上有未暂存的修改（未按 Ctrl+S 暂存进工程模型）。\n'
        + '重载页面会永久丢弃这些修改，且无法恢复。\n\n'
        + '仍要重载吗？（可先取消，Ctrl+S 暂存后再重载）',
      );
      if (!ok) return;
    }
    bypassUnloadGuardRef.current = true;
    reloadNarrativeEditorPage();
  }, [editorDirty]);

  // beforeunload 兜底（P0-2）：任何未经确认的整页卸载（脚本 reload、宿主导航等）在
  // 有脏草稿时都拦一道；经 confirmDiscardAndReload 确认过的重载不重复打扰。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!editorDirty || bypassUnloadGuardRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editorDirty]);
  const composition = useMemo(() => getComposition(data, compositionId), [data, compositionId]);
  const toggleCatGroup = useCallback((key: string) => {
    setCollapsedCatGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const compositionGroups = useMemo(() => groupCompositions(compositions, categories), [compositions, categories]);
  const subgraphGroups = useMemo(
    () => (composition
      ? groupSubgraphElements((composition.elements ?? []).filter((el) => isSubgraphElement(el)), categories, composition.id)
      : []),
    [composition, categories],
  );
  const renderCompositionItem = (comp: NarrativeCompositionDef): ReactNode => (
    <div className="composition-row" key={comp.id}>
      <button
        type="button"
        className={comp.id === composition?.id ? 'composition active' : 'composition'}
        onClick={() => {
          setCompositionId(comp.id);
          setGraphRef('main');
          setSelectedId(`graph:${comp.mainGraph.id}`);
          setSelectedJson(JSON.stringify(comp.mainGraph, null, 2));
        }}
      >
        <span>{graphDisplayName(comp.mainGraph)}</span>
        <small>编排ID: {comp.id} · 主图ID: {comp.mainGraph.id}</small>
      </button>
      <button
        type="button"
        className="row-delete"
        title="删除整个编排（连同主图与全部子图）"
        onClick={(e) => { e.stopPropagation(); deleteComposition(comp.id); }}
      >
        ✕
      </button>
    </div>
  );
  const renderSubgraphItem = (el: CompositionElementDef): ReactNode => (
    <div className="composition-row" key={el.id}>
      <button
        type="button"
        className={graphRef === `element:${el.id}` ? 'composition active' : 'composition'}
        onClick={() => {
          setGraphRef(`element:${el.id}`);
          setSelectedId(el.graph ? `graph:${el.graph.id}` : '');
          setSelectedJson(JSON.stringify(el.graph ?? {}, null, 2));
        }}
      >
        <span>{el.graph ? graphDisplayName(el.graph) : (el.label || el.id)}</span>
        <small>图ID: {el.graph?.id || ''} · 独占</small>
      </button>
      <button
        type="button"
        className="row-delete"
        title="删除该子图（连同其状态与迁移）"
        onClick={(e) => { e.stopPropagation(); deleteSubgraphElement(el.id); }}
      >
        ✕
      </button>
    </div>
  );
  // 分组渲染：未使用任何分类（仅一个「未分类」组或空）时保持原扁平列表，零视觉变化；
  // 一旦有分类则渲染可折叠分组头（命名分类在前、未分类殿后）。
  function renderCatGroups<T>(groups: CategoryGroup<T>[], keyPrefix: string, renderItem: (item: T) => ReactNode): ReactNode {
    const flat = groups.length === 0 || (groups.length === 1 && groups[0].isUncategorized);
    if (flat) return <>{groups.flatMap((group) => group.items).map(renderItem)}</>;
    return groups.map((group) => {
      const groupKey = `${keyPrefix}${group.key}`;
      const collapsed = collapsedCatGroups.has(groupKey);
      return (
        <div className="cat-group" key={groupKey}>
          <button
            type="button"
            className={`cat-group-head${group.isUncategorized ? ' uncategorized' : ''}`}
            onClick={() => toggleCatGroup(groupKey)}
            title={collapsed ? '展开分组' : '折叠分组'}
          >
            <span className="cat-caret">{collapsed ? '▸' : '▾'}</span>
            <span className="cat-name">{group.label}</span>
            <span className="cat-count">{group.items.length}</span>
          </button>
          {!collapsed && group.items.map(renderItem)}
        </div>
      );
    });
  }
  const graph = useMemo(() => getEditableGraph(composition, graphRef), [composition, graphRef]);
  const activeStates = useMemo(() => extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? {}, [runtimeSnapshot, simulation]);
  /** 全部活计图（主图 + 万一有的元素图），Debug 页签活计模拟操作行的数据源 */
  const simRunGraphs = useMemo(() => {
    const out: { id: string; label: string; states: string[] }[] = [];
    for (const comp of data.compositions ?? []) {
      for (const g of [comp.mainGraph, ...(comp.elements ?? []).map((el) => el.graph)]) {
        if (g?.run) out.push({ id: g.id, label: g.label || g.id, states: Object.keys(g.states ?? {}) });
      }
    }
    return out;
  }, [data]);
  const knownSignals = useMemo(() => collectKnownSignals(data), [data]);
  const selectedObject = useMemo(
    () => getSelectedSummary(composition, graph, graphRef, selectedId),
    [composition, graph, graphRef, selectedId],
  );
  const entityNarrative = useMemo(
    () => buildEntityNarrativeIndex(data, projection, validationIssues, activeStates, dialogueRelations),
    [data, projection, validationIssues, activeStates, dialogueRelations],
  );
  const transitionsForInspector = useMemo(() => {
    if (!graph) return [];
    const all = graph.transitions ?? [];
    if (!selectedId) return all;
    if (selectedId.startsWith('state:')) {
      const sid = selectedId.slice('state:'.length);
      return all.filter((tr) => String(tr.from) === sid || String(tr.to) === sid);
    }
    if (selectedId.startsWith('transition:')) {
      const tid = selectedId.slice('transition:'.length);
      return all.filter((tr) => tr.id === tid);
    }
    if (selectedId.startsWith('transition-anchor:')) {
      const parsed = parseTransitionAnchorId(selectedId);
      if (parsed?.graphId === graph.id) return all.filter((tr) => tr.id === parsed.transitionId);
    }
    return all;
  }, [graph, selectedId]);

  const refreshProjectionAndValidation = useCallback(async (nextData = data) => {
    await flushRemoteSync(normalizeFile(nextData));
  }, [data, flushRemoteSync]);

  useEffect(() => {
    void loadNarrativeDataWithSource().then(async (loaded) => {
      const next = normalizeFile(loaded.data);
      setDataInternal(next);
      setCompositionId(next.compositions?.[0]?.id ?? '');
      setSignalKey(collectKnownSignals(next)[0] ?? '');
      const loadedCatalog = await loadAuthoringCatalog();
      setCatalog(loadedCatalog);
      // 给 TS 权威校验上膛 activePlane 存在性检查（不注入则该检查跳过、只剩 Python 兜底）。
      setKnownPlaneIdsForValidation(loadedCatalog.planeIds ?? null);
      const loadedTemplates = await loadTemplates();
      setTemplates(loadedTemplates.templates ?? []);
      setCategories(await loadCategories());
      await flushRemoteSync(next);
      setDataSource(loaded.source);
      setSavedDataHash(stableHash(JSON.stringify(next)));
      setDirty(false);
      resetHistory();
      // 撤销日志挂在宿主 ProjectModel 上、跨页面加载存活：重载后恢复「撤销重构(n)」入口（P3）。
      setRefactorJournalSize(await refactorJournalSizeRemote());
      setStatus(`已加载：${loaded.source}`);
    });
  }, []);

  // 任务总线：面板打开或 compositionId 变化时，向宿主拉取该编排的关联清单。
  useEffect(() => {
    if (!taskBusOpen || !compositionId) return;
    let cancelled = false;
    void loadTaskIndex(compositionId).then((index) => {
      if (!cancelled) setTaskIndex(index);
    });
    return () => {
      cancelled = true;
    };
  }, [taskBusOpen, compositionId]);

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
      // 宿主跳转定位（PySide 位面面板 Tab2 双击）：切编排 + 聚焦状态。
      // focusIssue 声明在本 effect 之后，经 ref 转接（依赖数组直接引用会踩 TDZ）。
      focusState: (graphId: string, stateId: string): boolean => {
        const gid = String(graphId ?? '').trim();
        const sid = String(stateId ?? '').trim();
        const focus = focusIssueRef.current;
        if (!gid || !sid || !focus) return false;
        for (const comp of data.compositions ?? []) {
          const inMain = comp.mainGraph?.id === gid;
          const el = inMain ? undefined : (comp.elements ?? []).find((e) => e.graph?.id === gid);
          if (!inMain && !el) continue;
          focus({
            severity: 'warning',
            code: 'host.focusState',
            message: '',
            target: { kind: 'state', compositionId: comp.id, graphId: gid, stateId: sid, ...(el ? { elementId: el.id } : {}) },
          });
          return true;
        }
        return false;
      },
    };
    window.__narrativeEditor = api;
    // 崩溃兜底快照（P1-07）：卸载/崩溃后 __narrativeEditor 会被清掉，此变量刻意**不清除**，
    // 供顶层 ErrorBoundary 崩溃页导出草稿、宿主壳兜底读取。
    window.__narrativeEditorLastDraft = currentDataJson;
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

  useEffect(() => {
    const ids = [...new Set((catalog.dialogueGraphIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (ids.length === 0) {
      setDialogueRelations(emptyDialogueRelationIndex);
      return;
    }
    let cancelled = false;
    void loadDialogueRelations(ids).then((next) => {
      if (!cancelled) setDialogueRelations(next);
    });
    return () => {
      cancelled = true;
    };
  }, [catalog.dialogueGraphIds]);

  useEffect(() => {
    if (entityNarrative.owners.length === 0) {
      if (selectedEntityOwnerKey) setSelectedEntityOwnerKey('');
      return;
    }
    if (selectedEntityOwnerKey && entityNarrative.owners.some((owner) => owner.ownerKey === selectedEntityOwnerKey)) {
      return;
    }
    const fallback = entityNarrative.owners[0]!.ownerKey;
    if (selectedId.startsWith('element:') && composition) {
      const element = getElementByNodeId(composition, selectedId);
      const ownerType = element?.ownerType?.trim();
      const ownerId = element?.ownerId?.trim();
      if (element?.kind === 'wrapperGraph' && ownerType && ownerId) {
        const key = `${ownerType}:${ownerId}`;
        if (entityNarrative.owners.some((owner) => owner.ownerKey === key)) {
          setSelectedEntityOwnerKey(key);
          return;
        }
      }
    }
    setSelectedEntityOwnerKey(fallback);
  }, [entityNarrative, selectedEntityOwnerKey, selectedId, composition]);

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
    // 分组框随结构重建一并注入（经 ref 取，分组变更本身由下方 reconcile effect 处理）
    setNodes([...builtNodes, ...buildGroupFrameNodes(currentGroupsRef.current)]);
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

  // 分组数据变更（建/删/改名/改色/折叠/框几何）→ 就地对齐画布上的分组框节点
  useEffect(() => {
    setNodes((current) => reconcileGroupFrameNodes(current, currentGroups));
  }, [currentGroups]);

  const signalLabelMap = useMemo(() => buildSignalLabelMap(data), [data]);

  const { nodes: displayNodes, edges: displayEdges } = useMemo(() => {
    const selected = applyCanvasSelection(nodes, edges, selectedId);
    // 折叠呈现变换：成员隐藏、跨组连线改接分组框——只作用于 display 拷贝
    const grouped = applyEditorGroupDisplay(selected.nodes, selected.edges, currentGroups);
    // 信号显示模式（默认中文名，勾「信号id」回原始 id）：同样只作用于 display 拷贝
    if (preferences.canvasSignalDisplay === 'id') return grouped;
    return { nodes: grouped.nodes, edges: applySignalDisplayToEdges(grouped.edges, signalLabelMap) };
  }, [nodes, edges, selectedId, currentGroups, preferences.canvasSignalDisplay, signalLabelMap]);

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

  const groupActions = useMemo(() => ({
    rename: (gid: string) => {
      const g = currentGroupsRef.current[gid];
      if (!g) return;
      const name = window.prompt('分组名称：', g.name);
      if (!name?.trim()) return;
      updateCurrentGroups((groups) => (
        groups[gid] ? { ...groups, [gid]: { ...groups[gid], name: name.trim() } } : groups
      ));
    },
    setColor: (gid: string, color: string) => {
      updateCurrentGroups((groups) => (
        groups[gid] ? { ...groups, [gid]: { ...groups[gid], color } } : groups
      ));
    },
    toggleCollapsed: (gid: string) => {
      updateCurrentGroups((groups) => (
        groups[gid] ? { ...groups, [gid]: { ...groups[gid], collapsed: groups[gid].collapsed !== true } } : groups
      ));
    },
    remove: (gid: string) => {
      // 纯视觉层删除：框内节点与编排数据不受影响，无需确认
      updateCurrentGroups((groups) => {
        if (!groups[gid]) return groups;
        const next = { ...groups };
        delete next[gid];
        return next;
      });
    },
    setFrameRect: (gid: string, rect: { x: number; y: number; width: number; height: number }) => {
      updateCurrentGroups((groups) => (
        groups[gid]
          ? {
            ...groups,
            [gid]: {
              ...groups[gid],
              frame: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            },
          }
          : groups
      ));
    },
  }), [updateCurrentGroups]);

  const canvasActions = useMemo(() => ({
    toggleSubgraphElement: (elementId: string) => {
      const el = composition?.elements?.find((item) => item.id === elementId);
      if (!el || !isSubgraphElement(el)) return;
      toggleExpandedElement(elementId);
    },
    groupActions,
  }), [composition, toggleExpandedElement, groupActions]);

  const createGroupFrame = useCallback(() => {
    if (!compositionId) return;
    const name = window.prompt('新建分组框——显示名称：', '分组');
    if (!name?.trim()) return;
    // 放在当前实体节点云的质心附近；按已有组数错开避免完全重叠。无节点时用固定落点。
    const anchorNodes = nodes.filter((n) => (
      !n.parentId && n.data?.kind !== 'editorGroupFrame'
      && n.data?.kind !== 'graphAnchor' && n.data?.kind !== 'projectionAnchor' && n.data?.kind !== 'transitionAnchor'
    ));
    const cx = anchorNodes.length
      ? anchorNodes.reduce((sum, n) => sum + n.position.x, 0) / anchorNodes.length
      : 160;
    const cy = anchorNodes.length
      ? anchorNodes.reduce((sum, n) => sum + n.position.y, 0) / anchorNodes.length
      : 140;
    updateCurrentGroups((groups) => {
      const gid = newGroupId(groups);
      const offset = Object.keys(groups).length * 32;
      return {
        ...groups,
        [gid]: {
          name: name.trim(),
          color: groupColorForIndex(Object.keys(groups).length),
          frame: { x: Math.round(cx - 210 + offset), y: Math.round(cy - 150 + offset), width: 420, height: 300 },
        },
      };
    });
    setStatus(`已新建分组框「${name.trim()}」——拖动节点使其中心落入框内即归组；拖标题移动框，选中后拖角调大小。`);
  }, [compositionId, nodes, updateCurrentGroups]);

  const removeModelObjects = useCallback((ids: string[]) => {
    const targets = ids.filter((id) => isSelectionDeletable(id, graphRef));
    if (!targets.length) {
      setStatus('没有可删除的选中项');
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
    // 删除元素会连同其整个子图（全部状态与迁移）一并删除——这是最容易误操作、
    // 破坏面最大的一步，删除前显式确认（其余状态/迁移删除较轻且可撤销，不打断）。
    if (countedElements.size > 0) {
      const names = [...countedElements].join('、');
      const ok = window.confirm(
        `将删除 ${countedElements.size} 个元素（${names}），并连同其整个子图（状态与迁移）一起删除。\n` +
        `此操作可用 Ctrl+Z 撤销。是否继续？`,
      );
      if (!ok) {
        setStatus('已取消删除');
        return;
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
    setStatus(blockedLastState ? '至少要保留一个状态' : expectedRemoved ? `已删除 ${expectedRemoved} 个对象` : '未删除任何对象');
  }, [composition, compositionId, graph, graphRef, selectedId, updateData]);

  const onNodesChange: OnNodesChange<CanvasNode> = useCallback((changes) => {
    // 分组框是编辑器视觉层（且已 deletable:false），防御性排除：绝不进模型删除
    const removedNodeIds = changes
      .filter((c) => c.type === 'remove')
      .map((c) => c.id)
      .filter((id) => !parseGroupFrameNodeId(id));
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
    // 连线只在「编辑」模式建迁移；连线/调试模式用于查看关系与运行时，误拖不应改模型。
    if (canvasMode !== 'edit') {
      setStatus('仅「编辑」模式可连线创建迁移；连线 / 调试模式用于查看关系与运行时。');
      return;
    }
    const view = resolveActiveGraphView(composition, graphRef);
    if (!view) return;

    const source = stateEndpointFromNodeIdForView(conn.source ?? '', view);
    const target = stateEndpointFromNodeIdForView(conn.target ?? '', view);
    if (!source || !target) {
      setStatus('只有状态节点之间可以连线创建迁移');
      return;
    }
    if (source.graphId !== target.graphId) {
      setStatus('跨图关系请用信号、状态广播或投影元数据表达，不能直接跨图连线。');
      return;
    }

    if (view.kind === 'graphExclusive') {
      let createdTransition: NarrativeTransitionDef | null = null;
      updateCurrentGraph((g) => {
        createdTransition = createTransition(g, source.stateId, target.stateId);
      });
      // 经中间量重读：赋值发生在回调闭包里，TS 控制流会把变量收窄成 null/never。
      const createdInGraph = createdTransition as NarrativeTransitionDef | null;
      if (createdInGraph) {
        setSelectedId(view.scope.transitionEdgeId(createdInGraph.id));
        setSelectedJson(JSON.stringify(createdInGraph, null, 2));
        setStatus(`已创建迁移 ${createdInGraph.id}`);
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
    const created = createdTransition as NarrativeTransitionDef | null;
    if (created) {
      const edgeId = source.elementId ? inlineSubgraphTransitionId(source.elementId, created.id) : `transition:${created.id}`;
      setSelectedId(edgeId);
      setSelectedJson(JSON.stringify(created, null, 2));
      setStatus(`已创建迁移 ${created.id}`);
    }
  }, [canvasMode, composition, graph, graphRef, updateCurrentGraph, updateData]);

  const onNodeDragStop = useCallback((_event: unknown, node: CanvasNode) => {
    const draggedGid = parseGroupFrameNodeId(node.id);
    if (draggedGid) {
      updateCurrentGroups((groups) => {
        const g = groups[draggedGid];
        if (!g) return groups;
        return {
          ...groups,
          [draggedGid]: { ...g, frame: { ...g.frame, x: Math.round(node.position.x), y: Math.round(node.position.y) } },
        };
      });
      return;
    }
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
  }, [composition?.id, compositionId, graphRef, updateCurrentGraph, updateCurrentGroups, updateData]);

  const selectNode = useCallback((_event: unknown, node: CanvasNode) => {
    const selectedGid = parseGroupFrameNodeId(node.id);
    if (selectedGid) {
      // 分组框是编辑器视觉层，不是模型对象：检查器只展示分组定义本身
      setSelectedId(node.id);
      setSelectedJson(JSON.stringify(currentGroupsRef.current[selectedGid] ?? {}, null, 2));
      return;
    }
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
        setStatus(`已创建子图状态 ${newId}`);
      }
      return;
    }
    updateCurrentGraph((g) => { newId = createState(g); });
    if (newId) {
      setSelectedId(`state:${newId}`);
      setStatus(`已创建状态 ${newId}`);
    }
  }, [composition, compositionId, expandedElementIds, graphRef, selectedId, updateCurrentGraph, updateData]);

  const addCompositionAction = useCallback(() => {
    let compId = '';
    let graphId = '';
    let graphJson = '';
    updateData((next) => {
      const comp = createComposition(next);
      compId = comp.id;
      graphId = comp.mainGraph.id;
      graphJson = JSON.stringify(comp.mainGraph, null, 2);
    });
    setCompositionId(compId);
    setGraphRef('main');
    setSelectedId(graphId ? `graph:${graphId}` : '');
    setSelectedJson(graphJson);
    setExpandedElementIds([]);
  }, [updateData]);

  const addElementAction = useCallback((kind: ElementKind) => {
    if (!composition || graphRef !== 'main') return;
    let id = '';
    updateData((next) => {
      const comp = getComposition(next, composition.id);
      if (!comp) return;
      id = createElement(comp, kind, next).id;
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

  // 从侧栏「编排列表」删除整个编排（主图 + 全部元素/子图）。破坏面大 → 显式确认、可撤销。
  const deleteComposition = useCallback((compId: string) => {
    const target = (data.compositions ?? []).find((c) => c.id === compId);
    if (!target) return;
    const label = graphDisplayName(target.mainGraph) || compId;
    const elCount = (target.elements ?? []).length;
    const ok = window.confirm(
      `将删除整个编排「${label}」（编排ID: ${compId}），包含其主图与 ${elCount} 个元素/子图。\n` +
      `此操作可用 Ctrl+Z 撤销。是否继续？`,
    );
    if (!ok) { setStatus('已取消删除'); return; }
    updateData((next) => {
      next.compositions = (next.compositions ?? []).filter((c) => c.id !== compId);
    });
    if (compId === compositionId) {
      const remaining = (data.compositions ?? []).filter((c) => c.id !== compId);
      const nextComp = remaining[0];
      setCompositionId(nextComp?.id ?? '');
      setGraphRef('main');
      setSelectedId(nextComp ? `graph:${nextComp.mainGraph.id}` : '');
      setSelectedJson('');
    }
    // 刻意不在此清理它的整理分组标签：分类存在撤销历史之外，若在删除时一并抹掉，Ctrl+Z 只能
    // 复原叙事数据、复原不回分类，就不是「彻底回到删除前」。留成孤儿完全无害（分组按 id 反查、
    // 查不到就不渲染，永不进 JSON），并在下次编辑任一分类时由 pruneOrphans 自动清掉。
    setStatus(`已删除编排「${label}」`);
  }, [data, compositionId, updateData]);

  // 从侧栏「子图导航」删除一个子图元素（连同其内部状态与迁移）。显式确认、可撤销。
  const deleteSubgraphElement = useCallback((elementId: string) => {
    const el = composition?.elements?.find((e) => e.id === elementId);
    if (!el || !composition) return;
    const label = el.graph ? graphDisplayName(el.graph) : (el.label || elementId);
    const ok = window.confirm(
      `将删除子图「${label}」（元素ID: ${elementId}），连同其全部状态与迁移。\n` +
      `此操作可用 Ctrl+Z 撤销。是否继续？`,
    );
    if (!ok) { setStatus('已取消删除'); return; }
    updateData((next) => {
      const comp = getComposition(next, compositionId);
      if (comp) comp.elements = (comp.elements ?? []).filter((e) => e.id !== elementId);
    });
    if (graphRef === `element:${elementId}`) {
      setGraphRef('main');
      setSelectedId(`graph:${composition.mainGraph.id}`);
      setSelectedJson('');
    }
    // 同上：不在删除时抹掉它的整理分组标签，以保证 Ctrl+Z 能彻底复原（含分类）。
    // 孤儿标签无害且会在下次编辑分类时自动清理。
    setStatus(`已删除子图「${label}」`);
  }, [composition, compositionId, graphRef, updateData]);

  const selectionDeletable = isSelectionDeletable(selectedId, graphRef);

  const applyAutoLayout = useCallback(async () => {
    if (!composition) return;
    // ELK 异步：先对当前数据算好一份纯坐标 plan，再在 updateData 里同步写回既有位置字段，
    // 保持原有脏态/撤销流程不变；只写坐标，绝不碰任何其它数据/语义。
    const comp = getComposition(data, compositionId);
    if (!comp) return;
    setStatus('正在计算布局…');
    try {
      if (graphRef === 'main') {
        const plan = await computeCompositionLayout(comp, expandedElementIds);
        updateData((next) => {
          const target = getComposition(next, compositionId);
          if (target) applyCompositionLayout(target, plan);
        });
      } else {
        const target = getEditableGraph(comp, graphRef);
        if (!target) return;
        const positions = await computeGraphLayout(target);
        updateData((next) => {
          const nextComp = getComposition(next, compositionId);
          const nextGraph = nextComp ? getEditableGraph(nextComp, graphRef) : null;
          if (nextGraph) applyGraphLayout(nextGraph, positions);
        });
      }
      setFitTargetNodeIds([]);
      setFitViewRev((v) => v + 1);
      setStatus('已应用自动布局（ELK）');
    } catch (err) {
      console.error('[autoLayout] failed', err);
      setStatus('自动布局失败（详见控制台）');
    }
  }, [composition, data, compositionId, expandedElementIds, graphRef, updateData]);

  const fitCanvas = useCallback(() => {
    setFitTargetNodeIds([]);
    setFitViewRev((v) => v + 1);
  }, []);

  const applySelectedJson = useCallback(async () => {
    if (!selectedId || selectedId.startsWith('projection:')) {
      setStatus('投影连线只读，不能编辑');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(selectedJson);
    } catch (e) {
      setStatus(`JSON 解析失败：${String(e)}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setStatus('选中对象必须是 JSON 对象');
      return;
    }
    try {
      const candidate = normalizeFile(data);
      const nextSelectedId = applySelectedObjectJson(candidate, composition?.id ?? compositionId, graphRef, selectedId, parsed as Record<string, unknown>);
      if (!nextSelectedId) {
        setStatus('选中对象已不存在');
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
      // 走 history（可撤销/重做）而非 setDataInternal 绕过撤销栈——否则 Advanced 标签页里
      // 「应用 JSON」的改动进不了撤销栈，一次 Ctrl+Z 会静默把它丢弃且无重做项。
      updateData((next) => {
        for (const key of Object.keys(next)) delete (next as Record<string, unknown>)[key];
        Object.assign(next, normalized);
      });
      setSelectedId(nextSelectedId);
      setSelectedJson(JSON.stringify(getObjectForSelection(normalized, composition?.id ?? compositionId, graphRef, nextSelectedId), null, 2));
      setStatus('已应用 JSON');
    } catch (e) {
      setStatus(String(e));
    }
  }, [composition?.id, compositionId, data, graphRef, refreshProjectionAndValidation, selectedId, selectedJson, updateData]);

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
      setStatus('已暂存到工程模型（请在主编辑器执行「全部保存」写入磁盘）');
    } else {
      // 正常情况下 web 侧校验（TS∪Python）是桥端 Python 校验的超集，不会走到这里；
      // 桥校验偶发不可用/结果不一致时，给出可读提示而非直接抛英文协议串。
      // 注意：协议前缀已在上面的正则里判定过，这里只改「显示」不影响判定。
      const friendly = /^save blocked:/i.test(result)
        ? '保存被工程校验拦截：数据仍有校验错误（详见校验面板）'
        : `保存失败：${result}`;
      setStatus(friendly);
    }
  }, [data, flushRemoteSync]);

  const runLocalSimulation = useCallback(() => {
    const key = signalKey.trim();
    if (!key) {
      setStatus('信号为空');
      return;
    }
    // 状态链：运行时快照优先，其次上一次本地模拟（多步干跑连续性——活计循环验证靠它）
    const carried = extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? undefined;
    const result = simulateSignalImpact(data, key, carried, simRunLayer);
    setSimulation(result);
    setSimRunLayer(result.runLayer);
    setRuntimeSnapshot({ ok: false, reason: '正在显示本地模拟' });
    setStatus(`已模拟 ${result.recentTransitions.length} 条迁移`);
  }, [data, runtimeSnapshot, signalKey, simulation, simRunLayer]);

  /** 活计生命周期模拟操作（接单/重开/回退/切换激活）：与本地模拟共用状态链 */
  const applySimRunOp = useCallback((op: SimulationRunOp, graphId: string, stateId?: string) => {
    const carried = extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? undefined;
    const result = simulateRunLifecycle(data, op, graphId, { activeStates: carried, runLayer: simRunLayer, stateId });
    setSimulation(result);
    setSimRunLayer(result.runLayer);
    setRuntimeSnapshot({ ok: false, reason: '正在显示本地模拟' });
    setStatus(result.log.at(-1) ?? `已执行 ${op}`);
  }, [data, runtimeSnapshot, simulation, simRunLayer]);

  const clearLocalSimulation = useCallback(() => {
    setSimulation(null);
    setSimRunLayer(emptySimulationRunLayer());
    setRuntimeSnapshot({ ok: false, reason: '本地模拟已清空' });
    setStatus('本地模拟状态已清空（活计计数一并归零）');
  }, []);

  const pullRuntimeSnapshot = useCallback(async () => {
    const result = await getRuntimeSnapshot();
    setRuntimeSnapshot(result);
    setStatus(result.ok ? '已拉取运行时快照' : `运行时不可用：${result.reason}`);
  }, []);

  const emitRuntime = useCallback(async () => {
    const request = parseExternalSignalKey(signalKey.trim());
    const result = await emitRuntimeSignal(request);
    setRuntimeSnapshot(result);
    if (!result.ok) {
      runLocalSimulation();
      setStatus(`运行时不可用，已本地模拟：${result.reason}`);
    } else {
      setStatus('已发送运行时信号');
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
  focusIssueRef.current = focusIssue;

  // 任务问题：按当前 composition 实时计算（不走 Python get_task_index，那读的是上次存盘态）。
  // 信号发出集/位面归属来自 catalog（B 侧算），此处按字段名消费并对缺省容错（旧 host 无该字段=跳过对应检查）。
  const taskIssues = useMemo<TaskIssueDef[]>(() => {
    const out: TaskIssueDef[] = [];
    if (!composition) return out;
    const compId = composition.id;

    const graphs: Array<{ graph: NarrativeGraphDef; elementId?: string }> = [];
    if (composition.mainGraph?.id) graphs.push({ graph: composition.mainGraph });
    for (const el of composition.elements ?? []) {
      if (el.graph?.id) graphs.push({ graph: el.graph, elementId: el.id });
    }

    // 本作曲 blackbox 声明的 emit 集（web 侧现算，用于豁免"有声明"的监听信号）。
    const declaredEmits = new Set<string>();
    for (const el of composition.elements ?? []) {
      for (const raw of el.meta?.emits ?? []) {
        const s = String(raw ?? '').trim();
        if (s) declaredEmits.add(s);
      }
    }

    const emittedSignals = catalog.emittedSignals;
    const emittedSet = Array.isArray(emittedSignals) ? new Set(emittedSignals) : null;
    const planeMembership = catalog.planeMembership;
    const hasPlaneMembership = planeMembership != null && typeof planeMembership === 'object';
    const exclusivePlanes = new Set(catalog.planeExclusive ?? []);

    // emptyPlane：某 state.activePlane=P 但没有场景实体显式归属 P。
    // shared（共享世界型）位面缺省实体照常存在，只是提醒；exclusive（独立世界型）
    // 缺省实体不存在，零显式归属 = 激活后玩家面对空世界，强提示。
    if (hasPlaneMembership) {
      for (const { graph, elementId } of graphs) {
        for (const [stateId, state] of Object.entries(graph.states ?? {})) {
          const plane = String(state.activePlane ?? '').trim();
          if (!plane) continue;
          if ((planeMembership[plane] ?? 0) > 0) continue;
          const isExclusive = exclusivePlanes.has(plane);
          out.push({
            kind: 'emptyPlane',
            severity: 'warning',
            message: isExclusive
              ? `位面「${plane}」是独立世界型（exclusive）且没有显式归属它的实体：状态 ${graph.id}.${stateId} 激活后玩家将面对空世界`
              : `位面「${plane}」被状态 ${graph.id}.${stateId} 激活，但无显式归属该位面的实体（缺省实体不计入，共享世界仍可见）`,
            focus: {
              severity: 'warning',
              code: 'task.plane.empty',
              message: '',
              target: { kind: 'state', compositionId: compId, graphId: graph.id, stateId, ...(elementId ? { elementId } : {}) },
            },
          });
        }
      }
    }

    // danglingEmitDeclared：blackbox 声明发出 E，但全项目无对话/资产真发它。
    if (emittedSet) {
      for (const el of composition.elements ?? []) {
        for (const raw of el.meta?.emits ?? []) {
          const sig = String(raw ?? '').trim();
          if (!sig || emittedSet.has(sig)) continue;
          out.push({
            kind: 'danglingEmitDeclared',
            severity: 'warning',
            message: `blackbox ${el.label || el.id} 声明发出信号「${sig}」，但没有任何对话/资产真正发出它`,
            focus: {
              severity: 'warning',
              code: 'task.emit.declaredNoEmit',
              message: '',
              target: { kind: 'element', compositionId: compId, elementId: el.id },
            },
          });
        }
      }
    }

    // danglingSignalNoEmit：transition 监听信号 S，但无人发出、也无 blackbox 声明。
    if (emittedSet) {
      for (const { graph, elementId } of graphs) {
        for (const t of graph.transitions ?? []) {
          if ((t.trigger ?? 'signal') !== 'signal') continue;
          const sig = String(t.signal ?? '').trim();
          if (!sig || sig === DEFAULT_DRAFT_SIGNAL) continue;
          if (emittedSet.has(sig) || declaredEmits.has(sig)) continue;
          out.push({
            kind: 'danglingSignalNoEmit',
            severity: 'warning',
            message: `转移 ${graph.id}.${t.id} 监听信号「${sig}」，但无人发出也无 blackbox 声明`,
            focus: {
              severity: 'warning',
              code: 'task.signal.noEmit',
              message: '',
              target: { kind: 'transition', compositionId: compId, graphId: graph.id, transitionId: t.id, ...(elementId ? { elementId } : {}) },
            },
          });
        }
      }
    }

    // badRef：复用现有 validationIssues 里的引用/悬空类问题（限本作曲），focus 用原 issue。
    for (const issue of validationIssues) {
      if (!isBadRefCode(issue.code)) continue;
      if (!issueInComposition(issue, compId, data)) continue;
      out.push({ kind: 'badRef', severity: issue.severity, message: issue.message, focus: issue });
    }

    return out;
  }, [composition, catalog, validationIssues, data]);

  const breadcrumbs = useMemo(() => {
    if (!composition) return [] as { label: string; onClick?: () => void }[];
    const crumbs: { label: string; onClick?: () => void }[] = [
      {
        label: graphDisplayName(composition.mainGraph),
        onClick: () => {
          setGraphRef('main');
          setSelectedId(`graph:${composition.mainGraph.id}`);
          setSelectedJson(JSON.stringify(composition.mainGraph, null, 2));
        },
      },
      {
        label: graphRef === 'main' ? `主图 ${composition.mainGraph.id}` : graphLabel(composition, graphRef),
        onClick: graphRef !== 'main' ? () => {
          setGraphRef('main');
          setSelectedId(`graph:${composition.mainGraph.id}`);
          setSelectedJson(JSON.stringify(composition.mainGraph, null, 2));
        } : undefined,
      },
    ];
    if (graphRef === 'main') {
      for (const eid of expandedElementIds) {
        const el = composition.elements?.find((item) => item.id === eid);
        if (el) {
          crumbs.push({
            label: `${el.graph ? graphDisplayName(el.graph) : (el.label || el.id)}（内联）`,
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
    { id: 'save', label: '暂存到工程 Ctrl+S · 需在主编辑器「全部保存」写盘', onSelect: () => { void save(); } },
    {
      id: 'refresh',
      label: '刷新投影',
      onSelect: () => { void refreshProjectionAndValidation(data); },
    },
    { id: 'reload', label: '重载页面  F5', onSelect: confirmDiscardAndReload },
  ], [confirmDiscardAndReload, data, refreshProjectionAndValidation, save]);

  const canvasMenuItems = useMemo((): ToolbarMenuItem[] => [
    {
      id: 'delete',
      label: '删除选中  Del / Backspace',
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
      if (e.isComposing) return;
      const target = e.target;
      const inTextField = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      const key = e.key.toLowerCase();
      const command = e.ctrlKey || e.metaKey;

      if (command && key === 's') {
        e.preventDefault();
        e.stopPropagation();
        void save();
        return;
      }
      if (!inTextField && command && key === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (!inTextField && command && key === 'y') {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }
      if (!inTextField && (key === 'delete' || key === 'backspace')) {
        if (selectionDeletable) deleteSelected();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!inTextField && key === 'f' && !command && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setFitTargetNodeIds([]);
        setFitViewRev((v) => v + 1);
        return;
      }
      if (key === 'f5') {
        // P0-2：始终拦下默认行为（纯浏览器里 F5 默认=整页刷新，正是要堵的口子）；
        // 焦点在文本框时不触发重载（主编辑器全局 F5=运行游戏的肌肉记忆误伤区），
        // 其余情况走带脏确认的统一重载入口。
        e.preventDefault();
        e.stopPropagation();
        if (!inTextField) confirmDiscardAndReload();
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [confirmDiscardAndReload, deleteSelected, redo, save, selectionDeletable, undo]);

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
          {renderCatGroups(compositionGroups, 'comp:', renderCompositionItem)}
        </div>

        {composition && (
          <>
            <div className="section-title">子图导航</div>
            <button type="button" className={graphRef === 'main' ? 'composition active' : 'composition'} onClick={() => {
              setGraphRef('main');
              setSelectedId(`graph:${composition.mainGraph.id}`);
              setSelectedJson(JSON.stringify(composition.mainGraph, null, 2));
            }}>
              <span>{graphDisplayName(composition.mainGraph) || '主图'}</span>
              <small>主图ID: {composition.mainGraph.id}</small>
            </button>
            {renderCatGroups(subgraphGroups, `sub:${composition.id}:`, renderSubgraphItem)}
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
            <button type="button" className="toolbar-btn" onClick={() => setEntityPanelOpen((v) => !v)} title={entityPanelOpen ? '关闭实体叙事状态面板' : '打开实体叙事状态面板'}>
              {entityPanelOpen ? '实体−' : '实体+'}
            </button>
            <button type="button" className="toolbar-btn" onClick={() => setTaskBusOpen((v) => !v)} title={taskBusOpen ? '关闭任务总线面板' : '打开任务总线面板（本编排牵涉的引用/位面/场景实体/任务）'}>
              {taskBusOpen ? '任务总线−' : '任务总线+'}
            </button>
            <button type="button" className="toolbar-btn" onClick={() => setTemplatesOpen((v) => !v)} title={templatesOpen ? '关闭模板面板' : '打开叙事状态机模板面板（填 taskId 一键派生新任务）'}>
              {templatesOpen ? '模板−' : '模板+'}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={createGroupFrame}
              title="新建画布分组框：命名/配色的矩形框，节点中心落入框内即归组；纯编辑器视觉整理，不影响编排数据。存 editor_data，随工程固化。"
            >
              +分组框
            </button>
            <label className="toggle compact-toggle" title="勾选后画布连线显示原始信号 id；不勾显示信号注册表里的中文名（无中文名的仍显示 id）。只影响显示，不改数据。">
              <input
                type="checkbox"
                checked={preferences.canvasSignalDisplay === 'id'}
                onChange={(e) => setPreferences({ canvasSignalDisplay: e.target.checked ? 'id' : 'label' })}
              />
              信号id
            </label>
            {refactorJournalSize > 0 && (
              <button
                type="button"
                className="toolbar-btn"
                onClick={undoRefactor}
                title="撤销最近一次信号重构（改名=反向改名；删除=精确回放复原）。全项目一体回退，只动暂存不落盘。"
              >
                撤销重构({refactorJournalSize})
              </button>
            )}
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
                if (node.id.startsWith('element:')) {
                  const eid = node.id.slice('element:'.length);
                  canvasActions.toggleSubgraphElement(eid);
                  return;
                }
                // 双击=就地改名（走全项目重构，先预览再执行）：状态节点 / 图节点 / 展开子图内的状态
                const inline = parseInlineSubgraphId(node.id);
                if (inline?.kind === 'state') {
                  const el = composition?.elements?.find((item) => item.id === inline.elementId);
                  if (el?.graph) setSignalRefactor({ kind: 'state-rename', graphId: el.graph.id, stateId: inline.objectId });
                  return;
                }
                if (node.id.startsWith('state:') && graph) {
                  setSignalRefactor({ kind: 'state-rename', graphId: graph.id, stateId: node.id.slice('state:'.length) });
                  return;
                }
                if (node.id.startsWith('graph:') && graph) {
                  setSignalRefactor({ kind: 'graph-rename', graphId: graph.id });
                }
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

          {entityPanelOpen && (
            <aside className="entity-global-panel">
              <div className="entity-global-head">
                <div>
                  <div className="section-title">实体叙事状态</div>
                  <div className="muted">全局 wrapper / 读写 / 信号关系</div>
                </div>
                <button type="button" onClick={() => setEntityPanelOpen(false)}>关闭</button>
              </div>
              <EntityNarrativeInspector
                index={entityNarrative}
                selectedOwnerKey={selectedEntityOwnerKey}
                onSelectOwnerKey={setSelectedEntityOwnerKey}
                setCompositionId={setCompositionId}
                setGraphRef={setGraphRef}
                setSelectedId={setSelectedId}
                setSelectedJson={setSelectedJson}
                setFitTargetNodeIds={setFitTargetNodeIds}
                setFitViewRev={setFitViewRev}
              />
            </aside>
          )}

          {taskBusOpen && (
            <aside className="entity-global-panel task-bus-panel">
              <div className="entity-global-head">
                <div>
                  <div className="section-title">任务总线</div>
                  <div className="muted">本编排牵涉的引用 / 位面 / 场景实体 / 任务</div>
                </div>
                <button type="button" onClick={() => setTaskBusOpen(false)}>关闭</button>
              </div>
              <TaskBusPanel index={taskIndex} issues={taskIssues} onFocusIssue={focusIssue} compositionLabel={composition?.label} onClose={() => setTaskBusOpen(false)} />
            </aside>
          )}

          {templatesOpen && (
            <aside className="entity-global-panel task-bus-panel">
              <div className="entity-global-head">
                <div>
                  <div className="section-title">叙事状态机模板</div>
                  <div className="muted">archetype 盖章：一键派生新任务</div>
                </div>
                <button type="button" onClick={() => setTemplatesOpen(false)}>关闭</button>
              </div>
              <TemplatesPanel
                templates={templates}
                catalog={catalog}
                currentComposition={composition}
                currentNarrative={data}
                onTemplatesChange={setTemplates}
                onStamped={handleStamped}
                onClose={() => setTemplatesOpen(false)}
              />
            </aside>
          )}

          {signalRefactor && (
            <SignalRefactorModal
              open
              request={signalRefactor}
              data={data}
              onClose={() => setSignalRefactor(null)}
              onRefactored={handleSignalRefactored}
            />
          )}

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
              onClick={() => {
                if (!composition) return;
                setGraphRef('main');
                setSelectedId(`graph:${composition.mainGraph.id}`);
                setSelectedJson(JSON.stringify(composition.mainGraph, null, 2));
              }}
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
                {tab === 'properties'
                  ? '属性'
                  : tab === 'transitions'
                    ? '关联迁移'
                    : tab === 'debug'
                      ? '调试'
                      : '高级'}
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
              categories={categories}
              onSetCompositionCategory={setCompositionCategoryFor}
              onSetSubgraphCategory={setSubgraphCategoryFor}
              onRequestSignalRefactor={(req) => setSignalRefactor(req)}
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
            {transitionsForInspector.map((tr) => {
              const trSignalNote = (data.signals ?? []).find((s) => s.id === tr.signal)?.notes?.trim();
              return (
              <button
                key={tr.id}
                type="button"
                className={`transition-row${selectedId === `transition:${tr.id}` ? ' active' : ''}`}
                title={trSignalNote ? `信号「${tr.signal}」：${trSignalNote}` : undefined}
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
                <small>{tr.signal === DEFAULT_DRAFT_SIGNAL ? '(草稿)' : (tr.signal || '(草稿)')}{trSignalNote ? ' 📝' : ''}</small>
              </button>
              );
            })}
            {transitionsForInspector.length === 0 && (
              <div className="muted">当前选中对象没有关联迁移</div>
            )}
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
              <button type="button" onClick={clearLocalSimulation} title="清掉本地模拟的状态链与活计计数，从头再来">清空模拟</button>
            </div>
            {simRunGraphs.length > 0 && (
              <div className="field">
                <label title="与运行时同语义：蛰伏不吃信号、全局单激活槽、到出口自动结算计数。用于在编辑器里干跑接单→交付→再接的循环。">活计模拟</label>
                {simRunGraphs.map((rg) => {
                  const active = activeStates[rg.id] as string | undefined;
                  const isActivated = simRunLayer.activatedArchetype === rg.id;
                  const isSuspended = simRunLayer.suspended.includes(rg.id);
                  const started = simRunLayer.started[rg.id] ?? 0;
                  const settledText = Object.entries(simRunLayer.settled[rg.id] ?? {})
                    .map(([exit, n]) => `${exit}×${n}`).join('，');
                  const statusText = active === undefined
                    ? `蛰伏${settledText ? ` · 已结算 ${settledText}` : started > 0 ? '' : '（未接过）'}`
                    : `第${started}单 · ${active}${isActivated ? ' · 激活中' : isSuspended ? ' · 挂起' : ''}${settledText ? ` · 已结算 ${settledText}` : ''}`;
                  return (
                    <div key={rg.id} style={{ marginBottom: 6 }}>
                      <div className="muted">⟳ {rg.label}｜{statusText}</div>
                      <div className="inspector-actions">
                        <button type="button" disabled={active !== undefined} title="startNarrativeRun：开新一轮并激活（顶替当前激活单）" onClick={() => applySimRunOp('start', rg.id)}>接单</button>
                        <button type="button" disabled={active === undefined || isActivated} title="activateNarrativeRun：切换激活，从当前态续跑" onClick={() => applySimRunOp('activate', rg.id)}>激活</button>
                        <button type="button" disabled={!isActivated} title="activateNarrativeRun('')：放下当前单（resumable 挂起、否则弃置）" onClick={() => applySimRunOp('activate', '')}>放下</button>
                        <button type="button" disabled={active === undefined} title="resetNarrativeRun：回初始状态重来（静默不广播）" onClick={() => applySimRunOp('reset', rg.id)}>重开</button>
                        <select
                          value=""
                          disabled={active === undefined}
                          title="revertNarrativeRun：跳回指定状态续玩（静默不广播）"
                          onChange={(e) => { if (e.target.value) applySimRunOp('revert', rg.id, e.target.value); }}
                        >
                          <option value="">回退到…</option>
                          {rg.states.map((sid) => <option key={sid} value={sid}>{sid}</option>)}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
  const lastFitKey = useRef('');
  const fitDone = useRef(false);

  useEffect(() => {
    const key = `${props.compositionId}|${props.graphRef}|${props.fitViewRev}|${props.fitTargetNodeIds.join(',')}`;
    // 仅在"真需要 fit"的信号变化时重置（切图/切编排/显式 fitViewRev++/聚焦目标变化）。
    if (lastFitKey.current !== key) {
      lastFitKey.current = key;
      fitDone.current = false;
    }
    // 本 key 已成功 fit 过 → 之后节点数组仅因拖动/编辑触发重建而变化时不再重复 fit，
    // 消除"拖一下就重新居中"的视口跳动；尚未成功时才（重）试，兼顾目标节点延迟渲染。
    if (fitDone.current) return;
    const duration = props.reduceMotion ? 0 : 220;
    const t = window.setTimeout(() => {
      if (props.fitTargetNodeIds.length) {
        const existing = new Set(props.nodes.map((node) => node.id));
        const targets = props.fitTargetNodeIds.filter((id) => existing.has(id));
        if (targets.length) {
          void fitView({ nodes: targets.map((id) => ({ id })), padding: 0.35, duration, maxZoom: 1.25 });
          fitDone.current = true;
        }
        // 目标节点尚未渲染 → 不标记完成，等下次节点变化再试
      } else {
        void fitView({ padding: 0.2, duration: props.reduceMotion ? 0 : 200 });
        fitDone.current = true;
      }
    }, 80);
    return () => window.clearTimeout(t);
  }, [props.compositionId, props.graphRef, props.fitViewRev, props.fitTargetNodeIds, props.nodes, props.reduceMotion, fitView]);

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
  categories: NarrativeCategoriesFileDef;
  onSetCompositionCategory: (compId: string, name: string) => void;
  onSetSubgraphCategory: (compId: string, elId: string, name: string) => void;
  /** 叙事重构入口（信号/状态/图 id 的全项目级联重构，仅 Qt 宿主内可用）。 */
  onRequestSignalRefactor?: (req: NarrativeRefactorRequest) => void;
}) {
  const { composition, graph, graphRef, selectedId } = props;
  const statesByGraph = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { graph: g } of compileGraphs(props.data)) out[g.id] = Object.keys(g.states ?? {});
    return out;
  }, [props.data]);
  const graphLabels = useMemo(() => Object.fromEntries(
    compileGraphs(props.data).map(({ graph: g }) => [g.id, graphReferenceLabel(g)]),
  ), [props.data]);
  const stateLabelsByGraph = useMemo(() => Object.fromEntries(
    compileGraphs(props.data).map(({ graph: g }) => [
      g.id,
      Object.fromEntries(Object.entries(g.states ?? {}).map(([sid, state]) => [sid, stateReferenceLabel(state, sid)])),
    ]),
  ), [props.data]);
  if (!composition || !graph) return <p className="muted">未选择编排。</p>;
  if (!selectedId) return <GraphInspector {...props} graph={graph} />;
  if (parseGroupFrameNodeId(selectedId)) {
    return (
      <p className="muted">
        画布分组框：纯编辑器视觉整理层，不进编排数据。
        双击标题改名；拖标题移动；选中后拖角调大小；标题栏按钮改色 / 折叠 / 删除。
      </p>
    );
  }
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
              graphLabels={graphLabels}
              statesByGraph={statesByGraph}
              stateLabelsByGraph={stateLabelsByGraph}
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
            graphLabels={graphLabels}
            statesByGraph={statesByGraph}
            stateLabelsByGraph={stateLabelsByGraph}
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
    if (!element || !subgraph) return <p className="muted">找不到展开的子图。</p>;
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
      ) : <p className="muted">找不到子图状态。</p>;
    }
    const transition = subgraph.transitions.find((t) => t.id === inline.objectId);
    return transition ? (
      <TransitionInspector
        {...props}
        graph={subgraph}
        transition={transition}
        graphIds={Object.keys(statesByGraph)}
        graphLabels={graphLabels}
        statesByGraph={statesByGraph}
        stateLabelsByGraph={stateLabelsByGraph}
        knownSignals={props.knownSignals}
        updateCurrentGraph={updateInlineGraph}
        setSelectedId={(id) => props.setSelectedId(prefixInlineSelection(inline.elementId, id))}
      />
    ) : <p className="muted">找不到子图迁移。</p>;
  }
  if (selectedId.startsWith('state:')) {
    const stateId = selectedId.slice('state:'.length);
    const state = graph.states[stateId];
    return state ? <StateInspector {...props} state={state} stateId={stateId} graph={graph} /> : <p className="muted">找不到状态。</p>;
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
          graphLabels={graphLabels}
          statesByGraph={statesByGraph}
          stateLabelsByGraph={stateLabelsByGraph}
          knownSignals={props.knownSignals}
        />
      ) : <p className="muted">找不到迁移。</p>;
  }
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const element = getElementByNodeId(composition, selectedId);
    return element ? <ElementInspector {...props} element={element} knownSignals={props.knownSignals} graphIds={Object.keys(statesByGraph)} /> : <p className="muted">找不到元素。</p>;
  }
  if (selectedId.startsWith('projection:')) {
    const edge = findProjectionEdge(props.projection, selectedId.replace('projection:', ''));
    return edge ? <ExternalWiringInspector edge={edge} /> : <p className="muted">找不到外部接线。</p>;
  }
  return <GraphInspector {...props} graph={graph} />;
}

function AdvancedInspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="advanced-inspector">
      <summary>{title}</summary>
      <div className="advanced-inspector-body">{children}</div>
    </details>
  );
}

function PropertySummary({
  title,
  rows,
}: {
  title?: string;
  rows: Array<[string, string] | null | undefined>;
}) {
  const visibleRows = rows.filter((row): row is [string, string] => Boolean(row));
  if (!title && visibleRows.length === 0) return null;
  return (
    <div className="property-summary">
      {title && <b>{title}</b>}
      {visibleRows.length > 0 && (
        <div className="property-summary-grid">
          {visibleRows.map(([label, value]) => (
            <div className="property-summary-row" key={label}>
              <span>{label}</span>
              <strong>{value || '—'}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GraphInspector(props: {
  data: NarrativeGraphsFileDef;
  composition?: NarrativeCompositionDef;
  graph: NarrativeGraphDef;
  graphRef: GraphRef;
  catalog: AuthoringCatalogDef;
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setStatus?: (status: string) => void;
  categories?: NarrativeCategoriesFileDef;
  onSetCompositionCategory?: (compId: string, name: string) => void;
  onSetSubgraphCategory?: (compId: string, elId: string, name: string) => void;
  onRequestSignalRefactor?: (req: NarrativeRefactorRequest) => void;
}) {
  const { graph, updateCurrentGraph, catalog, composition, graphRef } = props;
  const ownerChoices = ownerChoicesForGraph(graph, catalog);
  const parentElement = graphRef !== 'main' ? getElementByGraphRef(composition, graphRef) : undefined;
  const parentMeta = parentElement?.meta;
  return (
    <div className="form-grid">
      {parentElement && (
        <PropertySummary
          title={parentElement.graph ? graphDisplayName(parentElement.graph) : (parentElement.label || parentElement.id)}
          rows={[
            ['类型', elementSubtitle(parentElement)],
            parentElement.ownerType || parentElement.ownerId ? ['绑定', `${parentElement.ownerType || 'entity'} / ${parentElement.ownerId || '—'}`] : null,
            (parentMeta?.emits?.length ?? 0) > 0 ? ['发出', (parentMeta?.emits ?? []).join(', ')] : null,
            (parentMeta?.reads?.length ?? 0) > 0 ? ['读取', (parentMeta?.reads ?? []).join(', ')] : null,
          ]}
        />
      )}
      <TextField
        label="显示名"
        value={String(graph.label ?? '').trim() || graph.id}
        onChange={(value) => updateCurrentGraph((g, next) => {
          // 显示名为空或与 id 相同时删键（显示本就回退到 id），避免把 id 注入成显式 label。
          const keep = !!value.trim() && value.trim() !== g.id;
          if (keep) g.label = value.trim(); else delete g.label;
          if (parentElement && composition) {
            const comp = getComposition(next, composition.id);
            const el = comp?.elements?.find((item) => item.id === parentElement.id);
            if (el) { if (keep) el.label = value.trim(); else delete el.label; }
          }
        })}
      />
      <div className="property-line">
        <label>图 ID</label>
        <div className="signal-field-row">
          <input readOnly value={graph.id} />
          {props.onRequestSignalRefactor && (
            <button
              type="button"
              title="全项目级联改图 id（含派生信号、画布读取声明、场景/任务/对话图/地图/图鉴条件、存档迁移映射）；先预览使用点再执行，可撤销，不落盘。画布上双击图节点也可直接改名。"
              onClick={() => props.onRequestSignalRefactor!({ kind: 'graph-rename', graphId: graph.id })}
            >
              改名…
            </button>
          )}
        </div>
      </div>
      {composition && props.categories && graphRef === 'main' && props.onSetCompositionCategory && (
        <TextField
          label="编排整理分组（编辑器专用·不写入JSON）"
          value={getCompositionCategory(props.categories, composition.id)}
          commitOnBlur
          datalistValues={distinctCompositionCategories(props.categories)}
          onChange={(value) => props.onSetCompositionCategory!(composition.id, value)}
        />
      )}
      {composition && props.categories && parentElement && isSubgraphElement(parentElement) && props.onSetSubgraphCategory && (
        <TextField
          label="子图整理分组（编辑器专用·不写入JSON）"
          value={getSubgraphCategory(props.categories, composition.id, parentElement.id)}
          commitOnBlur
          datalistValues={distinctSubgraphCategories(props.categories, composition.id)}
          onChange={(value) => props.onSetSubgraphCategory!(composition.id, parentElement.id, value)}
        />
      )}
      <SelectField label="初始状态" value={graph.initialState} values={Object.keys(graph.states)} onChange={(value) => updateCurrentGraph((g) => { g.initialState = value; })} />
      <label className="toggle single-line-toggle" title="活计=可重复接取的委托（背尸单等）：运行时不自动实例化，由 startNarrativeRun 接单开一轮，走到出口状态自动结算计数。常驻图（主线/一次性支线）不勾。">
        <input
          type="checkbox"
          checked={Boolean(graph.run)}
          onChange={(e) => updateCurrentGraph((g) => {
            // 勾选=声明活计（默认可重复）；取消=删键回常驻图（不写空对象）
            if (e.target.checked) g.run = { repeatable: true };
            else delete g.run;
          })}
        />
        活计图（可重复运行的委托）
      </label>
      {graph.run && (
        <>
          <label className="toggle single-line-toggle" title="做完一单（到出口状态结算）后可再次接单开新一轮。">
            <input
              type="checkbox"
              checked={graph.run.repeatable === true}
              onChange={(e) => updateCurrentGraph((g) => {
                if (!g.run) return;
                if (e.target.checked) g.run.repeatable = true;
                else delete g.run.repeatable;
              })}
            />
            可重复（结算后能再接）
          </label>
          <label className="toggle single-line-toggle" title="切换激活到别的活计时：勾=本单挂起存进度、切回续玩；不勾=切走即弃、切回从头。">
            <input
              type="checkbox"
              checked={graph.run.resumable === true}
              onChange={(e) => updateCurrentGraph((g) => {
                if (!g.run) return;
                if (e.target.checked) g.run.resumable = true;
                else delete g.run.resumable;
              })}
            />
            可挂起（切走保进度）
          </label>
          <div className="property-line note">活计图必须配入口/出口状态；出口=交付点，进入即结算（计数 +1、实例回收）。</div>
        </>
      )}
      {(graph.ownerType === 'scenario' || Boolean(graph.run) || graph.entryState || graph.exitStates?.length) && (
        <>
          <SelectField label="入口状态" value={graph.entryState ?? ''} values={Object.keys(graph.states)} onChange={(value) => updateCurrentGraph((g) => { g.entryState = value; })} />
          <StringListField label="出口状态" value={graph.exitStates ?? []} onChange={(value) => updateCurrentGraph((g) => { g.exitStates = value; })} />
        </>
      )}
      {graph.projectFlags === true && (
        <div className="property-line danger">projectFlags 已废弃；新图应使用明确的叙事状态读取。</div>
      )}
      {parentElement?.kind === 'wrapperGraph' && (
        <>
          <TextField
            label="分类备注（写入JSON·区分同一实体的多个包装）"
            value={graph.category ?? ''}
            onChange={(value) => updateCurrentGraph((g) => { g.category = value; })}
          />
          <div className="property-line note">
            当同一个绑定对象（同 NPC/物件…）被多张实体包装图绑定时，给每张填一个不同的分类，用来区分它们
            （如「白天线」「夜里线」）。会写入 narrative_graphs.json、显示在实体视图、并参与校验（多包装缺/撞分类会告警）。
            这与上面的「整理分组」不同——那个只在编辑器里整理、不写进数据。
          </div>
        </>
      )}
      <PropertySummary rows={[['状态', String(Object.keys(graph.states).length)], ['迁移', String(graph.transitions.length)]]} />
      <AdvancedInspectorSection title="高级">
        <TextField label="Owner Type" value={graph.ownerType} onChange={(value) => updateCurrentGraph((g) => { g.ownerType = value; })} />
        <TextField
          label="Owner ID"
          value={graph.ownerId ?? ''}
          datalistValues={ownerChoices}
          flagUnknown
          readOnlyNote={graph.ownerType?.trim() === 'flow'
            ? 'flow 主图的 ownerId 无任何机制消费（运行时/目录/校验都不读它），历史值仅当注释保留——2026-07-13 拍板判死，不再邀请填写'
            : undefined}
          onChange={(value) => updateCurrentGraph((g) => { g.ownerId = value; })}
        />
        {(graph.ownerType === 'scenario' || graph.entryState || graph.exitStates?.length) && (
          <div className="property-line note">Scenario 只有入口/出口状态可以和外部图直接连线；内部状态在展开后编辑。</div>
        )}
      </AdvancedInspectorSection>
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
  onRequestSignalRefactor?: (req: NarrativeRefactorRequest) => void;
}) {
  const { graph, state, stateId, updateCurrentGraph } = props;
  const planeIds = props.catalog.planeIds ?? [];
  const activePlane = typeof state.activePlane === 'string' ? state.activePlane : '';
  // 保值孤儿契约：当前值不在已登记位面清单时，下拉保留该值并标注（未登记），绝不静默丢字段。
  const activePlaneOrphan = activePlane !== '' && !planeIds.includes(activePlane);
  const activePlaneHint = '进入此状态激活该位面；整图无点名时=normal';
  return (
    <div className="form-grid">
      <TextField label="显示名" value={state.label ?? ''} onChange={(value) => updateCurrentGraph((g) => { if (value.trim()) g.states[stateId].label = value; else delete g.states[stateId].label; })} />
      <div className="property-line">
        <label>状态 ID</label>
        <div className="signal-field-row">
          <input readOnly value={state.id || stateId} />
          {props.onRequestSignalRefactor && (
            <button
              type="button"
              title="全项目级联改名（含派生信号监听、场景/任务/对话图条件、存档迁移映射）；先预览使用点再执行，可撤销，不落盘。画布上双击状态节点也可直接改名。"
              onClick={() => props.onRequestSignalRefactor!({ kind: 'state-rename', graphId: graph.id, stateId })}
            >
              改名…
            </button>
          )}
        </div>
      </div>
      <TextAreaField label="策划备注" value={state.description ?? ''} onChange={(value) => updateCurrentGraph((g) => { if (value.trim()) g.states[stateId].description = value; else delete g.states[stateId].description; })} />
      <label className="toggle single-line-toggle">
        <input type="checkbox" checked={graph.initialState === stateId} onChange={(e) => e.target.checked && updateCurrentGraph((g) => { g.initialState = stateId; })} />
        设为初始状态
      </label>
      <label className="toggle single-line-toggle">
        <input
          type="checkbox"
          checked={state.broadcastOnEnter === true}
          onChange={(e) => updateCurrentGraph((g) => {
            // 取消勾选=删键而非写 false（默认键注入会成为 agent 维护 JSON 的字节噪音）
            if (e.target.checked) g.states[stateId].broadcastOnEnter = true;
            else delete g.states[stateId].broadcastOnEnter;
          })}
        />
        进入时广播派生信号
      </label>
      {state.broadcastOnEnter === true && (
        <div className="property-line note one-line-derived" title={stateEnteredSignalKey(graph.id, stateId)}>
          Derived Signal: {stateEnteredSignalKey(graph.id, stateId)}
        </div>
      )}
      <div className="field" title={activePlaneHint}>
        <label>
          激活位面
          {activePlaneOrphan && (
            <span
              title="该位面 id 不在已登记的 planes.json 候选中（保值显示，不会静默丢弃）"
              style={{ color: '#d9a441', marginLeft: 4 }}
            >
              ⚠ 未登记
            </span>
          )}
        </label>
        <select
          value={activePlane}
          title={activePlaneHint}
          onChange={(e) => {
            const value = e.target.value;
            updateCurrentGraph((g) => {
              if (value) g.states[stateId].activePlane = value;
              else delete g.states[stateId].activePlane;
            });
          }}
        >
          <option value="">(无)</option>
          {planeIds.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
          {activePlaneOrphan && (
            <option value={activePlane}>{activePlane}（未登记）</option>
          )}
        </select>
        {activePlane && (
          <button
            type="button"
            className="task-bus-jump-plane"
            title="在位面编辑器中打开该位面"
            onClick={() => navigateTo('plane', activePlane)}
          >
            跳转到位面
          </button>
        )}
      </div>
      <ActionListField
        label="进入时动作"
        actions={state.onEnterActions ?? []}
        catalog={props.catalog}
        knownSignals={props.knownSignals}
        onChange={(actions) => updateCurrentGraph((g) => { g.states[stateId].onEnterActions = actions; })}
      />
      <ActionListField
        label="离开时动作"
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
  graphLabels: Record<string, string>;
  statesByGraph: Record<string, string[]>;
  stateLabelsByGraph: Record<string, Record<string, string>>;
  updateData: (updater: (next: NarrativeGraphsFileDef) => void) => void;
  updateCurrentGraph: (updater: (g: NarrativeGraphDef, next: NarrativeGraphsFileDef) => void) => void;
  setSelectedId: (id: string) => void;
  setStatus: (status: string) => void;
  deleteSelected: () => void;
  onRequestSignalRefactor?: (req: NarrativeRefactorRequest) => void;
}) {
  const { graph, transition, updateCurrentGraph } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const stateChoices = Object.keys(graph.states);
  // 被引用处显示信号注释：让人看着这条迁移就知道它监听的信号是干嘛的（注释在信号注册处编写）。
  const signalNote = (props.data.signals ?? []).find((s) => s.id === transition.signal)?.notes?.trim();
  const legacyEndpoint = typeof transition.from !== 'string' || typeof transition.to !== 'string';
  const triggerMode = transition.trigger ?? 'signal';
  const isReactive = triggerMode === 'reactive' || triggerMode === 'reactiveAll' || triggerMode === 'reactiveAny';
  return (
    <div className="form-grid">
      <div className="transition-route" title="迁移起止状态请在画布连线中修改">
        <span>{typeof transition.from === 'string' ? transition.from : '—'}</span>
        <b>→</b>
        <span>{typeof transition.to === 'string' ? transition.to : '—'}</span>
      </div>
      <div className="field">
        <label>触发方式</label>
        <select
          value={triggerMode}
          onChange={(e) => {
            const val = e.target.value;
            updateCurrentGraph((g) => {
              const t = transitionIn(g, transition.id);
              if (val === 'signal') {
                delete t.trigger;
              } else {
                t.trigger = val as 'reactive' | 'reactiveAll' | 'reactiveAny';
              }
            });
          }}
        >
          <option value="signal">信号触发</option>
          <option value="reactive">条件自动触发（原始条件）</option>
          <option value="reactiveAll">等待全部满足（自动AND）</option>
          <option value="reactiveAny">等待任一满足（自动OR）</option>
        </select>
      </div>
      {legacyEndpoint && <div className="property-line danger">旧跨图端点不支持直接编辑。请选择本图状态，并用信号或投影元数据表达跨图影响。</div>}
      {!isReactive && (
        <>
          <div className="property-line">
            <label>信号</label>
            <div className="signal-field-row">
              <input readOnly value={transition.signal || DEFAULT_DRAFT_SIGNAL} />
              <button type="button" onClick={() => setPickerOpen(true)}>选择</button>
              {props.onRequestSignalRefactor
                && transition.signal
                && transition.signal !== DEFAULT_DRAFT_SIGNAL
                && !transition.signal.startsWith('state:') && (
                <button
                  type="button"
                  title="全项目级联改信号名（监听/发射/注册表/画布声明，含对话图与场景）；先预览使用点再执行，可撤销，不落盘。"
                  onClick={() => props.onRequestSignalRefactor!({ kind: 'signal-rename', signalId: transition.signal })}
                >
                  改名…
                </button>
              )}
            </div>
            {signalNote ? <div className="signal-note-display">📝 {signalNote}</div> : null}
          </div>
          <SignalPickerModal
            open={pickerOpen}
            data={props.data}
            currentSignal={transition.signal}
            onClose={() => setPickerOpen(false)}
            onSelect={(signalId) => updateCurrentGraph((g) => { transitionIn(g, transition.id).signal = signalId; })}
            onDataChange={props.updateData}
            onRequestRefactor={props.onRequestSignalRefactor
              ? (mode, signalId) => props.onRequestSignalRefactor!(
                mode === 'rename' ? { kind: 'signal-rename', signalId } : { kind: 'signal-delete', signalId },
              )
              : undefined}
          />
        </>
      )}
      {isReactive && (
        <div className="property-line note">条件满足时自动推进，不需要选择信号。</div>
      )}
      <ConditionBuilder
        value={transition.conditions ?? []}
        graphIds={props.graphIds}
        graphLabels={props.graphLabels}
        statesByGraph={props.statesByGraph}
        stateLabelsByGraph={props.stateLabelsByGraph}
        onApply={(value) => updateCurrentGraph((g) => { transitionIn(g, transition.id).conditions = Array.isArray(value) ? value : value ? [value] : []; })}
      />
      <NumberField label="优先级" value={transition.priority ?? 0} onChange={(value) => updateCurrentGraph((g) => { const t = transitionIn(g, transition.id); if (value !== 0) t.priority = value; else delete t.priority; })} />
      <AdvancedInspectorSection title="高级">
        <ReadOnlyField label="Transition ID" value={transition.id} />
        <div className="property-line note">迁移只在当前图内移动状态；跨图影响应通过信号、状态广播或投影关系表达。</div>
      </AdvancedInspectorSection>
      <div className="inspector-actions">
        <button type="button" className="secondary" onClick={props.deleteSelected}>删除迁移</button>
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
  setSelectedJson: (json: string) => void;
  setGraphRef: (ref: GraphRef) => void;
  setStatus: (status: string) => void;
  expandedElementIds: string[];
  toggleExpandedElement: (elementId: string) => void;
  graphIds: string[];
  categories?: NarrativeCategoriesFileDef;
  onSetSubgraphCategory?: (compId: string, elId: string, name: string) => void;
}) {
  const { composition, element, catalog, updateData } = props;
  const ownerChoices = ownerChoicesFor(element, catalog);
  const isSubgraph = isSubgraphElement(element);
  // 子图元素的信号接口从内容自动推导（只读展示）；黑盒元素才保留手工登记。
  const derivedInterface = useMemo(() => deriveGraphInterface(element.graph), [element.graph]);
  const legacyMetaCount = element.graph
    ? (element.meta?.emits?.length ?? 0) + (element.meta?.reads?.length ?? 0)
    : 0;
  // 黑盒登记的是"将来实现会发的作者信号"，派生广播（state:…）由图自动产生，不作候选
  const authorSignalOptions = useMemo(
    () => props.knownSignals.filter((sig) => !sig.startsWith('state:')),
    [props.knownSignals],
  );
  const expanded = props.expandedElementIds.includes(element.id);
  const displayName = isSubgraph ? (String(element.graph?.label ?? element.label ?? '').trim() || element.graph?.id || element.id) : (element.label ?? '');
  return (
    <div className="form-grid">
      <PropertySummary rows={[['类型', kindLabel(element.kind)]]} />
      <TextField
        label="显示名"
        value={displayName}
        onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
          // 空或等于回退 id 时删键，不把 id 注入成显式 label；存原始 value（不 trim）
          // 以免尾随/内部空格被吃、无法输入「Phase 2」（审查 P2），仅用 trim 判定保留。
          const fallbackId = el.graph?.id || el.id;
          const v = value.trim();
          const keep = !!v && v !== fallbackId;
          if (keep) el.label = value; else delete el.label;
          if (isSubgraph && el.graph) { if (keep) el.graph.label = value; else delete el.graph.label; }
        })}
      />
      {isSubgraph && composition && props.categories && props.onSetSubgraphCategory && (
        <TextField
          label="整理分组（编辑器专用·不写入JSON）"
          value={getSubgraphCategory(props.categories, composition.id, element.id)}
          commitOnBlur
          datalistValues={distinctSubgraphCategories(props.categories, composition.id)}
          onChange={(value) => props.onSetSubgraphCategory!(composition.id, element.id, value)}
        />
      )}
      {element.kind === 'wrapperGraph' ? (
        <>
          <SelectField label="绑定类型" value={element.ownerType ?? 'npc'} values={WRAPPER_OWNER_TYPES} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.ownerType = value; if (el.graph) el.graph.ownerType = value; })} />
          <TextField label="绑定对象" value={element.ownerId ?? ''} datalistValues={ownerChoices} flagUnknown onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
            el.ownerId = value;
            if (el.graph) el.graph.ownerId = value;
          })} />
          <TextField label="分类备注（写入JSON·区分同一实体的多个包装）" value={element.graph?.category ?? ''} onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
            if (el.graph) el.graph.category = value;
          })} />
          <div className="property-line note">
            同一个绑定对象被多张实体包装图绑定时，给每张填不同分类以区分（如「白天线」「夜里线」）。会写入
            narrative_graphs.json、显示在实体视图、并参与校验。与上面「整理分组」（仅编辑器整理、不写数据）不同。
          </div>
        </>
      ) : element.kind === 'scenarioSubgraph' ? (
        <>
          <TextField label="Scenario" value={element.refId || element.ownerId || ''} datalistValues={ownerChoices} flagUnknown onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
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
              <SelectField label="入口状态" value={element.graph.entryState ?? ''} values={Object.keys(element.graph.states)} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { if (el.graph) el.graph.entryState = value; })} />
              <StringListField label="出口状态" value={element.graph.exitStates ?? []} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { if (el.graph) el.graph.exitStates = value; })} />
            </>
          )}
        </>
      ) : (
        <>
          <TextField label="来源类型" value={element.ownerType ?? ''} onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.ownerType = value; })} />
          <TextField label="引用对象" value={element.refId ?? ''} datalistValues={ownerChoices} flagUnknown onChange={(value) => updateElement(updateData, composition, element.id, (el) => {
            el.refId = value;
          })} />
        </>
      )}
      {isSubgraph && (
        <div className="inspector-actions">
          <button type="button" onClick={() => props.toggleExpandedElement(element.id)}>{expanded ? '在主画布收起子图' : '在主画布展开子图'}</button>
          <button type="button" className="secondary" onClick={() => {
            props.setGraphRef(`element:${element.id}`);
            props.setSelectedId(element.graph ? `graph:${element.graph.id}` : '');
            props.setSelectedJson(JSON.stringify(element.graph ?? {}, null, 2));
          }}>独占打开子图</button>
        </div>
      )}
      <AdvancedInspectorSection title="高级">
        <ReadOnlyField label="Element ID" value={element.id} />
        {element.graph ? (
          <>
            <SignalChipsField
              label="发出信号（自动推导）"
              value={derivedInterface.emits}
              note="这张子图实际会发出的信号——从子图内容自动算出，改子图这里就跟着变，不用手填。"
              emptyText="（不发出任何信号）"
            />
            <SignalChipsField
              label="监听信号（自动推导）"
              value={derivedInterface.listens}
              note="子图的迁移在等待哪些信号。"
              emptyText="（不监听信号）"
            />
            <SignalChipsField
              label="读取状态（自动推导）"
              value={derivedInterface.readsStates}
              note="子图条件里读取的别的图状态（图.状态）。"
              emptyText="（不读取其它图状态）"
            />
            {legacyMetaCount > 0 && (
              <div className="property-line note">
                这个元素还留着 {legacyMetaCount} 条旧的手填登记（子图内容就在本文件里，现已改为自动推导，手填登记不再需要）。
                <button
                  type="button"
                  className="secondary"
                  onClick={() => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.emits = []; el.meta.reads = []; })}
                >清空旧登记</button>
              </div>
            )}
          </>
        ) : (
          <>
            <SignalChipsField
              label="发出信号（登记）"
              value={element.meta?.emits ?? []}
              options={authorSignalOptions}
              onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.emits = value; })}
              note="登记这个黑盒（对话等）将来会发出的信号：实现还没写时，先登记就能接线、校验也不误报。写好后校验会核对登记与实际是否一致。"
              emptyText="（未登记）"
            />
            <SignalChipsField
              label="读取状态（登记）"
              value={element.meta?.reads ?? []}
              options={props.graphIds}
              onChange={(value) => updateElement(updateData, composition, element.id, (el) => { el.meta ??= {}; el.meta.reads = value; })}
              note="登记这个黑盒会读取哪些叙事图的状态，供画布接线展示和改名时自动跟踪。"
              emptyText="（未登记）"
            />
          </>
        )}
        {element.kind === 'wrapperGraph' && (
          <div className="property-line note">绑定后 DialogueGraph 的 OwnerStateNode 才能读取该 wrapper 的 activeState；ContextStateNode 应读取 flow/scenario 图，不能选 npc wrapper。</div>
        )}
        {element.kind === 'scenarioSubgraph' && (
          <div className="property-line note">Scenario 是有边界的局部子图：外部只能连入口状态，只有出口状态能连回外部。</div>
        )}
      </AdvancedInspectorSection>
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

type EntityNarrativeWrapperSummary = {
  ownerType: string;
  ownerId: string;
  ownerKey: string;
  compositionId: string;
  compositionLabel: string;
  elementId: string;
  elementLabel: string;
  graphId: string;
  category: string;
  activeState: string;
  states: string[];
  transitions: number;
  broadcasts: string[];
  inputSignals: Array<{
    signal: string;
    transitionId: string;
    from: string;
    to: string;
    emitters: string[];
  }>;
  outputs: Array<{
    stateId: string;
    signal: string;
    downstream: string[];
  }>;
  reads: string[];
  writes: string[];
  issues: string[];
};

type EntityNarrativeOwnerSummary = {
  ownerType: string;
  ownerId: string;
  ownerKey: string;
  wrappers: EntityNarrativeWrapperSummary[];
};

type EntityNarrativeIndex = {
  owners: EntityNarrativeOwnerSummary[];
};

function EntityNarrativeInspector(props: {
  index: EntityNarrativeIndex;
  selectedOwnerKey: string;
  onSelectOwnerKey: (key: string) => void;
  setCompositionId: (id: string) => void;
  setGraphRef: (ref: GraphRef) => void;
  setSelectedId: (id: string) => void;
  setSelectedJson: (json: string) => void;
  setFitTargetNodeIds: (ids: string[]) => void;
  setFitViewRev: (value: number | ((value: number) => number)) => void;
}) {
  const [search, setSearch] = useState('');
  if (props.index.owners.length === 0) {
    return <div className="muted">当前没有绑定实体的 wrapperGraph。</div>;
  }
  const owner = props.index.owners.find((item) => item.ownerKey === props.selectedOwnerKey) ?? props.index.owners[0]!;
  const q = search.trim().toLowerCase();
  const wrappers = owner.wrappers.filter((wrapper) => {
    if (!q) return true;
    if (wrapper.graphId.toLowerCase().includes(q)) return true;
    if (wrapper.category.toLowerCase().includes(q)) return true;
    if (wrapper.states.some((sid) => sid.toLowerCase().includes(q))) return true;
    if (wrapper.inputSignals.some((row) => row.signal.toLowerCase().includes(q))) return true;
    return false;
  });
  return (
    <div className="entity-view">
      <div className="field">
        <label>实体</label>
        <select value={owner.ownerKey} onChange={(e) => props.onSelectOwnerKey(e.target.value)}>
          {props.index.owners.map((item) => (
            <option key={item.ownerKey} value={item.ownerKey}>
              {item.ownerType}:{item.ownerId} ({item.wrappers.length})
            </option>
          ))}
        </select>
      </div>
      <div className="property-summary">
        <b>{owner.ownerType}:{owner.ownerId}</b>
        <div className="property-summary-grid">
          <div className="property-summary-row"><span>Wrapper</span><strong>{owner.wrappers.length}</strong></div>
        </div>
      </div>
      <div className="field">
        <label>搜索（graph/state/signal/category）</label>
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="entity-wrapper-list">
        {wrappers.map((wrapper) => (
          <details key={`${wrapper.compositionId}:${wrapper.elementId}`} className="entity-wrapper-card" open>
            <summary>
              <span>{wrapper.graphId}</span>
              <small>{wrapper.category || '未分类'} / {wrapper.activeState || '—'}</small>
            </summary>
            <PropertySummary
              rows={[
                ['composition', wrapper.compositionLabel || wrapper.compositionId],
                ['element', wrapper.elementLabel || wrapper.elementId],
                ['category', wrapper.category || '—'],
                ['states', wrapper.states.join(' / ')],
                ['transitions', String(wrapper.transitions)],
                ['broadcasts', wrapper.broadcasts.join(', ') || '—'],
              ]}
            />
            <div className="inspector-actions">
              <button
                type="button"
                onClick={() => {
                  props.setCompositionId(wrapper.compositionId);
                  props.setGraphRef(`element:${wrapper.elementId}`);
                  props.setSelectedId(`graph:${wrapper.graphId}`);
                  props.setSelectedJson(JSON.stringify({ graphId: wrapper.graphId }, null, 2));
                  props.setFitTargetNodeIds(wrapper.states[0] ? [`state:${wrapper.states[0]}`] : []);
                  props.setFitViewRev((v) => v + 1);
                }}
              >
                跳转到 Wrapper
              </button>
            </div>
            <EntityRelationSection title="输入信号" rows={wrapper.inputSignals.map((row) => `${row.signal} | ${row.transitionId} | ${row.from} -> ${row.to}${row.emitters.length ? ` | 来自: ${row.emitters.join(' ; ')}` : ''}`)} />
            <EntityRelationSection title="输出广播" rows={wrapper.outputs.map((row) => `${row.signal} | ${row.stateId}${row.downstream.length ? ` | 下游: ${row.downstream.join(' ; ')}` : ''}`)} />
            <EntityRelationSection title="读取者" rows={wrapper.reads} />
            <EntityRelationSection title="直接写入者" rows={wrapper.writes} />
            <EntityRelationSection title="校验问题" rows={wrapper.issues} />
          </details>
        ))}
        {wrappers.length === 0 && <div className="muted">没有命中搜索结果。</div>}
      </div>
    </div>
  );
}

function EntityRelationSection({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="entity-relation-block">
      <div className="section-title">{title}</div>
      {rows.length > 0 ? (
        <div className="entity-relation-list">
          {rows.map((row, index) => (
            <div className="log" key={`${title}-${index}`}>{row}</div>
          ))}
        </div>
      ) : (
        <div className="muted">无</div>
      )}
    </div>
  );
}

function PreviewPanel({ simulation, runtimeSnapshot }: { simulation: SimulationResult | null; runtimeSnapshot: RuntimeDebugSnapshotDef }) {
  const activeStates = extractActiveStates(runtimeSnapshot) ?? simulation?.activeStates ?? {};
  const narrativeState = runtimeSnapshot.ok && runtimeSnapshot.snapshot && typeof runtimeSnapshot.snapshot === 'object'
    ? (runtimeSnapshot.snapshot as { narrativeState?: { recentTransitions?: unknown[]; recentIssues?: unknown[]; recentTrace?: unknown[] } }).narrativeState
    : null;
  const runtimeTrace = Array.isArray(narrativeState?.recentTrace) ? narrativeState.recentTrace.slice(-12) : [];
  const runtimeTransitions = Array.isArray(narrativeState?.recentTransitions) ? narrativeState.recentTransitions.slice(-8) : [];
  const runtimeIssues = Array.isArray(narrativeState?.recentIssues) ? narrativeState.recentIssues.slice(-8) : [];
  return (
    <div className="preview-panel">
      <div className="section-title">Active States</div>
      <pre>{Object.keys(activeStates).length ? JSON.stringify(activeStates, null, 2) : '(none)'}</pre>
      {simulation && (simulation.runLayer.activatedArchetype !== null || Object.keys(simulation.runLayer.started).length > 0) && (
        <>
          <div className="section-title">Run Layer（活计）</div>
          <pre>{JSON.stringify(simulation.runLayer, null, 2)}</pre>
        </>
      )}
      {runtimeTrace.length > 0 && (
        <>
          <div className="section-title">Runtime Trace</div>
          <div className="timeline">
            {runtimeTrace.map((item, index) => (
              <div key={index} className="log">{formatRuntimeTrace(item)}</div>
            ))}
          </div>
        </>
      )}
      {runtimeTransitions.length > 0 && (
        <>
          <div className="section-title">Runtime Transitions</div>
          <div className="timeline">
            {runtimeTransitions.map((item, index) => (
              <div key={index} className="log">{formatRuntimeTransition(item)}</div>
            ))}
          </div>
        </>
      )}
      {runtimeIssues.length > 0 && (
        <>
          <div className="section-title">Runtime Issues</div>
          <div className="timeline">
            {runtimeIssues.map((item, index) => (
              <div key={index} className="log">{formatRuntimeIssue(item)}</div>
            ))}
          </div>
        </>
      )}
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

function formatRuntimeTrace(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item ?? '');
  const event = item as Record<string, unknown>;
  const seq = event.seq === undefined ? '' : `#${String(event.seq)} `;
  const type = String(event.type ?? 'trace');
  const graph = event.graphId ? ` ${String(event.graphId)}` : '';
  const transition = event.transitionId ? `.${String(event.transitionId)}` : '';
  const fromTo = event.from || event.to ? ` ${String(event.from ?? '?')} -> ${String(event.to ?? '?')}` : '';
  const trigger = event.triggerKey ? ` [${String(event.triggerKey)}]` : '';
  const message = event.message ? ` - ${String(event.message)}` : '';
  return `${seq}${type}${graph}${transition}${fromTo}${trigger}${message}`;
}

function formatRuntimeTransition(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item ?? '');
  const transition = item as Record<string, unknown>;
  const graphId = String(transition.graphId ?? '?');
  const transitionId = String(transition.transitionId ?? '?');
  const from = String(transition.from ?? '?');
  const to = String(transition.to ?? '?');
  const triggerKey = String(transition.triggerKey ?? '');
  return `${graphId}: ${from} -> ${to} via ${transitionId}${triggerKey ? ` (${triggerKey})` : ''}`;
}

function formatRuntimeIssue(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item ?? '');
  const issue = item as Record<string, unknown>;
  const severity = String(issue.severity ?? 'issue');
  const code = String(issue.code ?? 'unknown');
  const message = String(issue.message ?? '');
  return message ? `${severity}: ${code} - ${message}` : `${severity}: ${code}`;
}

async function loadDialogueRelations(dialogueGraphIds: string[]): Promise<DialogueRelationIndex> {
  const rows = await Promise.all(dialogueGraphIds.map(async (graphId) => {
    const id = String(graphId ?? '').trim();
    if (!id) return null;
    try {
      const path = `/assets/dialogues/graphs/${encodeURIComponent(id)}.json`;
      const response = await fetch(path);
      if (!response.ok) return null;
      const file = await response.json() as {
        id?: string;
        preconditions?: unknown[];
        nodes?: Record<string, unknown>;
      };
      return collectDialogueRelationsFromFile(id, file);
    } catch {
      return null;
    }
  }));
  const out: DialogueRelationIndex = { reads: [], writes: [], emits: [] };
  for (const row of rows) {
    if (!row) continue;
    out.reads.push(...row.reads);
    out.writes.push(...row.writes);
    out.emits.push(...row.emits);
  }
  out.reads = uniqueRelationRows(out.reads);
  out.writes = uniqueRelationRows(out.writes);
  out.emits = uniqueRelationRows(out.emits);
  return out;
}

function collectDialogueRelationsFromFile(
  dialogueId: string,
  file: { preconditions?: unknown[]; nodes?: Record<string, unknown> },
): DialogueRelationIndex {
  const result: DialogueRelationIndex = { reads: [], writes: [], emits: [] };
  collectNarrativeReadsFromExpr(file.preconditions, (graphId, stateId) => {
    result.reads.push({
      graphId,
      summary: `dialogue ${dialogueId} / preconditions / narrative=${graphId} state=${stateId}`,
    });
  });
  const nodes = file.nodes ?? {};
  for (const [nodeId, nodeRaw] of Object.entries(nodes)) {
    if (!nodeRaw || typeof nodeRaw !== 'object') continue;
    const node = nodeRaw as Record<string, unknown>;
    const type = String(node.type ?? '').trim();
    if (type === 'ownerState') {
      const wrapperGraphId = String(node.wrapperGraphId ?? '').trim();
      if (wrapperGraphId) {
        result.reads.push({
          graphId: wrapperGraphId,
          summary: `dialogue ${dialogueId} / ownerState ${nodeId} / wrapperGraphId=${wrapperGraphId}`,
        });
      }
    } else if (type === 'contextState') {
      const graphId = String(node.graphId ?? '').trim();
      if (graphId) {
        result.reads.push({
          graphId,
          summary: `dialogue ${dialogueId} / contextState ${nodeId} / graphId=${graphId}`,
        });
      }
    }
    collectNarrativeReadsFromUnknown(node, (graphId, stateId) => {
      result.reads.push({
        graphId,
        summary: `dialogue ${dialogueId} / node ${nodeId} / condition narrative=${graphId} state=${stateId}`,
      });
    });
    visitUnknownValue(node, (obj) => {
      const actionType = String(obj.type ?? '').trim();
      const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
        ? obj.params as Record<string, unknown>
        : null;
      if (!params) return;
      if (actionType === 'emitNarrativeSignal') {
        const signal = String(params.signal ?? '').trim();
        if (!signal) return;
        result.emits.push({
          signal,
          summary: `dialogue ${dialogueId} / node ${nodeId} / emitNarrativeSignal signal=${signal}`,
        });
      } else if (actionType === 'setNarrativeState') {
        const graphId = String(params.graphId ?? '').trim();
        const stateId = String(params.stateId ?? '').trim();
        if (!graphId) return;
        result.writes.push({
          graphId,
          summary: `dialogue ${dialogueId} / node ${nodeId} / setNarrativeState ${graphId}${stateId ? `.${stateId}` : ''}`,
        });
      }
    });
  }
  result.reads = uniqueRelationRows(result.reads);
  result.writes = uniqueRelationRows(result.writes);
  result.emits = uniqueRelationRows(result.emits);
  return result;
}

function collectNarrativeReadsFromUnknown(
  value: unknown,
  onRead: (graphId: string, stateId: string) => void,
): void {
  visitUnknownValue(value, (obj) => {
    collectNarrativeReadsFromExpr([obj], onRead);
  });
}

function collectNarrativeReadsFromExpr(
  exprList: unknown,
  onRead: (graphId: string, stateId: string) => void,
): void {
  if (!Array.isArray(exprList)) return;
  for (const exprRaw of exprList) {
    if (!exprRaw || typeof exprRaw !== 'object' || Array.isArray(exprRaw)) continue;
    const expr = exprRaw as Record<string, unknown>;
    const graphId = String(expr.narrative ?? '').trim();
    const stateId = String(expr.state ?? '').trim();
    if (graphId && stateId) onRead(graphId, stateId);
    if (Array.isArray(expr.all)) collectNarrativeReadsFromExpr(expr.all, onRead);
    if (Array.isArray(expr.any)) collectNarrativeReadsFromExpr(expr.any, onRead);
    if (expr.not && typeof expr.not === 'object') collectNarrativeReadsFromExpr([expr.not], onRead);
  }
}

function visitUnknownValue(value: unknown, fn: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitUnknownValue(item, fn));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  fn(obj);
  Object.values(obj).forEach((item) => visitUnknownValue(item, fn));
}

function uniqueRelationRows<T extends { summary: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = String(row.summary ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** 引用/悬空类校验 code：任务问题面板把这些映射成 badRef 行（复用现成 focusIssue 定位）。 */
function isBadRefCode(code: string): boolean {
  if (code === 'blackbox.ref.empty') return true;
  if (code.startsWith('state.activePlane.')) return true;
  if (code.startsWith('condition.narrative.')) return true;
  if (code.startsWith('projection.') && code.endsWith('.dangling')) return true;
  return false;
}

/**
 * issue 是否属于该 composition（编排级，不限具体图——element 子图里的也算）。
 * 优先看 target.compositionId；signal 类 target 无 compositionId 时回退到 path 前缀。
 */
function issueInComposition(issue: ValidationIssueDef, compositionId: string, data: NarrativeGraphsFileDef): boolean {
  const target = issue.target;
  if (target && 'compositionId' in target && target.compositionId) {
    return target.compositionId === compositionId;
  }
  const match = /compositions\[(\d+)\]/.exec(issue.path ?? '');
  if (match) {
    const comp = (data.compositions ?? [])[Number(match[1])];
    return comp?.id === compositionId;
  }
  return false;
}

function buildEntityNarrativeIndex(
  data: NarrativeGraphsFileDef,
  projection: ProjectionResult,
  validationIssues: ValidationIssueDef[],
  activeStates: Record<string, string>,
  dialogueRelations: DialogueRelationIndex,
): EntityNarrativeIndex {
  const transitionRows = compileGraphs(data).flatMap(({ graph }) => (graph.transitions ?? []).map((transition) => ({
    graphId: graph.id,
    transitionId: transition.id,
    from: String(transition.from ?? ''),
    to: String(transition.to ?? ''),
    signal: String(transition.signal ?? ''),
  })));
  const byOwner = new Map<string, EntityNarrativeOwnerSummary>();
  for (const comp of data.compositions ?? []) {
    for (const element of comp.elements ?? []) {
      if (element.kind !== 'wrapperGraph' || !element.graph) continue;
      const ownerType = String(element.ownerType ?? element.graph.ownerType ?? '').trim();
      const ownerId = String(element.ownerId ?? element.graph.ownerId ?? '').trim();
      if (!ownerType || !ownerId) continue;
      const ownerKey = `${ownerType}:${ownerId}`;
      const graph = element.graph;
      const wrapper: EntityNarrativeWrapperSummary = {
        ownerType,
        ownerId,
        ownerKey,
        compositionId: comp.id,
        compositionLabel: graphDisplayName(comp.mainGraph),
        elementId: element.id,
        graphId: graph.id,
        elementLabel: graphDisplayName(graph),
        category: String(graph.category ?? '').trim(),
        activeState: activeStates[graph.id] ?? '',
        states: Object.keys(graph.states ?? {}),
        transitions: graph.transitions?.length ?? 0,
        broadcasts: [],
        inputSignals: [],
        outputs: [],
        reads: [],
        writes: [],
        issues: [],
      };
      for (const transition of graph.transitions ?? []) {
        const signal = String(transition.signal ?? '').trim();
        if (!signal) continue;
        const emitters = projection.triggerEdges
          .filter((edge) =>
            (edge.graphId === graph.id && edge.transitionId === transition.id)
            || endpointMatchesTransition(edge.target, graph.id, transition.id)
            || (String(edge.label ?? '').trim() === signal && endpointMentionsGraph(edge.target, graph.id)),
          )
          .map((edge) => projectionEdgeSummary(edge));
        wrapper.inputSignals.push({
          signal,
          transitionId: transition.id,
          from: String(transition.from ?? ''),
          to: String(transition.to ?? ''),
          emitters: uniqueStrings(emitters),
        });
      }
      for (const [stateId, state] of Object.entries(graph.states ?? {})) {
        if (state.broadcastOnEnter !== true) continue;
        const signal = stateEnteredSignalKey(graph.id, stateId);
        wrapper.broadcasts.push(signal);
        const downstreamTransitions = transitionRows
          .filter((row) => row.signal === signal)
          .map((row) => `${row.graphId}.${row.transitionId} (${row.from} -> ${row.to})`);
        const downstreamProjection = projection.triggerEdges
          .filter((edge) => String(edge.label ?? '').trim() === signal)
          .map((edge) => projectionEdgeSummary(edge));
        wrapper.outputs.push({
          stateId,
          signal,
          downstream: uniqueStrings([...downstreamTransitions, ...downstreamProjection]),
        });
      }
      wrapper.reads = uniqueStrings(
        [
          ...projection.readEdges
          .filter((edge) => endpointMentionsGraph(edge.source, graph.id) || endpointMentionsGraph(edge.target, graph.id) || edge.graphId === graph.id)
            .map((edge) => projectionEdgeSummary(edge)),
          ...dialogueRelations.reads.filter((row) => row.graphId === graph.id).map((row) => row.summary),
        ],
      );
      wrapper.writes = uniqueStrings(
        [
          ...(projection.stateCommandEdges ?? [])
            .filter((edge) => endpointMentionsGraph(edge.target, graph.id) || edge.graphId === graph.id)
            .map((edge) => projectionEdgeSummary(edge)),
          ...dialogueRelations.writes.filter((row) => row.graphId === graph.id).map((row) => row.summary),
        ],
      );
      for (const input of wrapper.inputSignals) {
        const dialogueEmitters = dialogueRelations.emits
          .filter((row) => row.signal === input.signal)
          .map((row) => row.summary);
        input.emitters = uniqueStrings([...input.emitters, ...dialogueEmitters]);
      }
      wrapper.issues = uniqueStrings(validationIssues
        .filter((issue) => (
          issue.target?.kind === 'element'
            ? issue.target.elementId === element.id
            : issue.target?.kind === 'graph'
              ? issue.target.graphId === graph.id
              : issue.target?.kind === 'state'
                ? issue.target.graphId === graph.id
                : issue.target?.kind === 'transition'
                  ? issue.target.graphId === graph.id
                  : String(issue.message ?? '').includes(graph.id)
        ))
        .map((issue) => `${issue.severity}:${issue.code}${issue.message ? ` - ${issue.message}` : ''}`));
      const owner = byOwner.get(ownerKey) ?? { ownerType, ownerId, ownerKey, wrappers: [] };
      owner.wrappers.push(wrapper);
      byOwner.set(ownerKey, owner);
    }
  }
  const owners = [...byOwner.values()]
    .map((owner) => ({
      ...owner,
      wrappers: owner.wrappers.sort((a, b) =>
        `${a.compositionId}|${a.category}|${a.graphId}`.localeCompare(`${b.compositionId}|${b.category}|${b.graphId}`),
      ),
    }))
    .sort((a, b) => a.ownerKey.localeCompare(b.ownerKey));
  return { owners };
}

function endpointMatchesTransition(endpointRaw: string | undefined, graphId: string, transitionId: string): boolean {
  const endpoint = String(endpointRaw ?? '').trim();
  if (!endpoint) return false;
  const parsed = parseTransitionAnchorEndpoint(endpoint);
  return Boolean(parsed && parsed.graphId === graphId && parsed.transitionId === transitionId);
}

function endpointMentionsGraph(endpointRaw: string | undefined, graphId: string): boolean {
  const endpoint = String(endpointRaw ?? '').trim();
  if (!endpoint) return false;
  const parsed = parseTransitionAnchorEndpoint(endpoint);
  if (parsed?.graphId === graphId) return true;
  if (endpoint === `graph:${graphId}`) return true;
  if (endpoint === `state:${graphId}`) return true;
  if (endpoint.startsWith(`projection-anchor:${graphId}.`)) return true;
  if (endpoint.startsWith(`state:${graphId}:`)) return true;
  return endpoint.includes(`${graphId}.`);
}

function parseTransitionAnchorEndpoint(endpoint: string): { graphId: string; transitionId: string } | null {
  const match = /^transition-anchor:([^:]+):(.+)$/.exec(endpoint);
  if (!match) return null;
  const graphId = safeDecodeUri(match[1] ?? '');
  const transitionId = safeDecodeUri(match[2] ?? '');
  if (!graphId || !transitionId) return null;
  return { graphId, transitionId };
}

function projectionEdgeSummary(edge: ProjectionEdgeDef): string {
  const label = String(edge.label ?? '').trim();
  const detail = String(edge.detail ?? '').trim();
  const summary = `${edge.source} -> ${edge.target}`;
  if (label && detail && detail !== label) return `${summary} [${label}] (${detail})`;
  if (label) return `${summary} [${label}]`;
  if (detail) return `${summary} (${detail})`;
  return summary;
}

function safeDecodeUri(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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
    el.graph.states[inline.objectId] = { ...nextState, id: inline.objectId };
    return inlineSubgraphStateId(inline.elementId, inline.objectId);
  }
  if (inline?.kind === 'transition') {
    const el = comp.elements?.find((item) => item.id === inline.elementId);
    if (!el?.graph || !el.graph.transitions.some((t) => t.id === inline.objectId)) return null;
    const transition = parsed as unknown as NarrativeTransitionDef;
    const idx = el.graph.transitions.findIndex((t) => t.id === inline.objectId);
    if (idx >= 0) el.graph.transitions[idx] = { ...transition, id: inline.objectId };
    return inlineSubgraphTransitionId(inline.elementId, inline.objectId);
  }
  if (selectedId.startsWith('state:')) {
    const oldId = selectedId.slice('state:'.length);
    if (!g.states[oldId]) return null;
    const nextState = parsed as unknown as NarrativeStateNodeDef;
    g.states[oldId] = { ...nextState, id: oldId };
    return `state:${oldId}`;
  }
  if (selectedId.startsWith('transition:')) {
    const oldId = selectedId.slice('transition:'.length);
    if (!g.transitions.some((t) => t.id === oldId)) return null;
    const transition = parsed as unknown as NarrativeTransitionDef;
    const idx = g.transitions.findIndex((t) => t.id === oldId);
    if (idx >= 0) g.transitions[idx] = { ...transition, id: oldId };
    return `transition:${oldId}`;
  }
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const oldId = selectedId.slice('element:'.length);
    const elements = comp.elements ?? [];
    const oldElement = elements.find((e) => e.id === oldId);
    if (!oldElement) return null;
    const nextElement = parsed as unknown as CompositionElementDef;
    const oldGraphId = oldElement.graph?.id;
    const idx = elements.findIndex((e) => e.id === oldId);
    if (idx < 0) return null;
    const replacement: CompositionElementDef = { ...nextElement, id: oldId };
    if (oldGraphId && replacement.graph) {
      replacement.graph = { ...replacement.graph, id: oldGraphId };
    }
    elements[idx] = replacement;
    return `element:${oldId}`;
  }
  if (selectedId.startsWith('graph:') || selectedId.startsWith('transition-anchor:')) {
    const replacement: NarrativeGraphDef = { ...(parsed as unknown as NarrativeGraphDef), id: g.id };
    if (graphRef === 'main') {
      comp.mainGraph = replacement;
    } else {
      const element = getElementByGraphRef(comp, graphRef);
      if (!element) return null;
      element.graph = replacement;
    }
    return `graph:${replacement.id}`;
  }
  return null;
}

function getSelectedSummary(comp: NarrativeCompositionDef | undefined, graph: NarrativeGraphDef | undefined, graphRef: GraphRef, selectedId: string) {
  if (!selectedId || !comp || !graph) return { title: graph?.id ?? '未选择', subtitle: '图检视器', navigate: null as null | { kind: string; id: string } };
  const inline = parseInlineSubgraphId(selectedId);
  if (inline) {
    const element = comp.elements?.find((el) => el.id === inline.elementId);
    return {
      title: inline.objectId,
      subtitle: `${element?.label || inline.elementId} 内联${inline.kind === 'state' ? '状态' : '迁移'}`,
      navigate: null,
    };
  }
  if (selectedId.startsWith('graph:')) return { title: selectedId.slice('graph:'.length), subtitle: '图锚点', navigate: null };
  if (selectedId.startsWith('transition-anchor:')) return { title: projectionEndpointLabel(selectedId), subtitle: '迁移触发锚点', navigate: null };
  if (selectedId.startsWith('projection-anchor:')) return { title: projectionEndpointLabel(selectedId), subtitle: '投影端点', navigate: null };
  if (selectedId.startsWith('state:')) return { title: selectedId.slice(6), subtitle: `状态 · 所属 ${graph.id}`, navigate: null };
  if (selectedId.startsWith('transition:')) return { title: selectedId.slice(11), subtitle: `迁移 · 所属 ${graph.id}`, navigate: null };
  if (selectedId.startsWith('element:') && graphRef === 'main') {
    const el = getElementByNodeId(comp, selectedId);
    return { title: el?.label || selectedId.slice(8), subtitle: elementSubtitle(el), navigate: navigationForElement(el) };
  }
  return { title: selectedId, subtitle: '只读投影连线', navigate: null };
}

function actionArray(value: unknown): ActionDef[] {
  return Array.isArray(value) ? value as ActionDef[] : [];
}

function TextField({ label, value, onChange, commitOnBlur, datalistId, datalistValues, flagUnknown, readOnlyNote }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  commitOnBlur?: boolean;
  datalistId?: string;
  datalistValues?: string[];
  flagUnknown?: boolean;
  /** 判死字段：只读展示 + 说明徽标（如 flow 主图 ownerId——无任何机制消费，不邀请填写）。 */
  readOnlyNote?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const listId = datalistId || (datalistValues?.length ? `${label.replace(/\W/g, '_')}_choices` : undefined);
  const current = commitOnBlur ? draft : value;
  // 引用字段：仍允许自由输入（网页内无法内嵌 PyQt 原生选择器，策划照常键入即可），
  // 但当值不在「已知候选」里时给温和提示，便于当场发现拼错/失效的引用。仅在候选非空时判定，
  // 候选为空（未加载 / 该 owner 类型无候选，如 system）不误标；纯提示不阻断保存（校验面板仍兜底）。
  const unknownRef = !readOnlyNote && !!flagUnknown && !!datalistValues && datalistValues.length > 0
    && current.trim().length > 0 && !datalistValues.includes(current.trim());
  const hint = readOnlyNote || (unknownRef ? '该 id 不在已知候选中，请确认引用是否有效（仅提示，不阻断保存）' : undefined);
  return (
    <div className="field">
      <label>
        {label}
        {unknownRef && <span title={hint} style={{ color: '#d9a441', marginLeft: 4 }}>⚠ 未知引用</span>}
        {readOnlyNote && <span title={readOnlyNote} style={{ color: '#8a8f98', marginLeft: 4 }}>（仅注释·无机制效力）</span>}
      </label>
      <input
        list={listId}
        value={current}
        title={hint}
        readOnly={!!readOnlyNote}
        style={unknownRef
          ? { borderColor: '#d9a441', background: 'rgba(217,164,65,0.08)' }
          : readOnlyNote ? { opacity: 0.6 } : undefined}
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
