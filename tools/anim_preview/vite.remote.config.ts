import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * The local HTML has three independent module entries.  The remote bootstrap
 * must install its API/CAS transport before any of them evaluates, so the
 * remote build replaces those tags with one bootstrap entry.  The bootstrap
 * then imports the same three modules in their original order.
 */
function remoteBootstrapEntry(): Plugin {
  const localEntries = [
    '/main.ts',
    '/workbench.ts',
    '/assemblyWorkbench.ts',
  ];

  return {
    name: 'animation-workbench-remote-bootstrap',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        let transformed = html;
        for (const entry of localEntries) {
          const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(
            `<script\\s+type=["']module["']\\s+src=["']${escaped}["']\\s*><\\/script>`,
            'g',
          );
          const matches = transformed.match(pattern) || [];
          if (matches.length !== 1) {
            throw new Error(`远程构建无法唯一替换入口 ${entry}（命中 ${matches.length}）`);
          }
          transformed = transformed.replace(pattern, '');
        }
        if (!transformed.includes('</body>')) throw new Error('远程构建 index.html 缺少 </body>');
        return transformed.replace(
          '</body>',
          '<script type="module" src="./remoteBootstrap.ts"></script>\n</body>',
        );
      },
    },
  };
}

// This is intentionally a separate configuration.  The localhost config,
// plugins, session-token semantics and ./dev.sh anim-preview stay untouched.
export default defineConfig({
  root: here,
  base: '/FindingDogDist/',
  publicDir: false,
  resolve: {
    alias: [
      { find: '@src', replacement: path.join(repoRoot, 'src') },
      { find: /^\.\/humanSession$/, replacement: path.join(here, 'humanSession.remote.ts') },
    ],
  },
  build: {
    outDir: path.join(here, 'dist-remote'),
    emptyOutDir: true,
  },
  plugins: [remoteBootstrapEntry()],
});
