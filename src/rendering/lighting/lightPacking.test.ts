import { describe, expect, it } from 'vitest';

import type { LightDef, SceneLightingDef } from '../../data/types';
import {
  CHARACTER_HEIGHT_WU,
  DEFAULT_LAMP_RADIUS_WU,
  DEFAULT_LIGHT_RANGE_WU,
  DEFAULT_SHADOW_BIAS_WU,
  DEFAULT_SHADOW_THICKNESS_WU,
  LIGHT_FLAG_CAST_SHADOW,
  LIGHT_FLAG_TWO_SIDED,
  LIGHT_KIND_CODE,
  MAX_STATIC_LIGHTS,
  SHADOW_LIGHT_BUDGET,
  directionFromAngles,
  packEmissive,
  packLights,
  packShadowBias,
  shadowLightCount,
  softeningQ2,
} from './lightPacking';

/**
 * `packLights` 是**场景背景与角色共用的同一次打包**——两边读的是同一个返回值。
 * 所以这里锁死的不只是"打包对不对"，还有"两边不可能分家"这个结构性保证的地基。
 */

function def(lights: LightDef[], extra: Partial<SceneLightingDef> = {}): SceneLightingDef {
  return {
    sky: { intensity: 1, hemi: 0.7, color: [1, 1, 1] },
    day: { sunIntensity: 0.8, sunElevationDeg: 50, sunAzimuthDeg: 150 },
    lights,
    display: {
      ev: 0, tonemap: 'filmic', whiteKelvin: 6500,
      contrast: 1, saturation: 1, lift: 0, liftKelvin: 6500,
    },
    ...extra,
  };
}

/** 雾津街头实测：1 个伪世界 q 单位 = 880 wu。 */
const MPQ = 880;

const point = (over: Partial<LightDef> = {}): LightDef => ({
  id: 'p', kind: 'point', intensity: 2, pos: [1, 2, 3], ...over,
});

describe('directionFromAngles', () => {
  it('方位 0 = 画面深处（Z 分量为 +cos·cos，不是 −）', () => {
    // ⚠ 这条锁的是符号。翻号会让所有已调好的场景里的太阳与聚光整体前后颠倒，
    //    而且画面"只是看着不对"，不会有任何报错。
    const d = directionFromAngles(0, 0);
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(0, 6);
    expect(d[2]).toBeCloseTo(1, 6);
  });

  it('方位 90 = 右侧，仰角 90 = 正上', () => {
    const right = directionFromAngles(0, 90);
    expect(right[0]).toBeCloseTo(1, 6);
    expect(right[2]).toBeCloseTo(0, 6);
    const up = directionFromAngles(90, 0);
    expect(up[1]).toBeCloseTo(1, 6);
  });

  it('与编辑器 scene_lights.spot_dir_from_angles 同式（单位长度）', () => {
    for (const [el, az] of [[0, 0], [30, 45], [-20, 200], [80, 330]]) {
      const d = directionFromAngles(el, az);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
    }
  });
});

describe('packLights · 日月专用槽', () => {
  it('第一盏 enabled 的 directional 走专用槽，不进数组', () => {
    const p = packLights(def([
      { id: 'moon', kind: 'directional', intensity: 0.4, elevationDeg: 60, azimuthDeg: 200 },
      point(),
    ]), MPQ);
    expect(p.sunIntensity).toBe(0.4);
    expect(p.count).toBe(1);                       // 只剩那盏点光
    expect(p.a[3]).toBe(LIGHT_KIND_CODE.point);
  });

  it('没有 directional 时日月槽关掉（强度 0、投影 0）', () => {
    const p = packLights(def([point()]), MPQ);
    expect(p.sunIntensity).toBe(0);
    expect(p.shadow[0]).toBe(0);
  });

  it('disabled 的 directional 不占专用槽，也不进数组', () => {
    const p = packLights(def([
      { id: 'off', kind: 'directional', intensity: 9, enabled: false },
      point(),
    ]), MPQ);
    expect(p.sunIntensity).toBe(0);
    expect(p.count).toBe(1);
  });

  it('第二盏起的 directional 落进数组（kind=3）', () => {
    const p = packLights(def([
      { id: 'a', kind: 'directional', intensity: 1 },
      { id: 'b', kind: 'directional', intensity: 0.2, elevationDeg: 10, azimuthDeg: 90 },
    ]), MPQ);
    expect(p.count).toBe(1);
    expect(p.a[3]).toBe(LIGHT_KIND_CODE.directional);
    // 数组里的 directional 方向也走同一个角度换算
    expect(p.d[0]).toBeCloseTo(Math.cos(Math.PI / 18), 5);
  });
});

