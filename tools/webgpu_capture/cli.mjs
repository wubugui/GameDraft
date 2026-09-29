#!/usr/bin/env node
// Agent entry point for the WebGPU capture broker used by the in-game F2 panel.
import { analyzeCapture } from './analyze.mjs';

const DEFAULT_BASE = process.env.GAMEDRAFT_WEBGPU_CAPTURE_API || 'http://127.0.0.1:5173';
const API_PATH = '/__gamedraft-api/webgpu-capture';
const TERMINAL = new Set(['completed', 'failed', 'stopped']);

function parseArgs(argv) {
  const args = { command: argv[0] || 'help' };
  const valued = new Set(['base', 'boot-id', 'job', 'frames', 'timeout', 'capture', 'output', 'payloads']);
  const flags = new Set(['wait', 'metadata']);
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (flags.has(key)) args[key] = true;
    else if (valued.has(key)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`missing value for --${key}`);
      args[key] = argv[++index];
    } else throw new Error(`unknown option: ${token}`);
  }
  return args;
}

function endpoint(base, query = {}) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password) {
    throw new Error('capture API must be loopback HTTP');
  }
  const api = new URL(API_PATH, url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') api.searchParams.set(key, String(value));
  }
  return api;
}

async function api(base, method, query = {}, body) {
  const response = await fetch(endpoint(base, query), {
    method,
    redirect: 'error',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`capture API returned HTTP ${response.status} without JSON`); }
  if (!response.ok) throw new Error(result?.error || `capture API returned HTTP ${response.status}`);
  return result;
}

function intOption(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function print(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

async function waitFor(base, job, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await api(base, 'GET', {
      action: 'status', jobId: job.id, targetBootId: job.targetBootId,
    });
    if (TERMINAL.has(result?.state)) return result;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`capture ${job.id} did not finish within ${timeoutSeconds}s; use status or stop`);
}

function payloadSelection(value) {
  if (value === undefined) return undefined;
  if (value === 'all') return 'all';
  if (!/^[0-9]+(?:,[0-9]+)*$/.test(value)) throw new Error('--payloads must be all or comma-separated IDs');
  return value.split(',').map(token => Number(token));
}

function usage() {
  return `Usage: node tools/webgpu_capture/cli.mjs <command> [options]
  targets [--base http://127.0.0.1:5216]
  capture [--frames 1..120] [--boot-id ID] [--wait] [--timeout 1..300] [--base URL]
  status --boot-id ID [--job ID] [--base URL]
  stop --job ID --boot-id ID [--base URL]
  analyze --capture FILE.wgpuc [--output OUTSIDE_PROJECT_DIR] [--metadata] [--payloads ID,ID|all]
  export --capture FILE.wgpuc [--output OUTSIDE_PROJECT_DIR] [--payloads ID,ID|all]
Capture files use WebGPU Inspector's .wgpuc format; RenderDoc .rdc files use tools/renderdoc_capture/cli.mjs.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || DEFAULT_BASE;
  switch (args.command) {
    case 'targets':
      print(await api(base, 'GET', { action: 'targets' }));
      break;
    case 'capture': {
      const frames = intOption(args.frames ?? '1', 'frames', 1, 120);
      const job = await api(base, 'POST', {}, {
        action: 'request', frames, targetBootId: args['boot-id'] || undefined,
      });
      const result = args.wait ? await waitFor(base, job, intOption(args.timeout ?? '180', 'timeout', 1, 300)) : job;
      print(result);
      if (result?.state === 'failed' || result?.state === 'stopped') process.exitCode = 1;
      break;
    }
    case 'status': {
      if (!args['boot-id']) throw new Error('status requires --boot-id from targets or capture result');
      print(await api(base, 'GET', {
        action: 'status', jobId: args.job || '', targetBootId: args['boot-id'] || '',
      }));
      break;
    }
    case 'stop': {
      if (!args.job || !args['boot-id']) throw new Error('stop requires --job and --boot-id');
      print(await api(base, 'POST', {}, {
        action: 'stop', jobId: args.job, targetBootId: args['boot-id'],
      }));
      break;
    }
    case 'analyze':
    case 'export': {
      if (!args.capture) throw new Error(`${args.command} requires --capture FILE.wgpuc`);
      const result = await analyzeCapture(args.capture, {
        output: args.output,
        exportMetadata: args.command === 'export' || !!args.metadata,
        payloads: payloadSelection(args.payloads),
      });
      print({
        outputDir: result.outputDir,
        reportFile: result.reportFile,
        captureFile: result.report.captureFile,
        sha256: result.report.sha256,
        commandCount: result.report.commandCount,
        objectCount: result.report.objectCount,
        eventCount: result.eventCount,
        imageCount: result.imageCount,
        frameImage: result.frameImage,
        viewerFile: result.viewerFile,
        stats: result.report.stats,
        validationErrorCount: result.report.validationErrorCount,
        exports: result.exports,
      });
      break;
    }
    case 'help':
      process.stdout.write(usage() + '\n');
      break;
    default:
      throw new Error(`unknown command: ${args.command}\n${usage()}`);
  }
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
