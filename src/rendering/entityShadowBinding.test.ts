import { describe, expect, it } from 'vitest';

import type { EntityShadowBinding, LightDef } from '../data/types';
import {
  parseLightRef,
  resolveBoundShadow,
  resolveBoundShadows,
  type ShadowBindingContext,
} from './entityShadowBinding';

/**
 * 这组测试守的是制作人定下的两条硬约束：
 * ①**不能自动 resolve** —— 作者绑什么就是什么，同样输入永远同样输出；
 * ②虚拟灯**只管影子**，不参与照亮。
 */

const M_IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * 游戏约定的真实 M（绕 X 转 45°、det=+1，行主序）。地面各向异性只有在这种"地面是斜的"
 * 的 M 下才有得测：单位 M 意味着相机没有俯仰、地面平面是边着看的，屏幕上根本没有地面。
 */
const C45 = Math.SQRT1_2;
const M_PITCH45 = [1, 0, 0, 0, C45, -C45, 0, C45, C45];

/**
 * 雾津街头实测：1 个伪世界 q 单位 = 880 wu。
 *
 * 灯的 `pos`/`range`/半径都是**世界空间 wu**，而 `charWorld` 与解算全在 **q** 里
 * ——因为 `intensity` 的量纲绑在距离单位上（照度 = I/r²），shader 里 march 走的是 q。
 * 下面的固件因此把"q 里的 3,4,0"写成 wu 的 2640,3520,0。
 */
const MPQ = 880;

function ctx(lights: LightDef[], over: Partial<ShadowBindingContext> = {}): ShadowBindingContext {
  return {
    charWorld: [0, 0, 0],          // 伪世界 q（与 shader 同尺）
    wuPerQUnit: MPQ,
    mRows: M_IDENTITY,
    lights,
    skyIntensity: 1,
    // 角色高 150 wu 恒定（见 lighting-scale-reference），折进 q
    charHeightQ: 150 / MPQ,
    ...over,
  };
}

const lamp = (over: Partial<LightDef> = {}): LightDef => ({
  id: 'lamp', kind: 'point', intensity: 10,
  pos: [3 * MPQ, 4 * MPQ, 0], range: 50 * MPQ, softeningRadius: 0.05 * MPQ, ...over,
});

describe('parseLightRef', () => {
  it('只认 light: 前缀', () => {
    expect(parseLightRef('light:lamp')).toBe('lamp');
    expect(parseLightRef('virtual')).toBeNull();
    expect(parseLightRef('none')).toBeNull();
    expect(parseLightRef('lamp')).toBeNull();
  });
});

describe('不投影的三种情形', () => {
  it("source: 'none' → null", () => {
    expect(resolveBoundShadow({ source: 'none' }, ctx([lamp()]))).toBeNull();
  });

  it('绑了不存在的灯 → null（不猜、不回落到别的灯）', () => {
    // ⚠ 这条是"禁止自动 resolve"的直接体现：找不到就没有影子，
    //   绝不"顺手挑一盏最近的"——那正是被否掉的旧行为。
    expect(resolveBoundShadow({ source: 'light:nope' }, ctx([lamp()]))).toBeNull();
  });

  it('绑的灯被关掉 → null', () => {
    expect(resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ enabled: false })]))).toBeNull();
  });

  it("source: 'virtual' 但没给 virtual 块 → null", () => {
    expect(resolveBoundShadow({ source: 'virtual' }, ctx([]))).toBeNull();
  });
});

describe('虚拟灯', () => {
  const v: EntityShadowBinding = {
    source: 'virtual',
    virtual: { azimuthDeg: 137, elevationDeg: 50, darkness: 0.8, softness: 0.4, length: 0 },
  };

  it('屏幕方位角**原样**用（虚拟灯没有世界位置，不绕世界坐标）', () => {
    expect(resolveBoundShadow(v, ctx([]))!.screenAngleDeg).toBe(137);
  });

  it('length 为 0 时按仰角自动算影长', () => {
    const s = resolveBoundShadow(v, ctx([]))!;
    expect(s.length).toBeCloseTo(1 / Math.tan((50 * Math.PI) / 180), 5);
  });

  it('length > 0 时原样用作者给的值（planar reach 系数，无量纲）', () => {
    // 曾经这里除以 metersPerWu ——那层「米」是凭空造的单位，已整体推倒。
    // `length` 本来就是"影长 = 角色高 × length"的倍率，除以任何东西都是错的。
    const s = resolveBoundShadow(
      { ...v, virtual: { ...v.virtual!, length: 2.5 } }, ctx([]))!;
    expect(s.length).toBe(2.5);
  });

  it('浓度被钳进 0..1', () => {
    const hi = resolveBoundShadow(
      { ...v, virtual: { ...v.virtual!, darkness: 5 } }, ctx([]))!;
    expect(hi.darkness).toBe(1);
    const lo = resolveBoundShadow(
      { ...v, virtual: { ...v.virtual!, darkness: -3 } }, ctx([]))!;
    expect(lo.darkness).toBe(0);
  });

  it('场景里有灯也不影响虚拟灯的解（虚拟灯完全不看灯表）', () => {
    const a = resolveBoundShadow(v, ctx([]))!;
    const b = resolveBoundShadow(v, ctx([lamp(), lamp({ id: 'x', pos: [-9 * MPQ, 9 * MPQ, 9 * MPQ] })]))!;
    expect(a).toEqual(b);
  });
});

