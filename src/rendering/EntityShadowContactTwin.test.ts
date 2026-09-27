/**
 * 接触 AO(胶囊 AO)的 GLSL / WGSL 孪生守门 + 无方向部分 capsuleOmni 的物理钉值。
 *
 * 游戏只跑 WGSL(CONTACT_FRAG_WGSL),工作台 / WebGL 仍编 GLSL(CONTACT_FRAG);master 2026-09-25 把无方向部分
 * 从「平底实心圆柱、贴身体表面归一」换成胶囊的余弦加权遮蔽 capsuleOmni(8 片方位角求积),GLSL 是自动合进来的,
 * WGSL 要手移。移错**不报错**,只是脚下 AO 的形状不对,所以这里钉三件事:
 *
 * 1. 逐函数孪生:函数集合一致(GLSL main ↔ WGSL mainFragment)、每个函数体里的数值字面量按源码顺序一致、
 *    顶层常量(PI / OMNI_SLICES / MIN_EL)同名同值;
 * 2. capsuleOmni 两边各自机械转成 JS 求值:逐点同值(WGSL 的 if / else 与 GLSL 三元式等价),
 *    并对得上 master 离线蒙特卡洛(40 万条射线)的钉值(tools/editor 的 test_npc_contact_shadow_form 同一张表、同一容差)
 *    和这里独立的确定性求积(射线 × 胶囊精确求交);
 * 3. 主函数里调用的实参与 GLSL 一致(顶 = max(近场高, 半径)),旧的圆柱式不再出现。
 *
 * 同文件的 cast 投影剪影片元(FRAG ↔ FRAG_WGSL)顺带走第 1 条。
 * 实机核对(2026-09-27,Chromium WebGPU / Intel Gen12 + WebGL2):CONTACT 程序整段编译 0 条消息、建管线通过;
 * capsuleOmni 在 966 组输入上 WGSL(compute)对 GLSL(WebGL2)最大差 5.4e-7,对 JS 双精度 < 2e-5。
 */
import { describe, expect, it } from 'vitest';
import { CONTACT_FRAG, CONTACT_FRAG_WGSL, FRAG, FRAG_WGSL } from './EntityShadow';

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

interface Decls { fns: Map<string, string>; consts: Map<string, string> }

