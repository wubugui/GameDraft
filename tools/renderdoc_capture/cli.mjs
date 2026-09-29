#!/usr/bin/env node
// Agent entry point for the same Vite RenderDoc capture API used by F2.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_BASE = process.env.GAMEDRAFT_RENDERDOC_API || 'http://127.0.0.1:5173';
const API_PATH = '/__gamedraft-api/renderdoc-capture';

function parseArgs(argv) {
  const out = { command: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (['wait', 'textures', 'raw-textures', 'buffers'].includes(key)) {
      out[key] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`missing value for --${key}`);
    out[key] = argv[++i];
  }
  return out;
}

function endpoint(base) {
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') {
    throw new Error('capture API must be loopback HTTP');
  }
  return new URL(API_PATH, url);
}

async function callApi(base, method, body = null, query = null) {
  const url = endpoint(base);
  if (query) for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function current(base, session, bootId) {
  return callApi(base, 'GET', null, { captureSessionId: session, targetBootId: bootId });
}

function sleep(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }

async function waitFor(base, session, bootId, terminal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await current(base, session, bootId);
    if (state.targetBootId && !bootId) bootId = state.targetBootId;
    if (terminal.has(state.state) && (!terminal.has('ready') || state.targetBootId || state.state !== 'ready')) return state;
    await sleep(350);
  }
  throw new Error(`timed out waiting for capture session ${session}`);
}

function pythonExecutable() {
  if (process.env.GAMEDRAFT_PYTHON && existsSync(process.env.GAMEDRAFT_PYTHON)) return process.env.GAMEDRAFT_PYTHON;
  const roots = [projectRoot];
  try {
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
    for (const line of (result.stdout || '').split(/\r?\n/)) if (line.startsWith('worktree ')) roots.push(line.slice(9));
  } catch { /* A standalone checkout can use GAMEDRAFT_PYTHON. */ }
  for (const root of roots) {
    const exe = join(root, '.tools', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (existsSync(exe)) return exe;
  }
  throw new Error('Python 3 interpreter not found; set GAMEDRAFT_PYTHON');
}

function analyze(args) {
  const capture = args.capture;
  if (!capture || !existsSync(capture)) throw new Error('analyze requires --capture <existing .rdc>');
  const output = args.output || join(dirname(resolve(capture)), 'analysis');
  const script = join(projectRoot, 'tools', 'renderdoc_capture', 'analyze.py');
  const cli = [script, '--capture', resolve(capture), '--output', resolve(output)];
  if (args['renderdoc-path']) cli.push('--renderdoc-path', resolve(args['renderdoc-path']));
  for (const option of ['textures', 'raw-textures', 'buffers']) if (args[option]) cli.push(`--${option}`);
  if (args.pixel) cli.push('--pixel', args.pixel);
  const result = spawnSync(pythonExecutable(), cli, { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || DEFAULT_BASE;
  switch (args.command) {
    case 'prepare': {
      const gameUrl = args.url || new URL('/?mode=dev', base).href;
      const result = await callApi(base, 'POST', { action: 'prepare', url: gameUrl });
      const settled = args.wait ? await waitFor(base, result.captureSessionId, '', new Set(['ready', 'failed']), 120000) : result;
      console.log(JSON.stringify(settled, null, 2));
      if (settled.state === 'failed') process.exitCode = 1;
      break;
    }
    case 'status':
      console.log(JSON.stringify(await current(base, args.session, args['boot-id']), null, 2));
      break;
    case 'capture': {
      if (!args.session) throw new Error('capture requires --session from prepare result');
      const state = await current(base, args.session, args['boot-id']);
      const bootId = args['boot-id'] || state.targetBootId;
      if (!bootId) throw new Error('capture session has no registered game bootId yet');
      const frames = args.frames == null ? 1 : Number(args.frames);
      const mode = frames === 1 ? 'single' : 'burst';
      const result = await callApi(base, 'POST', { mode, frames, targetBootId: bootId, captureSessionId: args.session });
      const settled = args.wait ? await waitFor(base, args.session, bootId, new Set(['completed', 'failed', 'stopped']), 180000) : result;
      console.log(JSON.stringify(settled, null, 2));
      if (settled.state === 'failed' || settled.state === 'stopped') process.exitCode = 1;
      break;
    }
    case 'stop': {
      if (!args.session) throw new Error('stop requires --session');
      const state = await current(base, args.session, args['boot-id']);
      const bootId = args['boot-id'] || state.targetBootId;
      if (!bootId) throw new Error('capture session has no registered game bootId yet');
      console.log(JSON.stringify(await callApi(base, 'POST', { action: 'stop', targetBootId: bootId, captureSessionId: args.session }), null, 2));
      break;
    }
    case 'analyze':
    case 'export':
      analyze(args);
      break;
    default:
      console.log('Usage: node tools/renderdoc_capture/cli.mjs <prepare|status|capture|stop|analyze|export> [options]\n' +
        '  --base http://127.0.0.1:5216  --session ID  --boot-id ID  --frames 1..120  --wait\n' +
        '  analyze/export: --capture FILE.rdc [--output DIR] [--textures] [--raw-textures] [--buffers] [--pixel RESOURCE:X:Y]');
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
