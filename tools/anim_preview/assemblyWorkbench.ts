import {
  AssemblyViewport,
  type AssemblyActionInput,
  type AssemblyViewportSnapshot,
  type AssemblyViewMode,
} from './assemblyViewport';
import {
  getHumanSessionToken,
  HUMAN_SESSION_READ_ONLY_MESSAGE,
} from './humanSession';

interface ArtifactView {
  index: number;
  name: string;
  path: string;
  mime: string;
  sha256: string;
  size?: number;
  absolutePath?: string;
}

interface GManifestFrame {
  sequenceIndex: number;
  file: string;
  sha256: string;
  byteSize?: number;
}

interface GManifest {
  schemaVersion: number;
  stage: 'G';
  frameCount: number;
  canvas: { width: number; height: number };
  frames: GManifestFrame[];
}

interface RevisionView {
  id: string;
  nodeId: string;
  parents: Record<string, string | null>;
  artifacts: ArtifactView[];
}

interface NodeView {
  id: string;
  status: string;
  head: string | null;
  revision?: RevisionView;
}

interface ActionView {
  id: string;
  label: string;
  loop?: boolean;
  frameRate?: number;
  enabled?: boolean;
}

interface CalibrationDraftView {
  inputHeads?: Record<string, string | null>;
  calibration?: Calibration;
}

interface WorkspaceSelectionView {
  workspace: {
    folderName: string;
    displayName: string;
    generation: number;
    actions: ActionView[];
  };
  states: NodeView[];
  calibrationDraft?: CalibrationDraftView | null;
}

interface CalibrationCommitResponse {
  revision: RevisionView;
  view: WorkspaceSelectionView;
}

interface WorkbenchSelectionEvent extends CustomEvent {
  detail: {
    folderName: string | null;
    view: WorkspaceSelectionView | null;
    selectionGeneration: number;
    workspaceGeneration: number | null;
  };
}

interface CalibrationAction {
  sourceNodeId: string;
  sourceRevisionId: string;
  sourceManifestArtifactIndex: number;
  sourceManifestSha256: string;
  source: string;
  sourceRoot: { x: number; y: number };
  scale: number;
  frameRate: number;
  loop: boolean;
  visible: boolean;
  opacity: number;
}

interface Calibration {
  schemaVersion: number;
  inputHeads: Record<string, string>;
  cellSize: { width: number; height: number };
  targetRoot: { x: number; y: number };
  worldSize: { width: number; height: number };
  actions: Record<string, CalibrationAction>;
  preview?: {
    mode: AssemblyViewMode;
    transition: { fromActionId: string; toActionId: string; mix: number } | null;
  };
}

interface ActionSource {
  action: ActionView;
  node: NodeView;
  revision: RevisionView;
  manifestArtifact: ArtifactView | null;
  width: number;
  height: number;
  frameArtifacts: ArtifactView[];
}

interface ActionControlRefs {
  card: HTMLElement;
  sourceX: HTMLInputElement;
  sourceY: HTMLInputElement;
  scale: HTMLInputElement;
  scaleNumber: HTMLInputElement;
  visible: HTMLInputElement;
  opacity: HTMLInputElement;
}

const canvas = required<HTMLCanvasElement>('assemblyCanvas');
const actionsRoot = required<HTMLElement>('assemblyActions');
const modeSelect = required<HTMLSelectElement>('assemblyMode');
const playButton = required<HTMLButtonElement>('assemblyPlay');
const playbackRate = required<HTMLInputElement>('assemblyZoom');
const checker = required<HTMLInputElement>('assemblyChecker');
const fitButton = required<HTMLButtonElement>('assemblyFit');
const timeline = required<HTMLInputElement>('assemblyTimeline');
const phaseLabel = required<HTMLElement>('assemblyPhase');
const cellWidth = required<HTMLInputElement>('assemblyCellW');
const cellHeight = required<HTMLInputElement>('assemblyCellH');
const targetX = required<HTMLInputElement>('assemblyTargetX');
const targetY = required<HTMLInputElement>('assemblyTargetY');
const worldWidth = required<HTMLInputElement>('assemblyWorldW');
const worldHeight = required<HTMLInputElement>('assemblyWorldH');
const worldHeightRange = required<HTMLInputElement>('assemblyWorldHRange');
const editStatus = required<HTMLElement>('assemblyEditStatus');
const draftStatus = required<HTMLElement>('assemblyDraftStatus');
const note = required<HTMLTextAreaElement>('assemblyNote');
const saveDraftButton = required<HTMLButtonElement>('assemblySaveDraft');
const commitButton = required<HTMLButtonElement>('assemblyCommit');
const transitionControls = required<HTMLElement>('assemblyTransitionControls');
const transitionFrom = required<HTMLSelectElement>('assemblyTransitionFrom');
const transitionTo = required<HTMLSelectElement>('assemblyTransitionTo');
const transitionMix = required<HTMLInputElement>('assemblyTransitionMix');
const toast = required<HTMLElement>('toast');

let viewport: AssemblyViewport | null = null;
let selectedFolder: string | null = null;
let selectedView: WorkspaceSelectionView | null = null;
let actionSources = new Map<string, ActionSource>();
let actionControls = new Map<string, ActionControlRefs>();
const sessionToken = getHumanSessionToken();
let loadSerial = 0;
let currentInputKey = '';
let initializing = false;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
let draftVersion = 0;
let savedDraftVersion = 0;
let draftWritePromise: Promise<void> | null = null;
let commitInFlight = false;
let explicitDraftNotice = false;
let assemblyReady = false;
let targetRootControlCard: HTMLElement | null = null;
let resumeAssemblyPlayback = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function required<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`R assembly 缺少 DOM #${id}`);
  return value as T;
}

