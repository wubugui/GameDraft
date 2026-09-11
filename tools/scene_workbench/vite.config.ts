import { defineConfig } from 'vite';
export default defineConfig({
  base: './', cacheDir: '.vite',
  server: { headers: { 'Cache-Control': 'no-store' }, proxy: { '/api': 'http://127.0.0.1:5348', '/reuse': 'http://127.0.0.1:5348' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
