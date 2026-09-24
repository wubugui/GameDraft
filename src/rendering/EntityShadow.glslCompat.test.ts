import { describe, expect, it } from 'vitest';

import SRC from './EntityShadow.ts?raw';

/**
 * EntityShadow 的几段 shader（cast 剪影 / 接触 AO / 共用顶点）**没有 `#version 300 es`**，Pixi 按 WebGL1
 * 兼容头编译（in/out/texture 由它转译）。ES 3.00 才有的内建一用上，整段编译失败——
 * 接触 AO 一点都不画、控制台一句 "Could not initialize shader"，TS 与单测全绿（2026-09-24 真机踩过：
 * 手写双线性用了 texelFetch / textureSize / ivec 的 clamp）。锁在这里。
 */

function glslBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\/\* glsl \*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') break;
      i += 1;
    }
    out.push(src.slice(start, i));
    re.lastIndex = i + 1;
  }
  return out;
}

/** 去掉 // 与块注释（注释里提到这些名字是在解释为什么不能用，不算）。 */
function stripComments(glsl: string): string {
  return glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const ES3_ONLY: [string, RegExp][] = [
  ['texelFetch', /\btexelFetch\s*\(/],
  ['textureSize', /\btextureSize\s*\(/],
  ['textureLod / textureGrad', /\btexture(Lod|Grad)\s*\(/],
  ['ivec / uvec / uint', /\b(ivec[234]|uvec[234]|uint)\b/],
  ['位运算 / 移位', /<<|>>|(?<!&)&(?![&=])|\^(?!\^)|(?<!\|)\|(?!\|)/],
  ['数组构造式', /\b\w+\s*\[\s*\d*\s*\]\s*\(/],
];

describe('EntityShadow 的 shader 只用 WebGL1 兼容写法', () => {
  const raw = glslBlocks(SRC);
  const blocks = raw.map(stripComments);

  it('原文里（**连注释**）都没有 ES3 版本声明——Pixi 在整段源码里找这串字决定编译模式', () => {
    // 2026-09-24 真机：CONTACT_FRAG 的一行注释写了"没有 #version 300 es"，Pixi 照样认成 ES3 编译，
    // 这条闸（当时剥了注释才查）就看不见了。所以查原文。
    expect(raw.length).toBeGreaterThanOrEqual(3);
    for (const b of raw) expect(b).not.toContain('#version 300 es');
  });

  it.each(ES3_ONLY)('不用 %s', (_name, re) => {
    for (const b of blocks) expect(re.test(b), b.match(re)?.[0]).toBe(false);
  });
});