describe('绑真实灯 · 方向', () => {
  it('影子倒向背光侧（灯在右上 → 影子指向左）', () => {
    // 单位 M 下 q ≡ world；灯在 +X，影子该指向 −X（屏幕角 180°）
    const s = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [10 * MPQ, 5 * MPQ, 0 * MPQ] })]))!;
    expect(Math.abs(s.screenAngleDeg)).toBeCloseTo(180, 4);
  });

  it('灯在正前方（−Z）时影子往 +Z 倒，屏幕上是 +Y 方向', () => {
    // 屏幕 y = −q.y，所以 world +Z（单位 M 下 q.z）不进屏幕角；
    // 这里验证的是水平分量参与、垂直分量不参与。
    const s = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [0 * MPQ, 8 * MPQ, -10 * MPQ] })]))!;
    expect(Number.isFinite(s.screenAngleDeg)).toBe(true);
  });

  it('仰角钳在 25..80（12° 的影子拉成薄条，真机读不出来）', () => {
    const low = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [100 * MPQ, 1 * MPQ, 0 * MPQ] })]))!;          // 几乎水平
    expect(low.elevationDeg).toBe(25);
    const high = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [0.1 * MPQ, 100 * MPQ, 0 * MPQ] })]))!;        // 几乎正上
    expect(high.elevationDeg).toBe(80);
  });

  it('平行光按 elevationDeg/azimuthDeg 定向，与角色位置无关', () => {
    const b: EntityShadowBinding = { source: 'light:moon' };
    const moon: LightDef = { id: 'moon', kind: 'directional', intensity: 1, elevationDeg: 60, azimuthDeg: 30 };
    const a1 = resolveBoundShadow(b, ctx([moon], { charWorld: [0, 0, 0] }))!;
    const a2 = resolveBoundShadow(b, ctx([moon], { charWorld: [50, 3, -20] }))!;
    expect(a1).toEqual(a2);
    expect(a1.elevationDeg).toBeCloseTo(60, 6);
  });
});

