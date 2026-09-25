/**
 * 运行时不依赖 Pixi:src 下的非测试代码不许 import 'pixi.js'(含子路径 / 动态 import / 类型 import)。
 * 渲染一律走 engine2d(→ RHI → WebGPU)。engine2d 自己的对照测试拿 Pixi 当参考实现,测试文件不在此限。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...runtimeSources(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(p) && !/\.test\.[mc]?[tj]sx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('运行时不依赖 Pixi', () => {
  it('src 下的运行时代码没有 pixi.js 的 import', () => {
    const pattern = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]pixi\.js(?:\/[^'"]*)?['"]/;
    const bad: string[] = [];
    for (const file of runtimeSources('src')) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!/^\s*(\*|\/\/|\/\*)/.test(line) && pattern.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