function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.style.borderColor = isError ? 'var(--err)' : 'var(--line)';
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setDraftStatus(message: string, kind: 'idle' | 'saving' | 'saved' | 'error' = 'idle'): void {
  draftStatus.textContent = message;
  draftStatus.classList.remove('saving', 'saved', 'error');
  if (kind !== 'idle') draftStatus.classList.add(kind);
}

function updateEditStatus(snapshot: AssemblyViewportSnapshot | null = viewport?.snapshot || null): void {
  if (!snapshot) {
    editStatus.textContent = '当前：等待动作素材载入';
    return;
  }
  if (snapshot.editHandle.kind === 'targetRoot') {
    editStatus.textContent = '当前正在调整：所有动作共同对准的统一落脚点';
    return;
  }
  if (snapshot.editHandle.kind === 'sourceRoot') {
    const actionId = snapshot.editHandle.actionId;
    const selected = snapshot.actions.find((candidate) => candidate.id === actionId);
    editStatus.textContent = `当前正在调整：${selected?.label || selected?.id || '所选动作'}的脚点`;
    return;
  }
  editStatus.textContent = '当前：只看效果；从左侧选择统一落脚点或某个动作开始调整';
}

function artifactUrl(folder: string, revision: RevisionView, artifact: ArtifactView): string {
  const query = new URLSearchParams({
    folder,
    revision: revision.id,
    index: String(artifact.index),
    v: artifact.sha256.slice(0, 16),
  });
  return `/api/workbench/artifact/${encodeURIComponent(artifact.name)}?${query.toString()}`;
}

function finitePositive(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function currentGHeads(view: WorkspaceSelectionView): Record<string, string> {
  return Object.fromEntries(view.states
    .filter((state) => state.id.startsWith('G/') && state.head)
    .map((state) => [state.id, state.head as string]));
}

function sameHeads(left: Record<string, string | null> | undefined, right: Record<string, string>): boolean {
  if (!left) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function makeInputKey(folder: string, view: WorkspaceSelectionView): string {
  const actions = view.workspace.actions.map((action) => ({
    id: action.id,
    label: action.label,
    loop: action.loop !== false,
    frameRate: action.frameRate || 8,
    enabled: action.enabled !== false,
  }));
  const gStates = view.states
    .filter((state) => state.id.startsWith('G/'))
    .map((state) => ({ id: state.id, status: state.status, head: state.head }));
  return `${folder}|${JSON.stringify({ actions, gStates })}`;
}

async function postHuman<T>(url: string, body: Record<string, unknown>): Promise<T> {
  if (!sessionToken) throw new Error(HUMAN_SESSION_READ_ONLY_MESSAGE);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Animation-Workbench-Token': sessionToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const error = await response.json() as { error?: string };
      message = error.error || message;
    } catch { /* response was not JSON */ }
    throw new Error(message);
  }
  return await response.json() as T;
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
  const manifest = canonicalRelativePath(manifestPath, 'manifest artifact path').split('/');
  manifest.pop();
  return [...manifest, ...canonicalRelativePath(framePath, 'manifest frame.file').split('/')].join('/');
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function verifiedArtifactBytes(
  folder: string,
  revision: RevisionView,
  artifact: ArtifactView,
  label: string,
): Promise<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) throw new Error(`${label} artifact sha256 非法`);
  if (!Number.isInteger(artifact.size) || Number(artifact.size) < 0) throw new Error(`${label} artifact size 非法`);
  const response = await fetch(artifactUrl(folder, revision, artifact), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${label} 读取失败：${response.status} ${response.statusText}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== artifact.size) {
    throw new Error(`${label} 字节数与 revision artifact 不一致`);
  }
  const digest = bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== artifact.sha256.toLowerCase()) throw new Error(`${label} 内容 sha256 与 revision artifact 不一致`);
  return bytes;
}

async function imageSizeFromBytes(bytes: ArrayBuffer, label: string): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`${label} 不是可读取的 PNG`));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseGManifest(value: unknown, label: string): GManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 不是 JSON 对象`);
  const raw = value as Partial<GManifest>;
  if (raw.schemaVersion !== 1) throw new Error(`${label} schemaVersion 必须为 1`);
  if (raw.stage !== 'G') throw new Error(`${label} stage 必须为 G`);
  if (!Number.isInteger(raw.frameCount) || Number(raw.frameCount) < 1) throw new Error(`${label} frameCount 非法`);
  const width = Number(raw.canvas?.width);
  const height = Number(raw.canvas?.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`${label} canvas 必须是正整数尺寸`);
  }
  if (!Array.isArray(raw.frames) || raw.frames.length !== raw.frameCount) {
    throw new Error(`${label} frames 数量与 frameCount 不一致`);
  }
  const seen = new Set<string>();
  const frames = raw.frames.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${label} frame ${index} 非法`);
    if (record.sequenceIndex !== index) throw new Error(`${label} frame ${index} sequenceIndex 必须连续且从 0 开始`);
    const file = canonicalRelativePath(record.file, `${label} frame ${index}.file`);
    if (seen.has(file)) throw new Error(`${label} frame 文件重复：${file}`);
    seen.add(file);
    if (!/^[0-9a-f]{64}$/i.test(record.sha256)) throw new Error(`${label} frame ${index} sha256 非法`);
    if (!Number.isInteger(record.byteSize) || Number(record.byteSize) < 1) throw new Error(`${label} frame ${index} byteSize 非法`);
    return {
      sequenceIndex: index,
      file,
      sha256: record.sha256.toLowerCase(),
      byteSize: Number(record.byteSize),
    };
  });
  return {
    schemaVersion: 1,
    stage: 'G',
    frameCount: Number(raw.frameCount),
    canvas: { width, height },
    frames,
  };
}

