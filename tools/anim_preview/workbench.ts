import {
  SequenceReviewer,
  type SequenceOrderSource,
  type SequenceReviewerFrame,
} from './sequenceReviewer';
import {
  getHumanSessionToken,
  HUMAN_SESSION_READ_ONLY_MESSAGE,
} from './humanSession';

type NodeStatus =
  | 'blocked'
  | 'runnable'
  | 'manual_required'
  | 'under_review'
  | 'accepted'
  | 'published'
  | 'rejected'
  | 'invalidated'
  | 'stale'
  | 'compatible_cached';

type ReviewDecision = 'submitted' | 'accepted' | 'rejected' | 'invalidated';
type ActionStage = 'D' | 'E' | 'F' | 'G';

interface CatalogWorkspaceSummary {
  characterId?: string;
  bundleId?: string;
  updatedAt?: string;
  actionCount?: number;
  error?: string;
}

interface CatalogItem {
  folderName: string;
  displayName: string;
  absolutePath: string;
  hasSetup: boolean;
  videos: string[];
  workspace: CatalogWorkspaceSummary | null;
}

interface ActionDef {
  id: string;
  label: string;
  description?: string;
  loop?: boolean;
  frameRate?: number;
  enabled?: boolean;
}

interface ReviewEvent {
  decision: Exclude<ReviewDecision, 'submitted'>;
  note: string;
  at: string;
  reviewer: string;
}

interface Artifact {
  index: number;
  name: string;
  path: string;
  role: string;
  mime: string;
  size: number;
  sha256: string;
  source?: string;
}

interface Revision {
  id: string;
  nodeId: string;
  createdAt: string;
  parents: Record<string, string | null>;
  producer?: {
    kind?: string;
    name?: string;
    note?: string;
  };
  metadata?: Record<string, unknown>;
  artifacts: Artifact[];
  review: ReviewEvent[];
}

interface PendingRevision {
  id: string;
  createdAt: string;
  compatible: boolean;
}

interface NodeState {
  id: string;
  label: string;
  owner: 'agent' | 'human' | string;
  deps: string[];
  kind: string;
  status: NodeStatus;
  reason: string;
  head: string | null;
  actionId?: string;
  actionLabel?: string;
  expectedParents: Record<string, string | null>;
  pendingRevisions: PendingRevision[];
  reviewCandidate?: string | null;
  compatibleRevision?: string | null;
  legacyBaseline?: string | null;
  revision?: Revision;
  contract?: {
    purpose?: string;
    inputs?: string[];
    outputs?: string[];
    acceptance?: string[];
  };
}

interface Checkpoint {
  id: string;
  name: string;
  note: string;
  createdAt: string;
  heads: Record<string, string>;
}

interface WorkspaceData {
  schemaVersion: number;
  generation: number;
  folderName: string;
  displayName: string;
  characterId: string;
  bundleId: string;
  staticTargetPath?: string;
  updatedAt: string;
  actions: ActionDef[];
  stageEpochs?: Partial<Record<ActionStage, number>>;
  heads: Record<string, string>;
  reviews: Record<string, ReviewEvent[]>;
  checkpoints: Checkpoint[];
  legacyBaselines: Record<string, string>;
}

interface WorkspaceView {
  workspace: WorkspaceData;
  states: NodeState[];
  histories: Record<string, Revision[]>;
  calibrationDraft: unknown;
  integrity: {
    ok: boolean;
    generation: number;
    orphanManifests: unknown[];
    missingManifests: unknown[];
    artifactProblems: unknown[];
  };
  storage: {
    revisionCount: number;
    artifactCount: number;
    uniqueObjectCount: number;
    logicalBytes: number;
    uniqueBytes: number;
  };
  paths: {
    characterRoot: string;
    workbenchRoot: string;
    agentContextJson: string;
    agentContextMarkdown: string;
  };
}

interface WorkbenchSelectionDetail {
  folderName: string | null;
  view: WorkspaceView | null;
  selectionGeneration: number;
  workspaceGeneration: number | null;
}

interface WorkbenchChangedMessage {
  folderName?: string | null;
  reasons?: string[];
}

interface WorkbenchExternalViewDetail {
  folderName: string;
  view: WorkspaceView;
  nodeId?: string;
  revisionId?: string;
}

interface WorkbenchPreviewCandidateDetail {
  id: string;
  label: string;
  folderName: string;
  revisionId: string;
  animUrl: string;
  atlasUrl: string;
  animVersion: string;
  atlasVersion: string;
}

interface ResolvedSequence {
  frames: SequenceReviewerFrame[];
  orderSource: SequenceOrderSource;
}

type ArtifactSelection = number | 'png-sequence' | null;

const STATUS_LABELS: Record<NodeStatus, string> = {
  blocked: '阻塞',
  runnable: '可由 Agent 推进',
  manual_required: '等待人工装配',
  under_review: '等待人工审查',
  accepted: '已通过',
  published: '已发布',
  rejected: '已拒绝',
  invalidated: '已失效',
  stale: '下游已过期',
  compatible_cached: '有兼容历史缓存',
};

const DECISION_LABELS: Record<ReviewDecision, string> = {
  submitted: '待审候选',
  accepted: '已通过',
  rejected: '已拒绝',
  invalidated: '已失效',
};

const NODE_SEMANTICS: Record<string, string> = {
  A: '角色设定稿。这里记录设计依据与被人工认可的设定版本。',
  B: '正侧面朝右的静态 Idle 源；既可进入静态抠图，也可作为动画视频生成输入。',
  C: '静态素材抠图结果；只处理透明背景，不改变已确认的角色构图。',
  H_STATIC: '静态 Sprite 的项目导出候选。发布动作仍由独立步骤完成。',
  D: '单动作动画视频结果。工作台只记录与审查，Agent 在外部主动产出。',
  E: '按动作语义抽出的完整画面帧序列；循环动作需验证首尾无缝。',
  F: '使用所有帧 bbox 的 union 固定裁剪全部帧，不做逐帧重定位。',
  G: '精确抠图；必须保持 F 的尺寸、顺序与几何位置不变。',
  R: '纯人工 Root、动作统一尺度和角色世界 Quad 装配，不创建 Agent 任务。',
  H: '基于已通过 R 的动画图集与 anim.json 导出候选。',
};

interface StagePresentation {
  code: string;
  title: string;
  stages: string[];
  hint: string;
}

const STAGE_PRESENTATIONS: StagePresentation[] = [
  { code: 'A', title: '角色设定', stages: ['A'], hint: '确认角色身份、服装、轮廓和朝向' },
  { code: 'B', title: 'Idle 基准', stages: ['B'], hint: '确认正侧面朝右的静态基准图' },
  { code: 'C', title: '静态抠图', stages: ['C'], hint: '得到可直接使用的透明静态 Sprite' },
  { code: 'Hₛ', title: '静态导出', stages: ['H_STATIC'], hint: '把已通过的静态 Sprite 导出到明确的项目位置' },
  { code: 'D', title: '动画视频', stages: ['D'], hint: '每个动作各自产出原始动画视频' },
  { code: 'E', title: '挑选帧', stages: ['E'], hint: '按动作语义抽帧，并检查循环首尾' },
  { code: 'F', title: '统一裁剪', stages: ['F'], hint: '所有帧共用同一个 union bbox' },
  { code: 'G', title: '精确抠图', stages: ['G'], hint: '只去背景，不再改变几何和裁剪' },
  { code: 'R', title: '锚点与缩放', stages: ['R'], hint: '人工对齐动作 root 和视觉大小' },
  { code: 'H', title: '动画导出', stages: ['H'], hint: '生成动画资源的项目候选' },
];

const ACTION_STAGES: ActionStage[] = ['D', 'E', 'F', 'G'];

const wbSearch = byId<HTMLInputElement>('wbSearch');
const wbCatalogCount = byId<HTMLElement>('wbCatalogCount');
const wbCatalog = byId<HTMLElement>('wbCatalog');
const wbCharacterName = byId<HTMLElement>('wbCharacterName');
const wbCharacterMeta = byId<HTMLElement>('wbCharacterMeta');
const wbInitControls = byId<HTMLElement>('wbInitControls');
const wbInitId = byId<HTMLInputElement>('wbInitId');
const wbInitBundle = byId<HTMLInputElement>('wbInitBundle');
const wbInitStatic = byId<HTMLInputElement>('wbInitStatic');
const wbInit = byId<HTMLButtonElement>('wbInit');
const wbActionControls = byId<HTMLElement>('wbActionControls');
const wbActionId = byId<HTMLInputElement>('wbActionId');
const wbActionLabel = byId<HTMLInputElement>('wbActionLabel');
const wbAddAction = byId<HTMLButtonElement>('wbAddAction');
const wbCheckpoint = byId<HTMLButtonElement>('wbCheckpoint');
const wbGeneration = byId<HTMLElement>('wbGeneration');
const wbActionManager = byId<HTMLElement>('wbActionManager');
const wbFocusBanner = byId<HTMLElement>('wbFocusBanner');
const wbStageOverview = byId<HTMLElement>('wbStageOverview');
const wbStageActions = byId<HTMLElement>('wbStageActions');
const wbGraph = byId<HTMLElement>('wbGraph');
const wbAddActionToggle = byId<HTMLButtonElement>('wbAddActionToggle');
const wbSettingsToggle = byId<HTMLButtonElement>('wbSettingsToggle');
const wbInspectorToggle = byId<HTMLButtonElement>('wbInspectorToggle');
const wbQuickAddPanel = byId<HTMLElement>('wbQuickAddPanel');
const wbRight = byId<HTMLElement>('wbRight');
const wbInspectorClose = byId<HTMLButtonElement>('wbInspectorClose');
const wbOverlayBackdrop = byId<HTMLElement>('wbOverlayBackdrop');
const artifactBar = byId<HTMLElement>('artifactBar');
const artifactViewport = byId<HTMLElement>('artifactViewport');
const artifactStageBadge = byId<HTMLElement>('artifactStageBadge');
const artifactReviewTitle = byId<HTMLElement>('artifactReviewTitle');
const artifactReviewMeta = byId<HTMLElement>('artifactReviewMeta');
const artifactInspectorToggle = byId<HTMLButtonElement>('artifactInspectorToggle');
const reviewCandidate = byId<HTMLElement>('reviewCandidate');
const reviewNote = byId<HTMLTextAreaElement>('reviewNote');
const reviewAccept = byId<HTMLButtonElement>('reviewAccept');
const reviewReject = byId<HTMLButtonElement>('reviewReject');
const reviewInvalidate = byId<HTMLButtonElement>('reviewInvalidate');
const revisionHistory = byId<HTMLElement>('revisionHistory');
const nodeInspector = byId<HTMLElement>('nodeInspector');
const globalStatus = byId<HTMLElement>('globalStatus');
const toast = byId<HTMLElement>('toast');
const assemblyCharacter = byId<HTMLElement>('assemblyCharacter');

