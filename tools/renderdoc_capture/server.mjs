// RenderDoc capture controller. The Vite middleware and agent CLI share this instance.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_BURST_FRAMES = 120;
const CAPTURE_QUERY_KEY = 'renderdocSession';

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(parent, target) {
  const rel = relative(parent.toLowerCase(), target.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalFuturePath(path) {
  const missing = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const next = dirname(current);
    if (next === current) break;
    missing.unshift(current.slice(next.length).replace(/^[/\\]/, ''));
    current = next;
  }
  const physical = await realpath(current);
  return resolve(physical, ...missing);
}

function worktreePaths(projectRoot) {
  const roots = [projectRoot];
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) roots.push(line.slice(9));
    }
  } catch { /* The root itself is still checked. */ }
  return [...new Set(roots.map(path => resolve(path)))];
}

function outputRoot() {
  const configured = process.env.GAMEDRAFT_RENDERDOC_CAPTURE_DIR;
  if (configured) return resolve(configured);
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'GameDraft', 'renderdoc-captures');
}

async function safeOutputRoot(projectRoot) {
  const base = await canonicalFuturePath(outputRoot());
  for (const root of worktreePaths(projectRoot)) {
    const canonical = await canonicalFuturePath(root);
    if (isWithin(canonical, base) || isWithin(base, canonical)) {
      throw new Error('RenderDoc output directory must be outside every GameDraft worktree');
    }
  }
  await mkdir(base, { recursive: true });
  const actual = await realpath(base);
  for (const root of worktreePaths(projectRoot)) {
    if (isWithin(await canonicalFuturePath(root), actual)) {
      throw new Error('RenderDoc output directory resolves inside a GameDraft worktree');
    }
  }
  return actual;
}

function renderDocDirectory() {
  const candidates = [
    process.env.GAMEDRAFT_RENDERDOC_DIR,
    join(process.env.LOCALAPPDATA || '', 'GameDraft', 'RenderDoc', '1.46', 'portable', 'RenderDoc_1.46_64'),
  ].filter(Boolean);
  return candidates.find(dir => existsSync(join(dir, 'renderdoccmd.exe')) && existsSync(join(dir, 'qrenderdoc.exe'))) || null;
}

