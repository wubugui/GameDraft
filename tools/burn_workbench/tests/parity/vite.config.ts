import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

// 固定 master 旧工具 GPU 参考页（见 ref.ts / legacy-source.json）；几何 helper 沿用共享纯函数。
// 图 / 接口代理到临时工作台样例服务；完整独立双树 A/B 是另外一道门。
// 依赖预构建缓存放系统临时目录（别和游戏 dev 服、别的工作树共用 node_modules/.vite）。
const wb = process.env.BURN_PARITY_WB || 'http://127.0.0.1:5351';
export default defineConfig({
  root: here,
  cacheDir: path.join(os.tmpdir(), 'burn-parity-vite', createHash('sha1').update(here).digest('hex').slice(0, 12)),
  publicDir: false,
  clearScreen: false,
  logLevel: 'warn',
  resolve: { alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BURN_PARITY_PORT || 5447),
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: { '/resources': wb, '/assets': wb, '/api': wb },
  },
  optimizeDeps: { entries: [path.join(here, 'index.html')] },
});
