import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parallaxPlugin } from './parallaxPlugin';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// 独立 dev server：parallax 场景可视化编辑器。
// - 复用仓库 public/ 资源（图层图片、示例场景）。
// - parallaxPlugin 提供：列可选图片、读/写 parallax_scenes.json。
// - 与运行时 CutsceneRenderer.showParallaxScene 同款 cover 映射数学，所见即所得。
export default defineConfig({
  root: here,
  publicDir: path.join(repoRoot, 'public'),
  resolve: {
    alias: { '@src': path.join(repoRoot, 'src') },
  },
  server: {
    port: 5205,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
  plugins: [parallaxPlugin(repoRoot)],
});