describe('packLights · 角度类不受尺度影响', () => {
  it('聚光把角度存成余弦，内锥余弦 > 外锥余弦', () => {
    const p = packLights(def([
      { id: 'a', kind: 'spot', intensity: 1, innerAngleDeg: 20, outerAngleDeg: 45, dir: [0, -1, 0] },
    ]), MPQ);
    expect(p.c[2]).toBeCloseTo(Math.cos(Math.PI / 9), 6);
    expect(p.c[3]).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(p.c[2]).toBeGreaterThan(p.c[3]);
  });

  it('换个 wuPerQUnit，锥角余弦一个字都不动（它不是长度）', () => {
    const d = def([{ id: 'a', kind: 'spot', intensity: 1, innerAngleDeg: 20,
                     outerAngleDeg: 45, dir: [0, -1, 0] }]);
    expect(packLights(d, 880).c[2]).toBe(packLights(d, 154).c[2]);
  });
});

describe('packLights · C.y 按 kind 复用', () => {
  /**
   * C.y 这一格**同时**被两种东西用：点/聚光装软化半径²，面光装自转弧度。
   * 之所以敢复用，是因为 `lcAreaLight` 的参数表里根本没有软化项 —— 那一格对面光
   * 本来就是空的。但复用意味着**写串了不会报错**，只会表现成"调自转没反应"或
   * "点光突然贴脸核爆"，所以这一组必须钉死。
   */
  const area = (over: Partial<LightDef> = {}): LightDef => ({
    id: 'w', kind: 'area', intensity: 2, pos: [0, 1, 0],
    size: [200, 100], orientation: [0, 0, -1], ...over,
  });

  it('面光的 C.y 是自转**弧度**，不是软化', () => {
    const out = packLights(def([area({ rollDeg: 90 })]), MPQ);
    // 载荷是 Float32Array —— 精度到此为止（约 7 位十进制），别拿 double 的尺子量
    expect(out.c[1]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('面光没填自转时是 0（不是软化的缺省值）', () => {
    const out = packLights(def([area()]), MPQ);
    expect(out.c[1]).toBe(0);
  });

  it('面光填了软化半径也不影响 C.y（面光不吃软化）', () => {
    const out = packLights(def([area({ rollDeg: 30, softeningRadius: 77 })]), MPQ);
    expect(out.c[1]).toBeCloseTo(Math.PI / 6, 6);
  });

  it('点光的 C.y 仍然是软化²，没被自转抢走', () => {
    const out = packLights(def([point({ softeningRadius: 12 })]), MPQ);
    expect(out.c[1]).toBeCloseTo(softeningQ2(12, 1 / MPQ), 9);
  });

  it('聚光的 C.y 也仍然是软化²', () => {
    const out = packLights(def([{
      id: 's', kind: 'spot', intensity: 1, pos: [0, 1, 0],
      dir: [0, -1, 0], softeningRadius: 9,
    }]), MPQ);
    expect(out.c[1]).toBeCloseTo(softeningQ2(9, 1 / MPQ), 9);
  });

  it('自转是角度，换个 wuPerQUnit 一个字都不动（它不是长度）', () => {
    const a = packLights(def([area({ rollDeg: -47.5 })]), MPQ);
    const b = packLights(def([area({ rollDeg: -47.5 })]), 154);
    expect(a.c[1]).toBe(b.c[1]);
  });
});

describe('packLights · 上限与截断', () => {
  it('超过上限的灯被丢弃，且 dropped 报出真实盏数（静默截断不可接受）', () => {
    const many = Array.from({ length: MAX_STATIC_LIGHTS + 7 },
      (_, i) => point({ id: `p${i}` }));
    const p = packLights(def(many), MPQ);
    expect(p.count).toBe(MAX_STATIC_LIGHTS);
    expect(p.dropped).toBe(7);
  });

  it('没超上限时 dropped 为 0', () => {
    expect(packLights(def([point(), point()]), MPQ).dropped).toBe(0);
  });
});

describe('packLights · 投影标志', () => {
  it('castShadow 缺省是关的（投影灯每盏都要 march 一次深度场，不能默认开）', () => {
    expect(packLights(def([point()]), MPQ).d[3]).toBe(0);
    expect(packLights(def([point({ castShadow: true })]), MPQ).d[3]).toBe(1);
  });

  it('日月槽的 castShadow 缺省是**开**的（它是主光，没影子等于没打光）', () => {
    const p = packLights(def([{ id: 's', kind: 'directional', intensity: 1 }]), MPQ);
    expect(p.shadow[0]).toBeGreaterThan(0);
  });
});

describe('packEmissive', () => {
  it('没配 emissive 时增益为 0（灯只照亮、不发光）', () => {
    expect(packEmissive(def([]), MPQ)[0]).toBe(0);
  });

  it('灯体/光晕半径从 wu 折进 q', () => {
    const e = packEmissive(def([], {
      emissive: { gain: 1, coreRadius: 176, haloRadius: 880, haloGain: 0.3 },
    }), MPQ);
    expect(e[0]).toBe(1);
    expect(e[1]).toBeCloseTo(0.2, 9);
    expect(e[2]).toBeCloseTo(1.0, 9);
    expect(e[3]).toBe(0.3);
  });
});

describe('shadowLightCount', () => {
  it('只数 enabled 且 castShadow 的灯', () => {
    const lights: LightDef[] = [
      point({ castShadow: true }),
      point({ castShadow: true, enabled: false }),
      point({ castShadow: false }),
      point({ castShadow: true }),
    ];
    expect(shadowLightCount(lights)).toBe(2);
    expect(SHADOW_LIGHT_BUDGET).toBeGreaterThan(0);
  });
});

describe('场景与角色读的是同一份', () => {
  it('同一个 def 打两次结果逐位一致（打包是纯函数，没有隐藏状态）', () => {
    const d = def([
      { id: 'moon', kind: 'directional', intensity: 0.3, elevationDeg: 55, azimuthDeg: 210 },
      point({ id: 'lamp', castShadow: true, range: 7, kelvin: 2200 }),
      { id: 'win', kind: 'area', intensity: 3, pos: [0, 1, 0], size: [2, 3], dir: [0, 0, -1] },
      { id: 'lant', kind: 'spot', intensity: 4, pos: [2, 3, 1], dir: [0, -1, 0] },
    ]);
    const a = packLights(d, MPQ);
    const b = packLights(d, MPQ);
    for (const k of ['a', 'b', 'c', 'd'] as const) {
      expect(Array.from(a[k])).toEqual(Array.from(b[k]));
    }
    expect(a.sunColor).toEqual(b.sunColor);
    expect(a.count).toBe(b.count);
  });
});

/**
 * ## 作者面是**世界空间 wu**，shader 里 march 的是**伪世界 q**
 *
 * 这两个是**不同的空间**，差一个逐场景的比例
 * `wuPerQUnit = worldWidth / (native_w / ppu)`（雾津街头 880、teahouse 154）。
 * `packLights` 里那一次乘法就是它们之间的 transform。
 *
 * ## 这里错过两次，都不要回退
 *
 * ① 一度给所有长度加了 `*Meters` 后缀，换算系数取 `bake.py` 里写死的
 *    `1.7 / char_wu`——「假设角色 1.7 米高」。**游戏里没有米**，是凭空造的单位。
 *
 * ② 推倒①之后，又把**伪世界 q 单位**叫成了 wu，并声称"同一个 wu 数值在不同场景
 *    差 5.7 倍"。那是把**相机变换**当成了世界单位的变化：`ppu` 逐场景不同是相机
 *    标定，`worldWidth` 才是世界宽度。判据很干脆——**角色在 wu 里 28 个场景恒为 150**，
 *    在 q 里才从 0.17 变到 0.97。
 *
 * 所以：作者填 wu（与 NPC 坐标同一把尺），消费端折一次进 q，就这一处。
 */
describe('作者面 wu → 伪世界 q：只在打包处折一次', () => {
  it('尺度锚：角色高 150 wu（28 个场景恒定，缺省值都按它定）', () => {
    expect(CHARACTER_HEIGHT_WU).toBe(150);
    expect(DEFAULT_LIGHT_RANGE_WU / CHARACTER_HEIGHT_WU).toBeCloseTo(3, 1);
    expect(DEFAULT_LAMP_RADIUS_WU / CHARACTER_HEIGHT_WU).toBeCloseTo(1 / 15, 2);
    expect(DEFAULT_SHADOW_THICKNESS_WU / CHARACTER_HEIGHT_WU).toBeCloseTo(1.76, 1);
    // 这两个刻意不取整：精确等于 wu 重构之前那一版的效果（÷880 = 0.035 / 0.3）
    expect(DEFAULT_SHADOW_BIAS_WU / 880).toBeCloseTo(0.035, 12);
    expect(DEFAULT_SHADOW_THICKNESS_WU / 880).toBeCloseTo(0.3, 12);
  });

  it('作用半径按 wuPerQUnit 折进 q', () => {
    const p = packLights(def([point({ range: 528 })]), MPQ);
    expect(p.c[0]).toBeCloseTo(528 / MPQ, 6);
  });

  it('位置也折，且**原点不动**（只换尺度，不平移）', () => {
    const p = packLights(def([point({ pos: [880, -440, 220] })]), MPQ);
    expect(p.a[0]).toBeCloseTo(1, 6);
    expect(p.a[1]).toBeCloseTo(-0.5, 6);
    expect(p.a[2]).toBeCloseTo(0.25, 6);
    // 零点仍是零点
    const z = packLights(def([point({ pos: [0, 0, 0] })]), MPQ);
    expect([z.a[0], z.a[1], z.a[2]]).toEqual([0, 0, 0]);
  });

  it('softening 作者填的是**半径**，折进 q 之后才平方', () => {
    expect(softeningQ2(88, 1 / MPQ)).toBeCloseTo(0.01, 9);
    expect(softeningQ2(undefined, 1 / MPQ))
      .toBeCloseTo((DEFAULT_LAMP_RADIUS_WU / MPQ) ** 2, 12);
  });

  it('面光半宽半高同样折', () => {
    const p = packLights(def([
      { id: 'a', kind: 'area', intensity: 1, size: [880, 440], dir: [0, 0, -1] },
    ]), MPQ);
    expect(p.c[2]).toBeCloseTo(0.5, 6);
    expect(p.c[3]).toBeCloseTo(0.25, 6);
  });

  it('同一份灯参在两个尺度不同的场景里，打出的 q 值差 wuPerQUnit 的比', () => {
    // 这正是 transform 生效的判据：作者写同一个 wu 数，两个场景的 q 载荷不同
    const d = def([point({ range: 450 })]);
    const wujin = packLights(d, 880);     // 雾津街头
    const teahouse = packLights(d, 154);  // teahouse
    expect(teahouse.c[0] / wujin.c[0]).toBeCloseTo(880 / 154, 4);
  });

  it('packShadowBias 缺省是 wu，折进 q 后厚度窗远小于场景纵深', () => {
    const [bias, thick] = packShadowBias(def([]), 1 / MPQ);
    expect(bias).toBeCloseTo(DEFAULT_SHADOW_BIAS_WU / MPQ, 9);
    expect(thick).toBeCloseTo(DEFAULT_SHADOW_THICKNESS_WU / MPQ, 9);
    // 雾津街头 depth_range 跨度 3.81 个 q 单位——旧的写死值 thick=2 占了 52%
    expect(thick).toBeLessThan(3.81 * 0.15);
  });

  it('场景显式写了就用场景的；只写一半时另一半回落缺省', () => {
    const [b1, t1] = packShadowBias(def([], { shadowBias: { bias: 88, thickness: 440 } }), 1 / MPQ);
    expect(b1).toBeCloseTo(0.1, 9);
    expect(t1).toBeCloseTo(0.5, 9);
    const [b2] = packShadowBias(def([], { shadowBias: { thickness: 440 } }), 1 / MPQ);
    expect(b2).toBeCloseTo(DEFAULT_SHADOW_BIAS_WU / MPQ, 9);
  });

  it('打包是纯函数：同一份输入打两次逐位一致', () => {
    const d = def([point({ range: 450, softeningRadius: 10 })]);
    expect(Array.from(packLights(d, MPQ).c)).toEqual(Array.from(packLights(d, MPQ).c));
  });
});

describe('D.w 位标志', () => {
  const area = (over: Partial<LightDef> = {}): LightDef => ({
    id: 'win', kind: 'area', intensity: 3, pos: [0, 1, 0],
    size: [2, 3], dir: [0, 0, -1], ...over,
  });

  it('两个标志各占一位，可以同时为真', () => {
    const cases: Array<[boolean, boolean, number]> = [
      [false, false, 0],
      [true, false, LIGHT_FLAG_CAST_SHADOW],
      [false, true, LIGHT_FLAG_TWO_SIDED],
      [true, true, LIGHT_FLAG_CAST_SHADOW + LIGHT_FLAG_TWO_SIDED],
    ];
    for (const [cast, two, want] of cases) {
      const p = packLights(def([area({ castShadow: cast, twoSided: two })]), MPQ);
      expect(p.d[3]).toBe(want);
    }
  });

  it('位值就是 1 和 2（shader 里 & 1 / & 2 硬编，改这里必须同步改 shader）', () => {
    expect(LIGHT_FLAG_CAST_SHADOW).toBe(1);
    expect(LIGHT_FLAG_TWO_SIDED).toBe(2);
  });

  it('两个 shader 都按位取，不再拿 D.w 当布尔', async () => {
    const SCENE = (await import('./SceneLightingPass.ts?raw')).default;
    const CHAR = (await import('./UnifiedCharacterShader.ts?raw')).default;
    for (const src of [SCENE, CHAR]) {
      expect(src).toContain('int flags = int(D.w + 0.5);');
      expect(src).toContain('(flags & 1) != 0');
      expect(src).toContain('(flags & 2) != 0');
      // 防回退：旧的布尔读法与硬传 false
      expect(src).not.toContain('D.w > 0.5');
      expect(src).not.toContain('C.x, false, vis');
    }
  });
});