const sessionToken = getHumanSessionToken();
let catalog: CatalogItem[] = [];
let selectedFolder: string | null = null;
let selectedNodeId: string | null = null;
let selectedRevisionId: string | null = null;
let selectedArtifact: ArtifactSelection = null;
let currentView: WorkspaceView | null = null;
let selectionGeneration = 0;
let workspaceRequestSerial = 0;
let catalogController: AbortController | null = null;
let workspaceController: AbortController | null = null;
let artifactController: AbortController | null = null;
let mutationInFlight = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let sequenceReviewer: SequenceReviewer | null = null;
const reviewDrafts = new Map<string, string>();

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Animation Workbench 缺少 DOM #${id}`);
  return element as T;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function emptyState(text: string): HTMLElement {
  return element('div', 'empty', text);
}

function pill(status: string, text: string): HTMLElement {
  return element('span', `pill ${status}`, text);
}

function setVisible(target: HTMLElement, visible: boolean): void {
  target.style.display = visible ? '' : 'none';
}

function shortId(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function lastDecision(revision: Revision | null | undefined): ReviewDecision {
  const events = revision?.review || [];
  return events.length ? events[events.length - 1].decision : 'submitted';
}

function currentCatalogItem(): CatalogItem | null {
  return catalog.find((item) => item.folderName === selectedFolder) || null;
}

function currentState(): NodeState | null {
  return currentView?.states.find((state) => state.id === selectedNodeId) || null;
}

function currentHistory(): Revision[] {
  if (!currentView || !selectedNodeId) return [];
  return currentView.histories[selectedNodeId] || [];
}

function currentRevision(): Revision | null {
  return currentHistory().find((revision) => revision.id === selectedRevisionId) || null;
}

function candidateIdFor(state: NodeState | null): string | null {
  if (!state) return null;
  if (state.reviewCandidate) return state.reviewCandidate;
  const compatible = state.pendingRevisions.find((candidate) => candidate.compatible);
  return compatible?.id || state.pendingRevisions[0]?.id || null;
}

function showToast(message: string, error = false): void {
  toast.textContent = message;
  toast.style.borderColor = error ? 'var(--err)' : 'var(--line)';
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setGlobalStatus(message: string, error = false): void {
  globalStatus.textContent = message;
  globalStatus.style.color = error ? 'var(--err)' : '';
}

function dispatchSelection(): void {
  const detail: WorkbenchSelectionDetail = {
    folderName: selectedFolder,
    view: currentView,
    selectionGeneration,
    workspaceGeneration: currentView?.workspace.generation ?? null,
  };
  window.dispatchEvent(new CustomEvent<WorkbenchSelectionDetail>('workbench-selection', { detail }));
  assemblyCharacter.textContent = currentView
    ? `${currentView.workspace.displayName} · ${currentView.workspace.characterId}`
    : '未选择已建立的角色工作区';
  updateAssemblyTabAvailability();
}

function updateAssemblyTabAvailability(): void {
  const assemblyTab = document.querySelector<HTMLButtonElement>('.top-tab[data-page="assemblyPage"]');
  if (!assemblyTab) return;
  assemblyTab.disabled = !currentView;
  assemblyTab.title = currentView ? '进入纯人工 R 装配' : '请先在资源流程中选择已建立的角色工作区';
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as T;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  if (!sessionToken) throw new Error(HUMAN_SESSION_READ_ONLY_MESSAGE);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Animation-Workbench-Token': sessionToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return await response.json() as T;
}

function artifactUrl(folderName: string, revisionId: string, index: number, name: string, sha256?: string): string {
  const params = new URLSearchParams({
    folder: folderName,
    revision: revisionId,
    index: String(index),
  });
  if (sha256) params.set('v', sha256.slice(0, 16));
  return `/api/workbench/artifact/${encodeURIComponent(name)}?${params.toString()}`;
}

function rawAssetUrl(folderName: string, name: string): string {
  const params = new URLSearchParams({ folder: folderName, name });
  return `/api/workbench/raw?${params.toString()}`;
}

function stageCodeForNode(nodeId: string): string {
  return nodeId.split('/')[0] || nodeId;
}

function stagePresentationForNode(nodeId: string): StagePresentation | null {
  const stage = stageCodeForNode(nodeId);
  return STAGE_PRESENTATIONS.find((entry) => entry.stages.includes(stage)) || null;
}

function actionLabelForState(state: NodeState): string {
  if (state.actionLabel) return state.actionLabel;
  if (!state.actionId) return '';
  return currentView?.workspace.actions.find((action) => action.id === state.actionId)?.label || state.actionId;
}

function stateDisplayName(state: NodeState): string {
  const stage = stagePresentationForNode(state.id);
  const action = actionLabelForState(state);
  return action ? `${stage?.title || state.label} · ${action}` : stage?.title || state.label;
}

function closeWorkbenchOverlays(): void {
  wbQuickAddPanel.classList.remove('open');
  wbActionManager.classList.remove('open');
  wbRight.classList.remove('open');
  wbOverlayBackdrop.classList.remove('open');
}

function openInspector(): void {
  wbActionManager.classList.remove('open');
  wbRight.classList.add('open');
  wbOverlayBackdrop.classList.add('open');
}

function openSettings(): void {
  wbRight.classList.remove('open');
  wbActionManager.classList.add('open');
  wbOverlayBackdrop.classList.add('open');
}

function disposeSequenceReviewer(): void {
  sequenceReviewer?.destroy();
  sequenceReviewer = null;
}

function canonicalRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`${label} 必须是规范的相对路径`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} 含非法路径段`);
  }
  return parts.join('/');
}

function artifactPathForManifestFrame(manifestPath: string, framePath: string): string {
  const parts = canonicalRelativePath(manifestPath, 'manifest artifact path').split('/');
  parts.pop();
  return [...parts, ...canonicalRelativePath(framePath, 'manifest frame.file').split('/')].join('/');
}

function fallbackSequence(folder: string, revision: Revision, pngs: Artifact[], reason: string): ResolvedSequence {
  const ordered = [...pngs].sort((left, right) => left.path.localeCompare(right.path, 'en', { numeric: true }));
  return {
    frames: ordered.map((artifact) => ({
      url: artifactUrl(folder, revision.id, artifact.index, artifact.name, artifact.sha256),
      label: artifact.name,
      path: artifact.path,
    })),
    orderSource: {
      kind: 'fallback',
      label: '路径排序 fallback',
      detail: reason,
    },
  };
}

async function resolveSequence(
  folder: string,
  revision: Revision,
  pngs: Artifact[],
  controller: AbortController,
): Promise<ResolvedSequence> {
  const expectedStage = revision.nodeId.split('/')[0];
  const manifests = revision.artifacts.filter((artifact) => artifact.name.toLowerCase() === 'manifest.json');
  try {
    if (manifests.length !== 1) {
      throw new Error(`需要且只能有一个 manifest.json，当前为 ${manifests.length} 个`);
    }
    const manifestArtifact = manifests[0];
    const response = await fetch(
      artifactUrl(folder, revision.id, manifestArtifact.index, manifestArtifact.name, manifestArtifact.sha256),
      { signal: controller.signal, cache: 'no-store' },
    );
    if (!response.ok) throw new Error(`manifest 读取失败：${await readError(response)}`);
    const raw = await response.json() as Record<string, unknown>;
    if (raw.schemaVersion !== 1) throw new Error(`manifest schemaVersion 不是 1`);
    if (raw.stage !== expectedStage) throw new Error(`manifest.stage=${String(raw.stage)}，期望 ${expectedStage}`);
    if (!Array.isArray(raw.frames) || !raw.frames.length) throw new Error('manifest.frames 为空');
    if (raw.frameCount !== raw.frames.length) throw new Error('manifest.frameCount 与 frames 数量不一致');

    const byPath = new Map<string, Artifact>();
    for (const artifact of revision.artifacts) {
      const path = canonicalRelativePath(artifact.path, 'revision artifact.path');
      if (byPath.has(path)) throw new Error(`revision artifact 路径重复：${path}`);
      byPath.set(path, artifact);
    }
    const seen = new Set<string>();
    const ordered: Artifact[] = [];
    raw.frames.forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`manifest frame ${index} 不是对象`);
      }
      const record = value as Record<string, unknown>;
      if (record.sequenceIndex !== index) throw new Error(`manifest frame ${index} sequenceIndex 不连续`);
      const path = artifactPathForManifestFrame(manifestArtifact.path, record.file as string);
      if (seen.has(path)) throw new Error(`manifest frame 文件重复：${path}`);
      seen.add(path);
      const artifact = byPath.get(path);
      if (!artifact || artifact.mime !== 'image/png') {
        throw new Error(`manifest frame ${index} 找不到对应 PNG：${String(record.file)}`);
      }
      if (typeof record.sha256 !== 'string' || record.sha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
        throw new Error(`manifest frame ${index} sha256 与 revision 不一致`);
      }
      if (!Number.isInteger(record.byteSize) || record.byteSize !== artifact.size) {
        throw new Error(`manifest frame ${index} byteSize 与 revision 不一致`);
      }
      ordered.push(artifact);
    });
    return {
      frames: ordered.map((artifact) => ({
        url: artifactUrl(folder, revision.id, artifact.index, artifact.name, artifact.sha256),
        label: artifact.name,
        path: artifact.path,
      })),
      orderSource: {
        kind: 'manifest',
        label: `${expectedStage} manifest 权威顺序`,
        detail: `${manifests[0].path} · ${ordered.length} 帧`,
      },
    };
  } catch (error) {
    if (controller.signal.aborted || (error as DOMException).name === 'AbortError') throw error;
    return fallbackSequence(folder, revision, pngs, String((error as Error).message || error));
  }
}

function actionPlaybackSpec(nodeId: string): { frameRate: number; loop: boolean } {
  const actionId = nodeId.split('/')[1] || '';
  const action = currentView?.workspace.actions.find((candidate) => candidate.id === actionId);
  return {
    frameRate: Math.max(1, Math.min(60, Math.round(action?.frameRate || 8))),
    loop: action?.loop !== false,
  };
}

function hPreviewArtifacts(revision: Revision): { anim: Artifact; atlas: Artifact } | null {
  if (revision.nodeId !== 'H') return null;
  const anim = revision.artifacts.filter((artifact) => artifact.name.toLowerCase() === 'anim.json');
  const atlas = revision.artifacts.filter((artifact) => artifact.name.toLowerCase() === 'atlas.png');
  return anim.length === 1 && atlas.length === 1 ? { anim: anim[0], atlas: atlas[0] } : null;
}

function previewHRevision(revision: Revision, anim: Artifact, atlas: Artifact): void {
  if (!selectedFolder || !currentView) return;
  const detail: WorkbenchPreviewCandidateDetail = {
    id: `workbench-h:${selectedFolder}:${revision.id}`,
    label: `${currentView.workspace.displayName} · H ${shortId(revision.id)}`,
    folderName: selectedFolder,
    revisionId: revision.id,
    animUrl: artifactUrl(selectedFolder, revision.id, anim.index, anim.name, anim.sha256),
    atlasUrl: artifactUrl(selectedFolder, revision.id, atlas.index, atlas.name, atlas.sha256),
    animVersion: anim.sha256.slice(0, 16),
    atlasVersion: atlas.sha256.slice(0, 16),
  };
  document.querySelector<HTMLButtonElement>('.top-tab[data-page="previewPage"]')?.click();
  window.dispatchEvent(new CustomEvent<WorkbenchPreviewCandidateDetail>('workbench-preview-candidate', { detail }));
}

async function refreshCatalog(preserveSelection = true): Promise<void> {
  catalogController?.abort();
  const controller = new AbortController();
  catalogController = controller;
  try {
    const response = await getJson<{ characters: CatalogItem[] }>('/api/workbench/catalog', controller.signal);
    if (controller.signal.aborted) return;
    catalog = response.characters;
    renderCatalog();
    if (preserveSelection && selectedFolder && !catalog.some((item) => item.folderName === selectedFolder)) {
      clearSelection();
    }
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return;
    setGlobalStatus(`目录读取失败：${String((error as Error).message || error)}`, true);
  }
}

function renderCatalog(): void {
  const query = wbSearch.value.trim().toLocaleLowerCase('zh-CN');
  const filtered = catalog.filter((item) => {
    const haystack = [
      item.folderName,
      item.displayName,
      item.workspace?.characterId || '',
      item.workspace?.bundleId || '',
      ...item.videos,
    ].join('\n').toLocaleLowerCase('zh-CN');
    return !query || haystack.includes(query);
  });
  wbCatalogCount.textContent = `${filtered.length}/${catalog.length}`;
  const fragment = document.createDocumentFragment();
  for (const item of filtered) {
    const row = element('div', `catalog-item${item.folderName === selectedFolder ? ' selected' : ''}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const thumbnail = element('div', 'catalog-thumb', item.displayName.slice(0, 1));
    if (item.hasSetup) {
      const image = element('img');
      image.alt = `${item.displayName} 设定稿缩略图`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = rawAssetUrl(item.folderName, 'setup.png');
      image.addEventListener('error', () => image.remove(), { once: true });
      thumbnail.append(image);
    }
    const copy = element('div', 'catalog-copy');
    copy.append(element('div', 'catalog-name', item.displayName));
    const sub = element('div', 'sub');
    const identity = item.workspace?.error
      ? '工作区损坏'
      : item.workspace
        ? `${item.workspace.actionCount || 0} 个动作`
        : '尚未建立流程';
    sub.append(element('span', '', identity));
    sub.append(element('span', '', item.videos.length ? `${item.videos.length} 个视频` : item.hasSetup ? '有设定稿' : '无素材'));
    copy.append(sub);
    row.append(thumbnail, copy);
    if (item.workspace?.error) row.title = item.workspace.error;
    row.addEventListener('click', () => void selectCatalog(item.folderName));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void selectCatalog(item.folderName);
      }
    });
    fragment.append(row);
  }
  if (!filtered.length) fragment.append(emptyState(query ? '没有匹配的角色' : '原始素材目录为空'));
  wbCatalog.replaceChildren(fragment);
}