describe('剪影的三个一阶几何修正（2026-08-22）', () => {
  const at = (pos: [number, number, number], over: Partial<ShadowBindingContext> = {}) =>
    resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [pos[0] * MPQ, pos[1] * MPQ, pos[2] * MPQ] })], { mRows: M_PITCH45, ...over }))!;

  describe('地面各向异性：横着倒的影子不该再短 41%', () => {
    it('同一仰角下，沿世界 X 倒的影长 = 沿世界 Z 倒的 1/cos45 倍', () => {
      // 两盏灯同高同水平距 → 仰角逐位相同，差别只在水平方位
      const alongX = at([4, 4, 0]);      // 影子横着倒（屏幕横向）
      const alongZ = at([0, 4, 4]);      // 影子朝屏幕上下倒
      expect(alongX.elevationDeg).toBeCloseTo(alongZ.elevationDeg, 10);
      expect(alongX.length / alongZ.length).toBeCloseTo(Math.SQRT2, 6);
    });

    it('沿世界 Z 那一支保持旧口径（1/tanθ）——修的是横向偏短，不是整体拉长', () => {
      expect(at([0, 4, 4]).length).toBeCloseTo(1 / Math.tan((45 * Math.PI) / 180), 6);
    });

    it('虚拟灯不吃各向异性（作者给的是屏幕方向、调的是屏幕长度）', () => {
      const v: EntityShadowBinding = {
        source: 'virtual',
        virtual: { azimuthDeg: 0, elevationDeg: 45, darkness: 0.5, softness: 0.3, length: 0 },
      };
      const s = resolveBoundShadow(v, ctx([], { mRows: M_PITCH45 }))!;
      expect(s.length).toBeCloseTo(1 / Math.tan((45 * Math.PI) / 180), 6);
    });
  });

  describe('spread：点光的头端散开', () => {
    it('灯越低（相对角色高）头端越宽', () => {
      const low = at([4, 4, 0], { charHeightQ: 2 });
      const high = at([4, 4, 0], { charHeightQ: 0.02 });
      expect(low.spread).toBeGreaterThan(high.spread);
      // 半身高 1、灯高于胸口 4 → u=0.25 → (1+u)/(1−u)
      expect(low.spread).toBeCloseTo(1.25 / 0.75, 6);
      // 角色相对灯高小到可忽略 → 趋近平行光，不散开
      expect(high.spread).toBeGreaterThanOrEqual(1);
      expect(high.spread).toBeLessThan(1.01);
    });

    it('平行光恒不散开（平行光线投不出梯形）', () => {
      const moon: LightDef = {
        id: 'moon', kind: 'directional', intensity: 1, elevationDeg: 40, azimuthDeg: 30,
      };
      const s = resolveBoundShadow({ source: 'light:moon' },
        ctx([moon], { mRows: M_PITCH45, charHeightQ: 2 }))!;
      expect(s.spread).toBe(1);
    });

    it('灯压到头顶时封顶，不炸成整屏', () => {
      const s = at([0.2, 0.1, 0], { charHeightQ: 2 });   // 灯低于胸口
      expect(s.spread).toBeCloseTo(1.25 / 0.75, 6);
    });

    it('虚拟灯当平行光看待（没有世界位置就没有投影分母）', () => {
      const s = resolveBoundShadow(
        { source: 'virtual', virtual: { azimuthDeg: 40, elevationDeg: 45, darkness: 0.5, softness: 0.3, length: 0 } },
        ctx([]))!;
      expect(s.spread).toBe(1);
    });
  });

  describe('widthScale：迎光截面', () => {
    it('侧向受光（灯在世界 X）压到体厚，正/背受光（灯在世界 Z）保持肩宽', () => {
      expect(at([4, 4, 0]).widthScale).toBeCloseTo(0.38, 6);
      expect(at([0, 4, 4]).widthScale).toBeCloseTo(1, 6);
    });

    it('斜 45° 落在两者之间', () => {
      const d = at([4, 4, 4]).widthScale;
      expect(d).toBeGreaterThan(0.38);
      expect(d).toBeLessThan(1);
    });

    it('虚拟灯按屏幕方位角近似（屏幕横向≈世界 X）', () => {
      const v = (azimuthDeg: number): number => resolveBoundShadow(
        { source: 'virtual', virtual: { azimuthDeg, elevationDeg: 45, darkness: 0.5, softness: 0.3, length: 0 } },
        ctx([]))!.widthScale;
      expect(v(0)).toBeCloseTo(0.38, 6);
      expect(v(90)).toBeCloseTo(1, 6);
    });
  });
});

describe('绑真实灯 · 浓度', () => {
  it('灯远远压过天光 → 影子实；灯与天光相当 → 影子淡', () => {
    const strong = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ intensity: 1000 })], { skyIntensity: 0.05 }))!;
    const weak = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ intensity: 0.2 })], { skyIntensity: 5 }))!;
    expect(strong.darkness).toBeGreaterThan(weak.darkness);
    expect(strong.darkness).toBeLessThanOrEqual(1);
    expect(weak.darkness).toBeGreaterThanOrEqual(0);
  });

  it('作用半径外的灯照度衰减掉，影子跟着淡（不是硬切）', () => {
    const near = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [1, 1, 0], range: 20 })]))!;
    const far = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [40, 1, 0], range: 20 })]))!;
    expect(far.darkness).toBeLessThan(near.darkness);
  });

  it('binding.darkness 覆盖自动值', () => {
    const s = resolveBoundShadow({ source: 'light:lamp', darkness: 0.33 }, ctx([lamp()]))!;
    expect(s.darkness).toBeCloseTo(0.33, 6);
  });

  it('binding.softness / lengthScale 覆盖自动值', () => {
    const s = resolveBoundShadow(
      { source: 'light:lamp', softness: 0.9, lengthScale: 2 }, ctx([lamp()]))!;
    expect(s.softness).toBeCloseTo(0.9, 6);
    const base = resolveBoundShadow({ source: 'light:lamp' }, ctx([lamp()]))!;
    expect(s.length).toBeCloseTo(base.length * 2, 6);
  });

  it('面光比点光软（角尺寸大）', () => {
    const area: LightDef = {
      id: 'win', kind: 'area', intensity: 10, pos: [3 * MPQ, 4 * MPQ, 0],
      size: [6 * MPQ, 8 * MPQ], range: 50 * MPQ, dir: [0, 0, -1],
    };
    const soft = resolveBoundShadow({ source: 'light:win' }, ctx([area]))!;
    const hard = resolveBoundShadow({ source: 'light:lamp' }, ctx([lamp()]))!;
    expect(soft.softness).toBeGreaterThan(hard.softness);
  });
});

