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
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '{"ok":true,"commands":[]}');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true,"commands":[]}');
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
          const payload = {
            ok: true,
            updatedAt: new Date().toISOString(),
            source: 'production-workbench',
            commands: commands.slice(0, 50),
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
  plugins: [debugFlagFavoritesApi(), runtimeDebugSnapshotApi(), runtimeCommandApi()],
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
    // 避免 Windows 动态排除端口段（常见含 2948–3047，3000 会 EACCES）
    port: 5173,
    // Editor embed: bind explicitly so Local: URL matches WebEngine (127.0.0.1).
    host: process.env.GAMEDRAFT_EDITOR_EMBED === '1' ? '127.0.0.1' : undefined,
    // Editor embed: do not open external browser.
    open: process.env.GAMEDRAFT_EDITOR_EMBED !== '1',
  },
});
