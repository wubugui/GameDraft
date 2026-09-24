// 共用:定位 TypeScript 编译器、建 Program、行号工具。
// TypeScript 解析顺序:环境变量 TYPESCRIPT_PATH → 仓库 node_modules/typescript(package.json 里的 devDependency)。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAP_DIR = path.resolve(HERE, '..');
export const ROOT = path.resolve(MAP_DIR, '..');
export const SRC = path.join(ROOT, 'src');

export function loadTs() {
  const candidates = [];
  if (process.env.TYPESCRIPT_PATH) candidates.push(process.env.TYPESCRIPT_PATH);
  candidates.push(path.join(ROOT, 'node_modules', 'typescript'));
  const req = createRequire(path.join(ROOT, 'package.json'));
  for (const c of candidates) {
    try {
      return req(c);
    } catch { /* try next */ }
  }
  try {
    return req('typescript');
  } catch {
    console.error('找不到 typescript。先在仓库根跑 npm install,或设 TYPESCRIPT_PATH=<.../node_modules/typescript>。');
    process.exit(2);
  }
}

export const ts = loadTs();

/** 仓库相对路径,统一正斜杠 */
export function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

export function lineOf(sf, pos) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** 节点起始行(跳过前导注释) */
export function nodeLine(node) {
  const sf = node.getSourceFile();
  return lineOf(sf, node.getStart(sf));
}

/** 运行时范围:src 下非测试 .ts。dev/debug/authoring 另标为边界。 */
export function isTestFile(f) {
  return /\.test\.ts$/.test(f);
}

export const BOUNDARY_DIRS = ['src/dev/', 'src/debug/', 'src/authoring/'];
export function isBoundaryFile(relPath) {
  return BOUNDARY_DIRS.some((d) => relPath.startsWith(d));
}

export function listSrcTs() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !isTestFile(e.name)) out.push(p);
    }
  };
  walk(SRC);
  return out.sort();
}

export function createProgram() {
  const cfgPath = path.join(ROOT, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  const options = { ...parsed.options, types: [], noEmit: true, skipLibCheck: true };
  const rootNames = listSrcTs();
  const program = ts.createProgram(rootNames, options);
  return { program, options, rootNames };
}
