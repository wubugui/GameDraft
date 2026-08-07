import { defineConfig } from 'vite';
import { resolve } from 'path';

/** 临时取景服（键盘导航接入自验用，端口 5505）。收工即删。 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5505,
    strictPort: true,
    hmr: false,
  },
});
