import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { animScanPlugin } from './animScanPlugin';
import { animationWorkspacePlugin } from './workspacePlugin';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Standalone dev server for the animation preview tool. Reuses the game's own
// rendering code (src/rendering/*) so the preview is byte-identical to in-game,
// serves the repo's public/ assets, and hosts the live scan+watch plugin.
export default defineConfig({
  root: here,
  publicDir: path.join(repoRoot, 'public'),
  resolve: {
    alias: { '@src': path.join(repoRoot, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
  plugins: [animScanPlugin(repoRoot), animationWorkspacePlugin(repoRoot)],
});