function renderDocVersion(dir) {
  const line = execFileSync(join(dir, 'renderdoccmd.exe'), ['version'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  const match = /\bv(\d+)\.(\d+)\b/.exec(line);
  if (!match) throw new Error('could not read RenderDoc version');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 1 || (major === 1 && minor < 46)) throw new Error(`RenderDoc ${major}.${minor} is too old; v1.46 or newer is required`);
  return `${major}.${minor}`;
}

function browserExecutable() {
  const candidates = [
    process.env.GAMEDRAFT_RENDERDOC_BROWSER,
    join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find(exe => existsSync(exe)) || null;
}

function publicStatus(session, reason = '') {
  if (!session) {
    return {
      captureReady: false, state: 'idle', reason: reason || '请先准备 RenderDoc 专用游戏窗口',
      completedFrames: 0, requestedFrames: 0, outputDir: null, error: null,
      captureSessionId: null, targetBootId: null,
    };
  }
  return {
    captureReady: Boolean(session.captureReady), state: session.state,
    reason: session.reason || '', error: session.error || null,
    completedFrames: session.completedFrames || 0,
    requestedFrames: session.requestedFrames || 0,
    outputDir: session.outputDir || null,
    captureSessionId: session.id, targetBootId: session.bootId || null,
    renderDocVersion: session.renderDocVersion || null,
    url: session.url,
  };
}

export function createCaptureController(projectRoot) {
  const root = resolve(projectRoot);
  let session = null;
  let closed = false;

  function select(input = {}, bind = false) {
    if (!session || input.captureSessionId !== session.id) return null;
    const bootId = String(input.targetBootId || '');
    if (bind && session.captureReady && !session.bootId && bootId) session.bootId = bootId;
    if (session.bootId && bootId && session.bootId !== bootId) return null;
    return session;
  }

  async function status(input = {}) {
    const selected = select(input, true);
    if (!selected) return publicStatus(null, session ? '当前游戏窗口不是 RenderDoc 专用会话' : '请先准备 RenderDoc 专用游戏窗口');
    return publicStatus(selected);
  }

  async function prepare({ url, targetBootId = '' } = {}) {
    if (closed) throw new Error('capture controller is closed');
    if (session?.state === 'preparing' || session?.state === 'capturing') throw new Error('a capture session is busy');
    const previous = session;
    if (previous?.backend) await previous.backend.close();
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('capture session URL must use loopback HTTP');
    }
    const id = randomBytes(24).toString('hex');
    parsed.searchParams.set(CAPTURE_QUERY_KEY, id);
    const next = {
      id, url: parsed.href, sourceBootId: String(targetBootId || ''), bootId: '',
      state: 'preparing', captureReady: false, reason: '', error: null,
      completedFrames: 0, requestedFrames: 0, outputDir: null, backend: null,
    };
    session = next;
    void (async () => {
      try {
        const base = await safeOutputRoot(root);
        const rdDir = renderDocDirectory();
        if (!rdDir) throw new Error('RenderDoc executable not found; set GAMEDRAFT_RENDERDOC_DIR to v1.46 portable directory');
        const version = renderDocVersion(rdDir);
        const browser = browserExecutable();
        if (!browser) throw new Error('Chrome or Edge not found; set GAMEDRAFT_RENDERDOC_BROWSER');
        const sessionDir = join(base, new Date().toISOString().slice(0, 10), id);
        if (session !== next || closed) return;
        next.sessionDir = sessionDir;
        next.renderDocVersion = version;
        // The capture backend must establish a controlled D3D12 target before
        // captureReady is set. Dawn's injection toggle captures EVERY present;
        // reporting readiness before a bounded capture path exists would be unsafe.
        throw new Error('RenderDoc/Dawn bounded WebGPU capture backend is not yet available');
      } catch (error) {
        if (session !== next || closed) return;
        next.state = 'failed';
        next.error = errorText(error);
        next.reason = next.error;
      }
    })();
    return publicStatus(next);
  }

  async function start({ mode, frames, targetBootId, captureSessionId } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const selected = select({ targetBootId, captureSessionId });
    if (!selected || !selected.bootId || selected.bootId !== targetBootId) throw new Error('capture session and game bootId do not match');
    if (mode !== 'single' && mode !== 'burst') throw new Error('mode must be single or burst');
    const count = mode === 'single' ? 1 : Number(frames);
    if (mode === 'single' && frames != null && Number(frames) !== 1) throw new Error('single captures exactly one frame');
    if (!Number.isInteger(count) || (mode === 'burst' && (count < 2 || count > MAX_BURST_FRAMES))) {
      throw new Error(`burst frames must be an integer from 2 to ${MAX_BURST_FRAMES}`);
    }
    if (!selected.captureReady || !selected.backend) throw new Error(selected.reason || 'RenderDoc capture session is not ready');
    if (selected.state === 'capturing') throw new Error('capture already running');
    selected.state = 'capturing';
    selected.error = null;
    selected.completedFrames = 0;
    selected.requestedFrames = count;
    void selected.backend.capture(count).then(result => {
      if (session !== selected || selected.state !== 'capturing') return;
      selected.completedFrames = result.completedFrames;
      selected.outputDir = result.outputDir;
      selected.state = 'completed';
    }).catch(error => {
      if (session !== selected || selected.state !== 'capturing') return;
      selected.state = 'failed';
      selected.error = errorText(error);
      selected.reason = selected.error;
    });
    return publicStatus(selected);
  }

  async function stop({ targetBootId, captureSessionId } = {}) {
    const selected = select({ targetBootId, captureSessionId });
    if (!selected || !selected.bootId || selected.bootId !== targetBootId) throw new Error('capture session and game bootId do not match');
    if (selected.state === 'capturing') {
      selected.state = 'stopped';
      void Promise.resolve(selected.backend?.stop()).catch(error => { selected.error = errorText(error); });
    }
    return publicStatus(selected);
  }

  async function close() {
    closed = true;
    const old = session;
    session = null;
    await old?.backend?.close();
  }

  return { status, prepare, start, stop, close };
}
