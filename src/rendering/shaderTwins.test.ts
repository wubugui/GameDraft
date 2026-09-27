/**
 * GLSL / WGSL 孪生守门:游戏只画 WGSL。燃烧 / 呼吸 / 光柱 / 雷 / 粒子 / 实体阴影 / 前景层覆盖图的 GLSL 孪生已删
 * (工作台都迁到了游戏同一个 WebGPU 渲染器,2026-09-28);还剩的只有角色照明那一条线——charShadeCore(角色照明实验室
 * 直接读它)、lightingCore / worldReconstruct、角色照明公共块、实体灯循环,以及角色照明滤镜拼的前景层取样段 fgSample——
 * 随角色照明那边迁完一起删,在那之前两份要一起改。这里逐对比较:
 *   · 函数集合双向一致;
 *   · 每个函数体里的数值字面量**按源码顺序**一致(整数 / 浮点 / 十六进制都算,带负号;写法归一见 lits);
 *   · 顶层常量(GLSL 的 const 与对象式 #define、WGSL 的 const / override)按名字双向一致、值一致;
 *   · 两边同名的 struct 字段名与顺序一致。
 * 改了一边忘了另一边 ⇒ 这里红(工作台预览与游戏不再是同一个着色器)。
 * 登记的例外(每条都已核实等价,只放过登记的那几个字面量)见 KNOWN_EQUIVALENT / WGSL_ONLY_HELPERS;守门自己的灵敏度由文末的「变异自检」钉住。
 */
import { describe, expect, it } from 'vitest';
import LC_GLSL from './lighting/lightingCore.glsl?raw';
import WR_GLSL from './lighting/worldReconstruct.glsl?raw';
import CS_GLSL from './charShadeCore.glsl?raw';
import CS_WGSL from './charShadeCore.wgsl?raw';
import { LC_WGSL, WR_CORE_WGSL, WR_TEX_WGSL, WR_SPRITE_WGSL } from './lighting/wgslChunks';
import {
  CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL, PROBE_SAMPLING_GLSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_GLSL, SKYAO_SAMPLING_WGSL,
} from './CharacterShadingFilter';
import { ENTITY_SCENE_LIGHTS_GLSL, ENTITY_SCENE_LIGHTS_WGSL } from './CharacterLitSprite';
import { FG_OCCLUSION_GLSL } from './foreground/foregroundMaskGlsl';
import { FG_OCCLUSION_WGSL } from './foreground/foregroundMaskWgsl';

/** 取 `//__${tag}_BEGIN__` 与 `//__${tag}_END__` 之间;标记缺失或颠倒直接抛(改名后不许悄悄切出半截源)。 */
const sl = (src: string, tag: string) => {
  const b = `//__${tag}_BEGIN__`, e = `//__${tag}_END__`;
  const i = src.indexOf(b), j = src.indexOf(e);
  if (i < 0 || j < i) throw new Error(`切片标记缺失或颠倒: ${tag}`);
  return src.substring(i + b.length, j);
};
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** 一份着色器源的顶层声明:函数名 → 整段文本、常量名 → 值表达式、struct 名 → 字段名(按声明顺序)。 */
interface Decls { fns: Map<string, string>; consts: Map<string, string>; structs: Map<string, string[]> }

