import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MUTANTS from './mutants.json';

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

/**
 * 候选侧补件(与 refFallback 对称):本分支删掉的 GLSL 孪生,用例里还可能为参考侧 import 着(GLSL 宿主拼真实 GLSL
 * 片段,如 `@src/.../xxx.glsl?raw`)。参考侧跑 Pixi WebGL、执行它;候选侧只 import、从不执行(engine2d 只跑 WGSL),
 * 所以候选侧缺的 **`.glsl` 文件**从参考树(master)补上,终端报一次清单——本分支有的一律用本分支的,补件只填空缺。
 * 只补 `.glsl`:TS 模块缺了是真错(候选侧测的必须是本分支的代码),照常报错。本分支从 TS 模块里删掉的 GLSL **导出**
 * 不经这里:用例按命名空间取(`import * as M`,候选侧取到 undefined、只在参考侧用),与参考侧取本分支才有的 WGSL
 * 导出同一个写法。只处理用例经 `@src/` 的 import;本分支 src 里自己的相对 import 缺文件是本分支的错。
 */
function candFallback(): Plugin {
  const refSrc = path.join(refRoot, 'src');
  const reported = new Set<string>();
  return {
    name: 'render-parity-cand-fallback',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const [file, query] = source.split('?');
      if (!file.endsWith('.glsl')) return null;
      if (!file.startsWith(srcRoot + path.sep) && !file.startsWith(`${srcRoot}/`)) return null;
      if (fs.existsSync(file)) return null;
      const rel = path.relative(srcRoot, file);
      if (!fs.existsSync(path.join(refSrc, rel))) return null;
      if (!reported.has(rel)) {
        reported.add(rel);
        console.warn(`[render_parity] 本分支没有 src/${rel.replace(/\\/g, '/')},用参考树(master)的补上(候选侧只 import、不执行 GLSL)`);
      }
      const target = path.join(refSrc, rel) + (query !== undefined ? `?${query}` : '');
      return this.resolve(target, importer, { ...options, skipSelf: true });
    },
  };
}

/**
 * 两侧都把 RT gather 的逐像素随机旋转钉成 0(`hash12(gl_FragCoord.xy)` / `hash12(fragCoord)` → `0.0`)。
 * 真显卡上 ANGLE(FXC)与 Dawn(DXC)对同一串浮点式子的收缩 / 精度不同,hash12 的 fract 把末位差放大成完全不同的
 * 旋转角,「RT gather」几个用例因此永远逐位不等(SwiftShader 下两边同一编译器才相同);钉住之后其余整条
 * gather(步进、入盒、NEE、miss)仍逐字节比。只改本对照页里加载的源,不动游戏。
 * 没找到要替换的式子就直接抛(改名后不许悄悄失效);`RENDER_PARITY_PIN_GATHER_ROT=0` 关掉。
 * GLSL 那条只挂参考侧:本分支的 CharacterShadingFilter.ts 已没有 GLSL(gather 在 charLightCommon.wgsl 里)。
 * WGSL 那条两侧都挂(参考侧经 refFallback 补进来、只 import 不执行,替换无害)。
 */
function pinGatherRotation(): Plugin {
  const rules: Array<{ file: RegExp; from: string; refOnly?: boolean }> = [
    { file: /[\\/]CharacterShadingFilter\.ts$/, from: 'hash12(gl_FragCoord.xy)', refOnly: true },
    { file: /[\\/]charLightCommon\.wgsl$/, from: 'hash12(fragCoord)' },
  ].filter((r) => side === 'ref' || !r.refOnly);
  return {
    name: 'render-parity-pin-gather-rot',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      const rule = rules.find((r) => r.file.test(file));
      if (!rule) return null;
      if (!code.includes(rule.from)) throw new Error(`[render_parity] ${file} 里找不到 ${rule.from}(改名了?同步 vite.config.ts 的 pinGatherRotation)`);
      return { code: code.split(rule.from).join('0.0'), map: null };
    },
  };
}
const pinRot = process.env.RENDER_PARITY_PIN_GATHER_ROT !== '0';

/**
 * 变异自检(`run.mjs --mutants`):只在候选侧、只在内存里把某个运行时源(WGSL / 宿主 TS)改坏一处(mutants.json 的
 * 一条),看它点名的用例是否当场变红 —— 证明容差没有宽到放过真错。找不到要改的式子就直接抛(源码改了,变异要跟着改);
 * 文件根本没被加载时不抛,但那样用例全绿,run.mjs 会报「漏网」。
 */
interface Mutant { id: string; file: string; edits: { from: string; to: string; all?: boolean }[] }
function applyMutant(id: string): Plugin {
  const m = (MUTANTS as Mutant[]).find((x) => x.id === id);
  if (!m) throw new Error(`[render_parity] mutants.json 里没有变异 ${id}`);
  const file = new RegExp(m.file);
  return {
    name: 'render-parity-mutant',
    enforce: 'pre',
    transform(code, moduleId) {
      const f = moduleId.split('?')[0];
      if (!file.test(f)) return null;
      let out = code;
      for (const e of m.edits) {
        if (!out.includes(e.from)) throw new Error(`[render_parity] 变异 ${id}:${f} 里找不到 ${e.from}`);
        out = e.all ? out.split(e.from).join(e.to) : out.replace(e.from, () => e.to);
      }
      return { code: out, map: null };
    },
  };
}
const mutantId = side === 'cand' ? process.env.RENDER_PARITY_MUTATE ?? '' : '';
const portBase = Number(process.env.RENDER_PARITY_PORT) || 0;

export default defineConfig({
  root: here,
  cacheDir: path.join(
    os.tmpdir(),
    'render-parity-vite',
    createHash('sha1').update(`${here}|${side}|${refRoot}`).digest('hex').slice(0, 12),
  ),
  plugins: [
    ...(side === 'ref' ? [refFallback()] : refRoot ? [candFallback()] : []),
    ...(pinRot ? [pinGatherRotation()] : []),
    ...(mutantId ? [applyMutant(mutantId)] : []),
  ],
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
    // RENDER_PARITY_PORT(run.mjs --port):参考侧用它、候选侧用它 +1;不给就用老端口
    port: portBase ? portBase + (side === 'ref' ? 0 : 1) : side === 'ref' ? 5192 : 5198,
    strictPort: false,
    // node_modules 可能是指向别处的软链(worktree),放开同源文件访问限制;这是本地测试页
    fs: { strict: false, allow: [repoRoot] },
    // 候选页里开参考服务的 iframe(跨源),参考页 postMessage 回来
    cors: true,
  },
});
