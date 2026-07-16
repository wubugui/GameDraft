/*
 * Static GitHub Pages transport for the animation workbench.
 *
 * Read side:
 *   existing /api GETs -> immutable/public JSON shards and content-addressed
 *   media in wubugui/FindingDogDist/docs.
 *
 * Write side:
 *   calibration-draft -> this browser's IndexedDB only;
 *   every other POST -> an explicit GitHub Issue command, followed by polling
 *   a processor-authored receipt.  The exact receipt.response is returned to
 *   the existing UI, so the UI never optimistically mutates authoritative
 *   state.
 */

const RAW_DOCS_BASE = 'https://raw.githubusercontent.com/wubugui/FindingDogDist/main/docs/';
const ISSUE_NEW_URL = 'https://github.com/wubugui/FindingDogDist/issues/new';
const ISSUE_MARKER_PREFIX = '<!-- animation-workbench-command:v1:';
const RECEIPT_POLL_INTERVAL_MS = 2_000;
const RECEIPT_TIMEOUT_MS = 15 * 60_000;
const WORKSPACE_SCHEMA_VERSION = 2;
const REMOTE_MUTATION_ENDPOINTS = new Set([
  '/api/workbench/init',
  '/api/workbench/action',
  '/api/workbench/action-spec',
  '/api/workbench/action-enabled',
  '/api/workbench/export-targets',
  '/api/workbench/action-stage-invalidate',
  '/api/workbench/stage-invalidate',
  '/api/workbench/review',
  '/api/workbench/head',
  '/api/workbench/restore-compatible',
  '/api/workbench/checkpoint',
  '/api/workbench/restore-checkpoint',
  '/api/workbench/calibration-commit',
]);

const nativeFetch = window.fetch.bind(window);

interface RemoteMapEntry {
  path?: string;
  sha256?: string;
  size?: number;
  mime?: string;
  name?: string;
}

interface RemoteMapDocument {
  schemaVersion?: number;
  entries?: Record<string, string | RemoteMapEntry>;
}

interface RemoteCommand {
  schemaVersion: 1;
  requestId: string;
  endpoint: string;
  body: Record<string, unknown>;
  expectedGeneration: number | null;
}

interface RemoteReceipt {
  schemaVersion?: number;
  requestId?: string;
  endpoint?: string;
  ok?: boolean;
  status?: number;
  response?: unknown;
}

interface CalibrationDraftRecord {
  schemaVersion: number;
  updatedAt: string;
  inputHeads: Record<string, string>;
  calibration: Record<string, unknown>;
}

const workspaceCache = new Map<string, Record<string, any>>();
let artifactEntries: Record<string, string | RemoteMapEntry> = {};
let rawEntries: Record<string, string | RemoteMapEntry> = {};
let remoteStatus: HTMLElement | null = null;

function jsonResponse(value: unknown, status = 200, statusText = ''): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(message: string, status = 400, code = 'BAD_REQUEST'): Response {
  return jsonResponse({ error: message, code }, status);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function utf8Base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function folderShardName(folder: string): string {
  return utf8Base64Url(folder);
}

function dataUrl(relativePath: string, cacheBust = true): string {
  const url = new URL(relativePath, RAW_DOCS_BASE);
  if (cacheBust) url.searchParams.set('_remote', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return url.href;
}

function contentUrl(relativePath: string): string {
  let normalized = relativePath.trim();
  if (/^https:\/\//i.test(normalized)) return normalized;
  if (normalized.startsWith('/FindingDogDist/')) normalized = normalized.slice('/FindingDogDist/'.length);
  if (normalized.startsWith('/docs/')) normalized = normalized.slice('/docs/'.length);
  if (normalized.startsWith('docs/')) normalized = normalized.slice('docs/'.length);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (!/^media\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\.[A-Za-z0-9._-]+)?$/i.test(normalized)) {
    throw new Error(`远程 CAS 路径非法：${relativePath}`);
  }
  return new URL(normalized, RAW_DOCS_BASE).href;
}

function normalizePublicUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePublicUrls);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && ['url', 'animUrl', 'atlasUrl', 'bgUrl'].includes(key)) {
      try {
        output[key] = contentUrl(child);
      } catch {
        output[key] = child;
      }
    } else {
      output[key] = normalizePublicUrls(child);
    }
  }
  return output;
}

