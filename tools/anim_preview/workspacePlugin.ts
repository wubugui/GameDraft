import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

// workspaceStore is intentionally plain ESM so the exact same implementation is
// callable by both this Vite bridge and the Agent-facing Node CLI.
import {
  addAction,
  characterRoot,
  commitCalibration,
  createCheckpoint,
  createWorkspace,
  getWorkspaceView,
  invalidateActionStage,
  listCatalog,
  rawAssetsRoot,
  recordReview,
  resolveArtifactPath,
  restoreCheckpoint,
  restoreCompatible,
  saveCalibrationDraft,
  setActionEnabled,
  setHead,
  updateActionSpec,
  updateExportTargets,
} from './workspaceStore.mjs';

const WORKBENCH_MARKER = 'animation-workbench';
const ACTION_BRANCH_STAGES = new Set(['D', 'E', 'F', 'G']);

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(part);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
  } as Record<string, string>)[ext] || 'application/octet-stream';
}

function streamFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeFor(filePath));
  res.setHeader('Cache-Control', 'no-store');
  if (!range) {
    res.statusCode = 200;
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.end();
    return;
  }
  if (!match[1] && !match[2]) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.end();
    return;
  }
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
  const end = suffixLength !== null
    ? stat.size - 1
    : (match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.end();
    return;
  }
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`缺少查询参数 ${key}`);
  return value;
}

function actionStageNodeId(stageValue: unknown, actionIdValue: unknown): string {
  const stage = String(stageValue || '').toUpperCase();
  if (!ACTION_BRANCH_STAGES.has(stage)) throw new Error(`不支持按动作失效的阶段: ${stageValue || ''}`);
  const actionId = String(actionIdValue || '').trim();
  if (!actionId || actionId === '.' || actionId === '..' || /[\\/\0]/.test(actionId)) {
    throw new Error('非法动作 id');
  }
  return `${stage}/${actionId}`;
}

