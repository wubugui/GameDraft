/** 临时隔离预览服（扎纸小游戏 UI 观感取景，端口 5603）。收工即删。 */
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: { port: 5603, strictPort: true, hmr: false, open: false },
});
