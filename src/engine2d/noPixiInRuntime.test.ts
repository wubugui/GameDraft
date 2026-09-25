/**
 * 运行时不依赖 Pixi:src 下的非测试代码不许 import 'pixi.js'(含子路径 / 动态 import / 类型 import)。
 * 渲染一律走 engine2d(→ RHI → WebGPU)。engine2d 自己的对照测试拿 Pixi 当参考实现,测试文件不在此限。
 * 动画工作台(tools/anim_preview)直接渲染运行时的 SpriteEntity / 光照滤镜 / 阴影,同样只许用 engine2d
 * (两套渲染器的对象不能混挂;构建产物 dist-remote 不在此列)。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function runtimeSources(dir: string, skipDirs: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!skipDirs.includes(name)) out.push(...runtimeSources(p, skipDirs));
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(p) && !/\.test\.[mc]?[tj]sx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const PIXI_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]pixi\.js(?:\/[^'"]*)?['"]/;

function pixiImports(files: string[]): string[] {
  const bad: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/^\s*(\*|\/\/|\/\*)/.test(line) && PIXI_IMPORT.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

describe('运行时不依赖 Pixi', () => {
  it('src 下的运行时代码没有 pixi.js 的 import', () => {
    const bad = pixiImports(runtimeSources('src'));
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('动画工作台(tools/anim_preview)没有 pixi.js 的 import', () => {
    const bad = pixiImports(runtimeSources('tools/anim_preview', ['dist-remote', 'node_modules']));
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
