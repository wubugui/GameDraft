import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// RHI 冒烟页:直接用 src/rendering/rhi 的源码,不经游戏入口。
// 端口避开编辑器(5173)、agent(5174–5188)、扫描(5194–5197)、验收门(5199/5299)。
export default defineConfig({
  root: here,
  resolve: {
    alias: { '@src': path.join(repoRoot, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5191,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
});
