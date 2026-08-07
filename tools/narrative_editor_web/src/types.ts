import type { Edge, Node } from '@xyflow/react';

export type ElementKind =
  | 'wrapperGraph'
  | 'scenarioSubgraph'
  | 'dialogueBlackbox'
  | 'zoneBlackbox'
  | 'minigameBlackbox'
  | 'cutsceneBlackbox';

export interface ActionDef {
  type: string;
  params?: Record<string, unknown>;
}

export interface ElementMetaDef {
  emits?: string[];
  reads?: string[];
  commands?: string[];
  [key: string]: unknown;
}

export interface NarrativeStateNodeDef {
  id: string;
  label?: string;
  description?: string;
  /** When true, entering this state auto-emits derived signal state:<graphId>:<stateId>. */
  broadcastOnEnter?: boolean;
  /** Plane id activated while this state is active; absent everywhere in a graph = plane "normal". */
  activePlane?: string;
  onEnterActions?: ActionDef[];
  onExitActions?: ActionDef[];
  meta?: Record<string, unknown>;
}

/**
 * Graph-local state id. Transitions never target another graph directly; cross-graph
 * effects must be modeled with signals, state broadcasts, or projection metadata.
 */
export type NarrativeEndpointDef = string;

export interface NarrativeTransitionDef {
  id: string;
  from: NarrativeEndpointDef;
  to: NarrativeEndpointDef;
  signal: string;
  /**
   * How this transition is triggered:
   * - 'signal' (default): requires a matching signal + optional conditions
   * - 'reactive': auto-fires when conditions (passed through as-is) are met
   * - 'reactiveAll': auto-fires when ALL flat conditions met (auto-wrapped in {all})
   * - 'reactiveAny': auto-fires when ANY flat condition met (auto-wrapped in {any})
   */
  trigger?: 'signal' | 'reactive' | 'reactiveAll' | 'reactiveAny';
  conditions?: unknown[];
  priority?: number;
}

export interface NarrativeGraphDef {
  id: string;
  label?: string;
  ownerType: string;
  ownerId?: string;
  /** Free-form wrapper category/remark used for grouping in entity view. */
  category?: string;
  /** 活计图声明（可重复运行的委托机器）；缺省=常驻图。见叙事运行实例化设计稿 v2。 */
  run?: { repeatable?: boolean; resumable?: boolean };
  initialState: string;
  entryState?: string;
  exitStates?: string[];
  projectFlags?: boolean;
  states: Record<string, NarrativeStateNodeDef>;
  transitions: NarrativeTransitionDef[];
}

export interface CompositionElementDef {
  id: string;
  kind: ElementKind;
  label?: string;
  ownerType?: string;
  ownerId?: string;
  refId?: string;
  graph?: NarrativeGraphDef;
  x?: number;
  y?: number;
  /** 元素级章节包标（C4）：本子图归入此包，进包 live/出包 dormant；无=常驻。 */
  package?: string;
  meta?: ElementMetaDef;
}

export interface NarrativeCompositionDef {
  id: string;
  label?: string;
  description?: string;
  /** composition 级章节包标（整组）；元素可用 element.package 覆盖。 */
  package?: string;
  mainGraph: NarrativeGraphDef;
  elements?: CompositionElementDef[];
}

export interface NarrativeAuthorSignalDef {
  id: string;
  label?: string;
  notes?: string;
}

export type SignalCatalogKind = 'author' | 'derived' | 'draft';

export interface SignalCatalogEntryDef {
  id: string;
  kind: SignalCatalogKind;
  label?: string;
  notes?: string;
  graphId?: string;
  stateId?: string;
  listeners: number;
  emitters: number;
  editable: boolean;
  /**
   * 是否真的有 `narrative_graphs.signals` 注册行。false = 目录从监听端/黑盒声明反推出来的
   * 影子条目——运行时照跑（发射与监听只对字符串），但校验会一直报"未在信号注册表登记"，
   * 且没有可编辑的 label/注释。派生信号恒为 true 语义（由状态自动产生，无需注册行）。
   */
  registered: boolean;
}

export interface SignalListenerRefDef {
  compositionId: string;
  graphId: string;
  transitionId: string;
  from: string;
  to: string;
}

export interface SignalEmitterRefDef {
  kind: string;
  refId: string;
  detail: string;
}

