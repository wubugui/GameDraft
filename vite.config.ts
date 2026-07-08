import { defineConfig, type Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';

/** 开发服：读写 resources/editor_projects/editor_data/debug_flag_favorites.json，供 F2 Flag 收藏持久化（不使用 localStorage）。 */
function debugFlagFavoritesApi(): Plugin {
  return {
    name: 'gamedraft-debug-flag-favorites-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/debug-flag-favorites') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(root, 'resources/editor_projects/editor_data/debug_flag_favorites.json');
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '[]');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('[]');
          }
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not array');
            return;
          }
          const keys = [...new Set(parsed.map((x) => String(x)).filter(Boolean))].slice(0, 64);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(keys, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(keys));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/** 开发服：读写 resources/editor_projects/editor_data/debug_dock_pins.json，供 F2 区块 pin
 *（快捷页 ★ / 画面常驻 📌）跨端口、跨浏览器持久化（localStorage 按 origin 隔离，换端口会"失忆"）。 */
function debugDockPinsApi(): Plugin {
  return {
    name: 'gamedraft-debug-dock-pins-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/debug-dock-pins') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(root, 'resources/editor_projects/editor_data/debug_dock_pins.json');
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '{}');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{}');
          }
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const norm = (v: unknown): string[] =>
            Array.isArray(v) ? [...new Set(v.map((x) => String(x)).filter(Boolean))].slice(0, 64) : [];
          const payload = {
            quick: norm((parsed as { quick?: unknown }).quick),
            screen: norm((parsed as { screen?: unknown }).screen),
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/** 开发服：接收运行中浏览器上报的 runtime debug snapshot，供独立生产工作台读取。 */
function runtimeDebugSnapshotApi(): Plugin {
  return {
    name: 'gamedraft-runtime-debug-snapshot-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/runtime-debug-snapshot') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(
          root,
          'resources/editor_projects/editor_data/production_workbench/runtime_debug_snapshot.json',
        );
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '{"ok":false,"reason":"empty snapshot"}');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":false,"reason":"runtime snapshot not found"}');
          }
          return;
        }
        if (req.method === 'DELETE') {
          try {
            await unlink(filePath);
          } catch {
            /* already absent */
          }
          res.setHeader('Content-Type', 'application/json');
          res.end('{"ok":true}');
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const ch of req) {
            const buf = ch as Buffer;
            size += buf.length;
            if (size > 2_000_000) {
              res.statusCode = 413;
              res.end('snapshot too large');
              return;
            }
            chunks.push(buf);
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const payload = {
            ok: true,
            capturedAt: new Date().toISOString(),
            source: 'vite-runtime',
            snapshot: parsed,
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end('{"ok":true}');
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/** 命令入队后最长存活（毫秒）：超过即由服务端在下次 GET/POST 顺手剪除。
 *  根因修 #8：targetBootId 指向已死实例的孤儿命令无人认领（bootId 每次加载随机重生），
 *  服务端 TTL 剪枝保证最多滞留 TTL 即被清除，不依赖任何客户端认领。 */
const RUNTIME_COMMAND_TTL_MS = 30_000;

/** 剔除已超过 TTL 的命令。返回是否有任何命令被剪除（供调用方决定是否需要写回文件）。
 *  无 enqueuedAt 的历史/外部命令视为刚入队（不误删），交由 POST 路径补打时间戳。 */
function pruneExpiredCommands(commands: unknown[], now: number): { kept: unknown[]; pruned: boolean } {
  const kept = commands.filter((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return true;
    const at = (c as { enqueuedAt?: unknown }).enqueuedAt;
    if (typeof at !== 'number' || !Number.isFinite(at)) return true;
    return now - at <= RUNTIME_COMMAND_TTL_MS;
  });
  return { kept, pruned: kept.length !== commands.length };
}

/** 开发服：生产工作台写入 runtime command queue，运行中的浏览器轮询并执行白名单 debug 命令。 */
function runtimeCommandApi(): Plugin {
  return {
    name: 'gamedraft-runtime-command-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/runtime-command') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(
          root,
          'resources/editor_projects/editor_data/production_workbench/runtime_command_queue.json',
        );
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            if (!raw) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{"ok":true,"commands":[]}');
              return;
            }
            const parsed = (JSON.parse(raw) ?? {}) as Record<string, unknown> & { commands?: unknown[] };
            const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
            // GET 时顺手 TTL 剪枝：孤儿命令（targetBootId 无人认领）最多滞留 TTL 即清除，
            // 避免每 600ms 被重复 GET+parse 永不出队。
            const { kept, pruned } = pruneExpiredCommands(commands, Date.now());
            if (pruned) {
              if (kept.length === 0) {
                await unlink(filePath).catch(() => {});
              } else {
                await writeFile(
                  filePath,
                  `${JSON.stringify({ ...parsed, commands: kept }, null, 2)}\n`,
                  'utf-8',
                );
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: parsed.ok ?? true, ...parsed, commands: kept }));
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true,"commands":[]}');
          }
          return;
        }
        if (req.method === 'DELETE') {
          // 定向消费：`DELETE ?ids=a,b,c` 只删这些 id 的命令（多开页签时 targetBootId 不符的
          // 命令留在队列等目标实例取走）；不带 ids 保持旧行为——整队列清除。
          const idsParam = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('ids');
          if (idsParam) {
            const ids = new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean));
            try {
              const raw = (await readFile(filePath, 'utf-8')).trim();
              const parsed = raw ? (JSON.parse(raw) as { commands?: unknown[] }) : null;
              const commands = Array.isArray(parsed?.commands) ? parsed!.commands : [];
              const remaining = commands.filter((c) => {
                const id = c && typeof c === 'object' ? String((c as { id?: unknown }).id ?? '') : '';
                return !ids.has(id);
              });
              if (remaining.length === 0) {
                await unlink(filePath);
              } else {
                await writeFile(
                  filePath,
                  `${JSON.stringify({ ...(parsed as object), commands: remaining }, null, 2)}\n`,
                  'utf-8',
                );
              }
            } catch {
              /* absent or invalid → nothing to consume */
            }
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true}');
            return;
          }
          try {
            await unlink(filePath);
          } catch {
            /* already absent */
          }
          res.setHeader('Content-Type', 'application/json');
          res.end('{"ok":true}');
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const ch of req) {
            const buf = ch as Buffer;
            size += buf.length;
            if (size > 200_000) {
              res.statusCode = 413;
              res.end('command queue too large');
              return;
            }
            chunks.push(buf);
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const commands = (parsed as { commands?: unknown }).commands;
          if (!Array.isArray(commands)) {
            res.statusCode = 400;
            res.end('commands is not array');
            return;
          }
          // 不再 slice(0,50) 静默丢尾（body 200KB 上限已兜底总量）；缺 id 的命令由服务端补发
          // 唯一 id——定向 DELETE 依赖每条命令都有 id。同时打入队时间戳 enqueuedAt（服务器时间），
          // 供 TTL 剪枝识别孤儿命令；已带有效 enqueuedAt 的命令保留原值（重复 POST 不重置 TTL）。
          const now = Date.now();
          const stamped = commands.map((c, i) => {
            if (c && typeof c === 'object' && !Array.isArray(c)) {
              const rec = c as Record<string, unknown>;
              const id = rec.id === undefined || rec.id === null ? '' : String(rec.id).trim();
              const at = rec.enqueuedAt;
              const hasAt = typeof at === 'number' && Number.isFinite(at);
              if (!id || !hasAt) {
                return {
                  ...rec,
                  id: id || `cmd_${now}_${i}_${Math.random().toString(36).slice(2, 8)}`,
                  enqueuedAt: hasAt ? at : now,
                };
              }
            }
            return c;
          });
          // POST 时也顺手剪掉已过期命令，避免入队即挟带的历史孤儿命令原样写回。
          const { kept } = pruneExpiredCommands(stamped, now);
          const payload = {
            ok: true,
            updatedAt: new Date().toISOString(),
            source: 'production-workbench',
            commands: kept,
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, count: payload.commands.length }));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [debugFlagFavoritesApi(), debugDockPinsApi(), runtimeDebugSnapshotApi(), runtimeCommandApi()],
  base: './',
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    // Editor embed: bind explicitly so Local: URL matches WebEngine (127.0.0.1).
    host: process.env.GAMEDRAFT_EDITOR_EMBED === '1' ? '127.0.0.1' : undefined,
    // Editor embed: do not open external browser.
    open: process.env.GAMEDRAFT_EDITOR_EMBED !== '1',
  },
});