function addRemoteArtifactPlaceholders(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) addRemoteArtifactPlaceholders(child);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, any>;
  if (Array.isArray(record.artifacts)) {
    for (const artifact of record.artifacts) {
      if (!artifact || typeof artifact !== 'object') continue;
      const sha256 = String(artifact.sha256 || '').toLowerCase();
      const artifactPath = String(artifact.path || '');
      if (/^[0-9a-f]{64}$/.test(sha256) && artifactPath) {
        // Existing R code uses absolutePath only as a provenance/source token;
        // bytes still come from the verified artifact API/CAS map.  The Issue
        // processor resolves this non-local token back to the runner's actual
        // immutable revision path before committing a calibration.
        artifact.absolutePath = `remote-cas://${sha256}/${artifactPath}`;
      }
    }
  }
  for (const child of Object.values(record)) addRemoteArtifactPlaceholders(child);
}

function remoteCatalog(value: unknown): unknown {
  const normalized = normalizePublicUrls(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
  const characters = (normalized as Record<string, unknown>).characters;
  if (!Array.isArray(characters)) return normalized;
  for (const character of characters) {
    if (character && typeof character === 'object') {
      (character as Record<string, unknown>).absolutePath = '远程公开快照（本机源目录不公开）';
    }
  }
  return normalized;
}

async function loadJsonDocument(relativePath: string, signal?: AbortSignal): Promise<unknown> {
  const response = await nativeFetch(dataUrl(relativePath), { cache: 'no-store', signal });
  if (!response.ok) {
    throw new Error(`${relativePath} HTTP ${response.status} ${response.statusText}`.trim());
  }
  return await response.json();
}

function mapPath(entry: string | RemoteMapEntry | undefined): string | null {
  if (typeof entry === 'string') return entry;
  return typeof entry?.path === 'string' ? entry.path : null;
}

function artifactMapKey(url: URL): string | null {
  const folder = url.searchParams.get('folder');
  const revision = url.searchParams.get('revision');
  const index = url.searchParams.get('index');
  if (!folder || !revision || !/^\d+$/.test(index || '')) return null;
  return `${folder}\0${revision}\0${index}`;
}

function rawMapKey(url: URL): string | null {
  const folder = url.searchParams.get('folder');
  const name = url.searchParams.get('name');
  if (!folder || !name || /[\\/\0]/.test(name) || name === '.' || name === '..') return null;
  return `${folder}\0${name}`;
}

function mappedApiContentUrl(url: URL): string | null {
  if (url.pathname === '/api/workbench/raw') {
    const key = rawMapKey(url);
    const path = key ? mapPath(rawEntries[key]) : null;
    return path ? contentUrl(path) : null;
  }
  const artifactPrefix = '/api/workbench/artifact';
  if (url.pathname !== artifactPrefix && !url.pathname.startsWith(`${artifactPrefix}/`)) return null;
  const key = artifactMapKey(url);
  const entry = key ? artifactEntries[key] : undefined;
  const path = mapPath(entry);
  if (!path) return null;
  if (typeof entry === 'object' && entry?.name && url.pathname.startsWith(`${artifactPrefix}/`)) {
    const hinted = decodeURIComponent(url.pathname.slice(artifactPrefix.length + 1));
    if (hinted !== entry.name) return null;
  }
  return contentUrl(path);
}

function rewriteSubresourceUrl(raw: string): string {
  try {
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return raw;
    return mappedApiContentUrl(url) || raw;
  } catch {
    return raw;
  }
}

function patchSrcProperty(prototype: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src');
  if (!descriptor?.get || !descriptor.set || descriptor.configurable === false) return;
  Object.defineProperty(prototype, 'src', {
    ...descriptor,
    set(value: string) {
      descriptor.set!.call(this, rewriteSubresourceUrl(String(value)));
    },
  });
}

function installSubresourceRewriter(): void {
  patchSrcProperty(HTMLImageElement.prototype);
  patchSrcProperty(HTMLMediaElement.prototype);
  patchSrcProperty(HTMLSourceElement.prototype);
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setRemoteAttribute(name: string, value: string): void {
    nativeSetAttribute.call(this, name, name.toLowerCase() === 'src' ? rewriteSubresourceUrl(String(value)) : value);
  };
}

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('animation-workbench-remote-v1', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('calibrationDrafts')) {
        request.result.createObjectStore('calibrationDrafts');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
  });
}