async function sourceForAction(
  folder: string,
  view: WorkspaceSelectionView,
  action: ActionView,
): Promise<ActionSource> {
  const node = view.states.find((state) => state.id === `G/${action.id}`);
  if (!node || !node.head || !node.revision || !['accepted', 'published'].includes(node.status)) {
    throw new Error(`${action.label || action.id} 的 G 尚未通过`);
  }
  const revision = node.revision;
  const manifests = revision.artifacts.filter((artifact) => artifact.name === 'manifest.json' && artifact.mime.includes('json'));
  if (manifests.length !== 1) throw new Error(`${node.id} 必须且只能包含一个 manifest.json`);
  const manifestArtifact = manifests[0];
  if (!manifestArtifact.absolutePath) throw new Error(`${node.id} manifest 缺少工作区绝对路径，不能交给 H`);
  const manifestBytes = await verifiedArtifactBytes(folder, revision, manifestArtifact, `${node.id} manifest`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error(`${node.id} manifest.json 不是合法 JSON`);
  }
  const manifest = parseGManifest(parsed, `${node.id} manifest`);
  const artifactsByPath = new Map<string, ArtifactView>();
  for (const artifact of revision.artifacts) {
    const canonical = canonicalRelativePath(artifact.path, `${node.id} artifact.path`);
    if (artifactsByPath.has(canonical)) throw new Error(`${node.id} artifact 路径重复：${canonical}`);
    artifactsByPath.set(canonical, artifact);
  }
  const frameArtifacts: ArtifactView[] = [];
  for (const frame of manifest.frames) {
    const artifactPath = artifactPathForManifestFrame(manifestArtifact.path, frame.file);
    const artifact = artifactsByPath.get(artifactPath);
    if (!artifact || artifact.mime !== 'image/png') {
      throw new Error(`${node.id} manifest frame ${frame.sequenceIndex} 找不到对应 PNG：${frame.file}`);
    }
    if (artifact.sha256.toLowerCase() !== frame.sha256 || artifact.size !== frame.byteSize) {
      throw new Error(`${node.id} manifest frame ${frame.sequenceIndex} 的 hash/byteSize 与 artifact 不一致`);
    }
    const bytes = await verifiedArtifactBytes(folder, revision, artifact, `${node.id} frame ${frame.sequenceIndex}`);
    const size = await imageSizeFromBytes(bytes, `${node.id} frame ${frame.sequenceIndex}`);
    if (size.width !== manifest.canvas.width || size.height !== manifest.canvas.height) {
      throw new Error(`${node.id} frame ${frame.sequenceIndex} 尺寸 ${size.width}×${size.height} 与 manifest canvas 不一致`);
    }
    frameArtifacts.push(artifact);
  }
  return {
    action,
    node,
    revision,
    manifestArtifact,
    width: manifest.canvas.width,
    height: manifest.canvas.height,
    frameArtifacts,
  };
}

function draftCalibration(view: WorkspaceSelectionView): Calibration | null {
  const draft = view.calibrationDraft;
  const heads = currentGHeads(view);
  if (!draft?.calibration || !sameHeads(draft.inputHeads, heads)) return null;
  return draft.calibration;
}

async function handleSelection(event: Event): Promise<void> {
  const detail = (event as WorkbenchSelectionEvent).detail;
  selectedFolder = detail.folderName;
  selectedView = detail.view;
  if (!detail.folderName || !detail.view) {
    loadSerial += 1;
    currentInputKey = '';
    clearViewport('请先选择已建立的角色工作区');
    return;
  }
  const key = makeInputKey(detail.folderName, detail.view);
  if (key === currentInputKey && viewport) {
    viewport.resize();
    return;
  }
  const serial = ++loadSerial;
  currentInputKey = key;
  await loadWorkspaceAssembly(detail.folderName, detail.view, serial);
}

