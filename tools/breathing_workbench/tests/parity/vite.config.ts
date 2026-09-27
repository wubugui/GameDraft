import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

// 呼吸工作台逐像素对照的「游戏侧」参考页：由 vite 按游戏自己的模块图编译 `src/`（与游戏 dev 服同一套 `?raw` / 别名语义），
// 画法照游戏组装层现拼（见 ref.ts）。图 / 位移场 / 资产文档一律代理到正在跑的呼吸工作台服务（同一份字节）。
// 依赖预构建缓存放系统临时目录（别和游戏 dev 服、别的工作树共用 node_modules/.vite）。
const wb = process.env.BREATH_PARITY_WB || 'http://127.0.0.1:5352';
export default defineConfig({
  root: here,
  cacheDir: path.join(os.tmpdir(), 'breath-parity-vite', createHash('sha1').update(here).digest('hex').slice(0, 12)),
  publicDir: false,
  clearScreen: false,
  logLevel: 'warn',
  resolve: { alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BREATH_PARITY_PORT || 5489),
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: { '/resources': wb, '/assets': wb, '/api': wb },
  },
  optimizeDeps: { entries: [path.join(here, 'index.html')] },
});