export interface NarrativeGraphsFileDef {
  schemaVersion?: number;
  signals?: NarrativeAuthorSignalDef[];
  compositions?: NarrativeCompositionDef[];
}

/**
 * 「整理分组」标签：编辑器专用，运行时永不加载，**绝不进 narrative_graphs.json**。
 * 只为作者整理左侧「编排列表」（compositions）与「子图导航」（subgraphs，按 compose 作用域）。
 * 与 NarrativeGraphDef.category「分类备注」（进 JSON、驱动运行时校验）完全无关。
 */
export interface NarrativeCategoriesFileDef {
  schemaVersion?: number;
  /** compositionId → 分类名 */
  compositions?: Record<string, string>;
  /** compositionId → (elementId → 分类名) */
  subgraphs?: Record<string, Record<string, string>>;
}

export interface ProjectionEdgeDef {
  id: string;
  kind: 'trigger' | 'read' | 'stateCommand';
  source: string;
  target: string;
  label?: string;
  detail?: string;
  compositionId?: string;
  graphId?: string;
  transitionId?: string;
  readonly?: boolean;
}

export interface ProjectionResult {
  schemaVersion?: number;
  triggerEdges: ProjectionEdgeDef[];
  readEdges: ProjectionEdgeDef[];
  stateCommandEdges?: ProjectionEdgeDef[];
  warnings?: ProjectionWarningDef[];
}

export interface ProjectionWarningDef {
  severity: 'warning';
  code: string;
  message: string;
  compositionId?: string;
  detail?: string;
}

export type ValidationTargetDef =
  | { kind: 'composition'; compositionId: string; field?: string }
  | { kind: 'graph'; compositionId: string; graphId: string; elementId?: string; field?: string }
  | { kind: 'element'; compositionId: string; elementId: string; field?: string }
  | { kind: 'state'; compositionId: string; graphId: string; stateId: string; elementId?: string; field?: string }
  | { kind: 'transition'; compositionId: string; graphId: string; transitionId: string; elementId?: string; field?: string }
  | { kind: 'signal'; signalId: string; field?: string };

export interface ValidationIssueDef {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  itemId?: string;
  target?: ValidationTargetDef;
}

/* ------------------------------------------------------------------ 信号关系
 * 宿主 tools/narrative_xref 扫出来的「谁发谁听」。字段名与 Python 侧 to_dict()
 * 一一对应，别在这边改名——两边对不上就是整张面板空白。
 */

/** 发送方的通道：戏里发的 / 内容资产发的 / 叙事图动作 / 进入即广播 / 派生信号的上游因果 */
export type XrefChannel = 'dialogue' | 'asset' | 'narrativeAction' | 'broadcast' | 'upstream';

export interface XrefEmitterDef {
  signal: string;
  channel: XrefChannel;
  containerKind: string;
  containerId: string;
  containerLabel: string;
  kindLabel: string;
  where: string;
  context: string;
  note: string;
  file: string;
  pointer: string;
  anchors: string[][];
  /** 主编辑器只加载不保存的数据面（物件检视）：跳不过去，界面要提前说明而不是让人白点 */
  readonly: boolean;
  /* 叙事图内的坐标（广播状态 / 状态动作 / 上游转移才有）：这类行走**画布定位**，
     不走文件跳转——narrative_graphs.json 的文件跳转只认 states/<id>，转移落不到点。 */
  compositionId: string;
  elementId: string;
  graphId: string;
  stateId: string;
  transitionId: string;
}

export interface XrefListenerDef {
  signal: string;
  compositionId: string;
  compositionLabel: string;
  graphId: string;
  graphLabel: string;
  elementId: string;
  transitionId: string;
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  conditions: string[];
  /** 活计图：运行时只有「当前激活的那一个」才吃信号，挂起的一条都不接 */
  runGraph: boolean;
  priority: number;
  trigger: string;
  file: string;
  pointer: string;
}

export interface XrefDeclarationDef {
  signal: string;
  compositionId: string;
  compositionLabel: string;
  elementId: string;
  elementLabel: string;
  elementKind: string;
  refId: string;
  file: string;
  pointer: string;
}

export interface XrefStateReadDef {
  graphId: string;
  stateId: string;
  containerKind: string;
  containerId: string;
  kindLabel: string;
  where: string;
  file: string;
  pointer: string;
  readonly: boolean;
  /** 与发射行同款：跳转要靠它定位到具体条目，缺了就只能打开页面 */
  anchors: string[][];
}