function clearSelection(): void {
  selectionGeneration += 1;
  workspaceController?.abort();
  artifactController?.abort();
  disposeSequenceReviewer();
  selectedFolder = null;
  selectedNodeId = null;
  selectedRevisionId = null;
  selectedArtifact = null;
  currentView = null;
  closeWorkbenchOverlays();
  wbCharacterName.textContent = '请选择角色';
  wbCharacterMeta.textContent = '—';
  wbGeneration.textContent = '';
  setVisible(wbInitControls, false);
  setVisible(wbActionControls, false);
  setVisible(wbActionManager, false);
  wbActionManager.replaceChildren();
  wbFocusBanner.replaceChildren(element('div', 'muted', '选择角色后，这里会告诉你下一步该做什么。'));
  wbStageOverview.replaceChildren();
  wbStageActions.classList.remove('show');
  wbStageActions.replaceChildren();
  wbGraph.replaceChildren(emptyState('选择一个角色查看流水线'));
  clearReviewPanels('选择节点或历史版本查看素材');
  nodeInspector.replaceChildren(emptyState('选择图节点查看状态、依赖和 Agent 语义'));
  renderCatalog();
  dispatchSelection();
}

async function selectCatalog(folderName: string): Promise<void> {
  const item = catalog.find((candidate) => candidate.folderName === folderName);
  if (!item) return;
  selectionGeneration += 1;
  workspaceController?.abort();
  artifactController?.abort();
  disposeSequenceReviewer();
  selectedFolder = folderName;
  selectedNodeId = null;
  selectedRevisionId = null;
  selectedArtifact = null;
  currentView = null;
  closeWorkbenchOverlays();
  setVisible(wbActionManager, false);
  wbActionManager.replaceChildren();
  renderCatalog();
  renderCatalogSelectionHeader(item);
  dispatchSelection();
  if (item.workspace?.error) {
    renderFocusBanner();
    renderStageOverview();
    wbGraph.replaceChildren(emptyState('工作区文件无法读取；请先排查磁盘数据，不会自动覆盖'));
    clearReviewPanels('工作区损坏，已保持只读');
    nodeInspector.replaceChildren(errorCard(item.workspace.error));
    return;
  }
  if (!item.workspace) {
    renderFocusBanner();
    renderStageOverview();
    wbGraph.replaceChildren(emptyState('尚未建立版本图。建立工作区不会移动、删除或覆盖已有素材。'));
    clearReviewPanels('建立工作区后可审查各阶段历史');
    nodeInspector.replaceChildren(buildRawSummary(item));
    return;
  }
  await loadSelectedWorkspace(selectionGeneration);
}

function renderCatalogSelectionHeader(item: CatalogItem): void {
  wbCharacterName.textContent = item.displayName;
  wbCharacterMeta.textContent = item.workspace && !item.workspace.error
    ? `${item.workspace.characterId || '—'} · ${item.workspace.bundleId || '未绑定 bundle'}`
    : `${item.hasSetup ? '有 setup.png' : '无 setup.png'} · ${item.videos.length} 个视频`;
  setVisible(wbInitControls, !item.workspace);
  setVisible(wbActionControls, Boolean(item.workspace && !item.workspace.error));
  wbInitId.value = item.workspace?.characterId || item.folderName;
  wbInitBundle.value = item.workspace?.bundleId || '';
  wbInitStatic.value = '';
  wbGeneration.textContent = '';
  wbGeneration.title = '';
}

async function loadSelectedWorkspace(generation: number): Promise<void> {
  if (!selectedFolder) return;
  workspaceController?.abort();
  const controller = new AbortController();
  workspaceController = controller;
  const requestSerial = ++workspaceRequestSerial;
  const folder = selectedFolder;
  setGlobalStatus(`正在读取 ${folder}…`);
  try {
    const params = new URLSearchParams({ folder });
    const view = await getJson<WorkspaceView>(`/api/workbench/workspace?${params.toString()}`, controller.signal);
    if (controller.signal.aborted
      || requestSerial !== workspaceRequestSerial
      || generation !== selectionGeneration
      || folder !== selectedFolder) return;
    const applied = applyWorkspaceView(view);
    const visibleView = applied ? view : currentView;
    if (visibleView) {
      const actions = visibleView.workspace.actions.filter((action) => action.enabled !== false).length;
      setGlobalStatus(`${visibleView.workspace.displayName} · ${actions} 个动作`);
    }
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return;
    if (generation !== selectionGeneration || folder !== selectedFolder) return;
    setGlobalStatus(`工作区读取失败：${String((error as Error).message || error)}`, true);
    wbGraph.replaceChildren(emptyState('读取失败；磁盘内容未被修改'));
  }
}

function applyWorkspaceView(view: WorkspaceView): boolean {
  if (!selectedFolder || view.workspace.folderName !== selectedFolder) return false;
  if (currentView
    && currentView.workspace.folderName === view.workspace.folderName
    && view.workspace.generation < currentView.workspace.generation) {
    return false;
  }
  const previousNode = selectedNodeId;
  const previousRevision = selectedRevisionId;
  currentView = view;
  const item = currentCatalogItem();
  if (item) {
    item.workspace = {
      characterId: view.workspace.characterId,
      bundleId: view.workspace.bundleId,
      updatedAt: view.workspace.updatedAt,
      actionCount: view.workspace.actions.filter((action) => action.enabled !== false).length,
    };
  }
  wbCharacterName.textContent = view.workspace.displayName;
  const enabledActions = view.workspace.actions.filter((action) => action.enabled !== false).length;
  wbCharacterMeta.textContent = `${enabledActions} 个动作 · ${view.workspace.bundleId || '尚未设置导出目标'}`;
  wbGeneration.textContent = `gen ${view.workspace.generation}`;
  wbGeneration.title = `工作区数据版本 ${view.workspace.generation}`;
  setVisible(wbInitControls, false);
  setVisible(wbActionControls, true);
  if (!selectedNodeId || !view.states.some((state) => state.id === selectedNodeId)) {
    selectedNodeId = preferredState(view.states)?.id || view.states[0]?.id || null;
  }
  const history = selectedNodeId ? view.histories[selectedNodeId] || [] : [];
  if (!selectedRevisionId || !history.some((revision) => revision.id === selectedRevisionId)) {
    selectedRevisionId = defaultRevisionId(currentState(), history);
    selectedArtifact = null;
  } else if (previousNode !== selectedNodeId || previousRevision !== selectedRevisionId) {
    selectedArtifact = null;
  }
  renderCatalog();
  renderActionManager();
  renderWorkspace();
  dispatchSelection();
  return true;
}

function defaultRevisionId(state: NodeState | null, history: Revision[]): string | null {
  const candidate = candidateIdFor(state);
  if (candidate && history.some((revision) => revision.id === candidate)) return candidate;
  if (state?.head && history.some((revision) => revision.id === state.head)) return state.head;
  if (state?.legacyBaseline && history.some((revision) => revision.id === state.legacyBaseline)) {
    return state.legacyBaseline;
  }
  return history[0]?.id || null;
}

function renderWorkspace(): void {
  if (!currentView) return;
  renderFocusBanner();
  renderStageOverview();
  renderStageActions();
  renderGraph();
  renderReviewHeader();
  renderReviewRail();
  renderNodeInspector();
  renderArtifactBarAndViewport();
  refreshMutationControls();
}

function revisionWaitingForReview(state: NodeState): Revision | null {
  const revisionId = candidateIdFor(state);
  if (!revisionId || !currentView) return null;
  const revision = (currentView.histories[state.id] || []).find((candidate) => candidate.id === revisionId) || null;
  return revision && lastDecision(revision) === 'submitted' ? revision : null;
}