async function readCalibrationDraft(folder: string): Promise<CalibrationDraftRecord | null> {
  const database = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('calibrationDrafts', 'readonly');
      const request = transaction.objectStore('calibrationDrafts').get(folder);
      request.onsuccess = () => resolve((request.result as CalibrationDraftRecord | undefined) || null);
      request.onerror = () => reject(request.error || new Error('R 草稿读取失败'));
    });
  } finally {
    database.close();
  }
}

async function writeCalibrationDraft(
  folder: string,
  calibration: Record<string, unknown>,
): Promise<CalibrationDraftRecord> {
  const inputHeads = calibration.inputHeads;
  if (!inputHeads || typeof inputHeads !== 'object' || Array.isArray(inputHeads)) {
    throw new Error('calibration.inputHeads 非法');
  }
  const draft: CalibrationDraftRecord = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    inputHeads: cloneJson(inputHeads as Record<string, string>),
    calibration: cloneJson(calibration),
  };
  const database = await openDraftDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('calibrationDrafts', 'readwrite');
      transaction.objectStore('calibrationDrafts').put(draft, folder);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('R 草稿保存事务中止'));
      transaction.onerror = () => reject(transaction.error || new Error('R 草稿保存失败'));
    });
  } finally {
    database.close();
  }
  return draft;
}

async function workspaceView(folder: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const shard = folderShardName(folder);
  const raw = await loadJsonDocument(`data/workspaces/${shard}.json`, signal);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('远程 workspace shard 不是对象');
  const serverView = raw as Record<string, any>;
  addRemoteArtifactPlaceholders(serverView);
  serverView.paths = {
    characterRoot: `remote-snapshot://${folderShardName(folder)}`,
    workbenchRoot: `remote-snapshot://${folderShardName(folder)}/animation-workbench`,
    agentContextJson: '远程公开快照不暴露 runner 文件路径',
    agentContextMarkdown: '远程公开快照不暴露 runner 文件路径',
  };
  workspaceCache.set(folder, cloneJson(serverView));
  const view = cloneJson(serverView);
  // A build-machine draft is never authoritative for a remote browser.  The
  // browser-private draft either overlays it or makes the field explicitly null.
  try {
    view.calibrationDraft = await readCalibrationDraft(folder);
  } catch (error) {
    view.calibrationDraft = null;
    setRemoteStatus(`公开快照可读；浏览器 R 草稿不可用：${String((error as Error).message || error)}`, true);
  }
  return view;
}

function cacheReturnedWorkspace(folder: string, response: unknown): void {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return;
  const record = response as Record<string, any>;
  const candidate = record.workspace?.generation != null
    ? record
    : record.view?.workspace?.generation != null
      ? record.view
      : null;
  if (candidate) workspaceCache.set(folder, cloneJson(candidate));
}

async function fetchStaticApi(url: URL, signal?: AbortSignal): Promise<Response> {
  if (url.pathname === '/api/workbench/catalog') {
    return jsonResponse(remoteCatalog(await loadJsonDocument('data/catalog.json', signal)));
  }
  if (url.pathname === '/api/workbench/workspace') {
    const folder = url.searchParams.get('folder');
    if (!folder) return errorResponse('缺少 query 参数 folder');
    return jsonResponse(await workspaceView(folder, signal));
  }
  if (url.pathname === '/api/anim/index') {
    return jsonResponse(normalizePublicUrls(await loadJsonDocument('data/anim-index.json', signal)));
  }
  if (url.pathname === '/api/anim/scenes') {
    return jsonResponse(normalizePublicUrls(await loadJsonDocument('data/scenes.json', signal)));
  }
  if (url.pathname === '/api/anim/backgrounds') {
    return jsonResponse(normalizePublicUrls(await loadJsonDocument('data/backgrounds.json', signal)));
  }
  const mapped = mappedApiContentUrl(url);
  if (!mapped) return errorResponse(`远程快照没有映射：${url.pathname}`, 404, 'NOT_FOUND');
  return await nativeFetch(mapped, { cache: 'force-cache', signal });
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  return input instanceof Request ? input.signal : undefined;
}

