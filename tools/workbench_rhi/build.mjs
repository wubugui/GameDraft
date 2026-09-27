#!/usr/bin/env node
/**
 * 工作台 RHI 接入层的打包器：把一个 TS 入口（引擎的 engine2d / RHI + 游戏自己的渲染模块 + 工作台胶水）
 * 用 **vite 的库模式**打成一个自包含的 ESM 文件，给 Python serve 的原生 JS 页面 `await import()`。
 *
 *   node tools/workbench_rhi/build.mjs <entry.ts> <out.js>
 *
 * - 用 vite（不是裸 rolldown）：游戏模块里的 `xxx.wgsl?raw`、`import.meta.env` 与游戏构建同一套语义；
 * - 单文件（不拆块）：页面只 import 一个 URL，serve 不用管块路由；
 * - 先打进临时目录、再原子换上（serve 正在读旧包时不会读到半截）；
 * - 同目录写 `<out 去掉 .js>.stamp.json`：本次**实际打进去的全部源文件**（含 node_modules 里的）的尺寸 + 修改时刻，
 *   Python 侧（`build.py`）按它判"源比产物新就重打"——是打包器自己报的清单，不是正则扫 import 猜的。
 *
 * 纯本地：只读仓库根的 node_modules，不联网（离线机器照样能打）。平台无关：路径一律 path / pathToFileURL 处理。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const STAMP_VERSION = 1;

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const [, , entryArg, outArg] = process.argv;
if (!entryArg || !outArg) fail('用法：node tools/workbench_rhi/build.mjs <entry.ts> <out.js>');
const entry = path.resolve(entryArg);
const outFile = path.resolve(outArg);
if (!fs.existsSync(entry)) fail(`入口不存在：${entry}`);
if (!outFile.endsWith('.js')) fail(`产物必须是 .js：${outFile}`);

function stampPathOf(out) {
  return out.slice(0, -'.js'.length) + '.stamp.json';
}

function fileStat(p) {
  const st = fs.statSync(p);
  return { path: p, size: st.size, mtimeMs: st.mtimeMs };
}

const inputs = new Set();
/** 打包器实际读过的每一个真实文件（去掉 `?raw` 之类的查询串；虚拟模块 `\0…` 不算） */
function collectInputs() {
  return {
    name: 'workbench-rhi-inputs',
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (!id || id.startsWith('\0')) continue;
        const file = id.split('?')[0];
        if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) inputs.add(path.normalize(file));
      }
    },
  };
}

const { build } = await import('vite');
const outDir = path.dirname(outFile);
fs.mkdirSync(outDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(outDir, '.wbrhi-'));
try {
  await build({
    configFile: false,
    root: repoRoot,
    mode: 'production',
    logLevel: 'warn',
    clearScreen: false,
    publicDir: false,
    resolve: { alias: { '@src': path.join(repoRoot, 'src'), '@': path.join(repoRoot, 'src') } },
    // 库模式不替换 process.env.*：依赖里要是读它，浏览器里会 ReferenceError
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [collectInputs()],
    build: {
      outDir: tmpDir,
      emptyOutDir: false,
      write: true,
      minify: false,
      sourcemap: false,
      target: 'es2022',
      copyPublicDir: false,
      reportCompressedSize: false,
      lib: { entry, formats: ['es'], fileName: () => 'bundle.js' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const built = path.join(tmpDir, 'bundle.js');
  if (!fs.existsSync(built)) fail('vite 没产出 bundle.js');
  // Windows 上 serve 线程正在读旧包时 rename 可能 EPERM：短暂重试
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(built, outFile);
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const self = fs.readFileSync(fileURLToPath(import.meta.url));
  const lock = path.join(repoRoot, 'package-lock.json');
  const stamp = {
    version: STAMP_VERSION,
    entry,
    builder: createHash('sha1').update(self).digest('hex'),
    inputs: [...inputs, ...(fs.existsSync(lock) ? [lock] : [])].sort().map(fileStat),
  };
  const stampFile = stampPathOf(outFile);
  fs.writeFileSync(`${stampFile}.tmp`, JSON.stringify(stamp, null, 1));
  fs.renameSync(`${stampFile}.tmp`, stampFile);
  process.stdout.write(`ok ${outFile} (${stamp.inputs.length} inputs)\n`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
