import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// 渲染像素对照页:直接用 src/ 下的运行时代码,不经游戏入口。一个配置两种服务(run.mjs 各起一个):
//   RENDER_PARITY_SIDE=ref  —— 参考:`@src` → RENDER_PARITY_REF_ROOT/src(从 master 抽出的树),`pixi.js` 是真 Pixi;
//   RENDER_PARITY_SIDE=cand —— 候选(缺省):`@src` → 本工作区 src,`pixi.js` → engine2d 公共入口。
// 抽出的树放在仓库内 .tools/ 下(已 gitignore、vitest 不扫),裸包名照常解析到仓库根的 node_modules。
// 端口避开编辑器(5173)、agent(5174–5188)、RHI 冒烟(5191)、扫描(5194–5197)、验收门(5199/5299);被占就往后找。
// 依赖预构建缓存按工作树 + 侧 + 参考树分开放(多个 git worktree 共用一份 node_modules 时互不踩)。
const side = process.env.RENDER_PARITY_SIDE === 'ref' ? 'ref' : 'cand';
const refRoot = process.env.RENDER_PARITY_REF_ROOT ?? '';
if (side === 'ref' && !refRoot) throw new Error('参考服务要给 RENDER_PARITY_REF_ROOT(master 的 src 树所在目录)');
const srcRoot = side === 'ref' ? path.join(refRoot, 'src') : path.join(repoRoot, 'src');

/**
 * 参考侧补件:用例会 import 本分支才有的模块(WGSL 源码、RHI),master 的树里没有。参考侧跑的是 Pixi WebGL,
 * 这些模块在那条路径上只被 import、不被执行(WGSL 串不会进 WebGL),所以缺了就从本分支的 src 补上,
 * 并在终端报一次清单——**master 里有的模块一律用 master 的**,补件只填空缺,不替换。
 */
function refFallback(): Plugin {
  const branchSrc = path.join(repoRoot, 'src');
  const reported = new Set<string>();
  const exists = (p: string) => ['', '.ts', '/index.ts'].some((ext) => fs.existsSync(p + ext));
  return {
    name: 'render-parity-ref-fallback',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const [file, query] = source.split('?');
      if (!file.startsWith(srcRoot + path.sep) && !file.startsWith(`${srcRoot}/`)) return null;
      if (exists(file)) return null;
      const rel = path.relative(srcRoot, file);
      if (!reported.has(rel)) {
        reported.add(rel);
        console.warn(`[render_parity] 参考树(master)没有 src/${rel.replace(/\\/g, '/')},用本分支的补上(只在参考侧 import、不在 WebGL 路径上执行)`);
      }
      const target = path.join(branchSrc, rel) + (query !== undefined ? `?${query}` : '');
      return this.resolve(target, importer, { ...options, skipSelf: true });
    },
  };
}

export default defineConfig({
  root: here,
  cacheDir: path.join(
    os.tmpdir(),
    'render-parity-vite',
    createHash('sha1').update(`${here}|${side}|${refRoot}`).digest('hex').slice(0, 12),
  ),
  plugins: side === 'ref' ? [refFallback()] : [],
  resolve: {
    alias: [
      { find: '@parity-side', replacement: path.join(here, side === 'ref' ? 'side_ref.ts' : 'side_cand.ts') },
      { find: /^@src\//, replacement: `${srcRoot}/` },
      { find: /^@\//, replacement: `${srcRoot}/` },
      ...(side === 'cand' ? [{ find: /^pixi\.js$/, replacement: path.join(repoRoot, 'src', 'engine2d', 'index.ts') }] : []),
    ],
  },
  server: {
    host: '127.0.0.1',
    port: side === 'ref' ? 5192 : 5198,
    strictPort: false,
    // node_modules 可能是指向别处的软链(worktree),放开同源文件访问限制;这是本地测试页
    fs: { strict: false, allow: [repoRoot] },
    // 候选页里开参考服务的 iframe(跨源),参考页 postMessage 回来
    cors: true,
  },
});
