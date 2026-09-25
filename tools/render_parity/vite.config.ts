import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// 渲染像素对照页:直接用 src/ 下的运行时代码,不经游戏入口。
// 端口避开编辑器(5173)、agent(5174–5188)、RHI 冒烟(5191)、扫描(5194–5197)、验收门(5199/5299)。
export default defineConfig({
  root: here,
  resolve: {
    alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5192,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
});
