import { describe, expect, it } from 'vitest';

import CHAR_FILTER from '../CharacterShadingFilter.ts?raw';
import CHAR_MESH from '../CharacterLitSprite.ts?raw';
import LIT_BG from './LitBackground.ts?raw';
import PREFIX from './shadowPrefix.ts?raw';
import SCENE from './SceneLightingPass.ts?raw';
import WORLD_RECONSTRUCT from './worldReconstruct.wgsl?raw';
import { CHAR_LIGHT_COMMON_WGSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_WGSL } from '../CharacterShadingFilter';
import { FG_OCCLUSION_WGSL } from '../foreground/foregroundMaskWgsl';
import { LC_WGSL, WR_CORE_WGSL } from './wgslChunks';

/**
 * **拼出来的 WGSL 里，被调用的每个函数都必须有定义。**
 *
 * ## 这条为什么存在
 *
 * 2026-08-22(当时着色器还是 GLSL)：场景 pass 调了一个从来没写过的 lightToQ（清理死代码时把定义删了、
 * 调用留下了）。后果是**整个重打光 shader 编译失败**——不是画错，是一帧都没画：
 * 辐射场 RT 保持清屏值 0，LitBackground 采到全 0，**28 个场景背景全黑**。
 *
 * 而当时**所有的门都是绿的**：
 * - tsc 看不见模板串里的着色器；
 * - 模板串 lint(现 shaderTemplateLint)只做 toContain 字符串包含（防反引号截断、防回退），
 *   它甚至有一条断言就写着那行调用 —— 那行**确实在**，只是它调用的函数不存在。
 *   字符串检查结构上就抓不到这类错。
 * - 真机验证那几轮跑的是**改动之前**的版本。
 *
 * 所以补这一条：把每个 shader **实际拼进去的**片段（自身的 wgsl 块 + 它拼接的共用段）合起来，
 * 抽出「定义了哪些函数 / 结构体」与「调用了哪些函数」，做包含检查。
 * 这不是完整的 WGSL 编译器，但它抓的正是"调了个不存在的东西"这一类 ——
 * 也就是能让整条管线一帧不画的那一类（WebGPU 下是整条管线建不起来）。
 */

/** WGSL 内建函数 / 类型构造器 / 关键字（被"调用"形式匹配到的都要放行）。 */
const BUILTINS = new Set([
  // 关键字/流程（`if (...)` 这种会被正则当成调用）
  'if', 'for', 'while', 'switch', 'return', 'else', 'loop', 'case',
  // 类型构造器 / 转换
  'f32', 'f16', 'i32', 'u32', 'bool',
  'vec2', 'vec3', 'vec4', 'vec2f', 'vec3f', 'vec4f', 'vec2i', 'vec3i', 'vec4i', 'vec2u', 'vec3u', 'vec4u',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'mat2x2f', 'mat3x3f', 'mat4x4f', 'array', 'bitcast',
  // 数学
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inverseSqrt',
  'abs', 'sign', 'floor', 'trunc', 'round', 'ceil', 'fract', 'modf', 'frexp', 'ldexp',
  'min', 'max', 'clamp', 'saturate', 'mix', 'step', 'smoothstep', 'fma', 'select',
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceForward', 'reflect', 'refract',
  'transpose', 'determinant', 'any', 'all',
  'countOneBits', 'firstLeadingBit', 'firstTrailingBit', 'extractBits', 'insertBits', 'reverseBits',
  'pack4x8unorm', 'unpack4x8unorm', 'pack2x16float', 'unpack2x16float', 'quantizeToF16',
  // 纹理
  'textureSample', 'textureSampleLevel', 'textureSampleBias', 'textureSampleGrad',
  'textureSampleCompare', 'textureSampleCompareLevel', 'textureGather', 'textureLoad',
  'textureDimensions', 'textureNumLevels', 'arrayLength',
  // 导数
  'dpdx', 'dpdy', 'fwidth', 'dpdxFine', 'dpdyFine', 'dpdxCoarse', 'dpdyCoarse',
]);

/** `/* wgsl *\/ \`...\`` 模板串的内容，`${...}` 插值剥掉（拼进来的段在 deps 里单列）。 */
function wgslBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\/\* wgsl \*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') break;
      i += 1;
    }
    out.push(src.slice(m.index + m[0].length, i).replace(/\$\{[^}]*\}/g, ' '));
    re.lastIndex = i + 1;
  }
  return out;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 定义：`fn 名字(` 与 `struct 名字 {`（结构体名当构造器调用）。 */
function definedFns(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{/g)) out.add(m[1]);
  return out;
}

/** 调用：`名字(`；`@location(0)` 这类属性不算（前面是 @）。 */
function calledFns(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?<![@\w])([A-Za-z_]\w*)\s*\(/g)) out.add(m[1]);
  return out;
}

