import { describe, expect, it } from 'vitest';
import type { Texture } from '../engine2d';
import {
  depthScaleLookup, loadBackgroundSwayInput, stepSwayOscillator, swayBendAngle, swayInsertIndex,
} from './backgroundSway';
import type { SceneData } from '../data/types';

/** 与烘焙端 `sway_field.scale_from_depth`(np.interp)同口径:表内线性、表外钳两端、下限 0.01 */
describe('depthScaleLookup', () => {
  const tbl: [number, number][] = [[-1.2, 1.7], [0, 0.8], [1, 0.25]];

  it('表内线性插值', () => {
    expect(depthScaleLookup(tbl, -0.6)).toBeCloseTo(1.25, 10);
    expect(depthScaleLookup(tbl, 0.5)).toBeCloseTo(0.525, 10);
    expect(depthScaleLookup(tbl, 0)).toBeCloseTo(0.8, 10);
  });

  it('表外钳两端', () => {
    expect(depthScaleLookup(tbl, -5)).toBe(1.7);
    expect(depthScaleLookup(tbl, 9)).toBe(0.25);
  });

  it('系数不低于 0.01', () => {
    expect(depthScaleLookup([[0, 0.5], [1, -1]], 0.9)).toBe(0.01);
  });
});

/**
 * 草木的惯性：风只给目标角度，株自己解二阶振子。这几条钉的是"有惯性"本身——
 * 准静态那版（直接把目标当姿态）会让每一条都红。
 */
describe('stepSwayOscillator', () => {
  const H = 1 / 120;
  /** 一路跑到 t 秒，返回角度序列（每子步一个） */
  const run = (target: number, om0: number, zeta: number, secs: number, th0 = 0): number[] => {
    const st = new Float32Array([th0, 0]);
    const out: number[] = [];
    for (let i = 0; i < Math.round(secs / H); i++) {
      stepSwayOscillator(st, 0, target, om0 * om0, 2 * zeta * om0, H, 1);
      out.push(st[0]);
    }
    return out;
  };

  it('阶跃会过冲，不是瞬间到位', () => {
    const om0 = 2 * Math.PI * 1;                       // 1 Hz
    const a = run(1, om0, 0.2, 4);
    expect(a[0]).toBeLessThan(0.05);                   // 第一子步几乎没动（有惯性）
    const peak = Math.max(...a);
    expect(peak).toBeGreaterThan(1.3);                 // ζ=0.2 的理论过冲 ≈ 52%
    expect(peak).toBeLessThan(1.7);
  });

  it('余振的周期 = 固有周期，而且会衰减到终值', () => {
    const om0 = 2 * Math.PI * 2;                       // 2 Hz ⇒ 周期 0.5 s
    const a = run(1, om0, 0.08, 6);
    const peaks: number[] = [];
    for (let i = 1; i < a.length - 1; i++) if (a[i] > a[i - 1] && a[i] >= a[i + 1]) peaks.push(i * H);
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    expect(peaks[1] - peaks[0]).toBeCloseTo(0.5, 1);   // 阻尼小 ⇒ 阻尼周期 ≈ 固有周期
    expect(a[a.length - 1]).toBeCloseTo(1, 2);         // 最终停在目标上
  });

  it('阻尼越大过冲越小', () => {
    const om0 = 2 * Math.PI * 1;
    const soft = Math.max(...run(1, om0, 0.1, 4));
    const hard = Math.max(...run(1, om0, 0.6, 4));
    expect(soft).toBeGreaterThan(hard);
    expect(hard).toBeLessThan(1.15);
  });

  it('子步拆多少份不改变轨迹（帧率无关）', () => {
    const om0 = 2 * Math.PI * 1.5, k1 = om0 * om0, k2 = 2 * 0.2 * om0;
    const one = new Float32Array([0, 0]), four = new Float32Array([0, 0]);
    for (let i = 0; i < 240; i++) {
      stepSwayOscillator(one, 0, 1, k1, k2, H, 1);
      stepSwayOscillator(four, 0, 1, k1, k2, H / 4, 4);
    }
    expect(four[0]).toBeCloseTo(one[0], 2);
  });

  it('常年被吹也不发散（大风里的稳定性）', () => {
    const a = run(0.35, 2 * Math.PI * 5, 0.12, 30);
    expect(Number.isFinite(a[a.length - 1])).toBe(true);
    expect(a[a.length - 1]).toBeCloseTo(0.35, 3);
  });
});

/**
 * 弯角的饱和：看得见的晃动是「阵风峰值的弯角 − 平时的弯角」，所以**饱和方式决定强风里还动不动**。
 * 硬截断(`min(θmax, ...)`)会让平均与峰值双双顶到天花板、相减恒为 0 —— 制作人 2026-09-12 实测到的
 * "风速调很大反而一动不动"。这几条钉的就是"不许再出现死区"。
 */
