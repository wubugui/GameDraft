// The standalone Electron dev package serves the same capture controller as
// Vite. Game requests use gamedraft://; local agents use a loopback HTTP port.
import { createServer } from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createWebGpuCaptureController } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = '/__gamedraft-api/webgpu-capture';
const INSPECTOR = '/__gamedraft-api/webgpu-inspector.js';
const VIEWER = '/__gamedraft-api/webgpu-viewer';
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function smallJson(request) {
  if (!request.body) throw new Error('request body is required');
  const chunks = [];
  let size = 0;
  for await (const part of request.body) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 8192) throw new Error('request too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function lengthHeader(request) {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

async function handleRequest(request, controller) {
  const url = new URL(request.url);
  try {
    if (url.pathname === INSPECTOR) {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return new Response(await readFile(join(HERE, 'vendor', 'webgpu_inspector.js')), {
        headers: { ...NO_STORE, 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    }
    if (url.pathname === VIEWER) {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const file = url.searchParams.get('file') || 'viewer.html';
      const physical = await controller.viewerFile({ jobId: url.searchParams.get('jobId') || '', file });
      const contentType = file.endsWith('.png') ? 'image/png' :
        file.endsWith('.js') ? 'text/javascript; charset=utf-8' :
        file.endsWith('.json') ? 'application/json; charset=utf-8' :
        file.endsWith('.wgsl') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
      return new Response(await readFile(physical), {
        headers: { ...NO_STORE, 'Content-Type': contentType },
      });
    }
    if (url.pathname !== CAPTURE) return null;
    const qs = url.searchParams;
    const action = qs.get('action') || '';
    let result;
    if (request.method === 'GET') {
      if (action === 'targets') result = controller.list();
      else if (action === 'poll') result = controller.poll({ targetBootId: qs.get('targetBootId') || '' });
      else if (action === 'status') result = controller.status({
        jobId: qs.get('jobId') || '', targetBootId: qs.get('targetBootId') || '',
      });
      else throw new Error('unknown action');
    } else if (request.method === 'POST') {
      const body = await smallJson(request);
      if (body.action === 'register') result = controller.register(body);
      else if (body.action === 'request') result = await controller.request(body);
      else if (body.action === 'fail') result = controller.fail(body);
      else if (body.action === 'stop') result = controller.stop(body);
      else throw new Error('unknown action');
    } else if (request.method === 'PUT') {
      const common = {
        jobId: qs.get('jobId') || '', targetBootId: qs.get('targetBootId') || '',
        stream: request.body, contentLength: lengthHeader(request),
      };
      if (action === 'frame-image') result = await controller.uploadFrameImage({
        ...common, frameIndex: Number(qs.get('frameIndex')),
      });
      else result = await controller.upload({ ...common, actualFrames: Number(qs.get('actualFrames')) });
    } else return json({ error: 'method not allowed' }, 405);
    return json(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function discoveryFile() {
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'),
    'GameDraft', 'webgpu-capture-api.json');
}

export async function startElectronCaptureBroker(gameRoot) {
  const controller = createWebGpuCaptureController(gameRoot);
  const server = createServer(async (incoming, outgoing) => {
    // Browser pages cannot use this agent endpoint. The game uses its own
    // gamedraft:// route, while Node agents send requests without Origin.
    if (incoming.headers.origin) {
      outgoing.writeHead(403, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'foreign origin' }));
      return;
    }
    try {
      const host = incoming.headers.host || '127.0.0.1';
      const request = new Request(`http://${host}${incoming.url || '/'}`, {
        method: incoming.method,
        headers: incoming.headers,
        body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming),
        duplex: 'half',
      });
      const response = await handleRequest(request, controller) || json({ error: 'not found' }, 404);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
      else outgoing.end();
    } catch (error) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: String(error) }));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const info = { schema: 'gamedraft-electron-webgpu-capture-v1',
      base: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: new Date().toISOString() };
    const file = discoveryFile();
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(info)}\n`);
    await rename(temp, file);
    return {
      base: info.base,
      handle: request => handleRequest(request, controller),
      close() {
        controller.close();
        server.close();
        try {
          if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
        } catch { /* A stale discovery file is ignored by the CLI. */ }
      },
    };
  } catch (error) {
    controller.close();
    server.close();
    throw error;
  }
}