async function loadWorkspaceAssembly(folder: string, view: WorkspaceSelectionView, serial: number): Promise<void> {
  initializing = true;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = null;
  savedDraftVersion = draftVersion;
  explicitDraftNotice = false;
  clearViewport('正在读取所有已通过 G 动作…');
  editStatus.textContent = '正在载入已通过的动作帧，请稍候…';
  setDraftStatus('正在检查上次草稿与当前 G 版本是否匹配');
  const enabledActions = view.workspace.actions.filter((action) => action.enabled !== false);
  if (!enabledActions.length) {
    clearViewport('尚无动作分支');
    initializing = false;
    return;
  }
  const gReadiness = enabledActions.map((action) => ({
    action,
    node: view.states.find((state) => state.id === `G/${action.id}`) || null,
  }));
  const blocked = gReadiness.filter(({ node }) => !node?.head || !node.revision || !['accepted', 'published'].includes(node.status));
  if (blocked.length) {
    renderGReadiness(gReadiness);
    editStatus.textContent = `还不能开始：${blocked.length} 个动作尚未完成精确抠图并通过审查`;
    setDraftStatus('所有启用动作的 G 阶段通过后，才会开放对齐与缩放', 'error');
    initializing = false;
    return;
  }
  try {
    const sources = await Promise.all(enabledActions.map((action) => sourceForAction(folder, view, action)));
    if (serial !== loadSerial || folder !== selectedFolder) return;
    actionSources = new Map(sources.map((source) => [source.action.id, source]));
    const saved = draftCalibration(view);
    const defaultWidth = Math.max(...sources.map((source) => source.width));
    const defaultHeight = Math.max(...sources.map((source) => source.height));
    const stageSize = saved?.cellSize || { width: defaultWidth, height: defaultHeight };
    const targetRoot = saved?.targetRoot || { x: stageSize.width / 2, y: stageSize.height };
    const savedWorldHeight = saved?.worldSize?.height || 1;
    const worldSize = {
      width: saved?.worldSize?.width || savedWorldHeight * stageSize.width / stageSize.height,
      height: savedWorldHeight,
    };
    const inputs: AssemblyActionInput[] = sources.map((source, index) => {
      const previous = saved?.actions?.[source.action.id];
      return {
        id: source.action.id,
        label: source.action.label || source.action.id,
        frames: source.frameArtifacts.map((artifact) => artifactUrl(folder, source.revision, artifact)),
        sourceRoot: previous?.sourceRoot || { x: source.width / 2, y: source.height },
        scale: previous?.scale || 1,
        visible: previous?.visible ?? true,
        opacity: previous?.opacity ?? (index === 0 ? 1 : 0.58),
        tint: ['#58a6ff', '#f97316', '#34d399', '#e879f9', '#facc15'][index % 5],
        tintStrength: sources.length > 1 ? 0.13 : 0,
      };
    });
    applyGlobalFields(stageSize, targetRoot, worldSize);
    populateTransitions(inputs.map((input) => ({ id: input.id, label: input.label || input.id })));
    const savedMode = saved?.preview?.mode || 'overlay';
    modeSelect.value = savedMode;
    const savedTransition = saved?.preview?.transition || defaultTransition(inputs);
    applyTransitionFields(savedTransition);
    const assemblyVisible = isAssemblyPageActive();
    const nextViewport = await AssemblyViewport.create({
      canvas,
      stageSize,
      targetRoot,
      worldSize,
      actions: inputs,
      mode: savedMode,
      transition: savedTransition || undefined,
      durationSeconds: Math.max(...sources.map((source) => source.frameArtifacts.length / Math.max(1, source.action.frameRate || 8))),
      playbackRate: finitePositive(playbackRate, 1),
      autoplay: assemblyVisible,
      editHandle: sessionToken ? { kind: 'targetRoot' } : { kind: 'none' },
      checkerEnabled: checker.checked,
      onChange: ({ reason, snapshot }) => onViewportChange(reason, snapshot),
      onLoadError: (error) => showToast(`${error.actionId} 第 ${error.frameIndex + 1} 帧加载失败`, true),
    });
    if (serial !== loadSerial || folder !== selectedFolder) {
      nextViewport.destroy(); return;
    }
    viewport?.destroy();
    viewport = nextViewport;
    const visibleNow = isAssemblyPageActive();
    if (!visibleNow && viewport.snapshot.playing) viewport.pause();
    else if (visibleNow && !viewport.snapshot.playing && !assemblyVisible) viewport.play();
    renderActionControls(viewport.snapshot);
    transitionControls.style.display = savedMode === 'transition' ? '' : 'none';
    targetRootControlCard = buildTargetRootEditor();
    actionsRoot.prepend(targetRootControlCard);
    const loadReport = viewport.loadReport;
    assemblyReady = loadReport.failed.length === 0;
    if (!assemblyReady) actionsRoot.prepend(buildLoadFailureCard(loadReport.failed));
    resumeAssemblyPlayback = !visibleNow && assemblyReady;
    updateTransport(viewport.snapshot);
    updateEditStatus(viewport.snapshot);
    setDraftStatus(saved ? '已载入与当前动作匹配的草稿' : '草稿会在每次调整后自动保存', saved ? 'saved' : 'idle');
    updateAssemblyMutationControls();
  } catch (error) {
    clearViewport(String((error as Error).message || error));
    setDraftStatus('动作素材尚未就绪，暂时无法保存', 'error');
  } finally {
    initializing = false;
  }
}

function renderGReadiness(entries: Array<{ action: ActionView; node: NodeView | null }>): void {
  const fragment = document.createDocumentFragment();
  const summary = document.createElement('div');
  summary.className = 'card';
  const ready = entries.filter(({ node }) => Boolean(node?.head && node.revision && ['accepted', 'published'].includes(node.status))).length;
  const title = document.createElement('b');
  title.textContent = `动作准备度 ${ready}/${entries.length}`;
  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.textContent = '这里不会自动推进 Agent；回到流程页查看未完成动作。';
  summary.append(title, detail);
  fragment.append(summary);
  for (const { action, node } of entries) {
    const isReady = Boolean(node?.head && node.revision && ['accepted', 'published'].includes(node.status));
    const card = document.createElement('div');
    card.className = 'action-cal';
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('b');
    name.textContent = action.label || action.id;
    const status = document.createElement('span');
    status.className = `pill ${isReady ? 'accepted' : node?.status === 'under_review' ? 'under_review' : 'blocked'}`;
    status.textContent = isReady
      ? 'G 已通过'
      : node?.status === 'under_review'
        ? 'G 等待你审查'
        : node?.status === 'runnable'
          ? 'G 等待 Agent'
          : 'G 上游未完成';
    row.append(name, status);
    card.append(row);
    fragment.append(card);
  }
  actionsRoot.replaceChildren(fragment);
}