function parseRequestBody(text: string): Record<string, unknown> {
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('远程写请求 body 必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

async function requestBodyFromRequest(input: Request): Promise<Record<string, unknown>> {
  return parseRequestBody(await input.clone().text());
}

function setRemoteStatus(message: string, error = false): void {
  if (!remoteStatus) return;
  remoteStatus.textContent = message;
  remoteStatus.style.color = error ? '#ff9ba3' : '#8ed9bd';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
    }, { once: true });
  });
}

async function pollReceipt(command: RemoteCommand, signal?: AbortSignal): Promise<Response> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < RECEIPT_TIMEOUT_MS) {
    if (signal?.aborted) throw signal.reason || new DOMException('操作已取消', 'AbortError');
    let response: Response;
    try {
      response = await nativeFetch(dataUrl(`data/receipts/${command.requestId}.json`), {
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      setRemoteStatus(`网络暂不可用，继续等待回执 · ${command.requestId.slice(0, 8)}`, true);
      await sleep(RECEIPT_POLL_INTERVAL_MS, signal);
      continue;
    }
    if (response.ok) {
      const receipt = await response.json() as RemoteReceipt;
      if (
        receipt.schemaVersion !== 1
        || receipt.requestId !== command.requestId
        || receipt.endpoint !== command.endpoint
        || typeof receipt.ok !== 'boolean'
        || !Number.isInteger(receipt.status)
        || Number(receipt.status) < 100
        || Number(receipt.status) > 599
        || !Object.prototype.hasOwnProperty.call(receipt, 'response')
      ) {
        throw new Error('远程回执与当前请求不匹配');
      }
      const status = Number(receipt.status);
      setRemoteStatus(receipt.ok ? `已确认 ${command.requestId.slice(0, 8)}` : `操作被拒绝 ${command.requestId.slice(0, 8)}`, !receipt.ok);
      const folder = typeof command.body.folderName === 'string' ? command.body.folderName : '';
      if (folder && receipt.ok) cacheReturnedWorkspace(folder, receipt.response);
      return jsonResponse(receipt.response, status);
    }
    if (response.status !== 404) {
      setRemoteStatus(`等待回执 · GitHub raw HTTP ${response.status}`, true);
    }
    await sleep(RECEIPT_POLL_INTERVAL_MS, signal);
  }
  setRemoteStatus(`回执超时 ${command.requestId.slice(0, 8)}`, true);
  return errorResponse(
    `等待 GitHub 回执超时；requestId=${command.requestId}。Issue 若稍后处理完成，可刷新页面查看最新快照。`,
    504,
    'RECEIPT_TIMEOUT',
  );
}

function issueUrl(command: RemoteCommand): string {
  const encoded = utf8Base64Url(JSON.stringify(command));
  const marker = `${ISSUE_MARKER_PREFIX}${encoded} -->`;
  const calibration = command.body.calibration;
  const readableBody = cloneJson(command.body);
  if (calibration && typeof calibration === 'object' && !Array.isArray(calibration)) {
    const record = calibration as Record<string, any>;
    readableBody.calibration = {
      schemaVersion: record.schemaVersion,
      inputHeads: record.inputHeads,
      cellSize: record.cellSize,
      targetRoot: record.targetRoot,
      worldSize: record.worldSize,
      actions: record.actions && typeof record.actions === 'object' ? Object.keys(record.actions) : [],
    };
  }
  const readableJson = JSON.stringify({
    requestId: command.requestId,
    endpoint: command.endpoint,
    expectedGeneration: command.expectedGeneration,
    body: readableBody,
  }, null, 2).replace(/</g, '\\u003c').replace(/`/g, '\\u0060');
  const body = [
    '动画资源工作台远程操作请求。',
    '',
    '请确认下面的可读摘要；仓库自动化只解析最后一行命令标记。',
    '',
    '```json',
    readableJson,
    '```',
    '',
    marker,
  ].join('\n');
  const url = new URL(ISSUE_NEW_URL);
  url.searchParams.set('title', `[动画工作台] ${command.endpoint.split('/').pop()} · ${command.requestId.slice(0, 8)}`);
  url.searchParams.set('body', body);
  return url.href;
}

async function currentGeneration(folder: string, endpoint: string, signal?: AbortSignal): Promise<number | null> {
  if (endpoint === '/api/workbench/init') return null;
  let view = workspaceCache.get(folder);
  if (!view) {
    await workspaceView(folder, signal);
    view = workspaceCache.get(folder);
  }
  const generation = view?.workspace?.generation;
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('无法取得当前 workspace generation；请刷新角色后重试');
  }
  return generation;
}

