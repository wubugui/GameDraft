/**
 * 运行时不依赖 Pixi:src 下的非测试代码不许 import 'pixi.js' / '@pixi/*'。
 * 渲染一律走 engine2d(→ RHI → WebGPU)。engine2d 自己的对照测试拿 Pixi 当参考实现,测试文件不在此限。
 * 动画工作台(tools/anim_preview)直接渲染运行时的 SpriteEntity / 光照滤镜 / 阴影,视差编辑器(tools/parallax_editor)
 * 也已迁到 engine2d,同样只许用 engine2d(两套渲染器的对象不能混挂;pixi.js 仍是 devDependency,退回去照样能构建,
 * 只有这里拦得住)。构建产物(dist / dist-remote)与 node_modules 不在此列。
 *
 * 按整份文件匹配(不逐行):先把注释换成等长空白(字符串 / 模板字符串里的 // 与 /* 不算注释),再找
 * 静态 import / export … from、import type、副作用 import、动态 import()、require(),模块名可跨行、三种引号都算,
 * 'pixi.js' 本体、'pixi.js/…' 子路径与 '@pixi/…' 包一并拦。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 构建产物与依赖目录:任何一层叫这些名字都跳过 */
const SKIP_DIRS = ['dist', 'dist-remote', 'node_modules'];

function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.includes(name)) out.push(...runtimeSources(p));
    } else if (/\.[mc]?[tj]sx?$/.test(p) && !/\.test\.[mc]?[tj]sx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * 注释换成空白(换行保留,偏移与行号不变)。字符串 / 模板字符串原样跳过;正则字面量按「前一个有效字符不是
 * 标识符 / 数字 / 右括号,或前面是 return 之类的关键字」判定,里面的引号不会被当成字符串开头。
 */
const REGEX_AFTER_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|instanceof|new|throw)\s*$/;

function blankComments(src: string): string {
  const out = src.split('');
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, prev = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; else if (c !== '`' && src[j] === '\n') break; j++; }
      i = j + 1; prev = c; continue;
    }
    if (c === '/' && (!/[\w$)\]]/.test(prev) || REGEX_AFTER_KEYWORD.test(src.slice(Math.max(0, i - 24), i)))) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        j++;
      }
      i = j + 1; prev = '/'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/** 模块名:pixi.js 本体 / 子路径,或 @pixi/ 下的任何包 */
const PIXI_MODULE = String.raw`(?:pixi\.js(?:\/[^'"\x60]*)?|@pixi\/[^'"\x60]*)`;
/** from '…'(import / export / import type)、import '…'(副作用)、import('…')、require('…');空白可跨行 */
const PIXI_IMPORT = new RegExp(String.raw`(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*['"\x60]${PIXI_MODULE}['"\x60]`, 'g');

function pixiImportsIn(file: string, text: string): string[] {
  const bad: string[] = [];
  const code = blankComments(text);
  for (const m of code.matchAll(PIXI_IMPORT)) {
    const line = code.slice(0, m.index).split('\n').length;
    bad.push(`${file}:${line}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  return bad;
}

function pixiImports(files: string[]): string[] {
  return files.flatMap((f) => pixiImportsIn(f, readFileSync(f, 'utf8')));
}

describe('运行时不依赖 Pixi', () => {
  it('src 下的运行时代码没有 Pixi 的 import', () => {
    const bad = pixiImports(runtimeSources('src'));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('动画工作台(tools/anim_preview)没有 Pixi 的 import', () => {
    const bad = pixiImports(runtimeSources('tools/anim_preview'));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('视差编辑器(tools/parallax_editor)没有 Pixi 的 import', () => {
    const files = runtimeSources('tools/parallax_editor');
    expect(files.some((f) => f.endsWith('main.ts'))).toBe(true);
    const bad = pixiImports(files);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('Pixi import 守门自检', () => {
  const hit = (text: string) => pixiImportsIn('x.ts', text).length > 0;

  it('每种 import 写法都拦得住', () => {
    const forms = [
      `import { Sprite } from 'pixi.js';`,
      `import * as PIXI from "pixi.js";`,
      `import type { Texture } from 'pixi.js';`,
      `import { type Texture } from 'pixi.js';`,
      `export { Sprite } from 'pixi.js';`,
      `export * from 'pixi.js';`,
      `export type { Texture } from 'pixi.js';`,
      `import 'pixi.js';`,
      `import 'pixi.js/advanced-blend-modes';`,
      `const P = await import('pixi.js');`,
      'const P = await import(`pixi.js`);',
      `const P = import (\n  'pixi.js/unsafe-eval'\n);`,
      `type T = typeof import('pixi.js');`,
      `const P = require('pixi.js');`,
      `import P = require('pixi.js');`,
      `import {\n  Sprite,\n  Texture,\n} from\n  'pixi.js';`,
      `/* keep */ import { Sprite } from 'pixi.js';`,
      `const a = 1; // x\nimport { Sprite } from 'pixi.js';`,
      `import { Sprite } from '@pixi/sprite';`,
      `import '@pixi/unsafe-eval';`,
      `const s = require("@pixi/core");`,
    ];
    for (const f of forms) expect(hit(f), f).toBe(true);
  });

  it('注释 / 字符串里的字样与形近的包名不误报', () => {
    const clean = [
      `// import { Sprite } from 'pixi.js';`,
      `/* 迁移 = 把 \`from 'pixi.js'\` 换成 engine2d */`,
      `import { Sprite } from '@src/engine2d';`,
      `import x from 'pixi.js-legacy-shim-not-real';`,
      `import x from 'my-pixi.js';`,
      `const url = 'http://example.com/pixi.js'; import { a } from './a';`,
      `const re = /['"]/; import { a } from './a';`,
    ];
    // 正则字面量里的引号 / 反引号不能开出一段假字符串,把后面真正的 import 吞掉
    expect(hit('function f(s) { return /[`\'"]/.test(s); }\nimport { Sprite } from \'pixi.js\';')).toBe(true);
    expect(hit('const re = /`/;\nimport { Sprite } from \'pixi.js\';')).toBe(true);
    for (const f of clean) expect(hit(f), f).toBe(false);
    // 字符串里的 // 不能把后面真正的 import 当注释吃掉
    expect(hit(`const url = 'http://x'; import { Sprite } from 'pixi.js';`)).toBe(true);
    expect(pixiImportsIn('x.ts', `const a = 1;\n\nimport {\n  S,\n} from 'pixi.js';`)).toEqual([`x.ts:5: from 'pixi.js'`]);
  });
});