function clearViewport(message: string): void {
  viewport?.destroy();
  viewport = null;
  assemblyReady = false;
  targetRootControlCard = null;
  resumeAssemblyPlayback = false;
  actionSources.clear();
  actionControls.clear();
  const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = message;
  actionsRoot.replaceChildren(empty);
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
  updateEditStatus(null);
  updateAssemblyMutationControls();
}

function buildLoadFailureCard(failures: Array<{ actionId: string; frameIndex: number; message: string }>): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card assembly-load-errors';
  const title = document.createElement('b');
  title.textContent = `帧加载失败 · ${failures.length}`;
  const explanation = document.createElement('div');
  explanation.className = 'muted';
  explanation.textContent = 'R 审查不完整，保存与提交已锁定。修复文件后重新载入工作区。';
  const list = document.createElement('ul');
  for (const failure of failures) {
    const item = document.createElement('li');
    item.textContent = `${failure.actionId} #${failure.frameIndex + 1}：${failure.message}`;
    list.append(item);
  }
  card.append(title, explanation, list);
  return card;
}

function isAssemblyPageActive(): boolean {
  return document.getElementById('assemblyPage')?.classList.contains('active') === true;
}

function updateAssemblyMutationControls(): void {
  const busy = Boolean(draftWritePromise) || commitInFlight;
  saveDraftButton.disabled = !sessionToken || !viewport || !assemblyReady || busy;
  commitButton.disabled = !sessionToken || !viewport || !assemblyReady || busy;
  applyAssemblyCapabilityState();
}

function applyAssemblyCapabilityState(): void {
  if (sessionToken) return;
  const mutationControls: Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement> = [
    modeSelect,
    transitionFrom,
    transitionTo,
    transitionMix,
    cellWidth,
    cellHeight,
    targetX,
    targetY,
    worldWidth,
    worldHeight,
    worldHeightRange,
    note,
    saveDraftButton,
    commitButton,
  ];
  for (const control of mutationControls) {
    control.disabled = true;
    control.title = HUMAN_SESSION_READ_ONLY_MESSAGE;
  }
  viewport?.setEditHandle({ kind: 'none' });
}

function applyGlobalFields(
  stage: { width: number; height: number },
  target: { x: number; y: number },
  world: { width: number; height: number },
): void {
  cellWidth.value = String(Math.round(stage.width));
  cellHeight.value = String(Math.round(stage.height));
  targetX.value = target.x.toFixed(2);
  targetY.value = target.y.toFixed(2);
  worldWidth.value = world.width.toFixed(4);
  worldHeight.value = world.height.toFixed(4);
  if (world.height > Number(worldHeightRange.max)) worldHeightRange.max = String(Math.ceil(world.height * 1.25));
  worldHeightRange.value = String(world.height);
}

function defaultTransition(inputs: AssemblyActionInput[]): { fromActionId: string; toActionId: string; mix: number } | null {
  return inputs.length >= 2 ? { fromActionId: inputs[0].id, toActionId: inputs[1].id, mix: 0.5 } : null;
}

function populateTransitions(actions: Array<{ id: string; label: string }>): void {
  const options = actions.map((action) => {
    const option = document.createElement('option'); option.value = action.id; option.textContent = action.label; return option;
  });
  transitionFrom.replaceChildren(...options.map((option) => option.cloneNode(true)));
  transitionTo.replaceChildren(...options);
}

function applyTransitionFields(transition: { fromActionId: string; toActionId: string; mix: number } | null): void {
  if (!transition) return;
  transitionFrom.value = transition.fromActionId;
  transitionTo.value = transition.toActionId;
  transitionMix.value = String(transition.mix);
}

function buildTargetRootEditor(): HTMLElement {
  const card = document.createElement('div'); card.className = 'action-cal selected';
  const row = document.createElement('div'); row.className = 'row';
  const dot = document.createElement('span'); dot.className = 'action-color'; dot.style.background = '#ffdf6e';
  const copy = document.createElement('div'); copy.className = 'action-title';
  const title = document.createElement('b'); title.textContent = '统一落脚点';
  const help = document.createElement('div'); help.className = 'muted'; help.textContent = '所有动作最终都对准这里';
  copy.append(title, help);
  const button = document.createElement('button'); button.className = 't good'; button.textContent = '拖动落脚点';
  button.disabled = !sessionToken;
  if (!sessionToken) button.title = HUMAN_SESSION_READ_ONLY_MESSAGE;
  button.addEventListener('click', () => {
    viewport?.setEditHandle({ kind: 'targetRoot' });
    for (const refs of actionControls.values()) refs.card.classList.remove('selected');
    card.classList.add('selected');
    updateEditStatus();
  });
  row.append(dot, copy, button); card.append(row);
  return card;
}