function preferredState(states: NodeState[]): NodeState | null {
  const selected = states.find((state) => state.id === selectedNodeId);
  if (selected && revisionWaitingForReview(selected)) return selected;
  return states.find((state) => revisionWaitingForReview(state))
    || states.find((state) => state.status === 'manual_required')
    || states.find((state) => ['runnable', 'compatible_cached', 'stale', 'invalidated', 'rejected'].includes(state.status))
    || selected
    || states[0]
    || null;
}

function renderFocusBanner(): void {
  const item = currentCatalogItem();
  const fragment = document.createDocumentFragment();
  const icon = element('div', 'focus-icon', '→');
  const copy = element('div', 'focus-copy');
  const eyebrow = element('span', 'eyebrow', '当前建议');
  const title = element('b');
  const detail = element('span', 'muted');
  const actions = element('div', 'focus-actions');

  if (!item) {
    title.textContent = '先从左侧选择一个角色';
    detail.textContent = '选中后会显示整个制作进度和下一项待办。';
    icon.textContent = '1';
  } else if (item.workspace?.error) {
    title.textContent = '工作区需要修复';
    detail.textContent = '数据保持只读；先查看错误详情，不会自动覆盖任何素材。';
    icon.textContent = '!';
    const inspect = element('button', 't danger', '查看错误');
    inspect.type = 'button';
    inspect.addEventListener('click', openInspector);
    actions.append(inspect);
  } else if (!currentView) {
    title.textContent = item.workspace ? '正在读取角色流程…' : '这个角色还没有版本流程';
    detail.textContent = item.workspace
      ? '素材和历史载入后，会自动定位到最需要处理的阶段。'
      : '建立工作区只会新增版本账本，不移动、不覆盖现有素材。';
    icon.textContent = item.workspace ? '…' : '+';
    if (!item.workspace) {
      const create = element('button', 't primary', '建立工作区');
      create.type = 'button';
      create.addEventListener('click', () => wbInit.click());
      actions.append(create);
    }
  } else {
    const target = preferredState(currentView.states);
    if (!target) {
      title.textContent = '这个角色还没有可处理的阶段';
      detail.textContent = '可以先在“角色与动作设置”里添加动作。';
    } else {
      const pending = revisionWaitingForReview(target);
      const name = stateDisplayName(target);
      const primary = element('button', 't primary');
      primary.type = 'button';
      if (pending) {
        icon.textContent = '!';
        title.textContent = `请审查：${name}`;
        detail.textContent = '候选素材已经准备好。看完后，在右侧选择通过或退回修改。';
        primary.textContent = '开始审查';
        primary.addEventListener('click', () => selectNode(target.id));
      } else if (target.id === 'R' && target.status === 'manual_required') {
        icon.textContent = 'R';
        title.textContent = '对齐所有动作的落脚点和视觉大小';
        detail.textContent = '这是纯人工步骤：把多个动作叠在一起，边看边调。';
        primary.textContent = '进入锚点与缩放';
        primary.addEventListener('click', () => {
          document.querySelector<HTMLButtonElement>('.top-tab[data-page="assemblyPage"]')?.click();
        });
      } else if (['runnable', 'compatible_cached', 'stale', 'invalidated', 'rejected'].includes(target.status)) {
        icon.textContent = 'A';
        title.textContent = `等待 Agent 推进：${name}`;
        detail.textContent = '工作台只记录状态，不会自动发起任务；让 Agent 读取这个角色后继续。';
        primary.textContent = '查看这个阶段';
        primary.addEventListener('click', () => selectNode(target.id));
      } else {
        icon.textContent = '✓';
        title.textContent = '当前没有待审候选';
        detail.textContent = `正在查看 ${name}；可继续检查历史，或让 Agent 读取可推进节点。`;
        primary.textContent = '查看当前阶段';
        primary.addEventListener('click', () => selectNode(target.id));
      }
      actions.append(primary);
      const inspect = element('button', 't', '阶段要求');
      inspect.type = 'button';
      inspect.addEventListener('click', () => {
        selectNode(target.id);
        openInspector();
      });
      actions.append(inspect);
    }
  }
  copy.append(eyebrow, title, detail);
  fragment.append(icon, copy, actions);
  wbFocusBanner.replaceChildren(fragment);
}

function renderStageOverview(): void {
  if (!currentView) {
    wbStageOverview.replaceChildren();
    wbStageActions.classList.remove('show');
    wbStageActions.replaceChildren();
    return;
  }
  const view = currentView;
  const buildSummary = (presentation: StagePresentation): HTMLButtonElement => {
    const states = view.states.filter((state) => presentation.stages.includes(stageCodeForNode(state.id)));
    const target = preferredState(states);
    const waiting = states.filter((state) => revisionWaitingForReview(state)).length;
    const done = states.filter((state) => state.status === 'accepted' || state.status === 'published').length;
    const manual = states.filter((state) => state.status === 'manual_required').length;
    const attention = states.filter((state) => ['runnable', 'compatible_cached', 'stale', 'invalidated', 'rejected'].includes(state.status)).length;
    const selected = states.some((state) => state.id === selectedNodeId);
    const variant = waiting ? ' review' : states.length && done === states.length ? ' done' : manual || attention ? ' attention' : '';
    const button = element('button', `stage-summary${variant}${selected ? ' selected' : ''}`);
    button.type = 'button';
    button.disabled = !target;
    const heading = element('div');
    heading.append(element('span', 'stage-code', presentation.code), element('span', 'stage-title', presentation.title));
    let progress = '尚无节点';
    if (waiting) progress = `${waiting} 项等你审查`;
    else if (manual) progress = '等待人工调整';
    else if (states.length && done === states.length) progress = states.length > 1 ? `${done}/${states.length} 已通过` : '已通过';
    else if (attention) progress = `${attention} 项可继续`;
    else if (states.length) progress = `${done}/${states.length} 已完成`;
    button.append(heading, element('span', 'stage-progress', progress));
    button.title = `${presentation.hint}${target ? `\n${target.reason}` : ''}`;
    if (target) button.addEventListener('click', () => selectNode(target.id));
    return button;
  };

  const byCode = new Map(STAGE_PRESENTATIONS.map((entry) => [entry.code, entry]));
  const start = element('div', 'stage-overview-start');
  for (const code of ['A', 'B']) {
    const presentation = byCode.get(code);
    if (presentation) start.append(buildSummary(presentation));
  }

  const branches = element('div', 'stage-branch-stack');
  const staticLane = element('div', 'stage-lane static');
  staticLane.append(element('span', 'stage-lane-label', '静态分支'));
  for (const code of ['C', 'Hₛ']) {
    const presentation = byCode.get(code);
    if (presentation) staticLane.append(buildSummary(presentation));
  }
  const animationLane = element('div', 'stage-lane animation');
  animationLane.append(element('span', 'stage-lane-label', '动画分支'));
  for (const code of ['D', 'E', 'F', 'G', 'R', 'H']) {
    const presentation = byCode.get(code);
    if (presentation) animationLane.append(buildSummary(presentation));
  }
  branches.append(staticLane, animationLane);
  wbStageOverview.replaceChildren(start, branches);
}

function renderStageActions(): void {
  const selected = currentState();
  const stage = selected ? stageCodeForNode(selected.id) : '';
  if (!currentView || !['D', 'E', 'F', 'G'].includes(stage)) {
    wbStageActions.classList.remove('show');
    wbStageActions.replaceChildren();
    return;
  }
  const states = currentView.states.filter((state) => stageCodeForNode(state.id) === stage);
  const fragment = document.createDocumentFragment();
  fragment.append(element('span', 'stage-action-label', `${stagePresentationForNode(selected!.id)?.title || stage}：`));
  for (const state of states) {
    const pending = Boolean(revisionWaitingForReview(state));
    const done = state.status === 'accepted' || state.status === 'published';
    const attention = ['runnable', 'compatible_cached', 'stale', 'invalidated', 'rejected'].includes(state.status);
    const chip = element('button', `t stage-action-chip${state.id === selectedNodeId ? ' selected' : ''}`);
    chip.type = 'button';
    chip.append(
      element('span', `stage-action-dot${pending ? ' review' : done ? ' done' : attention ? ' attention' : ''}`),
      document.createTextNode(actionLabelForState(state) || state.actionId || state.id),
    );
    chip.title = `${STATUS_LABELS[state.status]} · ${state.reason}`;
    chip.addEventListener('click', () => selectNode(state.id));
    fragment.append(chip);
  }
  wbStageActions.replaceChildren(fragment);
  wbStageActions.classList.add('show');
}

function renderReviewHeader(): void {
  const state = currentState();
  const revision = currentRevision();
  if (!state) {
    artifactStageBadge.textContent = '—';
    artifactReviewTitle.textContent = '选择一个阶段开始审查';
    artifactReviewMeta.textContent = '素材会显示在下方';
    artifactInspectorToggle.disabled = true;
    return;
  }
  const stage = stagePresentationForNode(state.id);
  artifactStageBadge.textContent = stage?.code || stageCodeForNode(state.id);
  artifactReviewTitle.textContent = stateDisplayName(state);
  artifactReviewMeta.textContent = revision
    ? `${STATUS_LABELS[state.status]} · ${revision.artifacts.length} 个素材 · ${formatDate(revision.createdAt)}`
    : `${STATUS_LABELS[state.status]} · 还没有可查看的版本`;
  artifactInspectorToggle.disabled = false;
}