function parse(src: string, lang: 'glsl' | 'wgsl'): Decls {
  const fns = new Map<string, string>(), consts = new Map<string, string>(), structs = new Map<string, string[]>();
  // 预处理行:对象式 #define NAME value 当常量收;其余(#ifndef / 无值 #define / #endif …)丢掉
  const t = strip(src).replace(/^[ \t]*#.*$/gm, (line) => {
    const m = /^\s*#define\s+(\w+)[ \t]+(\S.*)$/.exec(line);
    if (m) consts.set(m[1], m[2].trim());
    return '';
  });
  // 按花括号深度切顶层项:深度 0 的 ';' 或回到深度 0 的 '}' 结束一项
  const items: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { items.push(t.slice(from, i + 1)); from = i + 1; }
    else if (c === ';' && depth === 0) { items.push(t.slice(from, i + 1)); from = i + 1; }
  }
  if (depth !== 0) throw new Error(`${lang} 花括号不配对`);
  items.push(t.slice(from));
  for (const raw of items) {
    const it = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^struct\s+(\w+)\s*\{([\s\S]*)\}$/.exec(it))) {
      const body = m[2];
      structs.set(m[1], lang === 'wgsl'
        ? [...body.matchAll(/(\w+)\s*:/g)].map((f) => f[1])
        : body.split(';').map((f) => /(\w+)\s*(?:\[[^\]]*\])?\s*$/.exec(f.trim())?.[1]).filter((f): f is string => !!f));
    } else if (it.endsWith('}')) {
      m = lang === 'wgsl' ? /\bfn\s+(\w+)\s*\(/.exec(it) : /^(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*\(/.exec(it);
      if (m) fns.set(m[1], it);
    } else if ((m = lang === 'wgsl'
      ? /^(?:const|override)\s+(\w+)\s*(?::[^=]*)?=\s*([\s\S]*);$/.exec(it)
      : /^const\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*=\s*([\s\S]*);$/.exec(it))) {
      consts.set(m[1], m[2].trim());
    }
  }
  return { fns, consts, structs };
}

/**
 * GLSL 的 texture(t, uv) 在 WGSL 里一律移植成 textureSampleLevel(t, s, uv, 0.0)(非一致控制流里只能显式 LOD);
 * 这个 0 号 LOD 实参(以及 GLSL textureLod 的 0 号 LOD)不算常量。非 0 的 LOD 照常参与比较。
 */
function dropZeroLod(s: string): string {
  const cuts: Array<[number, number]> = [];
  for (const m of s.matchAll(/\b(?:textureSampleLevel|textureLod)\s*\(/g)) {
    let depth = 1, i = m.index! + m[0].length, comma = -1;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === ',' && depth === 1) comma = i;
    }
    const close = i - 1;
    if (comma >= 0 && /^\s*(?:0+\.?0*|\.0+)[fh]?\s*$/.test(s.slice(comma + 1, close))) cuts.push([comma, close]);
  }
  let out = s;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

/**
 * 数值字面量按源码顺序展开(整数 / 浮点 / 十六进制都算,紧挨着的负号算进去),写法归一:
 * 1.0 ≡ 1. ≡ 1 ≡ 1f ≡ 1u ≡ 1i,0x10 ≡ 16,.5 ≡ 0.5;`x - 0.5` 与 `x + -0.5` 都记 -0.5。
 * 类型实参(vec3<f32> 之类)里没有数值;WGSL 的 array<T, N> 只留 N(对应 GLSL 声明里的 T x[N]),
 * GLSL 数组构造式 float[N](…) 的 N 由元素个数决定,不单算(WGSL 的 array(…) 构造不写第二遍)。
 */
function lits(s: string): string[] {
  let t = dropZeroLod(s);
  for (let k = 0; k < 3; k++) t = t.replace(/\b(?:vec[234]|mat[234]x[234]|texture_\w+|ptr|atomic)<[^<>]*>/g, ' ');
  t = t.replace(/\barray<[^<>,]*(?:,\s*([^<>]*))?>/g, (_, n: string | undefined) => ` ${n ?? ''} `);
  t = t.replace(/\b(float|int|uint|bool|[iub]?vec[234]|mat[234])\s*\[\s*\w+\s*\]\s*\(/g, '$1(');
  return [...t.matchAll(/(-\s*)?(?<![\w.])(0[xX][0-9a-fA-F]+|(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?)[fhiuFU]?(?![\w.])/g)]
    .map((m) => (m[1] ? '-' : '') + String(Number(m[2])));
}

const PAIRS: Array<[string, string, string]> = [
  ['WR_CORE', sl(WR_GLSL, 'WR_CORE'), WR_CORE_WGSL], ['WR_TEX', sl(WR_GLSL, 'WR_TEX'), WR_TEX_WGSL], ['WR_SPRITE', sl(WR_GLSL, 'WR_SPRITE'), WR_SPRITE_WGSL],
  ['LC', sl(LC_GLSL, 'LIGHTING_CORE'), LC_WGSL], ['CLC', CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL],
  ['PROBE', PROBE_SAMPLING_GLSL, PROBE_SAMPLING_WGSL], ['SKYAO', SKYAO_SAMPLING_GLSL, SKYAO_SAMPLING_WGSL],
  ['ESL', ENTITY_SCENE_LIGHTS_GLSL, ENTITY_SCENE_LIGHTS_WGSL], ['charShade', CS_GLSL, CS_WGSL],
  // 场景前景层:使用方共用的取样段(GLSL 版只剩角色照明滤镜在拼)
  ['fgOcc', FG_OCCLUSION_GLSL, FG_OCCLUSION_WGSL],
];
/**
 * 已核实等价、写法不同的函数(tag:函数名 → 放宽到哪一步):
 *   · 'unordered':GLSL 的三元式 `c ? a : b` 在 WGSL 里写成「默认值 + if 改写」,字面量先后变了、
 *     值 / 符号 / 个数都不变 → 只比多重集(改值、翻符号、增删常量照样红);
 *   · Splice:某一侧在第 at 个字面量处多出一段等价改写带来的字面量(必须恰好是 lits),先剪掉再按顺序比;
 *     剪的位置或值对不上 ⇒ 照样红(例外只放过登记的那几个字面量,函数里其余常量一个不少地比)。
 */
interface Splice { side: 'glsl' | 'wgsl'; at: number; lits: string[] }
const KNOWN_EQUIVALENT = new Map<string, 'unordered' | Splice>([
  // smoothstep(cosOuter, cosInner, x) 在 WGSL 里展开成 clamp(…, 0, 1) 与 t*t*(3-2t)(逐位对齐 GLSL,见 shaders-lighting 审查记录)
  ['LC:lcSpotLight', { side: 'wgsl', at: 1, lits: ['0', '1', '3', '-2'] }],
  // n.x>=0.?1.:-1. → var sx = -1.; if (n.x >= 0.) { sx = 1.; }
  ['CLC:octaEnc', 'unordered'], ['PROBE:octaEnc', 'unordered'],
  // abs(n.y) > 0.95 ? X : Y → var up = Y; if (abs(n.y) > 0.95) { up = X; }
  ['ESL:litAreaAxes', 'unordered'],
]);
/** 只在 WGSL 里有的移植辅助函数(tag:函数名);现存的几对里没有,留着口子 */
const WGSL_ONLY_HELPERS = new Set<string>();

/** 一对孪生的全部分歧(空 = 一致)。 */
function twinDiffs(tag: string, g: string, w: string): string[] {
  const G = parse(g, 'glsl'), W = parse(w, 'wgsl');
  const diffs: string[] = [];
  if (G.fns.size === 0) diffs.push('GLSL 一个函数都没切出来');
  for (const [n, body] of G.fns) {
    const wb = W.fns.get(n);
    if (!wb) { diffs.push(`WGSL 缺函数 ${n}`); continue; }
    const mode = KNOWN_EQUIVALENT.get(`${tag}:${n}`);
    let a = lits(body), b = lits(wb);
    if (mode === 'unordered') { a = [...a].sort(); b = [...b].sort(); }
    else if (mode) {
      const side = mode.side === 'glsl' ? a : b;
      const cut = side.splice(mode.at, mode.lits.length);
      if (cut.join(',') !== mode.lits.join(',')) diffs.push(`${n}: 登记的例外对不上(${mode.side} 第 ${mode.at} 个起应为 [${mode.lits.join(',')}],实为 [${cut.join(',')}])`);
    }
    if (a.join(',') !== b.join(',')) diffs.push(`${n}: glsl[${a.join(',')}] wgsl[${b.join(',')}]`);
  }
  for (const n of W.fns.keys()) if (!G.fns.has(n) && !WGSL_ONLY_HELPERS.has(`${tag}:${n}`)) diffs.push(`GLSL 缺函数 ${n}`);
  for (const [n, v] of G.consts) {
    const wv = W.consts.get(n);
    if (wv === undefined) { diffs.push(`WGSL 缺常量 ${n}`); continue; }
    const a = lits(v).join(','), b = lits(wv).join(',');
    if (a !== b) diffs.push(`常量 ${n}: glsl[${a}] wgsl[${b}]`);
  }
  for (const n of W.consts.keys()) if (!G.consts.has(n)) diffs.push(`GLSL 缺常量 ${n}`);
  for (const [n, f] of G.structs) {
    const wf = W.structs.get(n);
    if (wf && f.join(',') !== wf.join(',')) diffs.push(`struct ${n}: glsl{${f.join(',')}} wgsl{${wf.join(',')}}`);
  }
  return diffs;
}

describe('GLSL / WGSL 孪生逐函数一致(函数集合 + 数值常量 + 顶层常量 + struct)', () => {
  for (const [tag, g, w] of PAIRS) {
    it(tag, () => {
      const diffs = twinDiffs(tag, g, w);
      expect(diffs, diffs.join('\n')).toEqual([]);
    });
  }
});

describe('孪生守门自检(只在内存里改 WGSL 一侧,守门必须红)', () => {
  const pair = (tag: string) => PAIRS.find((p) => p[0] === tag)!;
  /** 把 WGSL 一侧的 from 换成 to(from 必须恰好出现)后比较;返回分歧。 */
  const mutate = (tag: string, ...subs: Array<[string, string]>) => {
    const [, g, w0] = pair(tag);
    let w = w0;
    for (const [from, to] of subs) {
      expect(w.includes(from), `${tag} 里找不到 ${from}`).toBe(true);
      w = w.replace(from, to);
    }
    return twinDiffs(tag, g, w);
  };

  it('字面量写法归一', () => {
    expect(lits('1.0 1. 1 1f 1u 1i 0x1 .5 0.50 5e-1 -0.5 x - 0.5 x + -0.5 vec3<f32>(2.0) array<f32, 9>'))
      .toEqual(['1', '1', '1', '1', '1', '1', '1', '0.5', '0.5', '0.5', '-0.5', '-0.5', '-0.5', '2', '9']);
    expect(lits('float A[9] = float[9](1.0, 2.0);')).toEqual(['9', '1', '2']);
    expect(lits('textureSampleLevel(t, s, uv, 0.0) textureSampleLevel(t, s, uv, 2.0) textureLod(t, uv, 0.0)')).toEqual(['2']);
  });

  it('整数常量:循环上界 / 迭代次数 / 光源类型码 / 契约版本', () => {
    expect(mutate('LC', ['i <= 128', 'i <= 64'])).not.toEqual([]);
    expect(mutate('LC', ['LC_SPOT: i32 = 1', 'LC_SPOT: i32 = 2'], ['LC_AREA: i32 = 2', 'LC_AREA: i32 = 1'])).not.toEqual([]);
    expect(mutate('WR_CORE', ['WR_CONTRACT: i32 = 2', 'WR_CONTRACT: i32 = 3'])).not.toEqual([]);
    expect(mutate('CLC', ['k == 18', 'k == 17'])).not.toEqual([]);
  });

  it('顶层常量(第一个函数之前的声明)', () => {
    expect(mutate('LC', ['3.14159265358979323846', '3.0'])).not.toEqual([]);
    expect(mutate('LC', ['0.2126, 0.7152, 0.0722', '0.299, 0.587, 0.114'])).not.toEqual([]);
    expect(mutate('LC', ['const LC_LINE: i32 = 4;', ''])).not.toEqual([]);
  });

  it('符号(含放宽成多重集的函数)', () => {
    expect(mutate('LC', ['(0.5 / LC_PI)', '(-0.5 / LC_PI)'])).not.toEqual([]);
    expect(mutate('CLC', ['var sx = -1.;', 'var sx = 1.;'])).not.toEqual([]);
    expect(mutate('WR_TEX', ['> 0.5', '> -0.5'])).not.toEqual([]);
  });

  it('同一函数里两个常量互换位置', () => {
    expect(mutate('CLC', ['return .946175 * n.x * n.y', 'return .669047 * n.x * n.y'],
      ['return .669047 * n.y * n.z', 'return .946175 * n.y * n.z'])).not.toEqual([]);
  });

  it('登记例外的函数里其余常量照比(例外只放过登记的那几个字面量)', () => {
    expect(mutate('ESL', ['if (abs(n.y) > 0.95)', 'if (abs(n.y) > 0.9)'])).not.toEqual([]);
    expect(mutate('LC', ['if (cone <= 0.0)', 'if (cone <= 0.1)'])).not.toEqual([]);
    expect(mutate('LC', ['(3.0 - 2.0 * coneT)', '(3.0 - 2.5 * coneT)'])).not.toEqual([]);
  });

  it('前景层取样段', () => {
    expect(mutate('fgOcc', ['max(s.r, 1e-4)', 'max(s.r, 1e-3)'])).not.toEqual([]);
    expect(mutate('fgOcc', ['return 2.0;', 'return 1.0;'])).not.toEqual([]);
  });

  it('LOD 非 0 照比', () => {
    expect(mutate('WR_TEX', ['uv, 0.0), invert', 'uv, 1.0), invert'])).not.toEqual([]);
  });

  it('struct 字段顺序(两边都声明时)', () => {
    const g = 'struct S { float a; vec3 b[2]; };\nfloat f() { return 1.0; }';
    expect(twinDiffs('x', g, 'struct S { a: f32, b: array<vec3<f32>, 2>, }\nfn f() -> f32 { return 1.0; }')).toEqual([]);
    expect(twinDiffs('x', g, 'struct S { b: array<vec3<f32>, 2>, a: f32, }\nfn f() -> f32 { return 1.0; }')).not.toEqual([]);
  });

  it('切片标记缺失直接抛', () => {
    expect(() => sl('abc//__X_END__', 'NOPE')).toThrow();
    expect(() => sl('//__X_END__ //__X_BEGIN__', 'X')).toThrow();
  });
});