export function animationWorkspacePlugin(repoRoot: string): Plugin {
  const configuredSessionToken = String(process.env.ANIMATION_WORKBENCH_HUMAN_TOKEN || '').trim();
  if (configuredSessionToken && !/^[A-Za-z0-9_-]{32,256}$/.test(configuredSessionToken)) {
    throw new Error('ANIMATION_WORKBENCH_HUMAN_TOKEN 必须是至少 32 位的 base64url 能力令牌');
  }
  // Direct `vite` starts intentionally remain read-only. The random fallback
  // keeps the write routes closed without creating any discoverable API that
  // could upgrade an ordinary reader into the human authority.
  const humanWritesEnabled = Boolean(configuredSessionToken);
  const sessionToken = configuredSessionToken || crypto.randomBytes(32).toString('base64url');
  const pendingNotifications = new Map<string, { timer: ReturnType<typeof setTimeout>; reasons: Set<string> }>();
  const notify = (server: ViteDevServer, folderName: string | null, reason: string) => {
    const key = folderName || '*';
    const pending = pendingNotifications.get(key);
    if (pending) {
      pending.reasons.add(reason);
      return;
    }
    const reasons = new Set([reason]);
    const timer = setTimeout(() => {
      pendingNotifications.delete(key);
      server.ws.send({
        type: 'custom',
        event: 'workbench:changed',
        data: { folderName, reasons: [...reasons].sort() },
      });
    }, 100);
    pendingNotifications.set(key, { timer, reasons });
  };

  const assertHumanRequest = (req: IncomingMessage): void => {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      throw new Error('人工写操作只接受 application/json');
    }
    const suppliedToken = String(req.headers['x-animation-workbench-token'] || '');
    const tokenMatches = suppliedToken.length === sessionToken.length
      && crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(sessionToken));
    if (!humanWritesEnabled || !tokenMatches) {
      throw new Error('人工写能力未授权；请使用 ./dev.sh anim-preview 启动的浏览器页面');
    }
    const origin = String(req.headers.origin || '');
    const host = String(req.headers.host || '');
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
      throw new Error('拒绝跨站工作台写操作');
    }
  };

  return {
    name: 'animation-workspace',
    configureServer(server) {
      const rawRoot = rawAssetsRoot(repoRoot);
      server.watcher.add(rawRoot);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/workbench/')) return next();
        try {
          if (req.method === 'GET' && url.pathname === '/api/workbench/catalog') {
            sendJson(res, { characters: listCatalog(repoRoot) });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/workbench/workspace') {
            sendJson(res, getWorkspaceView(repoRoot, requiredQuery(url, 'folder')));
            return;
          }
          const artifactRoute = '/api/workbench/artifact';
          if (req.method === 'GET' && (url.pathname === artifactRoute || url.pathname.startsWith(`${artifactRoute}/`))) {
            const resolved = resolveArtifactPath(
              repoRoot,
              requiredQuery(url, 'folder'),
              requiredQuery(url, 'revision'),
              Number(requiredQuery(url, 'index')),
            );
            const encodedName = url.pathname === artifactRoute ? '' : url.pathname.slice(artifactRoute.length + 1);
            if (encodedName) {
              const hintedName = decodeURIComponent(encodedName);
              if (!hintedName || hintedName.includes('/') || hintedName.includes('\\') || hintedName !== resolved.artifact.name) {
                throw new Error('artifact URL 文件名与不可变版本索引不一致');
              }
            }
            streamFile(req, res, resolved.path);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/workbench/raw') {
            const folder = requiredQuery(url, 'folder');
            const name = requiredQuery(url, 'name');
            if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('非法 raw 文件名');
            const root = characterRoot(repoRoot, folder);
            const filePath = path.resolve(root, name);
            if (!filePath.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
              throw new Error(`raw 文件不存在: ${name}`);
            }
            streamFile(req, res, filePath);
            return;
          }

          if (req.method !== 'POST') {
            sendJson(res, { error: 'Method not allowed' }, 405);
            return;
          }
          assertHumanRequest(req);
          const body = await readJsonBody(req);
          let value: unknown;
          let folderName: string | null = body.folderName || null;
          switch (url.pathname) {
            case '/api/workbench/init':
              value = createWorkspace(repoRoot, body);
              folderName = body.folderName;
              break;
            case '/api/workbench/action':
              value = addAction(repoRoot, body.folderName, body.action || body);
              break;
            case '/api/workbench/action-spec':
              value = updateActionSpec(
                repoRoot,
                body.folderName,
                body.actionId,
                body.patch || {},
                'human-ui',
              );
              break;
            case '/api/workbench/action-enabled':
              value = setActionEnabled(repoRoot, body.folderName, body.actionId, body.enabled, 'human-ui');
              break;
            case '/api/workbench/export-targets':
              value = updateExportTargets(repoRoot, body.folderName, body.patch || body.targets || body, 'human-ui');
              break;
            case '/api/workbench/action-stage-invalidate':
              value = recordReview(repoRoot, body.folderName, {
                nodeId: actionStageNodeId(body.stage, body.actionId),
                decision: 'invalidated',
                note: body.note || '',
                authority: 'human-ui',
              });
              break;
            case '/api/workbench/stage-invalidate':
              value = invalidateActionStage(
                repoRoot,
                body.folderName,
                body.stage,
                body.note || '',
                'human-ui',
              );
              break;
            case '/api/workbench/review':
              value = recordReview(repoRoot, body.folderName, { ...body, authority: 'human-ui' });
              break;
            case '/api/workbench/head':
              value = setHead(repoRoot, body.folderName, body.nodeId, body.revisionId, 'human-ui');
              break;
            case '/api/workbench/restore-compatible':
              value = restoreCompatible(repoRoot, body.folderName, body.nodeId, Boolean(body.recursive), 'human-ui');
              break;
            case '/api/workbench/checkpoint':
              value = createCheckpoint(repoRoot, body.folderName, { ...body, authority: 'human-ui' });
              break;
            case '/api/workbench/restore-checkpoint':
              value = restoreCheckpoint(repoRoot, body.folderName, body.checkpointId, 'human-ui');
              break;
            case '/api/workbench/calibration-draft':
              value = saveCalibrationDraft(repoRoot, body.folderName, body.calibration || {}, 'human-ui');
              break;
            case '/api/workbench/calibration-commit':
              value = commitCalibration(repoRoot, body.folderName, body.calibration || {}, body.note || '', 'human-ui');
              break;
            default:
              sendJson(res, { error: 'Not found' }, 404);
              return;
          }
          const pathParts = url.pathname.split('/');
          notify(server, folderName, pathParts[pathParts.length - 1] || 'mutation');
          sendJson(res, value);
        } catch (error: any) {
          sendJson(res, { error: String(error?.message || error), code: error?.code || 'BAD_REQUEST' }, error?.code === 'WORKSPACE_CONFLICT' ? 409 : 400);
        }
      });

      server.watcher.on('all', (event, file) => {
        const normalized = file.replace(/\\/g, '/');
        if (!normalized.includes('/tmp/原始素材/')) return;
        if (!normalized.includes(`/${WORKBENCH_MARKER}/`) && !/\.(png|jpg|jpeg|webp|mp4|mov|webm)$/i.test(normalized)) return;
        const tail = normalized.split('/tmp/原始素材/')[1] || '';
        const folderName = tail.split('/')[0] || null;
        notify(server, folderName, event);
      });
      server.httpServer?.once('close', () => {
        for (const pending of pendingNotifications.values()) clearTimeout(pending.timer);
        pendingNotifications.clear();
      });
    },
  };
}