describe('swayBendAngle', () => {
  const TH = 0.35;
  /** 平均风与阵风顶峰之间的弯角差 = 能看见的摆幅 */
  const amp = (x: number): number => swayBendAngle(TH * x * 1.8 * 1.8) - swayBendAngle(TH * x);

  it('小风下与"θ ∝ 风速平方"一致', () => {
    expect(swayBendAngle(TH * 0.01)).toBeCloseTo(TH * 0.01, 3);
    expect(swayBendAngle(TH * 0.05) / swayBendAngle(TH * 0.025)).toBeGreaterThan(1.9);
  });

  it('渐近到上限但永远不超过', () => {
    expect(swayBendAngle(TH * 1e6)).toBeLessThan(TH);
    expect(swayBendAngle(TH * 1e6)).toBeGreaterThan(TH * 0.99);
    let prev = -1;
    for (const x of [0.1, 0.5, 1, 2, 5, 20, 100]) {
      const v = swayBendAngle(TH * x);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('🔴 强风里摆幅只是变小，绝不归零（没有死区）', () => {
    for (const x of [1, 4, 16, 64, 256]) expect(amp(x)).toBeGreaterThan(0);
    // 硬截断那版在 x ≥ 1/1.8² 之后恒为 0：这里对照一下，确保我们不是那条曲线
    const hard = (x: number) => Math.min(TH, TH * x * 1.8 * 1.8) - Math.min(TH, TH * x);
    expect(hard(4)).toBe(0);
    expect(amp(4)).toBeGreaterThan(0.01);
  });

  it('摆幅在 U ≈ U_b 附近最大，再大就压下去（顺风收拢）', () => {
    const peak = [0.25, 0.5, 1, 2, 4, 8].map(amp);
    const iMax = peak.indexOf(Math.max(...peak));
    expect(iMax).toBeGreaterThanOrEqual(1);
    expect(iMax).toBeLessThanOrEqual(3);
    expect(peak[peak.length - 1]).toBeLessThan(peak[iMax]);
  });
});

/**
 * 热重载的缓存戳:草木工作台重烘后原地重装,URL **必须**带 `?v=<rev>`。
 * `AssetManager` 按 URL 缓存纹理,漏一张就是那一张永远是旧图——而且不报错,
 * 症状只是"推了没反应"(制作人会以为工具坏了)。
 */
describe('loadBackgroundSwayInput 的缓存戳', () => {
  const SCENE = {
    worldWidth: 100, worldHeight: 50,
    wind: { direction: [-1, 0, 0], speed: 400 },
    depthConfig: {
      M: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ppu: 10, cx: 0, cy: 0 },
      depth_mapping: { invert: false, scale: 1, offset: 0 },
      depth_map: 'raw_depth_rg.png',
    },
  } as unknown as SceneData;
  const META = {
    version: 3, margin: 12,
    plate: { file: 'sway_plate.png' }, matte: 'sway_matte.png', ids: 'sway_ids.png', rigid: 'sway_rigid.png',
    instances: [{ id: 1, kind: 'field', root: [10, 40], height: 60, persp: 1, reach: 20, bbox: [0, 20, 40, 50] }],
  };
  const fakeTex = { width: 64, height: 32, source: {} } as unknown as Texture;

  const run = async (cacheBust?: string) => {
    const asked: string[] = [];
    const am = {
      loadOptionalJson: async (p: string) => { asked.push(p); return META as never; },
      loadTexture: async (p: string) => { asked.push(p); return fakeTex; },
      getTexture: () => null,
    };
    await loadBackgroundSwayInput(am, SCENE, { bakeDir: '/bake', depth: '/d.png', cacheBust }, () => {});
    return asked;
  };

  it('给了缓存戳 ⇒ sway.json 与四张图**每一个**都带上', async () => {
    const asked = await run('7');
    expect(asked.length).toBeGreaterThanOrEqual(5);
    for (const u of asked) expect(u, u).toContain('?v=7');
    for (const f of ['sway.json', 'sway_plate.png', 'sway_matte.png', 'sway_ids.png', 'sway_rigid.png']) {
      expect(asked.some((u) => u.includes(f)), f).toBe(true);
    }
  });

  it('没给 ⇒ 一个都不带（进场景那次别把缓存搅乱）', async () => {
    for (const u of await run()) expect(u).not.toContain('?v=');
  });
});

/** 热重载时新层插回哪儿:插错 = 草木跑到实体前面或后面（画面很显眼，但没有断言看得住） */
describe('swayInsertIndex', () => {
  it('插回旧层原来的位置', () => {
    expect(swayInsertIndex(0, 3)).toBe(0);
    expect(swayInsertIndex(2, 5)).toBe(2);
  });

  it('旧层已经不在场上 ⇒ 追加到末尾', () => {
    expect(swayInsertIndex(-1, 4)).toBe(4);
  });

  it('旧层下标比现有子节点还大（同时少了别的层）⇒ 钳到末尾，不许越界抛异常', () => {
    expect(swayInsertIndex(9, 3)).toBe(3);
  });

  it('空容器 / 负数都给得出合法下标', () => {
    expect(swayInsertIndex(0, 0)).toBe(0);
    expect(swayInsertIndex(-5, 0)).toBe(0);
    expect(swayInsertIndex(1, -1)).toBe(0);
  });
});
