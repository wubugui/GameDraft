import { describe, expect, it } from 'vitest';

import CHAR from './UnifiedCharacterShader.ts?raw';
import LIT_BG from './LitBackground.ts?raw';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import SHADE_CORE_3 from './shadeCore3.glsl?raw';
import PREFIX from './shadowPrefix.ts?raw';
import SCENE from './SceneLightingPass.ts?raw';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

/**
 * **拼出来的 GLSL 里，被调用的每个函数都必须有定义。**
 *
 * ## 这条为什么存在
 *
 * 2026-08-22：场景 pass 调了一个从来没写过的 `lightToQ`（清理死代码时把定义删了、
 * 调用留下了）。后果是**整个重打光 shader 编译失败**——不是画错，是一帧都没画：
 * 辐射场 RT 保持清屏值 0，`LitBackground` 采到全 0，**28 个场景背景全黑**。
 *
 * 而当时**所有的门都是绿的**：
 * - `tsc` 看不见模板串里的 GLSL；
 * - `glslTemplateLint` 只做 `toContain` 字符串包含（防反引号截断、防回退），
 *   它甚至有一条断言就写着 `toContain('vec3 lq = lightToQ(...)')` —— 那行**确实在**，
 *   只是它调用的函数不存在。字符串检查结构上就抓不到这类错。
 * - 真机验证那几轮跑的是**改动之前**的版本。
 *
 * 所以补这一条：把每个 shader **实际拼进去的**片段（自身的 glsl 块 + 它 import 的
 * 切片）合起来，抽出「定义了哪些函数」与「调用了哪些函数」，做包含检查。
 * 这不是完整的 GLSL 编译器，但它抓的正是"调了个不存在的东西"这一类 ——
 * 也就是能让整条管线一帧不画的那一类。
 */

/** GLSL ES 3.00 内建函数 + 常见关键字（被"调用"形式匹配到的都要放行）。 */
const BUILTINS = new Set([
  // 关键字/流程（`if (...)` 这种会被正则当成调用）
  'if', 'for', 'while', 'switch', 'return', 'else', 'do',
  // 构造器
  'float', 'int', 'uint', 'bool', 'void',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  // 数学
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract',
  'mod', 'modf', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
  'isnan', 'isinf', 'floatBitsToInt', 'floatBitsToUint',
  'intBitsToFloat', 'uintBitsToFloat',
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward',
  'reflect', 'refract',
  'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse',
  'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
  'equal', 'notEqual', 'any', 'all', 'not',
  // 纹理
  'texture', 'textureProj', 'textureLod', 'textureOffset', 'texelFetch',
  'texelFetchOffset', 'textureProjOffset', 'textureLodOffset',
  'textureProjLod', 'textureProjLodOffset', 'textureGrad', 'textureGradOffset',
  'textureProjGrad', 'textureProjGradOffset', 'textureSize',
  // 导数/其它
  'dFdx', 'dFdy', 'fwidth', 'discard',
]);

/** `/* glsl *\/ \`...\`` 模板串的内容。与 glslTemplateLint 的取法一致。 */
function glslBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\/\* glsl \*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') break;
      i += 1;
    }
    out.push(src.slice(m.index + m[0].length, i));
    re.lastIndex = i + 1;
  }
  return out;
}

