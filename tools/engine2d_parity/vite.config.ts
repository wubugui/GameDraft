import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// engine2d 像素对照页:同一段场景代码分别交给 Pixi(WebGL,= master)与 engine2d(WebGPU)画,逐像素比。
// 端口避开编辑器(5173)、agent(5174–5188)、RHI 冒烟(5191)、渲染对照(5192)、扫描(5194–5197)、验收门(5199/5299)。
export default defineConfig({
  root: here,
  cacheDir: path.join(os.tmpdir(), 'engine2d-parity-vite', createHash('sha1').update(here).digest('hex').slice(0, 12)),
  resolve: {
    alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5193,
    strictPort: false,
    fs: { strict: false, allow: [repoRoot] },
  },
});
