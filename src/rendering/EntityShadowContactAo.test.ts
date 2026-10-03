/**
 * 接触 AO(胶囊 AO)片元 CONTACT_FRAG_WGSL 的守门 + 无方向部分 capsuleOmni 的物理钉值。
 *
 * master 2026-09-25 把无方向部分从「平底实心圆柱、贴身体表面归一」换成胶囊的余弦加权遮蔽 capsuleOmni
 * (8 片方位角求积)。移错**不报错**,只是脚下 AO 的形状不对,所以这里钉三件事:
 *
 * 1. 函数集合齐、切片数 OMNI_SLICES = 8;
 * 2. capsuleOmni 机械转成 JS 求值:对得上 master 离线蒙特卡洛(40 万条射线)的钉值(tools/editor 的
 *    test_npc_contact_shadow_form 同一张表、同一容差)和这里独立的确定性求积(射线 × 胶囊精确求交);
 * 3. 主函数里调用的实参 = master 的(顶 = max(近场高, 半径)),旧的圆柱式不再出现。
 *
 * 与 master 的 GLSL 版逐像素一致由 tools/render_parity 的「实体 / contact」用例钉住。
 * 实机核对(2026-09-27,Chromium WebGPU / Intel Gen12 + WebGL2):CONTACT 程序整段编译 0 条消息、建管线通过;
 * capsuleOmni 在 966 组输入上 WGSL(compute)对 master 的 GLSL(WebGL2)最大差 5.4e-7,对 JS 双精度 < 2e-5。
 */
import { describe, expect, it } from 'vitest';
import { CONTACT_FRAG_WGSL } from './EntityShadow';
import { ContactAoTransition } from './contactAoTransition';
import { resolveContactAo } from './contactAo';

describe('动画 AO 浓度过渡', () => {
  it('首次直接采用动作开关；默认一秒淡出和淡入，终点精确落到 0/1', () => {
    const fade = new ContactAoTransition();
    const defaults = resolveContactAo(undefined, { contact: 0.75, contactSize: 1 });
    const step = (enabled: boolean, ms: number) => fade.update(enabled, ms, defaults.fadeInMs, defaults.fadeOutMs);
    expect(step(true, 16)).toBe(1);
    expect(step(false, 500)).toBeCloseTo(0.5);
    expect(step(false, 500)).toBe(0);
    expect(fade.active).toBe(false);
    expect(step(true, 500)).toBeCloseTo(0.5);
    expect(step(true, 500)).toBe(1);
    expect(fade.active).toBe(false);
    expect(new ContactAoTransition().update(false, 16, 250, 150)).toBe(0);
  });

  it('快速反转从当前浓度继续，重复同目标不会重启；暂停和非法 dt 不推进', () => {
    const fade = new ContactAoTransition();
    fade.reset(true);
    const out = fade.update(false, 50, 250, 150);
    expect(fade.update(true, 0, 250, 150)).toBe(out);
    expect(fade.update(true, Number.NaN, 250, 150)).toBe(out);
    expect(fade.update(true, -10, 250, 150)).toBe(out);
    const back = fade.update(true, 125, 250, 150);
    expect(back).toBeGreaterThan(out);
    expect(back).toBeLessThan(1);
    expect(fade.update(false, 0, 250, 150)).toBe(back);
    expect(fade.update(false, 150, 250, 150)).toBe(0);
  });

  it('同样游戏时间在不同帧率下得到相同浓度，0ms 配置立即完成', () => {
    const one = new ContactAoTransition();
    const many = new ContactAoTransition();
    one.reset(false);
    many.reset(false);
    const expected = one.update(true, 120, 250, 150);
    let actual = 0;
    for (let i = 0; i < 12; i++) actual = many.update(true, 10, 250, 150);
    expect(actual).toBeCloseTo(expected, 12);
    expect(many.update(false, 0, 250, 0)).toBe(0);
    expect(many.update(true, 0, 0, 150)).toBe(1);
    expect(many.active).toBe(false);
  });
});

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

