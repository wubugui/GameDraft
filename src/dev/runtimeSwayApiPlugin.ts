import { dirname, resolve } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type { Plugin } from 'vite';

import { RUNTIME_SWAY_API } from './runtimeSwaySync';

/**
 * 开发服：草木工作台 → 游戏的**单向**槽（形状照抄上面两对，但只有一个方向、内容只有一行）。
 *
 * 草木的载荷是**盘上那几张 PNG**，不是 JSON，所以推的不是内容而是"它们变了"：
 * `{ rev, sceneId, ts }`。游戏看到比记住的 rev 大、且正是自己这个场景，就带着 `?v=rev`
 * 重新装一次拆层（不切场景、玩家不动）——`?v=` 是为了绕开 AssetManager 按 URL 的纹理缓存。
 */
export function runtimeSwayApi(): Plugin {
  // 路径常量只有一份：游戏侧与这里共用 RUNTIME_SWAY_API。各写一份字面量的话，
  // 漂了就是"推了没反应"且零报错（Python 侧那份由 tools/sway_workbench 的测试对着断言）。
  const DOC_PATH = RUNTIME_SWAY_API;
  return {
    name: 'gamedraft-runtime-sway-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
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
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ doc: await readDoc() }));
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
          await mkdir(dirname(filePath), { recursive: true });
          const prev = await readDoc();
          const rev = (typeof prev?.rev === 'number' ? prev.rev : 0) + 1;
          await writeFile(filePath, `${JSON.stringify({ rev, sceneId, ts: Date.now() })}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, rev }));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}