function renderActionManager(): void {
  if (!currentView) {
    setVisible(wbActionManager, false);
    wbActionManager.replaceChildren();
    return;
  }
  setVisible(wbActionManager, true);
  const card = element('div', 'card');
  const header = element('div', 'action-manager-head');
  header.append(element('b', '', '角色与动作设置'));
  header.append(element('span', 'muted', '这里是低频配置；保存只更新版本图，不会创建 Agent 任务'));
  const close = element('button', 't settings-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', closeWorkbenchOverlays);
  header.append(close);
  card.append(header);

  const exportTargets = element('div', 'export-target-row');
  exportTargets.append(element('b', '', '导出位置'));
  const bundleId = element('input', 't');
  bundleId.value = currentView.workspace.bundleId || '';
  bundleId.placeholder = '动画 bundleId（H 必填）';
  bundleId.setAttribute('aria-label', '动画 bundleId');
  const staticTargetPath = element('input', 't');
  staticTargetPath.value = currentView.workspace.staticTargetPath || '';
  staticTargetPath.placeholder = 'public/resources/runtime/images/.../sprite.png（H-static 必填）';
  staticTargetPath.setAttribute('aria-label', '静态 sprite 项目目标 PNG');
  const saveTargets = element('button', 't good', '保存目标');
  saveTargets.type = 'button';
  saveTargets.dataset.workbenchMutation = '';
  saveTargets.disabled = mutationInFlight || !sessionToken;
  saveTargets.title = '静态目标必须由人明确指定为 runtime/images 下的 PNG；工作台不会按角色名猜路径';
  saveTargets.addEventListener('click', () => {
    void saveExportTargets(bundleId.value, staticTargetPath.value);
  });
  exportTargets.append(bundleId, staticTargetPath, saveTargets);
  card.append(exportTargets);

  const actions = currentView.workspace.actions;
  const enabledActionCount = actions.filter((action) => action.enabled !== false).length;
  const list = element('div', 'action-manager-list');
  for (const action of actions) {
    const enabled = action.enabled !== false;
    const row = element('div', `action-manager-row${enabled ? '' : ' is-disabled'}`);
    const identity = element('div', 'action-id');
    identity.title = action.id;
    identity.append(element('b', 'mono', action.id), document.createTextNode(' '));
    identity.append(pill(enabled ? 'accepted' : 'invalidated', enabled ? '启用' : '停用'));

    const label = element('input', 't');
    label.value = action.label || action.id;
    label.placeholder = '显示名';
    label.setAttribute('aria-label', `${action.id} 显示名`);

    const description = element('input', 't');
    description.value = action.description || '';
    description.placeholder = '动作描述（Agent 可读取）';
    description.setAttribute('aria-label', `${action.id} 动作描述`);

    const loopLabel = element('label', 'ctl');
    const loop = element('input');
    loop.type = 'checkbox';
    loop.checked = action.loop !== false;
    loopLabel.append(loop, document.createTextNode('循环'));

    const fpsLabel = element('label', 'ctl');
    const fps = element('input', 't');
    fps.type = 'number';
    fps.min = '1';
    fps.max = '60';
    fps.step = '1';
    fps.value = String(action.frameRate || 8);
    fps.setAttribute('aria-label', `${action.id} 帧率`);
    fpsLabel.append(fps, document.createTextNode('fps'));

    const save = element('button', 't good', '保存规格');
    save.type = 'button';
    save.dataset.workbenchMutation = '';
    save.disabled = mutationInFlight || !sessionToken;
    save.title = 'label/description/loop/fps 的语义变化会只使该动作 D→G 及其汇合下游需要重建';
    save.addEventListener('click', () => {
      void saveActionSpecFromUi(action.id, {
        label: label.value,
        description: description.value,
        loop: loop.checked,
        frameRate: Number(fps.value),
      });
    });

    const toggle = element('button', `t${enabled ? ' danger' : ''}`, enabled ? '停用' : '重新启用');
    toggle.type = 'button';
    toggle.dataset.workbenchMutation = '';
    toggle.disabled = mutationInFlight || !sessionToken;
    toggle.title = enabled ? '停用会让该动作节点暂时离开当前图，但不删除任何版本或文件' : '用原动作 id 恢复该分支及历史';
    toggle.addEventListener('click', () => void setActionEnabledFromUi(action, !enabled));
    row.append(identity, label, description, loopLabel, fpsLabel, save, toggle);
    list.append(row);
  }
  if (!actions.length) list.append(element('div', 'muted', '尚无动作；可在上方用“＋动作”建立分支。'));
  card.append(list);

  const stageRow = element('div', 'stage-invalidate-row');
  stageRow.append(element('b', '', '批量标记重做'));
  const note = element('input', 't');
  note.placeholder = '必填：为什么要让整列重建（Agent 可读取）';
  note.setAttribute('aria-label', '整列失效原因');
  stageRow.append(note);
  for (const stage of ACTION_STAGES) {
    const epoch = Math.max(0, Number(currentView.workspace.stageEpochs?.[stage]) || 0);
    const button = element('button', 't danger', `${stage} 整列 · e${epoch}`);
    button.type = 'button';
    button.dataset.workbenchMutation = '';
    button.dataset.workbenchRequiresActions = '';
    button.disabled = mutationInFlight || !sessionToken || !enabledActionCount;
    button.title = `使所有动作的 ${stage} 节点及其下游按新阶段世代重建；不删除历史或文件`;
    button.addEventListener('click', () => void invalidateStageColumn(stage, note.value));
    stageRow.append(button);
  }
  card.append(stageRow);
  wbActionManager.replaceChildren(card);
  applyReadOnlyControlState();
}

function renderGraph(): void {
  if (!currentView) return;
  const byId = new Map(currentView.states.map((state) => [state.id, state]));
  const fragment = document.createDocumentFragment();
  const staticIds = ['A', 'B', 'C', 'H_STATIC'];
  fragment.append(buildLane('静态 Sprite 分支', staticIds, byId));
  const actions = currentView.workspace.actions.filter((action) => action.enabled !== false);
  for (const action of actions) {
    fragment.append(buildLane(
      `动画动作：${action.label || action.id} · ${action.loop === false ? '单次播放' : '循环'} · ${action.frameRate || 8} fps`,
      ['D', 'E', 'F', 'G'].map((stage) => `${stage}/${action.id}`),
      byId,
    ));
  }
  if (!actions.length) {
    const emptyLane = element('div', 'graph-lane');
    emptyLane.append(element('div', 'lane-label', '尚无动作分支；工作台不会自行创建动画任务'));
    fragment.append(emptyLane);
  }
  fragment.append(buildLane('所有动画动作汇合后，由人完成对齐、缩放和导出', ['R', 'H'], byId, 5));
  wbGraph.replaceChildren(fragment);
}

function buildLane(
  title: string,
  ids: string[],
  states: Map<string, NodeState>,
  startColumn = 1,
): HTMLElement {
  const lane = element('div', 'graph-lane');
  lane.append(element('div', 'lane-label', title));
  ids.forEach((id, index) => {
    const state = states.get(id);
    if (!state) return;
    const node = element('button', `graph-node${id === selectedNodeId ? ' selected' : ''}`);
    node.type = 'button';
    node.style.gridColumn = String(startColumn + index);
    const stage = stagePresentationForNode(state.id);
    node.append(element('div', 'node-id', `${stage?.code || stageCodeForNode(state.id)} · ${stage?.title || state.label}`));
    const action = actionLabelForState(state);
    node.append(element('div', 'node-label', action || (state.owner === 'human' ? '人工阶段' : 'Agent 阶段')));
    const status = element('div', 'node-state');
    status.append(pill(state.status, STATUS_LABELS[state.status]));
    if (candidateIdFor(state)) status.append(document.createTextNode(' '), pill('under_review', '候选'));
    if (state.head) status.append(document.createTextNode(' '), pill('accepted', 'head'));
    if (state.legacyBaseline) status.append(document.createTextNode(' '), pill('published', 'legacy'));
    node.append(status);
    node.title = `${state.reason}\n依赖：${state.deps.join(', ') || '无'}`;
    node.addEventListener('click', () => selectNode(state.id));
    lane.append(node);
  });
  return lane;
}

function selectNode(nodeId: string): void {
  if (!currentView || nodeId === selectedNodeId) return;
  artifactController?.abort();
  disposeSequenceReviewer();
  if (selectedRevisionId) reviewDrafts.set(selectedRevisionId, reviewNote.value);
  selectedNodeId = nodeId;
  const history = currentView.histories[nodeId] || [];
  selectedRevisionId = defaultRevisionId(currentState(), history);
  selectedArtifact = null;
  renderWorkspace();
}

function selectRevision(revisionId: string): void {
  if (revisionId === selectedRevisionId) return;
  artifactController?.abort();
  disposeSequenceReviewer();
  if (selectedRevisionId) reviewDrafts.set(selectedRevisionId, reviewNote.value);
  selectedRevisionId = revisionId;
  selectedArtifact = null;
  renderReviewHeader();
  renderReviewRail();
  renderNodeInspector();
  renderArtifactBarAndViewport();
  refreshMutationControls();
}

function renderReviewRail(): void {
  const state = currentState();
  if (!state) {
    reviewCandidate.replaceChildren(element('div', 'muted', '无'));
    revisionHistory.replaceChildren(element('div', 'muted', '无'));
    reviewNote.value = '';
    return;
  }
  const candidateId = candidateIdFor(state);
  const candidate = currentHistory().find((revision) => revision.id === candidateId) || null;
  const head = currentHistory().find((revision) => revision.id === state.head) || null;
  const summary = document.createDocumentFragment();
  summary.append(buildRevisionSummary('待审版 · 尚未影响当前资源', candidate, candidate?.id === selectedRevisionId));
  summary.append(buildRevisionSummary('当前使用版', head, head?.id === selectedRevisionId));
  if (state.legacyBaseline) {
    const legacy = currentHistory().find((revision) => revision.id === state.legacyBaseline) || null;
    summary.append(buildRevisionSummary('迁移前已发布版本', legacy, legacy?.id === selectedRevisionId));
  }
  reviewCandidate.replaceChildren(summary);

  const history = currentHistory();
  const fragment = document.createDocumentFragment();
  for (const revision of history) fragment.append(buildHistoryItem(revision, state));
  if (!history.length) fragment.append(element('div', 'muted', '该节点尚无版本'));
  revisionHistory.replaceChildren(fragment);
  reviewNote.value = selectedRevisionId ? reviewDrafts.get(selectedRevisionId) || '' : '';
}

function buildRevisionSummary(label: string, revision: Revision | null, selected: boolean): HTMLElement {
  const card = element('div', `card${selected ? ' selected' : ''}`);
  card.append(element('div', 'muted', label));
  if (!revision) {
    card.append(element('div', '', '无'));
    return card;
  }
  const button = element('button', `t${selected ? ' primary' : ''}`, selected ? '正在查看' : '查看');
  button.type = 'button';
  button.title = revision.id;
  button.addEventListener('click', () => selectRevision(revision.id));
  card.append(button, document.createTextNode(' '), pill(lastDecision(revision), DECISION_LABELS[lastDecision(revision)]));
  card.append(element('div', 'hash mono', shortId(revision.id)));
  return card;
}

function buildHistoryItem(revision: Revision, state: NodeState): HTMLElement {
  const row = element('div', `history-item${revision.id === selectedRevisionId ? ' selected' : ''}`);
  const title = element('div', 'row');
  title.append(element('b', 'mono', shortId(revision.id)));
  const decision = lastDecision(revision);
  title.append(pill(decision, DECISION_LABELS[decision]));
  if (revision.id === state.head) title.append(pill('accepted', '当前使用'));
  if (revision.id === candidateIdFor(state)) title.append(pill('under_review', '等待审查'));
  if (revision.id === state.legacyBaseline) title.append(pill('published', '迁移前已发布'));
  row.append(title);
  row.append(element('div', 'hash mono', `${formatDate(revision.createdAt)} · ${revision.artifacts.length} artifact`));
  const note = revision.producer?.note || revision.review[revision.review.length - 1]?.note || '';
  if (note) row.append(element('div', 'muted', note));
  row.addEventListener('click', () => selectRevision(revision.id));
  if (decision === 'accepted' && revision.id !== state.head) {
    const switchButton = element('button', 't', '恢复为当前版本');
    switchButton.type = 'button';
    switchButton.dataset.workbenchMutation = '';
    switchButton.disabled = mutationInFlight || !sessionToken;
    switchButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (window.confirm(`将 ${revision.id} 设为 ${state.id} 的生效 head？下游状态会按依赖自动重算。`)) {
        void switchHistoricalHead(state.id, revision.id);
      }
    });
    row.append(switchButton);
  }
  return row;
}