export interface XrefDiagnosticDef {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface SignalXrefCardDef {
  signal: string;
  kind: 'author' | 'derived' | 'draft' | 'unknown';
  label: string;
  notes: string;
  registered: boolean;
  emitters: XrefEmitterDef[];
  declarations: XrefDeclarationDef[];
  listeners: XrefListenerDef[];
  stateReads: XrefStateReadDef[];
  diagnostics: XrefDiagnosticDef[];
  sourceGraphId: string;
  sourceStateId: string;
  sourceStateLabel: string;
  /** 真发射数：不含派生信号的上游因果 */
  emitterCount: number;
  listenerCount: number;
  declarationCount: number;
}

export interface SignalXrefIndexDef {
  origin: string;
  stats: {
    dialogues: number;
    assets: number;
    graphs: number;
    transitions: number;
    signals: number;
  };
  signals: SignalXrefCardDef[];
}

export interface AuthoringCatalogDef {
  dialogueGraphIds: string[];
  scenarioIds: string[];
  questIds: string[];
  sceneIds: string[];
  sceneEntityRefs: string[];
  sceneNpcRefs: string[];
  sceneHotspotRefs: string[];
  zoneRefs: string[];
  /** Canonical scene-group owner refs, always qualified as sceneId:groupId. */
  sceneGroupRefs: string[];
  minigameIds: string[];
  cutsceneIds: string[];
  graphIds: string[];
  actionTypes: string[];
  actionParamSchemas: Record<string, Array<[string, string]>>;
  actionPersistence: Record<string, 'save' | 'memory' | string>;
  /** Registered plane ids from planes.json; optional for older Python hosts (default []). */
  planeIds?: string[];
  /** 每个位面被多少场景实体（hotspot/npc/zone 的 planes 字段包含它）归属；缺失=旧 host，容错跳过空位面检查。 */
  planeMembership?: Record<string, number>;
  /** 世界模型为 exclusive（独立世界型）的位面 id 集（沿 extends 链解析）；缺失=旧 host，按全 shared 处理。 */
  planeExclusive?: string[];
  /** 全项目实际发出的信号 id 去重集（对话图 + 内容资产 emitNarrativeSignal ∪ broadcastOnEnter 派生广播）；缺失=旧 host。 */
  emittedSignals?: string[];
  /**
   * Rich rows for popup reference pickers. `id` is the value written on an
   * intentional selection; aliases only recognise legacy values and are never
   * written automatically.
   */
  referenceEntries?: ReferenceCatalogEntryDef[];
}

export interface ReferenceCatalogEntryDef {
  kind: string;
  id: string;
  qualifiedId: string;
  label: string;
  aliases?: string[];
}

/** 任务问题：按当前 composition 实时计算的编排健康问题（信号断链 / 空位面 / 坏引用）。 */
export type TaskIssueKind = 'emptyPlane' | 'danglingSignalNoEmit' | 'danglingEmitDeclared' | 'badRef';

export interface TaskIssueDef {
  kind: TaskIssueKind;
  severity: 'error' | 'warning';
  message: string;
  /** 编排内定位目标：传给 focusIssue 回调（合成或复用现有 ValidationIssueDef）。 */
  focus?: ValidationIssueDef;
  /** 跨文件跳转目标：传给 navigateTo(kind, id)。 */
  navigate?: { kind: string; id: string };
}

/** 任务总线：一个 composition 牵涉到的前向引用（blackbox elements）。 */
export interface TaskReferenceDef {
  kind: 'dialogue' | 'scenario' | 'minigame' | 'zone' | 'cutscene' | 'npc' | 'hotspot' | 'scene' | 'quest';
  id: string;
  label: string;
  elementId: string;
}

/** 任务总线：各 state.activePlane 指向的位面。 */
export interface TaskPlaneDef {
  id: string;
  label: string;
  states: string[];
}

/** 任务总线：在条件里引用本作曲图、或位面归属本作曲的场景实体。 */
export interface TaskSceneEntityDef {
  kind: 'npc' | 'hotspot' | 'zone';
  sceneId: string;
  entityId: string;
  /** navigateTo 复合键 "sceneId:entityId"。 */
  navId: string;
  via: 'condition' | 'plane';
  label: string;
}

/** 任务总线：镜像本作曲的 quest。 */
export interface TaskQuestDef {
  id: string;
  via: 'condition' | 'wrapper';
  label: string;
}

/** 宿主 build_task_index(model, compositionId) 的返回形状。 */
export interface TaskIndex {
  compositionId: string;
  graphIds: string[];
  references: TaskReferenceDef[];
  planes: TaskPlaneDef[];
  sceneEntities: TaskSceneEntityDef[];
  quests: TaskQuestDef[];
}

/** 叙事状态机模板（archetype）：编辑器专用，运行时永不加载。 */
export type TemplateParamType =
  | 'identifier'
  | 'text'
  | 'number'
  | 'boolean'
  | 'planeRef'
  | 'dialogueRef'
  | 'minigameRef'
  | 'sceneRef'
  | 'npcRef'
  | 'hotspotRef'
  | 'zoneRef'
  | 'questRef'
  | 'cutsceneRef'
  | 'scenarioRef';

export interface TemplateParamDef {
  name: string;
  type: TemplateParamType;
  label?: string;
  required?: boolean;
  default?: unknown;
  note?: string;
  /** 仅「从现成作曲创建模板」时用：这个值出现在源作曲里，抽取时被替换成 {{name}}。 */
  sample?: string;
}

export interface TemplateSignalDef {
  id: string;
  label?: string;
  notes?: string;
}

export interface TemplateDialogueStubDef {
  id: string;
  title?: string;
  emitSignal?: string;
}

export interface TemplateRequiredEntityDef {
  kind?: string;
  note?: string;
}

export interface NarrativeTemplateDef {
  id: string;
  label?: string;
  description?: string;
  params: TemplateParamDef[];
  signals?: TemplateSignalDef[];
  composition: NarrativeCompositionDef | Record<string, unknown>;
  quest?: Record<string, unknown>;
  dialogueStubs?: TemplateDialogueStubDef[];
  requiredEntities?: TemplateRequiredEntityDef[];
}

export interface NarrativeTemplatesFileDef {
  schemaVersion?: number;
  templates: NarrativeTemplateDef[];
}

export interface StampDialogueStubStatusDef {
  id: string;
  emitSignal: string;
  exists: boolean;
}

export interface StampPreviewDef {
  compositionId: string;
  questId: string;
  signals: string[];
  dialogueStubs: StampDialogueStubStatusDef[];
  requiredEntities: TemplateRequiredEntityDef[];
  warnings: ValidationIssueDef[];
}

/** 盖章确认结果：三样产物全部只是「暂存」进 ProjectModel（零磁盘写入），Save All 一次性落盘。 */
export interface StampSummaryDef extends StampPreviewDef {
  questStaged: boolean;
  stubsStaged: string[];
  stubsSkipped: string[];
}

export interface StampResponseDef {
  ok: boolean;
  dryRun?: boolean;
  reason?: string;
  preview?: StampPreviewDef;
  narrative?: NarrativeGraphsFileDef;
  summary?: StampSummaryDef;
  errors?: ValidationIssueDef[];
  warnings?: ValidationIssueDef[];
}

export interface ExtractResponseDef {
  ok: boolean;
  reason?: string;
  template?: NarrativeTemplateDef;
  issues?: ValidationIssueDef[];
}

export interface RuntimeSignalRequestDef {
  sourceType: string;
  sourceId: string;
  signal: string;
}

export interface RuntimeDebugSnapshotDef {
  ok: boolean;
  reason?: string;
  snapshot?: unknown;
}

export type CanvasNode = Node<{
  label: string;
  subtitle: string;
  kind: 'state' | ElementKind | 'graphAnchor' | 'projectionAnchor' | 'transitionAnchor' | 'editorGroupFrame';
  detail?: string;
  boundary?: 'entry' | 'exit' | 'entryExit';
  active?: boolean;
  /** 编辑器分组框（kind === 'editorGroupFrame'）专用视觉字段，见 canvas/editorGroups.ts */
  groupColor?: string;
  groupCollapsed?: boolean;
  groupMemberCount?: number;
}>;

export type CanvasEdge = Edge<{
  label?: string;
  edgeKind: 'transition' | 'trigger' | 'read' | 'stateCommand';
  detail?: string;
  /** 画布路由（display 层派生，见 canvas/edgeRouting.ts）：平行边错开量与自环标记，不进数据。 */
  route?: { offset: number; selfLoop: boolean };
}>;