function renderActionControls(snapshot: AssemblyViewportSnapshot): void {
  actionControls.clear();
  const fragment = document.createDocumentFragment();
  for (const action of snapshot.actions) {
    const card = document.createElement('div'); card.className = 'action-cal';
    const header = document.createElement('div'); header.className = 'row';
    const dot = document.createElement('span'); dot.className = 'action-color'; dot.style.background = action.tint || '#58a6ff';
    const titleWrap = document.createElement('div'); titleWrap.className = 'action-title';
    const title = document.createElement('b'); title.textContent = action.label;
    const subtitle = document.createElement('div'); subtitle.className = 'muted'; subtitle.textContent = `${action.frameCount} 帧 · ${action.id}`;
    titleWrap.append(title, subtitle);
    const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = action.visible;
    const visibleLabel = document.createElement('label'); visibleLabel.className = 'ctl'; visibleLabel.append(visible, document.createTextNode('显示'));
    const solo = document.createElement('button'); solo.className = 't'; solo.textContent = '只看它';
    solo.type = 'button';
    solo.addEventListener('click', () => toggleSoloAction(action.id));
    const edit = document.createElement('button'); edit.className = 't'; edit.textContent = '调整脚点';
    edit.disabled = !sessionToken;
    if (!sessionToken) edit.title = HUMAN_SESSION_READ_ONLY_MESSAGE;
    edit.addEventListener('click', () => {
      viewport?.setEditHandle({ kind: 'sourceRoot', actionId: action.id });
      for (const refs of actionControls.values()) refs.card.classList.remove('selected');
      targetRootControlCard?.classList.remove('selected');
      card.classList.add('selected');
      updateEditStatus();
    });
    header.append(dot, titleWrap, visibleLabel, solo, edit);

    const sourceX = numberInput(action.sourceRoot.x, 0.1);
    const sourceY = numberInput(action.sourceRoot.y, 0.1);
    const scale = document.createElement('input'); scale.type = 'range'; scale.min = '0.05'; scale.max = '4'; scale.step = '0.01'; scale.value = String(action.scale);
    const scaleNumber = numberInput(action.scale, 0.01); scaleNumber.min = '0.01';
    const scaleRow = document.createElement('label'); scaleRow.className = 'action-scale-control';
    scaleRow.append(document.createElement('span'), scale, scaleNumber);
    (scaleRow.firstElementChild as HTMLElement).textContent = '动作视觉大小';

    const opacity = document.createElement('input'); opacity.type = 'range'; opacity.min = '0'; opacity.max = '1'; opacity.step = '0.01'; opacity.value = String(action.opacity);
    const precision = document.createElement('details'); precision.className = 'action-precision';
    const precisionSummary = document.createElement('summary'); precisionSummary.textContent = '精确脚点与对比透明度';
    const roots = document.createElement('div'); roots.className = 'row';
    roots.append(labelWith('脚点 X', sourceX), labelWith('Y', sourceY));
    const opacityRow = document.createElement('div'); opacityRow.className = 'row'; opacityRow.append(labelWith('叠加透明度', opacity));
    precision.append(precisionSummary, roots, opacityRow);
    card.append(header, scaleRow, precision);
    const refs = { card, sourceX, sourceY, scale, scaleNumber, visible, opacity };
    if (!sessionToken) {
      for (const control of [sourceX, sourceY, scale, scaleNumber, visible, opacity]) {
        control.disabled = true;
        control.title = HUMAN_SESSION_READ_ONLY_MESSAGE;
      }
    }
    actionControls.set(action.id, refs);
    sourceX.addEventListener('input', () => updateSourceRoot(action.id, refs));
    sourceY.addEventListener('input', () => updateSourceRoot(action.id, refs));
    scale.addEventListener('input', () => updateScale(action.id, refs, scale.value));
    scaleNumber.addEventListener('input', () => updateScale(action.id, refs, scaleNumber.value));
    visible.addEventListener('change', () => viewport?.setActionPreview(action.id, { visible: visible.checked }));
    opacity.addEventListener('input', () => viewport?.setActionPreview(action.id, { opacity: Number(opacity.value) }));
    fragment.append(card);
  }
  actionsRoot.replaceChildren(fragment);
}

function toggleSoloAction(actionId: string): void {
  if (!viewport) return;
  const actions = viewport.snapshot.actions;
  const alreadySolo = actions.every((action) => action.visible === (action.id === actionId));
  for (const action of actions) {
    const visible = alreadySolo || action.id === actionId;
    viewport.setActionPreview(action.id, { visible });
    const refs = actionControls.get(action.id);
    if (refs) refs.visible.checked = visible;
  }
}

function numberInput(value: number, step: number): HTMLInputElement {
  const input = document.createElement('input'); input.type = 'number'; input.className = 't'; input.step = String(step); input.value = value.toFixed(2); return input;
}

function labelWith(text: string, input: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label'); label.className = 'ctl'; label.append(document.createTextNode(text), input); return label;
}

function updateSourceRoot(actionId: string, refs: ActionControlRefs): void {
  viewport?.setActionTransform(actionId, {
    sourceRoot: { x: finite(refs.sourceX, 0), y: finite(refs.sourceY, 0) },
  });
}

function updateScale(actionId: string, refs: ActionControlRefs, raw: string): void {
  const value = Math.max(0.01, Number(raw) || 1);
  refs.scale.value = String(value);
  refs.scaleNumber.value = value.toFixed(2);
  viewport?.setActionTransform(actionId, { scale: value });
}

function onViewportChange(reason: string, snapshot: AssemblyViewportSnapshot): void {
  updateTransport(snapshot);
  if (reason === 'target-root' || reason === 'stage-size') {
    targetX.value = snapshot.targetRoot.x.toFixed(2);
    targetY.value = snapshot.targetRoot.y.toFixed(2);
  }
  for (const action of snapshot.actions) {
    const refs = actionControls.get(action.id);
    if (!refs) continue;
    refs.sourceX.value = action.sourceRoot.x.toFixed(2);
    refs.sourceY.value = action.sourceRoot.y.toFixed(2);
    refs.scale.value = String(action.scale);
    refs.scaleNumber.value = action.scale.toFixed(2);
    refs.visible.checked = action.visible;
    refs.opacity.value = String(action.opacity);
  }
  if (!initializing && [
    'target-root',
    'source-root',
    'action-scale',
    'world-size',
    'stage-size',
    'mode',
    'transition',
    'preview',
  ].includes(reason)) {
    queueDraftSave();
  }
}