async function dispatchIssueMutation(
  endpoint: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  issueWindow: Window,
): Promise<Response> {
  try {
    const folder = typeof body.folderName === 'string' ? body.folderName : '';
    if (!folder) throw new Error('远程写请求缺少 folderName');
    const command: RemoteCommand = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      endpoint,
      body: cloneJson(body),
      expectedGeneration: await currentGeneration(folder, endpoint, signal),
    };
    issueWindow.location.href = issueUrl(command);
    setRemoteStatus(`等待 Owner 提交 Issue 并确认 · ${command.requestId.slice(0, 8)}`);
    return await pollReceipt(command, signal);
  } catch (error) {
    issueWindow.close();
    const message = String((error as Error).message || error);
    setRemoteStatus(message, true);
    return errorResponse(message);
  }
}

async function interceptPostWithBody(
  url: URL,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (url.pathname === '/api/workbench/calibration-draft') {
    try {
      const folder = typeof body.folderName === 'string' ? body.folderName : '';
      const calibration = body.calibration;
      if (!folder || !calibration || typeof calibration !== 'object' || Array.isArray(calibration)) {
        throw new Error('R 草稿请求缺少 folderName 或 calibration');
      }
      const draft = await writeCalibrationDraft(folder, calibration as Record<string, unknown>);
      const cached = workspaceCache.get(folder);
      if (cached) cached.calibrationDraft = cloneJson(draft);
      setRemoteStatus('R 草稿已保存到当前浏览器（未公开、未提交 Issue）');
      return jsonResponse(draft);
    } catch (error) {
      return errorResponse(String((error as Error).message || error));
    }
  }

  if (!REMOTE_MUTATION_ENDPOINTS.has(url.pathname)) {
    return errorResponse(`远程 transport 不支持 ${url.pathname}`, 404, 'NOT_FOUND');
  }

  const confirmed = window.confirm(
    '这是公开的远程验收页。\n\n本操作不会直接写仓库；接下来会打开 wubugui/FindingDogDist 的 GitHub Issue，只有仓库 Owner 提交并确认后才会生效。\n\n继续创建确认 Issue？',
  );
  if (!confirmed) return errorResponse('已取消远程操作', 400, 'USER_CANCELLED');
  const issueWindow = window.open('about:blank', '_blank');
  if (!issueWindow) {
    return errorResponse('浏览器拦截了 GitHub Issue 窗口；请允许此站点打开新窗口后重试', 400, 'POPUP_BLOCKED');
  }
  issueWindow.opener = null;
  issueWindow.document.title = '正在准备 GitHub Issue…';
  issueWindow.document.body.textContent = '正在准备可审计的动画工作台操作请求…';
  return await dispatchIssueMutation(url.pathname, body, signal, issueWindow);
}

function interceptPost(
  url: URL,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const signal = requestSignal(input, init);
  // Existing workbench POSTs use a JSON string body.  Parse that path without
  // awaiting so confirm()+window.open() still runs in the originating click's
  // user-activation turn and is not spuriously blocked as a popup.
  if (typeof init?.body === 'string') {
    try {
      return interceptPostWithBody(url, parseRequestBody(init.body), signal);
    } catch (error) {
      return Promise.resolve(errorResponse(String((error as Error).message || error)));
    }
  }
  if (input instanceof Request) {
    return requestBodyFromRequest(input)
      .then((body) => interceptPostWithBody(url, body, signal))
      .catch((error) => errorResponse(String((error as Error).message || error)));
  }
  return Promise.resolve(errorResponse('远程写请求缺少 JSON body'));
}

