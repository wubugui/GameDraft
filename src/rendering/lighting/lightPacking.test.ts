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
  softeningWu2,
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
  it('directional **不再**走专用槽，与其它灯一样进数组（2026-08-30 契约变更）', () => {
    // 变更缘由：「原画即光照」模型删掉了 SceneLightingPass 里消费 sun 槽的那一整段，
    // 而唯一另一个消费者（统一角色 shader）也被 UNIFIED_CHAR_PATH_ENABLED 关死。
    // 继续抽 sun 槽 = 那盏灯背景不吃、角色也不吃、dropped 还不计它、日志一声不响
    // ——「失败不得伪装成功」在这条上是破的。现在它走 shader 里本来就在的
    // LC_DIRECTIONAL 分支。⚠ 代价：数组里的 directional **不投影**（那条 march 挂在
    // 已废弃的 uShadow 上），月光要影子得另立设计。
    const p = packLights(def([
      { id: 'moon', kind: 'directional', intensity: 0.4, elevationDeg: 60, azimuthDeg: 200 },
      point(),
    ]), MPQ);
    expect(p.sunIntensity).toBe(0);                // 槽恒为"无太阳"
    expect(p.count).toBe(2);                       // 两盏都在数组里
    expect(p.a[3]).toBe(LIGHT_KIND_CODE.directional);
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

  it('多盏 directional 全部落进数组（kind=3），方向走同一个角度换算', () => {
    const p = packLights(def([
      { id: 'a', kind: 'directional', intensity: 1 },
      { id: 'b', kind: 'directional', intensity: 0.2, elevationDeg: 10, azimuthDeg: 90 },
    ]), MPQ);
    expect(p.count).toBe(2);
    expect(p.a[3]).toBe(LIGHT_KIND_CODE.directional);
    expect(p.d[4]).toBeCloseTo(Math.cos(Math.PI / 18), 5);
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
    expect(out.c[1]).toBeCloseTo(softeningWu2(12), 9);
  });

  it('聚光的 C.y 也仍然是软化²', () => {
    const out = packLights(def([{
      id: 's', kind: 'spot', intensity: 1, pos: [0, 1, 0],
      dir: [0, -1, 0], softeningRadius: 9,
    }]), MPQ);
    expect(out.c[1]).toBeCloseTo(softeningWu2(9), 9);
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

  it('日月槽已停用：shadow 恒为关（2026-08-30；防回退）', () => {
    // 这条原来锁的是「日月是主光，castShadow 缺省开」。sun 槽不再被任何消费者读之后，
    // 那个缺省只会误导人以为月光有影子。锁成"恒关"是为了让回退可见。
    const p = packLights(def([{ id: 's', kind: 'directional', intensity: 1 }]), MPQ);
    expect(p.shadow[0]).toBe(0);
    expect(p.sunIntensity).toBe(0);
  });
});

describe('packEmissive', () => {
  it('没配 emissive 时增益为 0（灯只照亮、不发光）', () => {
    expect(packEmissive(def([]), MPQ)[0]).toBe(0);
  });

  it('灯体/光晕半径**原样是 wu**（铁律 0，2026-08-30 翻的口径）', () => {
    // 原来这里锁的是「折进 q」（176/880 → 0.2/1.0）。折算已移到 shader：
    // 光晕的视线积分把像素乘 uWuPerQUnit 变成 qw，于是这两个半径就是作者面那把 wu 尺。
    const e = packEmissive(def([], {
      emissive: { gain: 1, coreRadius: 176, haloRadius: 880, haloGain: 0.3 },
    }), MPQ);
    expect(e[0]).toBe(1);
    expect(e[1]).toBeCloseTo(176, 9);
    expect(e[2]).toBeCloseTo(880, 9);
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

  // ⚠ 下面这一组在 2026-08-30 **整体翻了口径**（制作人定死铁律 0：
  //   光照一律在世界空间、单位 wu）。它们原本锁的是「作用半径/位置/尺寸按
  //   wuPerQUnit 折进 q」，现在锁的是**不折** —— 折算移到 shader 一侧，
  //   由 `P = R·q × uWuPerQUnit` 一次把 q 转到 wu 世界。
  //   改这几条时请连同 coordinate-spaces.md 的铁律 0 一起看，别单看测试。

  it('作用半径**原样是 wu，不折**（铁律 0）', () => {
    const p = packLights(def([point({ range: 528 })]), MPQ);
    expect(p.c[0]).toBeCloseTo(528, 6);
  });

  it('位置**原样是 wu**，且原点仍是原点', () => {
    const p = packLights(def([point({ pos: [880, -440, 220] })]), MPQ);
    expect(p.a[0]).toBeCloseTo(880, 6);
    expect(p.a[1]).toBeCloseTo(-440, 6);
    expect(p.a[2]).toBeCloseTo(220, 6);
    const z = packLights(def([point({ pos: [0, 0, 0] })]), MPQ);
    expect([z.a[0], z.a[1], z.a[2]]).toEqual([0, 0, 0]);
  });

  it('softening 作者填的是**半径**，直接平方（wu²）', () => {
    expect(softeningWu2(88)).toBeCloseTo(88 * 88, 9);
    expect(softeningWu2(undefined)).toBeCloseTo(DEFAULT_LAMP_RADIUS_WU ** 2, 12);
  });

  it('面光半宽半高也是 wu', () => {
    const p = packLights(def([
      { id: 'a', kind: 'area', intensity: 1, size: [880, 440], dir: [0, 0, -1] },
    ]), MPQ);
    expect(p.c[2]).toBeCloseTo(440, 6);
    expect(p.c[3]).toBeCloseTo(220, 6);
  });

  it('**载荷不再随场景尺度变**：同一份灯参在两个场景里打出逐位相同的数', () => {
    // 这是铁律 0 最直接的判据。折算既然移到了 shader，打包就该与场景无关 ——
    // 换句话说：作者写 450 wu，载荷里就是 450，不管这个场景 ppu 是多少。
    const d = def([point({ range: 450, pos: [880, -440, 220] })]);
    const wujin = packLights(d, 880);     // 雾津街头
    const teahouse = packLights(d, 154);  // teahouse
    expect(teahouse.c[0]).toBe(wujin.c[0]);
    expect([...teahouse.a.slice(0, 3)]).toEqual([...wujin.a.slice(0, 3)]);
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

describe('灯的时段归属（2026-08-30「灯就是实体」）', () => {
  const def = (lights: unknown[]) => ({
    sky: { kelvin: 6500, intensity: 1, hemi: 0.9 },
    day: { sunIntensity: 0, sunElevationDeg: 45, sunAzimuthDeg: 180 },
    display: { ev: 0, tonemap: 'none' },
    lights,
  }) as never;

  it('缺省全时段 —— 旧数据零影响', () => {
    const d = def([{ id: 'a', kind: 'point', intensity: 1, pos: [0, 0, 0] }]);
    expect(packLights(d, 880, '夜').count).toBe(1);
    expect(packLights(d, 880, '辰').count).toBe(1);
    expect(packLights(d, 880, '').count).toBe(1);
  });

  it('写了 phases 就只在那些时段亮', () => {
    const d = def([
      { id: 'day', kind: 'point', intensity: 1, pos: [0, 0, 0], phases: ['辰', '午'] },
      { id: 'night', kind: 'point', intensity: 1, pos: [0, 0, 0], phases: ['夜'] },
    ]);
    expect(packLights(d, 880, '午').count).toBe(1);
    expect(packLights(d, 880, '夜').count).toBe(1);
    expect(packLights(d, 880, '暮').count).toBe(0);
  });

  it('时段为空串 = 不过滤（场景没开日夜时的安全默认：宁可多亮，不要全黑）', () => {
    const d = def([
      { id: 'day', kind: 'point', intensity: 1, pos: [0, 0, 0], phases: ['辰'] },
      { id: 'night', kind: 'point', intensity: 1, pos: [0, 0, 0], phases: ['夜'] },
    ]);
    expect(packLights(d, 880, '').count).toBe(2);
  });

  it('directional 也吃时段 —— 月亮不该在白天挂着', () => {
    const d = def([
      { id: 'moon', kind: 'directional', intensity: 2, elevationDeg: 35, phases: ['夜'] },
    ]);
    expect(packLights(d, 880, '夜').count).toBe(1);
    expect(packLights(d, 880, '午').count).toBe(0);
  });

  it('空 phases 数组当作没写（不是"一个时段都不亮"）', () => {
    const d = def([{ id: 'a', kind: 'point', intensity: 1, pos: [0, 0, 0], phases: [] }]);
    expect(packLights(d, 880, '夜').count).toBe(1);
  });
});
