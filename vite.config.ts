import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    // Editor embed: bind explicitly so Local: URL matches WebEngine (127.0.0.1).
    host: process.env.GAMEDRAFT_EDITOR_EMBED === '1' ? '127.0.0.1' : undefined,
    // Editor embed: do not open external browser.
    open: process.env.GAMEDRAFT_EDITOR_EMBED !== '1',
  },
});