function clearReviewPanels(message: string): void {
  disposeSequenceReviewer();
  artifactBar.replaceChildren(element('span', 'muted', message));
  artifactViewport.replaceChildren(emptyState(message));
  reviewCandidate.replaceChildren(element('div', 'muted', '无'));
  revisionHistory.replaceChildren(element('div', 'muted', '无'));
  reviewNote.value = '';
  artifactStageBadge.textContent = '—';
  artifactReviewTitle.textContent = '选择一个阶段开始审查';
  artifactReviewMeta.textContent = message;
  artifactInspectorToggle.disabled = true;
  reviewAccept.disabled = true;
  reviewReject.disabled = true;
  reviewInvalidate.disabled = true;
  reviewAccept.style.display = 'none';
  reviewReject.style.display = 'none';
  reviewInvalidate.style.display = 'none';
}

function renderArtifactBarAndViewport(): void {
  artifactController?.abort();
  disposeSequenceReviewer();
  const revision = currentRevision();
  if (!revision || !selectedFolder) {
    artifactBar.replaceChildren(element('span', 'muted', '所选节点/版本没有可审查素材'));
    artifactViewport.replaceChildren(emptyState('暂无素材'));
    return;
  }
  const pngs = revision.artifacts.filter((artifact) => artifact.mime === 'image/png');
  if (selectedArtifact === null
    || (selectedArtifact === 'png-sequence' && pngs.length < 2)
    || (typeof selectedArtifact === 'number' && !revision.artifacts.some((artifact) => artifact.index === selectedArtifact))) {
    selectedArtifact = pngs.length >= 2 ? 'png-sequence' : revision.artifacts[0]?.index ?? null;
  }
  const fragment = document.createDocumentFragment();
  const hPreview = hPreviewArtifacts(revision);
  if (hPreview) {
    const preview = element('button', 't good artifact-tab', '▶ 游戏真实渲染预览');
    preview.type = 'button';
    preview.title = '直接读取此 immutable H 版本的 anim.json + atlas.png；不会发布、复制或修改任何资源';
    preview.addEventListener('click', () => previewHRevision(revision, hPreview.anim, hPreview.atlas));
    fragment.append(preview);
  }
  if (pngs.length >= 2) {
    const sequence = element('button', `t artifact-tab${selectedArtifact === 'png-sequence' ? ' active' : ''}`, `PNG 序列 · ${pngs.length}`);
    sequence.type = 'button';
    sequence.addEventListener('click', () => {
      selectedArtifact = 'png-sequence';
      renderArtifactBarAndViewport();
    });
    fragment.append(sequence);
  }
  for (const artifact of revision.artifacts) {
    const label = artifact.role && artifact.role !== 'artifact'
      ? `${artifact.role} · ${artifact.name}`
      : artifact.name;
    const button = element('button', `t artifact-tab${selectedArtifact === artifact.index ? ' active' : ''}`, label);
    button.type = 'button';
    button.title = `${artifact.path}\n${artifact.mime}\n${formatBytes(artifact.size)}\nsha256 ${artifact.sha256}`;
    button.addEventListener('click', () => {
      selectedArtifact = artifact.index;
      renderArtifactBarAndViewport();
    });
    fragment.append(button);
  }
  if (!revision.artifacts.length) fragment.append(element('span', 'muted', '该版本没有 artifact'));
  artifactBar.replaceChildren(fragment);
  void renderSelectedArtifact(revision, pngs);
}

