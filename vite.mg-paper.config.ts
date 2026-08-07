import { defineConfig } from 'vite';
import { resolve } from 'path';

/** 临时隔离预览服（小游戏 UI 外壳并入视觉系统 · 扎纸）。收工删除。 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5603,
    strictPort: true,
    hmr: false,
    open: false,
  },
});
