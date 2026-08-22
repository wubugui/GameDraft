import { describe, expect, it } from 'vitest';

import SCENE_PASS from './SceneLightingPass.ts?raw';

/**
 * 去霾的**非负性**与**色度守恒**。
 *
 * 这条曾经是真 bug：写成 `max(painting - hazeAmt, 0.0)` 时，绝对量的减法配上
 * **有颜色**的霾（实测雾津街头 hazeColor = (0.835, 1.021, 1.144)）会在暗部把通道
 * **非对称地钳到 0** —— 蓝绿先死、红活下来，画面上一片红色噪点。
 * 实测该场景 7.23% 的像素被部分钳零（84% 只剩红通道）、18.87% 三通道全黑，
 * **孤立零点（肉眼看到的噪点）占 5.02%**。
 *
 * 改成"每通道至少留 HAZE_KEEP"之后孤立零点降到 0.002%。这里锁住那个性质，
 * 免得有人"顺手"把下限改回硬钳 —— 那种回退**不会报错**，只会让噪点悄悄回来。
 */

/** GLSL 里那一行的 JS 镜像。改一边必须改另一边（见文末机械契约）。 */
function dehaze(
  painting: readonly [number, number, number],
  hazeAmt: readonly [number, number, number],
  T: number,
  keep = 0.1,
): [number, number, number] {
  const div = Math.max(T, 0.15);
  return [0, 1, 2].map((i) => {
    const take = Math.min(hazeAmt[i], painting[i] * (1 - keep));
    return (painting[i] - take) / div;
  }) as [number, number, number];
}

const HAZE_COLOR: [number, number, number] = [0.835, 1.021, 1.144];

const scaled = (c: readonly [number, number, number], k: number) =>
  [c[0] * k, c[1] * k, c[2] * k] as [number, number, number];

describe('结构性保证：任何输入都不可能把通道钳到 0', () => {
  it('霾远大于像素时，仍然逐通道为正', () => {
    // 极端：像素几乎全黑，霾比它大两个数量级
    const out = dehaze([1e-4, 2e-5, 5e-6], scaled(HAZE_COLOR, 0.03), 0.85);
    for (const v of out) expect(v).toBeGreaterThan(0);
  });

  it('输出恒 ≥ 输入 × HAZE_KEEP / max(T,0.15)', () => {
    const keep = 0.1;
    for (const p of [1e-6, 1e-4, 0.003, 0.03, 0.3, 1.0]) {
      for (const s of [0.0, 0.01, 0.05, 0.2]) {
        const out = dehaze([p, p * 0.7, p * 0.3], scaled(HAZE_COLOR, s), 0.8, keep);
        expect(out[0]).toBeGreaterThanOrEqual(p * keep / 0.8 - 1e-12);
      }
    }
  });

  it('只有输入本身为 0 的通道才会输出 0', () => {
    const out = dehaze([0, 0.01, 0], scaled(HAZE_COLOR, 0.05), 0.9);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[1]).toBeGreaterThan(0);
  });
});

describe('色度守恒：下限起作用时按比例缩，不是逐通道乱砍', () => {
  it('霾压过像素时，输出与输入**同色**', () => {
    const p: [number, number, number] = [0.004, 0.0028, 0.0012];
    const out = dehaze(p, scaled(HAZE_COLOR, 0.05), 0.85);   // 霾 ≫ 像素，下限全面生效
    const ratio = out.map((v, i) => v / p[i]);
    expect(ratio[1]).toBeCloseTo(ratio[0], 9);
    expect(ratio[2]).toBeCloseTo(ratio[0], 9);
  });

  it('旧写法在同一输入下会把蓝绿砍成 0、只剩红（这正是红色噪点的来源）', () => {
    const p: [number, number, number] = [0.004, 0.0028, 0.0012];
    const amt = scaled(HAZE_COLOR, 0.0035);      // 恰好盖过绿蓝、盖不过红
    const old = p.map((v, i) => Math.max(v - amt[i], 0));
    expect(old[0]).toBeGreaterThan(0);           // 红活着
    expect(old[1]).toBe(0);                      // 绿死了
    expect(old[2]).toBe(0);                      // 蓝死了
    // 新写法：三个通道都活着
    const now = dehaze(p, amt, 0.85);
    for (const v of now) expect(v).toBeGreaterThan(0);
  });

  it('霾很小时行为与旧写法一致（不该改变已经调好的亮部）', () => {
    const p: [number, number, number] = [0.5, 0.4, 0.3];
    const amt = scaled(HAZE_COLOR, 0.01);        // 远小于像素 × 0.9
    const now = dehaze(p, amt, 0.9);
    const old = p.map((v, i) => Math.max(v - amt[i], 0) / Math.max(0.9, 0.15));
    now.forEach((v, i) => expect(v).toBeCloseTo(old[i], 12));
  });
});

describe('机械契约：GLSL 与这份镜像不许分家', () => {
  it('shader 里是下限法，不是硬钳', () => {
    expect(SCENE_PASS).toContain(
      'painting = (painting - min(hazeAmt, painting * (1.0 - HAZE_KEEP))) / max(T, 0.15);');
    expect(SCENE_PASS).toContain('#define HAZE_KEEP 0.1');
  });

  it('旧的硬钳写法必须已经不在（防回退）', () => {
    expect(SCENE_PASS).not.toContain('max(painting - uHazeColor');
  });

  it('去霾整段仍被 uHaze.y > 0 守着——占位场景 dehaze=0 必须整段跳过', () => {
    // 这是 27 个占位场景"背景逐像素零变化"的前提
    const i = SCENE_PASS.indexOf('if (uHaze.y > 0.0) {');
    expect(i).toBeGreaterThan(0);
    const j = SCENE_PASS.indexOf('HAZE_KEEP', i);
    expect(j).toBeGreaterThan(i);
  });
});

describe('形体参数不许从旧 probe 载荷继承', () => {
  it('统一光影自己写 uFlatten / uBulge，不经 syncFrame', async () => {
    // 曾经的 bug：`syncFrame` 把 `CharacterLightingSystem.shapeParams` 原样喂给新 shader，
    // 而那里的 flatten/bulge 来自旧 probe 载荷（`lighting/lighting.json` 的 shading 块），
    // 是给**旧着色模型**调的。雾津街头带着 flatten=1.0，于是新模型里
    // `n = mix(n, (0,0,-1), 1)` —— 法线整个压平，每盏灯的 N·L 都一样，方向性全丢。
    // 画面症状：角色法线调试视图是一片扁平的橄榄色 (128,128,0)，全身零形体明暗。
    const CHAR = (await import('./UnifiedCharacterShader.ts?raw')).default;
    expect(CHAR).toContain("num('uFlatten', def.characterShape?.flatten ?? 0);");
    expect(CHAR).toContain("num('uBulge', def.characterShape?.bulge ?? 0.22);");
  });

  it('缺省必须是 flatten=0（用真实法线）', async () => {
    const CHAR = (await import('./UnifiedCharacterShader.ts?raw')).default;
    // 缺省若是 1，法线图集就白配了——整套 N·L 与法线烘焙都失去意义
    expect(CHAR).not.toContain("characterShape?.flatten ?? 1");
  });

  it('syncFrame 只喂位姿与 AO，不再带形体参数', async () => {
    const CO = (await import('../../core/UnifiedCharacterLighting.ts?raw')).default;
    expect(CO).toContain("ao: { aoContact: number; aoForm: number }");
    expect(CO).not.toContain("shape.flatten");
    expect(CO).not.toContain("shape.bulge");
  });
});
