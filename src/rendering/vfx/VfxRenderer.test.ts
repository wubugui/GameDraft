/**
 * 粒子渲染侧的两件事：**曲线采样**与**按接地锚在实体之间分桶**。
 *
 * 分桶是玩家唯一能直接看见的排序结果（蝙蝠飞到关二狗身前还是身后），而它没有任何
 * 画面之外的痕迹——排错了只是"层级有点怪"。真机实测（崖墓前段）已确认：放到玩家身后
 * 的个体脚点 416 落进低桶、身前的 784 落进 `玩家脚点+ε`；这里把那条判据钉成机械门。
 */
import { describe, expect, it } from 'vitest';
import { MAX_BUCKETS, sampleCurve, vfxParamValues } from './VfxRenderer';

describe('sampleCurve', () => {
  it('空 / 缺省恒 1', () => {
    expect(sampleCurve(undefined, 0.5)).toBe(1);
    expect(sampleCurve([], 0.5)).toBe(1);
  });
  it('端点钳位，中间线性', () => {
    const c: [number, number][] = [[0, 0], [0.5, 1], [1, 0]];
    expect(sampleCurve(c, -1)).toBe(0);
    expect(sampleCurve(c, 0)).toBe(0);
    expect(sampleCurve(c, 0.25)).toBeCloseTo(0.5, 9);
    expect(sampleCurve(c, 0.5)).toBe(1);
    expect(sampleCurve(c, 0.75)).toBeCloseTo(0.5, 9);
    expect(sampleCurve(c, 2)).toBe(0);
  });
  it('单点 = 常数', () => {
    expect(sampleCurve([[0.3, 0.7]], 0)).toBe(0.7);
    expect(sampleCurve([[0.3, 0.7]], 1)).toBe(0.7);
  });
});

/**
 * 分桶规则的纯函数镜像（与 `VfxRenderer` 的 `refreshThresholds` / `bucketOf` / `bucketFootY`
 * 同式）。渲染器本体要 Pixi 上下文，这里只锁规则本身——规则错了画面就错，而画面不报错。
 */
function buckets(entityFootYs: number[]): { of: (y: number) => number; footY: (b: number) => number } {
  const th = [...entityFootYs].sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i < th.length; i++) if (i === 0 || th[i] !== th[i - 1]) th[w++] = th[i];
  th.length = w;
  if (th.length > MAX_BUCKETS - 1) {
    const keep = MAX_BUCKETS - 1;
    const out: number[] = [];
    for (let i = 0; i < keep; i++) out.push(th[Math.floor(((i + 1) * th.length) / (keep + 1))]);
    th.length = 0;
    th.push(...out);
  }
  return {
    of: (y) => { let i = 0; while (i < th.length && y >= th[i]) i++; return i; },
    footY: (b) => (th.length === 0 ? 0 : b < th.length ? th[b] - 1e-3 : th[th.length - 1] + 1e-3),
  };
}

describe('VfxRenderer · 接地锚分桶', () => {
  it('场上只有玩家时：身后进 0 桶（排在他前面之前）、身前进 1 桶', () => {
    const b = buckets([600]);
    // 真机实测的两组脚点（崖墓前段，玩家脚点 600）
    expect(b.of(416.2)).toBe(0);
    expect(b.of(783.8)).toBe(1);
    expect(b.footY(0)).toBeCloseTo(599.999, 6);   // 比玩家小 → 排他后面
    expect(b.footY(1)).toBeCloseTo(600.001, 6);   // 比玩家大 → 排他前面
  });

  it('多个实体：粒子落进相邻两实体之间，桶数 = 实体数 + 1', () => {
    const b = buckets([200, 450, 600]);
    expect(b.of(100)).toBe(0);
    expect(b.of(300)).toBe(1);
    expect(b.of(500)).toBe(2);
    expect(b.of(900)).toBe(3);
    // 每个桶的锚都严格落在它上界实体之前
    expect(b.footY(1)).toBeLessThan(450);
    expect(b.footY(2)).toBeLessThan(600);
    expect(b.footY(3)).toBeGreaterThan(600);
  });

  it('脚点恰好等于某实体时算它前面（>= 判据，与 entitySortZ 的升序同向）', () => {
    const b = buckets([600]);
    expect(b.of(600)).toBe(1);
  });

  it('实体重复脚点去重；实体多于上限时按分位数合并，桶数不超 MAX_BUCKETS', () => {
    const b = buckets([100, 100, 100]);
    expect(b.of(50)).toBe(0);
    expect(b.of(150)).toBe(1);
    const many = Array.from({ length: 40 }, (_, i) => i * 10);
    const b2 = buckets(many);
    expect(b2.of(1e9)).toBeLessThanOrEqual(MAX_BUCKETS - 1);
  });

  it('场上没有实体时退化成单桶', () => {
    const b = buckets([]);
    expect(b.of(123)).toBe(0);
    expect(b.footY(0)).toBe(0);
  });
});

/**
 * 受光 shader 的外观参数接线。这两个数没有任何画面之外的痕迹——错了只是"看着不对"。
 *
 * `uEmissive` 尤其要钉：水滴、火星这类电介质的漫反射反照率近乎 0，只靠 `lit` 的
 * 纯漫反射画出来比背景还黑（实测崖墓前段 23/255 vs 背景 68/255）。作者面填的
 * `appearance.emissive` 必须原值送到 uniform，漏接 = 效果整体退回黑疙瘩且不报错。
 */
describe('VfxRenderer · 受光外观参数（vfxParams）', () => {
  it('缺省不自发光；作者值原样送进去', () => {
    expect(vfxParamValues({}).uEmissive).toBe(0);
    expect(vfxParamValues({ emissive: 0.45 }).uEmissive).toBeCloseTo(0.45, 9);
    expect(vfxParamValues({ emissive: 1 }).uEmissive).toBe(1);
  });
  it('越界夹到 0..1（shader 里也夹，但别把脏值送过去）', () => {
    expect(vfxParamValues({ emissive: -3 }).uEmissive).toBe(0);
    expect(vfxParamValues({ emissive: 7 }).uEmissive).toBe(1);
    expect(vfxParamValues({ emissive: Number.NaN }).uEmissive).toBe(0);
  });
  it('加法混合不球化法线，普通混合球化 0.6', () => {
    expect(vfxParamValues({ blend: 'add' }).uSphere).toBe(0);
    expect(vfxParamValues({}).uSphere).toBe(0.6);
    expect(vfxParamValues({ blend: 'normal' }).uSphere).toBe(0.6);
  });
  it('两个参数互不干扰', () => {
    const v = vfxParamValues({ blend: 'add', emissive: 0.3 });
    expect(v).toEqual({ uSphere: 0, uEmissive: 0.3 });
  });
});