function updateTransport(snapshot: AssemblyViewportSnapshot): void {
  timeline.value = String(snapshot.phase);
  phaseLabel.textContent = snapshot.phase.toFixed(3);
  playButton.textContent = snapshot.playing ? '⏸ 暂停' : '▶ 播放';
  playButton.classList.toggle('on', snapshot.playing);
  updateEditStatus(snapshot);
}

function applyMode(): void {
  if (!viewport) return;
  const mode = modeSelect.value as AssemblyViewMode;
  if (mode === 'transition' && actionSources.size < 2) {
    modeSelect.value = 'overlay';
    showToast('至少两个动作才能查看切换', true);
    return;
  }
  viewport.setMode(mode);
  transitionControls.style.display = mode === 'transition' ? '' : 'none';
  if (mode === 'transition') applyTransition();
}

function applyTransition(): void {
  if (!viewport || transitionFrom.value === transitionTo.value) {
    if (transitionFrom.value === transitionTo.value) showToast('切换前后动作不能相同', true);
    return;
  }
  viewport.setTransition({
    fromActionId: transitionFrom.value,
    toActionId: transitionTo.value,
    mix: Number(transitionMix.value),
  });
}

function applyStageSize(): void {
  if (!viewport) return;
  const width = Math.round(finitePositive(cellWidth, viewport.snapshot.stageSize.width));
  const height = Math.round(finitePositive(cellHeight, viewport.snapshot.stageSize.height));
  cellWidth.value = String(width); cellHeight.value = String(height);
  viewport.setStageSize({ width, height });
  linkWorldFromHeight();
}

function applyTargetRoot(): void {
  if (!viewport) return;
  const stage = viewport.snapshot.stageSize;
  const x = Math.min(stage.width, Math.max(0, finite(targetX, viewport.snapshot.targetRoot.x)));
  const y = Math.min(stage.height, Math.max(0, finite(targetY, viewport.snapshot.targetRoot.y)));
  targetX.value = x.toFixed(2); targetY.value = y.toFixed(2);
  viewport.setTargetRoot({ x, y });
}

function linkWorldFromHeight(): void {
  if (!viewport) return;
  const height = finitePositive(worldHeight, viewport.snapshot.worldSize.height);
  const stage = viewport.snapshot.stageSize;
  const width = height * stage.width / stage.height;
  worldHeight.value = height.toFixed(4); worldWidth.value = width.toFixed(4);
  if (height > Number(worldHeightRange.max)) worldHeightRange.max = String(Math.ceil(height * 1.25));
  worldHeightRange.value = String(height);
  viewport.setWorldSize({ width, height });
}

function linkWorldFromWidth(): void {
  if (!viewport) return;
  const width = finitePositive(worldWidth, viewport.snapshot.worldSize.width);
  const stage = viewport.snapshot.stageSize;
  const height = width * stage.height / stage.width;
  worldWidth.value = width.toFixed(4); worldHeight.value = height.toFixed(4);
  if (height > Number(worldHeightRange.max)) worldHeightRange.max = String(Math.ceil(height * 1.25));
  worldHeightRange.value = String(height);
  viewport.setWorldSize({ width, height });
}

function buildCalibration(): Calibration {
  if (!viewport || !selectedView || !assemblyReady) throw new Error('R 装配尚未完整通过载入校验');
  const snapshot = viewport.snapshot;
  const actions: Record<string, CalibrationAction> = {};
  for (const action of snapshot.actions) {
    const source = actionSources.get(action.id);
    if (!source) throw new Error(`缺少 ${action.id} 的 G 来源`);
    const manifestArtifact = source.manifestArtifact;
    const absoluteManifest = manifestArtifact?.absolutePath;
    if (!manifestArtifact || !absoluteManifest) throw new Error(`${action.id} 缺少合法 G manifest`);
    actions[action.id] = {
      sourceNodeId: source.node.id,
      sourceRevisionId: source.revision.id,
      sourceManifestArtifactIndex: manifestArtifact.index,
      sourceManifestSha256: manifestArtifact.sha256,
      source: absoluteManifest.replace(/[/\\]manifest\.json$/, ''),
      sourceRoot: { ...action.sourceRoot },
      scale: action.scale,
      frameRate: Math.max(1, source.action.frameRate || 8),
      loop: source.action.loop !== false,
      visible: action.visible,
      opacity: action.opacity,
    };
  }
  return {
    schemaVersion: 1,
    inputHeads: currentGHeads(selectedView),
    cellSize: { ...snapshot.stageSize },
    targetRoot: { ...snapshot.targetRoot },
    worldSize: { ...snapshot.worldSize },
    actions,
    preview: { mode: snapshot.mode, transition: snapshot.transition },
  };
}

function queueDraftSave(): void {
  if (!sessionToken || !assemblyReady) return;
  draftVersion += 1;
  setDraftStatus('有新调整，稍后自动保存…', 'saving');
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void drainDraftSave(), 700);
}

function saveDraftExplicitly(): void {
  if (!selectedFolder || !viewport || !assemblyReady) {
    showToast('R 装配尚未完整通过载入校验', true);
    return;
  }
  explicitDraftNotice = true;
  draftVersion += 1;
  setDraftStatus('正在保存草稿…', 'saving');
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void drainDraftSave(), 0);
  if (draftWritePromise || commitInFlight) showToast('草稿保存已排队，将在当前写入结束后执行');
}

function schedulePendingDraft(): void {
  if (draftVersion <= savedDraftVersion || commitInFlight || !assemblyReady) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void drainDraftSave(), 0);
}

