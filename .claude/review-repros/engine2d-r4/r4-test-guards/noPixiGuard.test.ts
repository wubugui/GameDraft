/**
 * r4-test-guards: noPixiInRuntime.test.ts 的盲区(同一套正则 + 逐行 + 注释行跳过逻辑)。
 * 「断言 = 守门看不见」。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PIXI_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]pixi\.js(?:\/[^'"]*)?['"]/;
function flagged(src: string): number {
  let n = 0;
  src.split('\n').forEach((line) => {
    if (!/^\s*(\*|\/\/|\/\*)/.test(line) && PIXI_IMPORT.test(line)) n++;
  });
  return n;
}

describe('noPixiInRuntime 守门盲区', () => {
  it('基线:普通写法都抓得到', () => {
    expect(flagged(`import { Sprite } from 'pixi.js';`)).toBe(1);
    expect(flagged(`export * from "pixi.js";`)).toBe(1);
    expect(flagged(`const p = await import('pixi.js');`)).toBe(1);
  });

  it('from 与模块名分两行:漏', () => {
    expect(flagged(`import {\n  Sprite,\n} from\n  'pixi.js';`)).toBe(0);
  });

  it('动态 import 用模板字符串:漏', () => {
    expect(flagged('const p = await import(`pixi.js`);')).toBe(0);
  });

  it('行首带块注释的 import(如 /* @vite-ignore */ 前缀):整行被当注释跳过', () => {
    expect(flagged(`/* keep */ import { Sprite } from 'pixi.js';`)).toBe(0);
  });

  it('扫描范围只有 src 与 tools/anim_preview:tools/parallax_editor(已迁到 engine2d)不在内', () => {
    // 守门里 runtimeSources 只被调用于 'src' 与 'tools/anim_preview'
    const scanned = ['src', 'tools/anim_preview'];
    const parallax = readdirSync('tools/parallax_editor').filter((f) => /\.ts$/.test(f) && statSync(join('tools/parallax_editor', f)).isFile());
    expect(parallax).toContain('main.ts');
    expect(scanned.some((d) => 'tools/parallax_editor/main.ts'.startsWith(`${d}/`))).toBe(false);
  });
});
