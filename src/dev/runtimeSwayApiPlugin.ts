import { dirname, resolve, sep } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type { Plugin } from 'vite';

import { RUNTIME_SWAY_API, RUNTIME_SWAY_PREVIEW_DIR, SWAY_PREVIEW_FILES } from './runtimeSwaySync';

/**
 * 预览文件的 URL 余下部分（`<场景 id>/<烘焙目录名>/<文件名>`，各段已 URL 解码）→ 盘上路径；不合法 ⇒ null。
 * 只认三段、每段不许带路径分隔符 / `..`、文件名只许是拆层产物那几个——这个口子是往浏览器递本机文件的。
 */
export function swayPreviewFilePath(root: string, rest: string): string | null {
  const parts = rest.split('/');
  if (parts.length !== 3) return null;
  let seg: string[];
  try {
    seg = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (seg.some((s) => !s || s === '.' || s === '..' || /[\\/]/.test(s) || s.includes('\0'))) return null;
  if (!SWAY_PREVIEW_FILES.includes(seg[2])) return null;
  const base = resolve(root, RUNTIME_SWAY_PREVIEW_DIR);
  const full = resolve(base, seg[0], seg[1], seg[2]);
  return full.startsWith(base + sep) ? full : null;
}

/**
 * 开发服：草木工作台 → 游戏的**单向**槽（形状照抄上面两对，但只有一个方向、内容只有一行）。
 *
 * 草木的载荷是几张 PNG，不是 JSON，所以推的不是内容而是"它们变了"：
 * `{ rev, sceneId, source, ts }`。游戏看到比记住的 rev 大、且正是自己这个场景，就带着 `?v=rev`
 * 重新装一次拆层（不切场景、玩家不动）——`?v=` 是为了绕开 AssetManager 按 URL 的纹理缓存。
 * `source = 'preview'`（推给游戏）从 `<槽>/preview/...` 装本机预览目录里那份；`'export'`（导出到游戏）从资源装。
 */
export function runtimeSwayApi(): Plugin {
  // 路径常量只有一份：游戏侧与这里共用 RUNTIME_SWAY_API。各写一份字面量的话，
  // 漂了就是"推了没反应"且零报错（Python 侧那份由 tools/sway_workbench 的测试对着断言）。
  const DOC_PATH = RUNTIME_SWAY_API;
  const PREVIEW_PREFIX = `${RUNTIME_SWAY_API}/preview/`;
  /**
   * 游戏页的心跳（游戏轮询时带 `?scene=&boot=&preview=`；工作台自己探槽不带，不算）。
   * 回包里给 `game: {sceneId, bootId, preview, ageMs}`：工作台据此分得清"dev server 收下了"与"游戏页真看到了"——
   * 原来只要 dev server 应答就报「✔ 游戏里已换上」，游戏页根本没开也这么说。
   * `loading` = 游戏页开着、但正在装场景（冷启动 / 切场景，`sceneId` 这时可能是空的）或正在原地重装拆层：
   * 工作台见它就等，**别去拉起游戏 / 切场景**（原来这段不发心跳，按 P 会再开一个游戏窗口、或把玩家送回入口）。
   */
  let lastGame: { sceneId: string; bootId: string; preview: number; applied: number; loading: boolean; at: number } | null = null;
  const gameInfo = () => (lastGame
    ? {
      sceneId: lastGame.sceneId, bootId: lastGame.bootId, preview: lastGame.preview, applied: lastGame.applied,
      loading: lastGame.loading, ageMs: Date.now() - lastGame.at,
    }
    : null);
  return {
    name: 'gamedraft-runtime-sway-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly.startsWith(PREVIEW_PREFIX)) {
          // 推给游戏的预览：本机 local/sway_preview/ 里那几张（不在 public/ 下，打包抽不到；资源一个字节不动）
          const file = swayPreviewFilePath(server.config.root, pathOnly.slice(PREVIEW_PREFIX.length));
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
        if (pathOnly !== DOC_PATH) {
          next();
          return;
        }
        const filePath = resolve(server.config.root, 'resources/editor_projects/editor_data/runtime_sway.json');
        const readDoc = async (): Promise<Record<string, unknown> | null> => {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            return raw ? JSON.parse(raw) as Record<string, unknown> : null;
          } catch {
            return null;
          }
        };
        if (req.method === 'GET') {
          const qs = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
          const hbScene = (qs.get('scene') ?? '').trim();
          const hbBoot = (qs.get('boot') ?? '').slice(0, 80);
          const hbLoading = qs.get('loading') === '1';
          // 装场景期间的心跳没有场景 id，靠 boot 认出是游戏页（工作台自己探槽两样都不带）
          if (hbScene || (hbLoading && hbBoot)) {
            const pv = Number(qs.get('preview'));
            const ap = Number(qs.get('applied'));
            // applied = 这个场景里游戏真换上的最近那次推送的 rev（工作台据此确认"已换上"，不把"收下了"当成"换上了"）
            lastGame = {
              sceneId: hbScene, bootId: hbBoot, preview: Number.isFinite(pv) ? pv : 0, applied: Number.isFinite(ap) ? ap : 0,
              loading: hbLoading, at: Date.now(),
            };
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ doc: await readDoc(), game: gameInfo() }));
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          const sceneId = String(parsed.sceneId ?? '').trim();
          if (!sceneId) {
            res.statusCode = 400;
            res.end('bad payload: 需要 sceneId');
            return;
          }
          // 缺省按导出处理（老的推送没有这个字段，它们推的都是资源里那份）
          const source = parsed.source === 'preview' ? 'preview' : 'export';
          await mkdir(dirname(filePath), { recursive: true });
          const prev = await readDoc();
          const rev = (typeof prev?.rev === 'number' ? prev.rev : 0) + 1;
          await writeFile(filePath, `${JSON.stringify({ rev, sceneId, source, ts: Date.now() })}\n`, 'utf-8');
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