async function renderSelectedArtifact(revision: Revision, pngs: Artifact[]): Promise<void> {
  artifactController?.abort();
  const controller = new AbortController();
  artifactController = controller;
  const generation = selectionGeneration;
  const folder = selectedFolder;
  const revisionId = revision.id;
  if (!folder || selectedArtifact === null) {
    artifactViewport.replaceChildren(emptyState('暂无素材'));
    return;
  }
  if (selectedArtifact === 'png-sequence') {
    const stage = revision.nodeId.split('/')[0];
    if (stage === 'E' || stage === 'F' || stage === 'G') {
      artifactViewport.replaceChildren(emptyState('正在校验 manifest 权威帧序…'));
      try {
        const resolved = await resolveSequence(folder, revision, pngs, controller);
        if (controller.signal.aborted
          || generation !== selectionGeneration
          || folder !== selectedFolder
          || revisionId !== selectedRevisionId
          || selectedArtifact !== 'png-sequence') return;
        const playback = actionPlaybackSpec(revision.nodeId);
        const reviewer = new SequenceReviewer({
          frames: resolved.frames,
          frameRate: playback.frameRate,
          loop: playback.loop,
          orderSource: resolved.orderSource,
        });
        sequenceReviewer = reviewer;
        reviewer.setPageActive(document.getElementById('workbenchPage')?.classList.contains('active') === true);
        artifactViewport.replaceChildren(reviewer.element);
      } catch (error) {
        if ((error as DOMException).name === 'AbortError') return;
        artifactViewport.replaceChildren(errorCard(String((error as Error).message || error)));
      }
      return;
    }
    const grid = element('div', 'sequence-grid');
    pngs.forEach((artifact, order) => {
      const figure = element('figure');
      const image = element('img');
      image.alt = `${revision.nodeId} frame ${order + 1}: ${artifact.name}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = artifactUrl(folder, revisionId, artifact.index, artifact.name, artifact.sha256);
      const caption = element('figcaption', 'mono', `${String(order + 1).padStart(3, '0')} · ${artifact.name}`);
      caption.title = artifact.path;
      figure.append(image, caption);
      grid.append(figure);
    });
    artifactViewport.replaceChildren(grid);
    return;
  }
  const artifact = revision.artifacts.find((candidate) => candidate.index === selectedArtifact);
  if (!artifact) {
    artifactViewport.replaceChildren(emptyState('artifact 不存在'));
    return;
  }
  const url = artifactUrl(folder, revisionId, artifact.index, artifact.name, artifact.sha256);
  if (artifact.mime.startsWith('image/')) {
    const image = element('img');
    image.alt = `${revision.nodeId}: ${artifact.name}`;
    image.src = url;
    artifactViewport.replaceChildren(image);
    return;
  }
  if (artifact.mime.startsWith('video/')) {
    const video = element('video');
    video.controls = true;
    video.loop = actionPlaybackSpec(revision.nodeId).loop;
    video.preload = 'metadata';
    video.src = url;
    artifactViewport.replaceChildren(video);
    return;
  }
  const isJson = artifact.mime.startsWith('application/json') || artifact.name.toLowerCase().endsWith('.json');
  const isText = isJson
    || artifact.mime.startsWith('text/')
    || /\.(md|txt|csv|tsv)$/i.test(artifact.name);
  if (isText) {
    artifactViewport.replaceChildren(emptyState('正在读取文本…'));
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(await readError(response));
      const text = await response.text();
      if (controller.signal.aborted
        || generation !== selectionGeneration
        || folder !== selectedFolder
        || revisionId !== selectedRevisionId) return;
      const pre = element('pre', 'mono');
      if (isJson) {
        try {
          pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          pre.textContent = text;
        }
      } else {
        pre.textContent = text;
      }
      artifactViewport.replaceChildren(pre);
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return;
      artifactViewport.replaceChildren(errorCard(String((error as Error).message || error)));
    }
    return;
  }
  const card = element('div', 'card');
  card.append(element('b', '', artifact.name));
  card.append(element('div', 'muted mono', `${artifact.mime} · ${formatBytes(artifact.size)}`));
  card.append(element('div', 'muted mono', `sha256 ${artifact.sha256}`));
  const open = element('a', 't', '在新标签打开');
  open.href = url;
  open.target = '_blank';
  open.rel = 'noopener';
  card.append(open);
  artifactViewport.replaceChildren(card);
}

function renderNodeInspector(): void {
  const state = currentState();
  if (!currentView || !state) {
    nodeInspector.replaceChildren(emptyState('选择图节点查看状态、依赖和 Agent 语义'));
    return;
  }
  const fragment = document.createDocumentFragment();
  const stateCard = element('div', 'card');
  const heading = element('div', 'row');
  heading.append(element('b', 'mono', state.id), pill(state.status, STATUS_LABELS[state.status]));
  stateCard.append(heading);
  stateCard.append(element('div', 'muted', state.label));
  stateCard.append(element('p', '', state.contract?.purpose || semanticForNode(state)));
  const ownership = state.owner === 'human' ? '人工 UI' : '外部 Agent 主动推进';
  stateCard.append(kvRows([
    ['推进者', ownership],
    ['当前状态', state.reason],
    ['生效 head', shortId(state.head)],
    ['待审候选', shortId(candidateIdFor(state))],
    ['legacy baseline', shortId(state.legacyBaseline)],
  ]));
  fragment.append(stateCard);

  if (state.contract) {
    const contractCard = element('div', 'card');
    contractCard.append(element('b', '', 'Agent 可读语义契约'));
    for (const [label, values] of [
      ['输入', state.contract.inputs || []],
      ['输出', state.contract.outputs || []],
      ['验收', state.contract.acceptance || []],
    ] as const) {
      if (!values.length) continue;
      contractCard.append(element('div', 'muted', label));
      const list = element('ul');
      for (const value of values) list.append(element('li', '', value));
      contractCard.append(list);
    }
    fragment.append(contractCard);
  }

  const depCard = element('div', 'card');
  depCard.append(element('b', '', '依赖快照'));
  if (!state.deps.length) {
    depCard.append(element('div', 'muted', '无上游节点'));
  } else {
    const stateMap = new Map(currentView.states.map((node) => [node.id, node]));
    for (const dependency of state.deps) {
      const row = element('div', 'kv');
      row.append(element('span', 'k mono', dependency));
      const depState = stateMap.get(dependency);
      row.append(element('span', 'v', depState ? `${STATUS_LABELS[depState.status]} · ${shortId(state.expectedParents[dependency])}` : '缺失'));
      depCard.append(row);
    }
  }
  fragment.append(depCard);

  if (state.status === 'compatible_cached' && state.compatibleRevision) {
    const restoreCard = element('div', 'card');
    restoreCard.append(element('b', '', '兼容历史可复用'));
    restoreCard.append(element('div', 'muted mono', state.compatibleRevision));
    const restore = element('button', 't good', '恢复此节点及兼容下游');
    restore.type = 'button';
    restore.dataset.workbenchMutation = '';
    restore.disabled = mutationInFlight || !sessionToken;
    restore.addEventListener('click', () => {
      if (window.confirm('恢复与当前依赖完全匹配的历史版本，并递归尝试恢复下游兼容缓存？')) {
        void restoreCompatibleRecursive(state.id);
      }
    });
    restoreCard.append(restore);
    fragment.append(restoreCard);
  }

  const selected = currentRevision();
  if (selected) fragment.append(buildSelectedRevisionInspector(selected));
  fragment.append(buildWorkspaceHealthCard());
  fragment.append(buildCheckpointCard());
  nodeInspector.replaceChildren(fragment);
}

function semanticForNode(state: NodeState): string {
  if (NODE_SEMANTICS[state.id]) return NODE_SEMANTICS[state.id];
  const stage = state.id.split('/')[0];
  return NODE_SEMANTICS[stage] || '版本化动画资源节点。';
}

function kvRows(rows: Array<[string, string]>): HTMLElement {
  const grid = element('div', 'kv');
  for (const [key, value] of rows) {
    grid.append(element('span', 'k', key), element('span', 'v mono', value));
  }
  return grid;
}

function buildSelectedRevisionInspector(revision: Revision): HTMLElement {
  const card = element('div', 'card');
  card.append(element('b', '', '当前查看版本'));
  card.append(element('div', 'mono', revision.id));
  card.append(kvRows([
    ['结论', DECISION_LABELS[lastDecision(revision)]],
    ['产出者', [revision.producer?.kind, revision.producer?.name].filter(Boolean).join(' · ') || '—'],
    ['创建时间', formatDate(revision.createdAt)],
    ['artifact', String(revision.artifacts.length)],
  ]));
  if (revision.producer?.note) card.append(element('p', 'muted', revision.producer.note));
  if (revision.review.length) {
    const reviews = element('div');
    reviews.append(element('div', 'muted', '人工审查记录'));
    for (const event of revision.review) {
      const line = element('div', 'card');
      line.append(pill(event.decision, DECISION_LABELS[event.decision]));
      line.append(document.createTextNode(` ${formatDate(event.at)} · ${event.reviewer || 'human'}`));
      if (event.note) line.append(element('div', 'muted', event.note));
      reviews.append(line);
    }
    card.append(reviews);
  }
  return card;
}

function buildWorkspaceHealthCard(): HTMLElement {
  if (!currentView) return element('div');
  const card = element('div', 'card');
  const title = element('div', 'row');
  title.append(element('b', '', '工作区完整性'));
  title.append(pill(currentView.integrity.ok ? 'accepted' : 'invalidated', currentView.integrity.ok ? '索引正常' : '需要修复'));
  card.append(title);
  card.append(kvRows([
    ['版本', String(currentView.storage.revisionCount)],
    ['artifact', String(currentView.storage.artifactCount)],
    ['逻辑容量', formatBytes(currentView.storage.logicalBytes)],
    ['去重容量', formatBytes(currentView.storage.uniqueBytes)],
  ]));
  card.title = currentView.paths.agentContextMarkdown;
  return card;
}

function buildCheckpointCard(): HTMLElement {
  const card = element('div', 'card');
  card.append(element('b', '', '检查点'));
  const checkpoints = currentView?.workspace.checkpoints || [];
  if (!checkpoints.length) {
    card.append(element('div', 'muted', '尚无检查点'));
    return card;
  }
  for (const checkpoint of [...checkpoints].reverse()) {
    const row = element('div', 'history-item');
    row.append(element('b', '', checkpoint.name));
    row.append(element('div', 'muted mono', `${formatDate(checkpoint.createdAt)} · ${Object.keys(checkpoint.heads || {}).length} heads`));
    if (checkpoint.note) row.append(element('div', 'muted', checkpoint.note));
    const restore = element('button', 't', '恢复');
    restore.type = 'button';
    restore.dataset.workbenchMutation = '';
    restore.disabled = mutationInFlight || !sessionToken;
    restore.addEventListener('click', () => {
      if (window.confirm(`恢复检查点“${checkpoint.name}”？各节点会按恢复后的 head 自动重算依赖状态。`)) {
        void restoreSavedCheckpoint(checkpoint.id);
      }
    });
    row.append(restore);
    card.append(row);
  }
  return card;
}

function buildRawSummary(item: CatalogItem): HTMLElement {
  const card = element('div', 'card');
  card.append(element('b', '', '现有原始素材（只读）'));
  card.append(kvRows([
    ['setup.png', item.hasSetup ? '存在' : '不存在'],
    ['动画视频', String(item.videos.length)],
    ['目录', item.absolutePath],
  ]));
  if (item.videos.length) {
    const list = element('div', 'muted mono');
    for (const video of item.videos) list.append(element('div', '', video));
    card.append(list);
  }
  const warning = element('div', 'card');
  warning.append(element('b', '', '安全边界'));
  warning.append(element('div', 'muted', '建立工作区只创建版本账本；不会移动、删除或覆盖 setup、视频或已发布资源。'));
  const wrapper = element('div');
  wrapper.append(card, warning);
  return wrapper;
}

function errorCard(message: string): HTMLElement {
  const card = element('div', 'card');
  card.append(element('b', '', '错误'));
  card.append(element('div', 'muted', message));
  return card;
}

function refreshMutationControls(): void {
  const state = currentState();
  const revision = currentRevision();
  const decision = lastDecision(revision);
  const pending = state?.pendingRevisions.find((candidate) => candidate.id === revision?.id);
  const canDecideCandidate = Boolean(revision && decision === 'submitted');
  const canInvalidateHead = Boolean(revision
    && revision.id === state?.head
    && decision === 'accepted');
  reviewAccept.style.display = canDecideCandidate ? '' : 'none';
  reviewReject.style.display = canDecideCandidate ? '' : 'none';
  reviewInvalidate.style.display = canInvalidateHead ? '' : 'none';
  reviewAccept.disabled = mutationInFlight || !sessionToken || !revision || decision !== 'submitted' || !pending?.compatible;
  reviewReject.disabled = mutationInFlight || !sessionToken || !revision || decision !== 'submitted';
  reviewInvalidate.disabled = mutationInFlight
    || !sessionToken
    || !revision
    || revision.id !== state?.head
    || (decision !== 'accepted');
  wbInit.disabled = mutationInFlight || !sessionToken;
  wbAddAction.disabled = mutationInFlight || !sessionToken || !currentView;
  wbCheckpoint.disabled = mutationInFlight || !sessionToken || !currentView;
  reviewAccept.title = pending && !pending.compatible ? '该候选依赖已变化，不能通过' : '';
  reviewInvalidate.title = state
    ? `只直接失效 ${state.id} 的当前 head；依赖它的下游会自动重算，其他动作小节点不会被直接改写`
    : '';
  reviewNote.placeholder = canInvalidateHead
    ? '说明为什么这个已采用版本需要重做（必填，Agent 会读取）'
    : canDecideCandidate
      ? '通过可留空；退回修改时请写清楚问题（Agent 会读取）'
      : '选择待审版或当前使用版后填写意见';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-workbench-mutation]')) {
    const requiresActions = button.hasAttribute('data-workbench-requires-actions');
    button.disabled = mutationInFlight
      || !sessionToken
      || !currentView
      || (requiresActions && !currentView.workspace.actions.some((action) => action.enabled !== false));
  }
  applyReadOnlyControlState();
}

function applyReadOnlyControlState(): void {
  if (sessionToken) return;
  const selectors = [
    '#wbInitControls input',
    '#wbInitControls button',
    '#wbActionControls input',
    '#wbAddActionToggle',
    '#wbAddAction',
    '#wbCheckpoint',
    '#wbActionManager input',
    '#wbActionManager select',
    '#reviewRail textarea',
    '#reviewAccept',
    '#reviewReject',
    '#reviewInvalidate',
    '[data-workbench-mutation]',
  ];
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(selectors.join(','))) {
    control.disabled = true;
    control.title = HUMAN_SESSION_READ_ONLY_MESSAGE;
  }
}

function installReadOnlyNotice(): void {
  if (sessionToken || document.getElementById('workbenchReadOnlyNotice')) return;
  const notice = element('span', 'pill rejected', '只读 · 请用 ./dev.sh anim-preview 启动');
  notice.id = 'workbenchReadOnlyNotice';
  notice.title = `${HUMAN_SESSION_READ_ONLY_MESSAGE}。普通 npm/vite 地址不会获得人工写权限。`;
  document.querySelector('.topbar .brand')?.after(notice);
}

async function performMutation<T>(
  endpoint: string,
  body: Record<string, unknown>,
  apply: (response: T) => WorkspaceView | null,
  successMessage: string,
): Promise<void> {
  if (mutationInFlight) return;
  if (!sessionToken) {
    showToast(HUMAN_SESSION_READ_ONLY_MESSAGE, true);
    return;
  }
  const folder = selectedFolder;
  const generation = selectionGeneration;
  mutationInFlight = true;
  refreshMutationControls();
  setGlobalStatus('正在写入人工操作…');
  try {
    const response = await postJson<T>(endpoint, body);
    const view = apply(response);
    const applied = Boolean(view
      && folder === selectedFolder
      && generation === selectionGeneration
      && applyWorkspaceView(view));
    showToast(successMessage);
    const visibleView = applied ? view : currentView;
    if (visibleView) {
      const actions = visibleView.workspace.actions.filter((action) => action.enabled !== false).length;
      setGlobalStatus(`${visibleView.workspace.displayName} · ${actions} 个动作`);
    } else setGlobalStatus('操作完成');
    void refreshCatalog(true);
  } catch (error) {
    const message = String((error as Error).message || error);
    showToast(message, true);
    setGlobalStatus(`写入失败：${message}`, true);
  } finally {
    mutationInFlight = false;
    refreshMutationControls();
    renderNodeInspector();
  }
}

function directView(response: WorkspaceView): WorkspaceView {
  return response;
}

async function initializeWorkspace(): Promise<void> {
  const item = currentCatalogItem();
  const characterId = wbInitId.value.trim();
  if (!item || item.workspace || !characterId) {
    showToast('请填写 characterId', true);
    return;
  }
  await performMutation<WorkspaceView>(
    '/api/workbench/init',
    {
      folderName: item.folderName,
      displayName: item.displayName,
      characterId,
      bundleId: wbInitBundle.value.trim(),
      staticTargetPath: wbInitStatic.value.trim(),
    },
    directView,
    '工作区已建立；原素材保持原位',
  );
}

async function saveExportTargets(bundleIdValue: string, staticTargetPathValue: string): Promise<void> {
  if (!selectedFolder || !currentView) return;
  const bundleId = bundleIdValue.trim();
  const staticTargetPath = staticTargetPathValue.trim();
  await performMutation<WorkspaceView>(
    '/api/workbench/export-targets',
    { folderName: selectedFolder, patch: { bundleId, staticTargetPath } },
    directView,
    '项目导出目标已保存；相关节点状态已重算',
  );
}

async function addActionFromForm(): Promise<void> {
  if (!selectedFolder || !currentView) return;
  const id = wbActionId.value.trim();
  const label = wbActionLabel.value.trim() || id;
  if (!id) {
    showToast('请填写动作 id', true);
    return;
  }
  await performMutation<WorkspaceView>(
    '/api/workbench/action',
    { folderName: selectedFolder, action: { id, label } },
    directView,
    `动作 ${label} 已加入版本图`,
  );
  wbActionId.value = '';
  wbActionLabel.value = '';
  wbQuickAddPanel.classList.remove('open');
}

async function saveActionSpecFromUi(
  actionId: string,
  patch: { label: string; description: string; loop: boolean; frameRate: number },
): Promise<void> {
  if (!selectedFolder || !currentView) return;
  if (!Number.isInteger(patch.frameRate) || patch.frameRate < 1 || patch.frameRate > 60) {
    showToast('帧率必须是 1–60 的整数', true);
    return;
  }
  const label = patch.label.trim() || actionId;
  await performMutation<WorkspaceView>(
    '/api/workbench/action-spec',
    {
      folderName: selectedFolder,
      actionId,
      patch: {
        label,
        description: patch.description.trim(),
        loop: patch.loop,
        frameRate: patch.frameRate,
      },
    },
    directView,
    `动作 ${label} 的规格已保存；依赖状态已重算`,
  );
}

async function setActionEnabledFromUi(action: ActionDef, enabled: boolean): Promise<void> {
  if (!selectedFolder || !currentView) return;
  const label = action.label || action.id;
  if (!enabled && !window.confirm(
    `停用动作“${label}”（${action.id}）？\n\nD/E/F/G 节点会暂时离开当前图，R/H 将按剩余启用动作重算。历史版本和素材不会删除。`,
  )) return;
  await performMutation<WorkspaceView>(
    '/api/workbench/action-enabled',
    { folderName: selectedFolder, actionId: action.id, enabled },
    directView,
    enabled ? `动作 ${label} 已重新启用` : `动作 ${label} 已停用；历史与素材仍保留`,
  );
}

async function invalidateStageColumn(stage: ActionStage, noteValue: string): Promise<void> {
  if (!selectedFolder || !currentView) return;
  const note = noteValue.trim();
  if (!note) {
    showToast(`请先填写 ${stage} 整列失效原因`, true);
    return;
  }
  if (!window.confirm(
    `确认让所有动作分支的 ${stage} 整列失效？\n\n${stage} 及依赖它的下游会按新世代重建；这里只改版本图标记，不删除历史或任何素材。`,
  )) return;
  await performMutation<WorkspaceView>(
    '/api/workbench/stage-invalidate',
    { folderName: selectedFolder, stage, note },
    directView,
    `${stage} 整列已失效；Agent 可读取原因与重建状态`,
  );
}

async function recordSelectedReview(decision: Exclude<ReviewDecision, 'submitted'>): Promise<void> {
  if (!selectedFolder || !selectedRevisionId) return;
  const revisionId = selectedRevisionId;
  const note = reviewNote.value.trim();
  if ((decision === 'rejected' || decision === 'invalidated') && !note) {
    showToast(decision === 'rejected' ? '退回修改前，请写清楚需要修改的问题' : '标记重做前，请填写失效原因', true);
    reviewNote.focus();
    return;
  }
  if (decision === 'invalidated') {
    const nodeId = currentState()?.id || '当前节点';
    if (!window.confirm(
      `仅将 ${nodeId} 的当前生效 head 标记失效？\n\n直接标记的只有这一个节点；依赖它的下游会自动重算。其他动作小节点不会被直接失效，历史与素材不会删除。`,
    )) return;
  }
  reviewDrafts.set(revisionId, note);
  await performMutation<WorkspaceView>(
    '/api/workbench/review',
    { folderName: selectedFolder, revisionId, decision, note },
    directView,
    decision === 'accepted' ? '候选已通过并成为生效 head' : decision === 'rejected' ? '候选已拒绝' : '生效版本已标记失效',
  );
  reviewDrafts.delete(revisionId);
}

async function switchHistoricalHead(nodeId: string, revisionId: string): Promise<void> {
  if (!selectedFolder) return;
  await performMutation<WorkspaceView>(
    '/api/workbench/head',
    { folderName: selectedFolder, nodeId, revisionId },
    directView,
    '历史版本已切换为生效 head；下游状态已重算',
  );
}

async function restoreCompatibleRecursive(nodeId: string): Promise<void> {
  if (!selectedFolder) return;
  await performMutation<WorkspaceView>(
    '/api/workbench/restore-compatible',
    { folderName: selectedFolder, nodeId, recursive: true },
    directView,
    '已恢复可复用的兼容版本',
  );
}

async function createNamedCheckpoint(): Promise<void> {
  if (!selectedFolder || !currentView) return;
  const suggested = `检查点 ${currentView.workspace.checkpoints.length + 1}`;
  const name = window.prompt('检查点名称', suggested);
  if (name === null) return;
  await performMutation<{ checkpoint: Checkpoint; view: WorkspaceView }>(
    '/api/workbench/checkpoint',
    { folderName: selectedFolder, name: name.trim() || suggested },
    (response) => response.view,
    '检查点已保存',
  );
}

async function restoreSavedCheckpoint(checkpointId: string): Promise<void> {
  if (!selectedFolder) return;
  await performMutation<WorkspaceView>(
    '/api/workbench/restore-checkpoint',
    { folderName: selectedFolder, checkpointId },
    directView,
    '检查点已恢复；依赖状态已重算',
  );
}

function configureTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.top-tab[data-page]')];
  const pages = [...document.querySelectorAll<HTMLElement>('.tool-page')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const pageId = tab.dataset.page;
      if (!pageId || tab.disabled) {
        if (tab.disabled) showToast('请先选择已建立的角色工作区');
        return;
      }
      for (const other of tabs) other.classList.toggle('active', other === tab);
      for (const page of pages) page.classList.toggle('active', page.id === pageId);
      if (pageId !== 'workbenchPage') closeWorkbenchOverlays();
      sequenceReviewer?.setPageActive(pageId === 'workbenchPage');
      window.dispatchEvent(new CustomEvent('workbench-page-change', { detail: { pageId } }));
      window.dispatchEvent(new Event('resize'));
      if (pageId === 'assemblyPage') dispatchSelection();
    });
  }
  updateAssemblyTabAvailability();
}

const pendingChangedFolders = new Set<string>();
const pendingChangedReasons = new Set<string>();
let globalWorkbenchChange = false;
let wsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function queueWorkbenchRefresh(message: WorkbenchChangedMessage): void {
  if (message.folderName) pendingChangedFolders.add(message.folderName);
  else globalWorkbenchChange = true;
  for (const reason of message.reasons || []) pendingChangedReasons.add(reason);
  if (wsRefreshTimer) clearTimeout(wsRefreshTimer);
  wsRefreshTimer = setTimeout(() => void flushWorkbenchRefresh(), 160);
}

async function flushWorkbenchRefresh(): Promise<void> {
  wsRefreshTimer = null;
  const affectsSelection = Boolean(selectedFolder
    && (globalWorkbenchChange || pendingChangedFolders.has(selectedFolder)));
  const reasons = [...pendingChangedReasons];
  pendingChangedFolders.clear();
  pendingChangedReasons.clear();
  globalWorkbenchChange = false;
  await refreshCatalog(true);
  if (affectsSelection && selectedFolder && currentCatalogItem()?.workspace && !currentCatalogItem()?.workspace?.error) {
    await loadSelectedWorkspace(selectionGeneration);
  }
  if (reasons.length) setGlobalStatus(`已合并磁盘刷新 · ${reasons.join(', ')}`);
}

function bindEvents(): void {
  wbSearch.addEventListener('input', renderCatalog);
  wbInit.addEventListener('click', () => void initializeWorkspace());
  wbAddActionToggle.addEventListener('click', () => {
    wbQuickAddPanel.classList.toggle('open');
    if (wbQuickAddPanel.classList.contains('open')) {
      wbActionId.focus();
      wbActionManager.classList.remove('open');
      wbRight.classList.remove('open');
      wbOverlayBackdrop.classList.remove('open');
    }
  });
  wbSettingsToggle.addEventListener('click', openSettings);
  wbInspectorToggle.addEventListener('click', openInspector);
  artifactInspectorToggle.addEventListener('click', openInspector);
  wbInspectorClose.addEventListener('click', closeWorkbenchOverlays);
  wbOverlayBackdrop.addEventListener('click', closeWorkbenchOverlays);
  wbAddAction.addEventListener('click', () => void addActionFromForm());
  wbActionId.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void addActionFromForm();
  });
  wbActionLabel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void addActionFromForm();
  });
  wbCheckpoint.addEventListener('click', () => void createNamedCheckpoint());
  reviewNote.addEventListener('input', () => {
    if (selectedRevisionId) reviewDrafts.set(selectedRevisionId, reviewNote.value);
  });
  reviewAccept.addEventListener('click', () => void recordSelectedReview('accepted'));
  reviewReject.addEventListener('click', () => void recordSelectedReview('rejected'));
  reviewInvalidate.addEventListener('click', () => void recordSelectedReview('invalidated'));
  window.addEventListener('workbench-external-view', (event) => {
    const detail = (event as CustomEvent<WorkbenchExternalViewDetail>).detail;
    if (!detail?.view || detail.folderName !== selectedFolder) return;
    if (detail.nodeId) selectedNodeId = detail.nodeId;
    if (detail.revisionId) selectedRevisionId = detail.revisionId;
    selectedArtifact = null;
    applyWorkspaceView(detail.view);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeWorkbenchOverlays();
  });
  import.meta.hot?.on('workbench:changed', (message: WorkbenchChangedMessage) => queueWorkbenchRefresh(message));
}

async function boot(): Promise<void> {
  configureTabs();
  bindEvents();
  installReadOnlyNotice();
  dispatchSelection();
  refreshMutationControls();
  try {
    setGlobalStatus(sessionToken ? '工作台已连接 · 人工写能力已启用' : HUMAN_SESSION_READ_ONLY_MESSAGE);
    await refreshCatalog(false);
    const requestedFolder = new URLSearchParams(window.location.search).get('folder');
    const initial = requestedFolder && catalog.some((item) => item.folderName === requestedFolder)
      ? requestedFolder
      : catalog.find((item) => item.workspace && !item.workspace.error)?.folderName || catalog[0]?.folderName;
    if (initial) await selectCatalog(initial);
  } catch (error) {
    const message = String((error as Error).message || error);
    setGlobalStatus(`工作台连接失败：${message}`, true);
    showToast(message, true);
    refreshMutationControls();
  }
}

void boot();
