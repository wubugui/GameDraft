import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

/** dev-only:把仓库 public/assets 下的 JSON 只读透出为 /assets/**,让纯 web 模式
 * (无 Qt 桥)也能加载真实 narrative_graphs 等数据。仅 serve 生效,不进构建产物。 */
function serveGameAssets(): Plugin {
  const assetsRoot = path.resolve(__dirname, '../../public/assets');
  return {
    name: 'serve-game-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
        const file = path.resolve(assetsRoot, rel);
        if (!file.startsWith(assetsRoot) || !file.endsWith('.json') || !fs.existsSync(file)) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), serveGameAssets()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
    },
  },
});