interface Decls { fns: Map<string, string>; consts: Map<string, string> }

/** WGSL 顶层声明:函数名 → 整段文本,常量名 → 值表达式(按花括号深度切顶层项)。 */
function parse(src: string): Decls {
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
  if (depth !== 0) throw new Error('WGSL 花括号不配对');
  const fns = new Map<string, string>();
  const consts = new Map<string, string>();
  for (const raw of items) {
    const it = raw.trim().replace(/^@\w+\s*/, '');
    let m: RegExpExecArray | null;
    if (/^struct\b/.test(it)) continue;
    if (it.endsWith('}')) {
      m = /^fn\s+(\w+)\s*\(/.exec(it);
      if (m) fns.set(m[1], it);
    } else if ((m = /^const\s+(\w+)\s*(?::[^=]*)?=\s*([\s\S]*);$/.exec(it))) {
      consts.set(m[1], m[2].trim());
    }
  }
  return { fns, consts };
}

describe('接触 AO 片元(WGSL)的结构', () => {
  const W = parse(CONTACT_FRAG_WGSL);

  it('函数集合齐、capsuleOmni 在、切片数为 8', () => {
    // 切出来的函数集合就是 CONTACT_FRAG_WGSL 的全部(切漏了下面的求值会悄悄变松)
    expect([...W.fns.keys()].sort()).toEqual([
      'aoLightDir', 'capsuleDirOcc', 'capsuleOccAt', 'capsuleOmni', 'groundDepthAt', 'groundTexel', 'groundWorldWu', 'mainFragment', 'sourceOcc',
    ]);
    expect(W.consts.get('OMNI_SLICES')).toBe('8');
  });

  it('主函数用胶囊式、实参 = master 的(顶 = max(近场高, 半径)),旧的平底圆柱式不再出现', () => {
    const wMain = W.fns.get('mainFragment')!;
    const call = /capsuleOmni\(([^;]*)\);/.exec(wMain)?.[1].replace(/\bu\./g, '').replace(/\s+/g, '');
    expect(call).toBe('x,uRadiusWu,max(he,uRadiusWu)');
    expect(wMain).not.toMatch(/max\(x,\s*1e-4\)/);
  });

  it('GPU 仰角下限读取逐实体参数，手动档不会被 shader 的固定 25° 覆盖', () => {
    expect(W.fns.get('aoLightDir')).toContain('max(shadowUniforms.uMinElevation, atan2(v.y, hn))');
    expect(CONTACT_FRAG_WGSL).toContain('uMinElevation: f32');
  });
});

// ───────────────────────────── capsuleOmni 转成 JS 求值

/** WGSL 函数 → JS 函数(只认 capsuleOmni 用到的写法;转不干净 new Function 直接抛)。 */
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

function compile(src: string): Omni {
  const d = parse(src);
  const js = wgslFnToJs(d.fns.get('capsuleOmni')!);
  // 没转干净的类型名留在源里 ⇒ 说明 WGSL 写法变了,这里的转写要跟着改
  expect(js, js).not.toMatch(/\b(?:f32|i32|vec2<)\b/);
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

describe('capsuleOmni:就是胶囊的余弦加权遮蔽', () => {
  const wgsl = compile(CONTACT_FRAG_WGSL);

  it('处处有限、落在 [0, 1](if / else 不走 select:x 不大于 r 时 asin(r / x) 不求值;含 x < r 整圈、x = r、x > r 与顶等于半径的退化胶囊)', () => {
    for (const r of [1, 12.52]) {
      for (const top of [r, 3 * r, 46.85]) {
        for (let k = 0; k <= 160; k++) {
          const x = (k / 20) * r;
          const a = wgsl(x, r, top);
          expect(Number.isFinite(a), `x=${x} r=${r} top=${top}`).toBe(true);
          expect(a, `x=${x} r=${r} top=${top}`).toBeGreaterThanOrEqual(0);
          expect(a, `x=${x} r=${r} top=${top}`).toBeLessThanOrEqual(1 + 1e-9);
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