async function drainDraftSave(): Promise<void> {
  draftTimer = null;
  if (draftWritePromise || commitInFlight || !selectedFolder || !viewport || !assemblyReady) return;
  if (draftVersion <= savedDraftVersion) return;
  const version = draftVersion;
  const folder = selectedFolder;
  const serial = loadSerial;
  const notify = explicitDraftNotice;
  explicitDraftNotice = false;
  let calibration: Calibration;
  try {
    calibration = buildCalibration();
  } catch (error) {
    showToast(`草稿保存失败：${String((error as Error).message || error)}`, true);
    setDraftStatus('草稿保存失败，请检查当前装配状态', 'error');
    return;
  }
  setDraftStatus('正在保存草稿…', 'saving');
  const operation = (async () => {
    try {
      await postHuman('/api/workbench/calibration-draft', { folderName: folder, calibration });
      if (serial === loadSerial && folder === selectedFolder) {
        savedDraftVersion = Math.max(savedDraftVersion, version);
        setDraftStatus(`草稿已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, 'saved');
        if (notify) showToast('R 草稿已保存；未创建正式 revision');
      }
    } catch (error) {
      showToast(`草稿保存失败：${String((error as Error).message || error)}`, true);
      setDraftStatus('草稿保存失败；本次调整仍保留在当前页面', 'error');
    }
  })();
  draftWritePromise = operation;
  updateAssemblyMutationControls();
  await operation;
  if (draftWritePromise === operation) draftWritePromise = null;
  updateAssemblyMutationControls();
  if (serial === loadSerial && folder === selectedFolder) schedulePendingDraft();
}

async function commitCalibration(): Promise<void> {
  if (!selectedFolder || !viewport || !assemblyReady) {
    showToast('R 装配尚未完整通过载入校验，不能提交', true);
    return;
  }
  if (commitInFlight) {
    showToast('R 提交正在进行，请等待');
    return;
  }
  if (!window.confirm('提交当前人工装配为 R 候选？它仍需在“资源流程”中人工通过后才会成为生效 head。')) return;
  const folder = selectedFolder;
  const serial = loadSerial;
  commitInFlight = true;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = null;
  updateAssemblyMutationControls();
  try {
    if (draftWritePromise) {
      showToast('正在等待已排队的草稿写入完成…');
      await draftWritePromise;
    }
    if (serial !== loadSerial || folder !== selectedFolder || !viewport || !assemblyReady) {
      showToast('工作区已切换，本次 R 提交已取消', true);
      return;
    }
    const version = draftVersion;
    const calibration = buildCalibration();
    const response = await postHuman<CalibrationCommitResponse>('/api/workbench/calibration-commit', {
      folderName: folder,
      calibration,
      note: note.value.trim(),
    });
    savedDraftVersion = Math.max(savedDraftVersion, version);
    explicitDraftNotice = false;
    setDraftStatus('候选已提交，正在打开审查页…', 'saved');
    window.dispatchEvent(new CustomEvent('workbench-external-view', {
      detail: {
        folderName: folder,
        view: response.view,
        nodeId: 'R',
        revisionId: response.revision.id,
      },
    }));
    document.querySelector<HTMLButtonElement>('.top-tab[data-page="workbenchPage"]')?.click();
    showToast('对齐与缩放候选已提交；请在审查页做最终判断');
  } catch (error) {
    showToast(`R 提交失败：${String((error as Error).message || error)}`, true);
    setDraftStatus('候选提交失败；草稿仍保留', 'error');
  } finally {
    commitInFlight = false;
    updateAssemblyMutationControls();
    if (serial === loadSerial && folder === selectedFolder) schedulePendingDraft();
  }
}

function bind(): void {
  window.addEventListener('workbench-selection', (event) => void handleSelection(event));
  window.addEventListener('workbench-page-change', (event) => {
    const pageId = (event as CustomEvent<{ pageId: string }>).detail?.pageId;
    if (pageId === 'assemblyPage') {
      viewport?.resize();
      if (resumeAssemblyPlayback && viewport && assemblyReady) {
        resumeAssemblyPlayback = false;
        viewport.play();
      }
    } else if (viewport?.snapshot.playing) {
      resumeAssemblyPlayback = true;
      viewport.pause();
    }
  });
  modeSelect.addEventListener('change', applyMode);
  playButton.addEventListener('click', () => viewport?.togglePlayback());
  playbackRate.addEventListener('input', () => viewport?.setPlaybackRate(finitePositive(playbackRate, 1)));
  checker.addEventListener('change', () => viewport?.setCheckerEnabled(checker.checked));
  fitButton.addEventListener('click', () => viewport?.resize());
  timeline.addEventListener('input', () => { viewport?.pause(); viewport?.scrub(Number(timeline.value)); });
  transitionFrom.addEventListener('change', applyTransition);
  transitionTo.addEventListener('change', applyTransition);
  transitionMix.addEventListener('input', applyTransition);
  cellWidth.addEventListener('change', applyStageSize);
  cellHeight.addEventListener('change', applyStageSize);
  targetX.addEventListener('change', applyTargetRoot);
  targetY.addEventListener('change', applyTargetRoot);
  worldWidth.addEventListener('change', linkWorldFromWidth);
  worldHeight.addEventListener('change', linkWorldFromHeight);
  worldHeightRange.addEventListener('input', () => {
    worldHeight.value = worldHeightRange.value;
    linkWorldFromHeight();
  });
  saveDraftButton.addEventListener('click', saveDraftExplicitly);
  commitButton.addEventListener('click', () => void commitCalibration());
  window.addEventListener('beforeunload', () => viewport?.destroy(), { once: true });
  applyAssemblyCapabilityState();
}

bind();