function installFetchTransport(): void {
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL;
    try {
      const raw = input instanceof Request ? input.url : String(input);
      url = new URL(raw, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      return fetchStaticApi(url, requestSignal(input, init)).catch((error) =>
        errorResponse(String((error as Error).message || error), 502, 'REMOTE_READ_FAILED'));
    }
    if (method === 'POST' && url.pathname.startsWith('/api/workbench/')) {
      return interceptPost(url, input, init);
    }
    return Promise.resolve(errorResponse(`远程 transport 不支持 ${method} ${url.pathname}`, 405, 'METHOD_NOT_ALLOWED'));
  };
}

function installRemoteBanner(): void {
  const style = document.createElement('style');
  style.textContent = `
    :root { --remote-banner-height: 36px; }
    body { padding-top: var(--remote-banner-height); }
    .tool-page { height: calc(100vh - var(--top) - var(--remote-banner-height)) !important; }
    #animationWorkbenchRemoteBanner {
      position: fixed; inset: 0 0 auto 0; height: var(--remote-banner-height); z-index: 10000;
      display: flex; align-items: center; gap: 9px; padding: 5px 16px;
      color: #d8e4f5; background: #142033; border-bottom: 1px solid #35557d;
      font: 12px/1.35 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    #animationWorkbenchRemoteBanner strong { color: #f2f6fc; white-space: nowrap; }
    #animationWorkbenchRemoteBanner .remote-detail { color: #aebed3; }
    #animationWorkbenchRemoteStatus { margin-left: auto; white-space: nowrap; }
    @media (max-width: 780px) {
      :root { --remote-banner-height: 52px; }
      #animationWorkbenchRemoteBanner { align-items: flex-start; flex-wrap: wrap; padding: 6px 10px; }
      #animationWorkbenchRemoteStatus { width: 100%; margin-left: 0; }
    }
  `;
  document.head.appendChild(style);
  const banner = document.createElement('div');
  banner.id = 'animationWorkbenchRemoteBanner';
  const badge = document.createElement('strong');
  badge.textContent = '公开验收版';
  const detail = document.createElement('span');
  detail.className = 'remote-detail';
  detail.textContent = '素材快照公开可读；提交修改会打开 GitHub 确认页，确认前不会生效。';
  remoteStatus = document.createElement('span');
  remoteStatus.id = 'animationWorkbenchRemoteStatus';
  remoteStatus.textContent = '正在载入公开快照…';
  banner.append(badge, detail, remoteStatus);
  document.body.prepend(banner);
}

async function preloadRemoteMaps(): Promise<void> {
  const [artifactMap, rawMap, build] = await Promise.all([
    loadJsonDocument('data/artifact-map.json'),
    loadJsonDocument('data/raw-map.json'),
    loadJsonDocument('data/build.json').catch(() => null),
  ]);
  artifactEntries = (artifactMap as RemoteMapDocument)?.entries || {};
  rawEntries = (rawMap as RemoteMapDocument)?.entries || {};
  const buildId = build && typeof build === 'object'
    ? String((build as Record<string, unknown>).buildId || (build as Record<string, unknown>).generatedAt || '')
    : '';
  setRemoteStatus(buildId ? `公开快照 ${buildId}` : '公开快照已连接');
}

async function boot(): Promise<void> {
  installRemoteBanner();
  installFetchTransport();
  try {
    await preloadRemoteMaps();
  } catch (error) {
    setRemoteStatus(`快照索引载入失败：${String((error as Error).message || error)}`, true);
    // Import the application anyway: its ordinary error UI remains useful and
    // no mutation can bypass the missing remote maps/receipts.
  }
  installSubresourceRewriter();
  await import('./main');
  await import('./workbench');
  await import('./assemblyWorkbench');
}

void boot().catch((error) => {
  const message = `远程工作台启动失败：${String((error as Error).message || error)}`;
  setRemoteStatus(message, true);
  console.error(message, error);
});