/** 每个 shader 文件 + 它实际拼进去的共用段（与各文件的 import / 拼接一一对应）。 */
const TARGETS: { name: string; own: string; deps: string[] }[] = [
  // PROBE / SKYAO 采样段:「GI体」「skyao体」调试视图拼进来的角色采样块(probeE 等)
  { name: 'SceneLightingPass.ts', own: SCENE, deps: [WR_CORE_WGSL, LC_WGSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_WGSL] },
  { name: 'LitBackground.ts', own: LIT_BG, deps: [WR_CORE_WGSL, LC_WGSL] },
  // 线扫求解器是自洽的：不拼任何共用段，所有函数都在自己的模板串里
  { name: 'shadowPrefix.ts', own: PREFIX, deps: [] },
  // sprite 网格着色:LIT_WGSL = 自身各段 + CLC + WR_CORE + LC
  { name: 'CharacterLitSprite.ts', own: CHAR_MESH, deps: [CHAR_LIGHT_COMMON_WGSL, WR_CORE_WGSL, LC_WGSL] },
  // 角色着色滤镜:FILTER_WGSL = 自身 + CLC + 前景遮挡取样段
  { name: 'CharacterShadingFilter.ts', own: CHAR_FILTER, deps: [CHAR_LIGHT_COMMON_WGSL, FG_OCCLUSION_WGSL] },
];

function missingCalls(own: string, deps: string[]): string[] {
  const o = stripComments(own);
  const defined = definedFns(stripComments([o, ...deps].join('\n')));
  return [...calledFns(o)].filter((f) => !BUILTINS.has(f) && !defined.has(f)).sort();
}

describe('拼出来的 WGSL 里没有"调了但没定义"的函数', () => {
  it.each(TARGETS.map((t) => [t.name, t] as const))('%s', (_n, t) => {
    expect(
      missingCalls(wgslBlocks(t.own).join('\n'), t.deps),
      `${t.name}: 这些函数被调用但没有定义 —— 管线建不起来，`
      + '整条一帧都画不出来（2026-08-22 的 lightToQ 就是这么把 28 个场景弄黑的）',
    ).toEqual([]);
  });

  it('共用段自己也闭合(段内调用的都在段内或它依赖的段里)', () => {
    expect(missingCalls(LC_WGSL, [WR_CORE_WGSL]), 'LC').toEqual([]);
    expect(missingCalls(WR_CORE_WGSL, []), 'WR_CORE').toEqual([]);
    expect(missingCalls(CHAR_LIGHT_COMMON_WGSL, []), 'CLC').toEqual([]);
  });

  it('每个目标都真的抽到了东西（防止正则失配导致这条测试空转）', () => {
    for (const t of TARGETS) {
      const own = stripComments(wgslBlocks(t.own).join('\n'));
      expect(own.length, `${t.name}: 一个 wgsl 块都没抽到`).toBeGreaterThan(200);
      expect(calledFns(own).size, `${t.name}: 一个调用都没抽到`).toBeGreaterThan(5);
    }
    // 切片必须真的切出来了，不是回落成整篇
    expect(WR_CORE_WGSL.length).toBeGreaterThan(500);
    expect(WR_CORE_WGSL.length).toBeLessThan(WORLD_RECONSTRUCT.length);
    expect(LC_WGSL.length).toBeGreaterThan(500);
  });

  it('反向自检：故意插一个不存在的调用，这条测试必须红', () => {
    const poisoned = wgslBlocks(SCENE).join('\n') + '\nfn t() { let x = __nope__(1.0); }';
    expect(missingCalls(poisoned, [WR_CORE_WGSL, LC_WGSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_WGSL])).toContain('__nope__');
    // 属性不算调用、结构体构造器算定义
    expect(missingCalls('struct S { a: f32, }\n@fragment fn m(@location(0) v: f32) { let s = S(v); }', [])).toEqual([]);
  });
});

describe('WGSL 与 CPU 镜像的契约号一致', () => {
  it('WR_CONTRACT 两边同值', async () => {
    const m = /const\s+WR_CONTRACT\s*:\s*i32\s*=\s*(\d+)\s*;/.exec(WORLD_RECONSTRUCT);
    expect(m, 'WGSL 里找不到 const WR_CONTRACT').not.toBeNull();
    const TS_SRC = (await import('../../utils/worldReconstruct.ts?raw')).default;
    const t = /export const WR_CONTRACT = (\d+);/.exec(TS_SRC);
    expect(t, 'TS 里找不到 WR_CONTRACT').not.toBeNull();
    expect(Number(t![1]), '改了着色器必须同步改 CPU 镜像并 bump 契约号').toBe(Number(m![1]));
  });

  it('world→q 两边都有（这个方向一度只有 CPU 侧有，害得 shader 编译失败）', () => {
    expect(WR_CORE_WGSL).toContain('fn wrWorldToQ(');
  });
});
