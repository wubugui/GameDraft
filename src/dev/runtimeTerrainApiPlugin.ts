import { dirname, resolve, sep } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type { Plugin } from 'vite';

import { RUNTIME_TERRAIN_API, RUNTIME_TERRAIN_PREVIEW_DIR, TERRAIN_PREVIEW_FILES } from './runtimeTerrainSync';

/**
 * 预览文件的 URL 余下部分 → 盘上路径；不合法 ⇒ null。
 * 两种形状：`<场景>/<文件>`（碰撞两样）与 `<场景>/ground/<烘焙目录名>/<文件>`（行走面）。
 * 每段不许带分隔符 / `..`；文件名只许是产物那几个——这个口子是往浏览器递本机文件的。
 */
export function terrainPreviewFilePath(root: string, rest: string): string | null {
  const parts = rest.split('/');
  if (parts.length !== 2 && parts.length !== 4) return null;
  let seg: string[];
  try {
    seg = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (seg.some((s) => !s || s === '.' || s === '..' || /[\\/]/.test(s) || s.includes('\0'))) return null;
  if (parts.length === 4 && seg[1] !== 'ground') return null;
  if (!TERRAIN_PREVIEW_FILES.includes(seg[seg.length - 1])) return null;
  const base = resolve(root, RUNTIME_TERRAIN_PREVIEW_DIR);
  const full = resolve(base, ...seg);
  return full.startsWith(base + sep) ? full : null;
}

/**
 * 开发服：地形工作台 ↔ 游戏的槽（形状照抄草木那条，多一个 `status` 子路径给游戏回探测结果）。
 *
 * - `GET  <槽>?scene=&boot=&preview=&applied=&loading=`：游戏轮询 + 心跳；回 `{doc, game, status}`
 * - `POST <槽> {sceneId, writer, source}`：工作台推送（rev 自增）；`{probeOnly:true, probe:{seq, sceneId, points}}` 只换探测请求，rev 不动
 * - `POST <槽>/status {bootId, sceneId, probeSeq, blocked, grid, applied}`：游戏答探测（进程内存着，不落盘）
 * - `GET  <槽>/preview/<场景>/<文件>`、`<槽>/preview/<场景>/ground/<烘焙目录>/<文件>`：本机预览目录里的产物
 */
export function runtimeTerrainApi(): Plugin {
  const DOC_PATH = RUNTIME_TERRAIN_API;
  const STATUS_PATH = `${RUNTIME_TERRAIN_API}/status`;
  const PREVIEW_PREFIX = `${RUNTIME_TERRAIN_API}/preview/`;
  let lastGame: { sceneId: string; bootId: string; preview: number; applied: number; loading: boolean; at: number } | null = null;
  let lastStatus: Record<string, unknown> | null = null;
  const gameInfo = () => (lastGame
    ? {
      sceneId: lastGame.sceneId, bootId: lastGame.bootId, preview: lastGame.preview, applied: lastGame.applied,
      loading: lastGame.loading, ageMs: Date.now() - lastGame.at,
    }
    : null);
  return {
    name: 'gamedraft-runtime-terrain-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly.startsWith(PREVIEW_PREFIX)) {
          const file = terrainPreviewFilePath(server.config.root, pathOnly.slice(PREVIEW_PREFIX.length));
          if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
            res.statusCode = file ? 405 : 400;
            res.end();
            return;
          }
          try {
            const st = await stat(file);
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'image/png');
            res.setHeader('Content-Length', String(st.size));
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'HEAD') { res.end(); return; }
            res.end(await readFile(file));
          } catch {
            res.statusCode = 404;
            res.end();
          }
          return;
        }
        if (pathOnly !== DOC_PATH && pathOnly !== STATUS_PATH) {
          next();
          return;
        }
        const filePath = resolve(server.config.root, 'resources/editor_projects/editor_data/runtime_terrain.json');
        const readDoc = async (): Promise<Record<string, unknown> | null> => {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            return raw ? JSON.parse(raw) as Record<string, unknown> : null;
          } catch {
            return null;
          }
        };
        const readBody = async (): Promise<Record<string, unknown> | null> => {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
          } catch {
            return null;
          }
        };
        if (pathOnly === STATUS_PATH) {
          if (req.method === 'POST') {
            const parsed = await readBody();
            if (!parsed || typeof parsed.bootId !== 'string') { res.statusCode = 400; res.end('bad payload'); return; }
            lastStatus = { ...parsed, ts: Date.now() };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ status: lastStatus }));
          return;
        }
        if (req.method === 'GET') {
          const qs = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
          const hbScene = (qs.get('scene') ?? '').trim();
          const hbBoot = (qs.get('boot') ?? '').slice(0, 80);
          const hbLoading = qs.get('loading') === '1';
          if (hbScene || (hbLoading && hbBoot)) {
            const pv = Number(qs.get('preview'));
            const ap = Number(qs.get('applied'));
            lastGame = {
              sceneId: hbScene, bootId: hbBoot, preview: Number.isFinite(pv) ? pv : 0, applied: Number.isFinite(ap) ? ap : 0,
              loading: hbLoading, at: Date.now(),
            };
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ doc: await readDoc(), game: gameInfo(), status: lastStatus }));
          return;
        }
        if (req.method === 'POST') {
          const parsed = await readBody();
          if (!parsed) { res.statusCode = 400; res.end('invalid json'); return; }
          const sceneId = String(parsed.sceneId ?? '').trim();
          if (!sceneId) { res.statusCode = 400; res.end('bad payload: 需要 sceneId'); return; }
          await mkdir(dirname(filePath), { recursive: true });
          const prev = await readDoc();
          if (parsed.probeOnly === true) {
            // 只换探测请求，rev / ts 不动：游戏不会因此重装
            const probe = parsed.probe && typeof parsed.probe === 'object' ? parsed.probe as Record<string, unknown> : null;
            const pts = Array.isArray(probe?.points) ? (probe!.points as unknown[]).slice(0, 256) : [];
            const doc = { ...(prev ?? {}), probe: probe ? { seq: Number(probe.seq) || 0, sceneId, points: pts } : null };
            await writeFile(filePath, `${JSON.stringify(doc)}\n`, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, rev: typeof prev?.rev === 'number' ? prev.rev : 0, game: gameInfo() }));
            return;
          }
          const source = parsed.source === 'preview' ? 'preview' : 'export';
          const rev = (typeof prev?.rev === 'number' ? prev.rev : 0) + 1;
          await writeFile(filePath, `${JSON.stringify({ rev, sceneId, source, ts: Date.now(), probe: prev?.probe ?? null })}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, rev, game: gameInfo() }));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}
