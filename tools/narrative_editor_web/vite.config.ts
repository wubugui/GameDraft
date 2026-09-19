import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** 与 scripts/py.sh 同一顺序：项目 venv 优先，其次系统 python。 */
function pickPython(repoRoot: string): string {
  for (const rel of ['.tools/venv/Scripts/python.exe', '.tools/venv/bin/python']) {
    const candidate = path.join(repoRoot, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** dev-only:把共享扫描引擎（tools/narrative_xref --dump）透出为 /__dev/narrative_xref,
 * 让纯 web 模式(无 Qt 桥)也能看「关系」「编排全貌」与画布引用小标。仅 serve 生效,不进构建产物;
 * 读的是磁盘,看不见画布里未保存的草稿(主编辑器里走桥、带草稿)。 */
function serveNarrativeXref(): Plugin {
  const repoRoot = path.resolve(__dirname, '../..');
  return {
    name: 'serve-narrative-xref',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/narrative_xref', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const result = spawnSync(pickPython(repoRoot), ['-m', 'tools.narrative_xref', '--dump'], {
          cwd: repoRoot,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        });
        if (result.status !== 0 || !result.stdout) {
          res.statusCode = 500;
          const tail = (result.stderr || '').trim().split('\n').slice(-6).join('\n');
          res.end(JSON.stringify({ ok: false, reason: tail || `python 退出码 ${result.status}` }));
          return;
        }
        res.end(result.stdout);
      });
    },
  };
}

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
  plugins: [react(), serveGameAssets(), serveNarrativeXref()],
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