/** 取 `//__TAG_BEGIN__ ... //__TAG_END__` 之间的内容；没有标记就返回整篇。 */
function slice(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) return src;
  return src.substring(i + b.length, j);
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 定义：行首（可缩进）`<类型> <名字>(` 且该行不以 `return`/`else` 之类开头。 */
function definedFns(src: string): Set<string> {
  const out = new Set<string>();
  const re = /^[ \t]*(?:precision\s+\w+\s+)?[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** 调用：`名字(`，排除紧跟在类型/关键字后面的定义形式。 */
function calledFns(src: string): Set<string> {
  const out = new Set<string>();
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** 每个 shader 文件 + 它实际拼进去的切片。 */
const WR_CORE = slice(WORLD_RECONSTRUCT, 'WR_CORE');
const LC = slice(LIGHTING_CORE, 'LIGHTING_CORE');
// ⚠ shadeCore3 与 lightingCore 是**两份都要拼**的：前者用后者的 LC_* 与 lc*。
// 漏拼一份的症状与 lightToQ 那次一模一样 —— link 失败、整条管线一帧不画。
const SC3 = slice(SHADE_CORE_3, 'SHADE_CORE_3');

const TARGETS: { name: string; own: string; deps: string[] }[] = [
  { name: 'SceneLightingPass.ts', own: SCENE, deps: [WR_CORE, LC, SC3] },
  { name: 'UnifiedCharacterShader.ts', own: CHAR, deps: [WORLD_RECONSTRUCT, LIGHTING_CORE, SHADE_CORE_3] },
  { name: 'LitBackground.ts', own: LIT_BG, deps: [WR_CORE, LC] },
  // 线扫求解器是自洽的：不拼任何切片，所有函数都在自己的模板串里
  { name: 'shadowPrefix.ts', own: PREFIX, deps: [] },
];

describe('拼出来的 GLSL 里没有"调了但没定义"的函数', () => {
  it.each(TARGETS.map((t) => [t.name, t] as const))('%s', (_n, t) => {
    const own = stripComments(glslBlocks(t.own).join('\n'));
    const all = stripComments([own, ...t.deps].join('\n'));
    const defined = definedFns(all);
    const missing = [...calledFns(own)]
      .filter((f) => !BUILTINS.has(f) && !defined.has(f))
      .sort();
    expect(
      missing,
      `${t.name}: 这些函数被调用但没有定义 —— shader 会 link 失败，`
      + '整条管线一帧都画不出来（2026-08-22 的 lightToQ 就是这么把 28 个场景弄黑的）',
    ).toEqual([]);
  });

  it('每个目标都真的抽到了东西（防止正则失配导致这条测试空转）', () => {
    for (const t of TARGETS) {
      const own = stripComments(glslBlocks(t.own).join('\n'));
      expect(own.length, `${t.name}: 一个 glsl 块都没抽到`).toBeGreaterThan(200);
      expect(calledFns(own).size, `${t.name}: 一个调用都没抽到`).toBeGreaterThan(5);
    }
    // 切片必须真的切出来了，不是回落成整篇
    expect(WR_CORE.length).toBeGreaterThan(500);
    expect(WR_CORE.length).toBeLessThan(WORLD_RECONSTRUCT.length);
    expect(LC.length).toBeGreaterThan(500);
  });

  it('反向自检：故意插一个不存在的调用，这条测试必须红', () => {
    const poisoned = stripComments(glslBlocks(SCENE).join('\n')) + '\nvoid t(){ __nope__(1.0); }';
    const defined = definedFns([poisoned, WR_CORE, LC].join('\n'));
    const missing = [...calledFns(poisoned)].filter((f) => !BUILTINS.has(f) && !defined.has(f));
    expect(missing).toContain('__nope__');
  });
});

describe('GLSL 与 CPU 镜像的契约号一致', () => {
  it('WR_CONTRACT 两边同值', async () => {
    const m = /#define\s+WR_CONTRACT\s+(\d+)/.exec(WORLD_RECONSTRUCT);
    expect(m, 'GLSL 里找不到 #define WR_CONTRACT').not.toBeNull();
    const TS_SRC = (await import('../../utils/worldReconstruct.ts?raw')).default;
    const t = /export const WR_CONTRACT = (\d+);/.exec(TS_SRC);
    expect(t, 'TS 里找不到 WR_CONTRACT').not.toBeNull();
    expect(Number(t![1]), '改了 GLSL 必须同步改 CPU 镜像并 bump 契约号').toBe(Number(m![1]));
  });

  it('world→q 两边都有（这个方向一度只有 CPU 侧有，害得 shader 编译失败）', () => {
    expect(WR_CORE).toContain('vec3 wrWorldToQ(');
  });
});