/** 顶层声明:函数名 → 整段文本,常量名 → 值表达式(按花括号深度切顶层项)。 */
function parse(src: string, lang: 'glsl' | 'wgsl'): Decls {
  const t = stripComments(src);
  const items: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { items.push(t.slice(from, i + 1)); from = i + 1; }
    else if (c === ';' && depth === 0) { items.push(t.slice(from, i + 1)); from = i + 1; }
  }
  if (depth !== 0) throw new Error(`${lang} 花括号不配对`);
  const fns = new Map<string, string>();
  const consts = new Map<string, string>();
  for (const raw of items) {
    const it = raw.trim().replace(/^@\w+\s*/, '');
    let m: RegExpExecArray | null;
    if (/^struct\b/.test(it)) continue;
    if (it.endsWith('}')) {
      m = lang === 'wgsl' ? /^fn\s+(\w+)\s*\(/.exec(it) : /^\w+\s+(\w+)\s*\(/.exec(it);
      if (m) fns.set(m[1], it);
    } else if ((m = lang === 'wgsl'
      ? /^const\s+(\w+)\s*(?::[^=]*)?=\s*([\s\S]*);$/.exec(it)
      : /^const\s+\w+\s+(\w+)\s*=\s*([\s\S]*);$/.exec(it))) {
      consts.set(m[1], m[2].trim());
    }
  }
  return { fns, consts };
}

/** GLSL texture(t, uv) ↔ WGSL textureSampleLevel(t, s, uv, 0.0):那个 0 号 LOD 实参不算常量。 */
function dropZeroLod(s: string): string {
  const cuts: Array<[number, number]> = [];
  for (const m of s.matchAll(/\btextureSampleLevel\s*\(/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    let comma = -1;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === ',' && depth === 1) comma = i;
    }
    if (comma >= 0 && /^\s*0+\.?0*\s*$/.test(s.slice(comma + 1, i - 1))) cuts.push([comma, i - 1]);
  }
  let out = s;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

/**
 * 数值字面量按源码顺序(紧挨着的负号算进去;1.0 ≡ 1 ≡ 1f,1e-4 ≡ 0.0001)。
 * 类型实参里的数字、WGSL 属性(@location(0) 之类)里的数字不算。
 */
function lits(s: string): string[] {
  const t = dropZeroLod(s)
    .replace(/@\w+\s*\([^)]*\)/g, ' ')
    .replace(/\b(?:vec[234]|mat[234]x[234]|texture_\w+)<[^<>]*>/g, ' ');
  return [...t.matchAll(/(-\s*)?(?<![\w.])((?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?)[fhiuFU]?(?![\w.])/g)]
    .map((m) => (m[1] ? '-' : '') + String(Number(m[2])));
}

/** WGSL 的入口名与 GLSL 的 main 对上;其余同名。 */
const WGSL_NAME: Record<string, string> = { main: 'mainFragment' };

function twinDiffs(glsl: string, wgsl: string): string[] {
  const G = parse(glsl, 'glsl');
  const W = parse(wgsl, 'wgsl');
  const diffs: string[] = [];
  if (G.fns.size === 0) diffs.push('GLSL 一个函数都没切出来');
  const matched = new Set<string>();
  for (const [n, body] of G.fns) {
    const wn = WGSL_NAME[n] ?? n;
    const wb = W.fns.get(wn);
    if (!wb) { diffs.push(`WGSL 缺函数 ${wn}`); continue; }
    matched.add(wn);
    const a = lits(body).join(',');
    const b = lits(wb).join(',');
    if (a !== b) diffs.push(`${n}: glsl[${a}] wgsl[${b}]`);
  }
  for (const n of W.fns.keys()) if (!matched.has(n)) diffs.push(`GLSL 缺函数 ${n}`);
  for (const [n, v] of G.consts) {
    const wv = W.consts.get(n);
    if (wv === undefined) { diffs.push(`WGSL 缺常量 ${n}`); continue; }
    if (lits(v).join(',') !== lits(wv).join(',')) diffs.push(`常量 ${n}: glsl[${v}] wgsl[${wv}]`);
  }
  for (const n of W.consts.keys()) if (!G.consts.has(n)) diffs.push(`GLSL 缺常量 ${n}`);
  return diffs;
}

describe('接触 AO 的 GLSL / WGSL 孪生(函数集合 + 数值字面量顺序 + 顶层常量)', () => {
  it.each([
    ['contact:CONTACT_FRAG ↔ CONTACT_FRAG_WGSL', CONTACT_FRAG, CONTACT_FRAG_WGSL],
    // 同文件的 cast 投影剪影片元顺带守住(同一套移植约定;这次 master 没改它)
    ['cast:FRAG ↔ FRAG_WGSL', FRAG, FRAG_WGSL],
  ])('%s 逐函数一致', (_tag, glsl, wgsl) => {
    const diffs = twinDiffs(glsl, wgsl);
    expect(diffs, diffs.join('\n')).toEqual([]);
  });

  it('capsuleOmni 两边都在、切片数同为 8', () => {
    const G = parse(CONTACT_FRAG, 'glsl');
    const W = parse(CONTACT_FRAG_WGSL, 'wgsl');
    // 切出来的函数集合就是 CONTACT_FRAG 的全部(切漏了孪生比较会悄悄变松)
    expect([...G.fns.keys()].sort()).toEqual([
      'aoLightDir', 'capsuleDirOcc', 'capsuleOccAt', 'capsuleOmni', 'groundDepthAt', 'groundTexel', 'groundWorldWu', 'main', 'sourceOcc',
    ]);
    expect(W.fns.has('capsuleOmni')).toBe(true);
    expect(G.consts.get('OMNI_SLICES')).toBe('8');
    expect(W.consts.get('OMNI_SLICES')).toBe('8');
  });

  it('自检:只改 WGSL 一侧 capsuleOmni 的一个常量 / 删掉它,守门必须红', () => {
    const fn = parse(CONTACT_FRAG_WGSL, 'wgsl').fns.get('capsuleOmni')!;
    const bent = fn.replace('(f32(i) + 0.5)', '(f32(i) + 0.4)');
    expect(bent).not.toBe(fn);
    expect(twinDiffs(CONTACT_FRAG, CONTACT_FRAG_WGSL.replace(fn, bent)).some((d) => d.startsWith('capsuleOmni:'))).toBe(true);
    expect(twinDiffs(CONTACT_FRAG, CONTACT_FRAG_WGSL.replace(fn, '')).some((d) => d.includes('capsuleOmni'))).toBe(true);
  });

  it('主函数用胶囊式、实参与 GLSL 相同(顶 = max(近场高, 半径)),旧的平底圆柱式不再出现', () => {
    const gMain = parse(CONTACT_FRAG, 'glsl').fns.get('main')!;
    const wMain = parse(CONTACT_FRAG_WGSL, 'wgsl').fns.get('mainFragment')!;
    const call = (s: string) => /capsuleOmni\(([^;]*)\);/.exec(s)?.[1].replace(/\bu\./g, '').replace(/\s+/g, '');
    expect(call(gMain)).toBe('x,uRadiusWu,max(he,uRadiusWu)');
    expect(call(wMain)).toBe(call(gMain));
    for (const src of [gMain, wMain]) expect(src).not.toMatch(/max\(x,\s*1e-4\)/);
  });
});

// ───────────────────────────── capsuleOmni 转成 JS 求值

/** 一段着色器函数 → JS 函数(只认 capsuleOmni 用到的写法;转不干净 new Function 直接抛)。 */
function glslFnToJs(fn: string): string {
  return fn
    .replace(/^\w+\s+(\w+)\s*\(([^)]*)\)/, (_, n: string, ps: string) =>
      `function ${n}(${ps.split(',').map((p) => p.trim().split(/\s+/).pop()).join(', ')})`)
    .replace(/\b(?:float|int)\s+(\w+)\s*=/g, 'let $1 =')
    .replace(/\bfloat\s*\(/g, '(')
    .replace(/\batan\s*\(/g, 'atan2(');
}

function wgslFnToJs(fn: string): string {
  return fn
    .replace(/^fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*\w+/, (_, n: string, ps: string) =>
      `function ${n}(${ps.split(',').map((p) => p.split(':')[0].trim()).join(', ')})`)
    .replace(/\bvar\s+(\w+)\s*:\s*\w+\s*;/g, 'let $1;')
    .replace(/\b(?:var|let)\s+(\w+)\s*(?::\s*\w+\s*)?=/g, 'let $1 =')
    .replace(/\bvec2<f32>\s*\(/g, 'vec2(')
    .replace(/\b[fi]32\s*\(/g, '(');
}

type Omni = (x: number, r: number, top: number) => number;

function compile(src: string, lang: 'glsl' | 'wgsl'): Omni {
  const d = parse(src, lang);
  const fn = d.fns.get('capsuleOmni')!;
  const js = lang === 'glsl' ? glslFnToJs(fn) : wgslFnToJs(fn);
  // 没转干净的类型名留在源里 ⇒ 说明 WGSL / GLSL 写法变了,这里的转写要跟着改
  expect(js, js).not.toMatch(/\b(?:float|int|f32|i32|vec2<)\b/);
  const env: Record<string, unknown> = {
    asin: Math.asin, atan2: Math.atan2, min: Math.min, max: Math.max, sqrt: Math.sqrt, cos: Math.cos, sin: Math.sin,
    vec2: (a: number, b: number) => [a, b],
    length: (v: number[]) => Math.sqrt(v[0] * v[0] + v[1] * v[1]),
    PI: Number(d.consts.get('PI')),
    OMNI_SLICES: Number(d.consts.get('OMNI_SLICES')),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...Object.keys(env), `${js}\nreturn capsuleOmni;`)(...Object.values(env)) as Omni;
}

/**
 * 独立参照:地面点在原点,竖直胶囊(轴在水平距离 x 处,半径 r,底端球心高 r、顶端球心高 top)的余弦加权遮蔽。
 * 余弦加权测度换元 u = sin²(仰角) 后在 (u, 方位) 上均匀,网格中点逐条射线精确求交(竖条 + 两个球),命中比例即积分。
 * 方位关于轴对称,只扫半圈。
 */
function capsuleOmniReference(x: number, r: number, top: number, n = 800): number {
  const hitSphere = (dx: number, dy: number, cy: number): boolean => {
    const b = dx * x + dy * cy;
    const disc = b * b - (x * x + cy * cy - r * r);
    return disc >= 0 && b + Math.sqrt(disc) >= 0;
  };
  let hits = 0;
  for (let j = 0; j < n; j++) {
    const phi = ((j + 0.5) / n) * Math.PI;
    const hx = Math.cos(phi);
    const p2 = x * x * Math.sin(phi) ** 2;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const se = Math.sqrt(u);
      const ce = Math.sqrt(1 - u);
      let hit = false;
      if (p2 < r * r) {
        const hw = Math.sqrt(r * r - p2);
        const s1 = x * hx + hw;
        const s0 = Math.max(0, x * hx - hw);
        if (s1 >= 0 && s1 * (se / ce) >= r && s0 * (se / ce) <= top) hit = true;
      }
      if (!hit) hit = hitSphere(ce * hx, se, r) || hitSphere(ce * hx, se, top);
      if (hit) hits++;
    }
  }
  return hits / (n * n);
}

describe('capsuleOmni:WGSL 与 GLSL 同值,且就是胶囊的余弦加权遮蔽', () => {
  const wgsl = compile(CONTACT_FRAG_WGSL, 'wgsl');
  const glsl = compile(CONTACT_FRAG, 'glsl');

  it('逐点同值(WGSL 的 if / else = GLSL 的三元式;含 x < r 整圈、x = r、x > r 与顶等于半径的退化胶囊)', () => {
    for (const r of [1, 12.52]) {
      for (const top of [r, 3 * r, 46.85]) {
        for (let k = 0; k <= 160; k++) {
          const x = (k / 20) * r;
          const a = wgsl(x, r, top);
          expect(Number.isFinite(a), `x=${x} r=${r} top=${top}`).toBe(true);
          expect(a, `x=${x} r=${r} top=${top}`).toBe(glsl(x, r, top));
        }
      }
    }
  });

  it('对得上 master 的离线蒙特卡洛钉值(主角在崖墓前段的实测尺寸 r=12.52、顶 46.85;同 test_npc_contact_shadow_form 容差)', () => {
    const r = 12.52;
    const he = 46.85;
    const truth: Array<[number, number]> = [[0, 1.0], [0.5, 0.716], [1, 0.354], [1.5, 0.214], [2, 0.149], [3, 0.082], [6, 0.02]];
    for (const [xr, v] of truth) expect(Math.abs(wgsl(xr * r, r, Math.max(he, r)) - v), `x=${xr}r`).toBeLessThan(0.008);
  });

  it('贴地那一点正好 1、x = r 与 x = 2r 处与独立的确定性求积对得上', () => {
    const r = 12.52;
    const top = 46.85;
    expect(wgsl(0, r, top)).toBeCloseTo(1, 6);
    for (const xr of [0, 1, 2]) {
      const ref = capsuleOmniReference(xr * r, r, top);
      // 8 片求积在 x = r 处偏差最大(约 0.0063,精确值 1/(2√2));其余 < 0.002
      expect(Math.abs(wgsl(xr * r, r, top) - ref), `x=${xr}r ref=${ref}`).toBeLessThan(0.008);
    }
  });

  it('柱边不再断崖:跨过 x = r 那 10% 半径的落差,不超过紧挨着内侧同宽那一段的 1.5 倍', () => {
    const r = 12.52;
    const f = (xr: number) => wgsl(xr * r, r, 46.85);
    expect(f(0.95) - f(1.05)).toBeLessThan(1.5 * (f(0.85) - f(0.95)));
    // 往外单调降
    for (let k = 0; k < 60; k++) expect(f(k * 0.1 + 0.1)).toBeLessThanOrEqual(f(k * 0.1) + 1e-12);
  });
});
