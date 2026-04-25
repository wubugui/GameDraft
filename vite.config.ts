import { defineConfig, type Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';

/** 开发服：读写 editor_data/debug_flag_favorites.json，供 F2 Flag 收藏持久化（不使用 localStorage）。 */
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
        const filePath = resolve(root, 'editor_data/debug_flag_favorites.json');
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

export default defineConfig({
  plugins: [debugFlagFavoritesApi()],
  base: './',
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