describe('逐帧幂等 —— 这是"手动"的全部意思', () => {
  it('同样输入解出逐位相同的结果（无时间低通、无槽位继承、无隐藏状态）', () => {
    const b: EntityShadowBinding[] = [
      { source: 'light:lamp' },
      { source: 'virtual', virtual: { azimuthDeg: 20, elevationDeg: 40, darkness: 0.5, softness: 0.3, length: 0 } },
      { source: 'none' },
    ];
    const c = ctx([lamp()]);
    const first = resolveBoundShadows(b, c);
    for (let i = 0; i < 5; i++) expect(resolveBoundShadows(b, c)).toEqual(first);
  });

  it('结果与输入**同序**，不投影的位置留 null（影子不会在列表里跳位）', () => {
    const out = resolveBoundShadows([
      { source: 'none' },
      { source: 'light:lamp' },
      { source: 'light:missing' },
    ], ctx([lamp()]));
    expect(out.length).toBe(3);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
    expect(out[2]).toBeNull();
  });

  it('多条绑定的**方向**各自独立（各绑各的灯，互不干扰）', () => {
    const two = resolveBoundShadows([
      { source: 'light:lamp' },
      { source: 'light:lamp2' },
    ], ctx([lamp(), lamp({ id: 'lamp2', pos: [-3 * MPQ, 4 * MPQ, 0 * MPQ] })]));
    const solo = resolveBoundShadow({ source: 'light:lamp' }, ctx([lamp()]));
    expect(two[0]!.screenAngleDeg).toBeCloseTo(solo!.screenAngleDeg, 6);
    expect(two[0]!.elevationDeg).toBeCloseTo(solo!.elevationDeg, 6);
    // 左右两盏灯 → 两条影子朝相反侧
    expect(two[0]!.screenAngleDeg).not.toBeCloseTo(two[1]!.screenAngleDeg, 1);
  });
});

describe('浓度是「这盏灯占全部照明的份额」', () => {
  // ⚠ 这几条一律用**真实夜景量级**的天光（0.045）。默认 fixture 的 skyIntensity=1
  //   比灯还强，那种配比下所有影子都淡，测不出灯与灯之间的分账。
  const NIGHT = { skyIntensity: 0.045 };

  it('两盏同样近的灯互相填光，各自只该有半浓（不是各投一个全黑影）', () => {
    const both = resolveBoundShadows([
      { source: 'light:lamp' }, { source: 'light:lamp2' },
    ], ctx([lamp({ pos: [3 * MPQ, 4 * MPQ, 0 * MPQ] }), lamp({ id: 'lamp2', pos: [-3 * MPQ, 4 * MPQ, 0 * MPQ] })], NIGHT));
    expect(both[0]!.darkness).toBeCloseTo(both[1]!.darkness, 6);
    expect(both[0]!.darkness).toBeGreaterThan(0.4);
    expect(both[0]!.darkness).toBeLessThan(0.55);
  });

  it('加一盏远处的灯几乎不影响浓度（份额分母按距离衰减加权，不是数灯数）', () => {
    const near = resolveBoundShadow({ source: 'light:lamp' }, ctx([lamp()]))!;
    const withFar = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp(), lamp({ id: 'far', pos: [500 * MPQ, 4 * MPQ, 0 * MPQ] })]))!;
    expect(withFar.darkness).toBeCloseTo(near.darkness, 4);
  });

  it('关掉的灯不参与填光', () => {
    const on = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [3 * MPQ, 4 * MPQ, 0 * MPQ] }), lamp({ id: 'l2', pos: [-3 * MPQ, 4 * MPQ, 0 * MPQ] })], NIGHT))!;
    const off = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp({ pos: [3 * MPQ, 4 * MPQ, 0 * MPQ] }), lamp({ id: 'l2', pos: [-3, 4, 0], enabled: false })], NIGHT))!;
    expect(off.darkness).toBeGreaterThan(on.darkness * 1.5);
  });

  it('天光越强影子越淡（天光是唯一到处都在的填充光）', () => {
    const dim = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp()], { skyIntensity: 0.01 }))!;
    const bright = resolveBoundShadow({ source: 'light:lamp' },
      ctx([lamp()], { skyIntensity: 10 }))!;
    expect(bright.darkness).toBeLessThan(dim.darkness);
  });
});
