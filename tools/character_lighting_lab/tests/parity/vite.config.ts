import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

// 角色照明实验室逐像素对照的「游戏侧」参考页:由 vite 按游戏自己的模块图编译 `src/`(与游戏 dev 服同一套 `?raw` / 别名语义),
// 画法照游戏组装层现拼(见 ref.ts)。载荷 / 图一律代理到正在跑的实验室服务(同一份字节)。
// 依赖预构建缓存放系统临时目录(别和游戏 dev 服、别的工作树共用 node_modules/.vite)。
const lab = process.env.CHARLAB_PARITY_LAB || 'http://127.0.0.1:5531';
export default defineConfig({
  root: here,
  cacheDir: path.join(os.tmpdir(), 'charlab-parity-vite', createHash('sha1').update(here).digest('hex').slice(0, 12)),
  publicDir: false,
  clearScreen: false,
  logLevel: 'warn',
  resolve: { alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.CHARLAB_PARITY_PORT || 5541),
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: { '/resources': lab, '/api': lab, '/out': lab, '/char': lab },
  },
  optimizeDeps: { entries: [path.join(here, 'index.html')] },
});
