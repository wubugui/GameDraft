import { describe, expect, it } from 'vitest';

import {
  cameraBackWu,
  cameraListener,
  isSuspectWuPerQUnit,
  makeListener,
  planarResolver,
  resolveWorld,
  type AudioSpaceResolver,
} from './audioSpace';
import type { SceneSpaceGeometry, Vec3 } from './sceneSpace';

/**
 * 空间化音频的验收判据不是"听着对"，而是**几何上可判定**：
 * 左边的声源必须 pan < 0、远的必须比近的轻、镜头拉远必须整体变轻且声像收窄。
 * 这些都是数，能锁死；而"听着对"锁不住任何东西——坐标空间弄反了也一样"听着有声音"。
 *
 * 几何取自 **雾津街头** 的真实产物（与 `lightSpace.test.ts` 同一份，故意共用：
 * 两处若哪天对不上，说明有人动了其中一条链）。
 */
const WUJIN: Omit<SceneSpaceGeometry, 'ground'> = {
  work: { w: 512, h: 288 },
  cal: { ppu: 112.64, cx: 256, cy: 144 },
  sceneWorld: { w: 4000, h: 2251.2 },
  basisRows: [
    1, 0, 0,
    0, Math.SQRT1_2, -Math.SQRT1_2,
    0, Math.SQRT1_2, Math.SQRT1_2,
  ],
  wuPerQUnit: 880,
};

function ground(w = 512, h = 288, base = 0.4) {
  const data = new Float32Array(w * h);
  data.fill(base);
  return { data, w, h };
}

const FIELD: AudioSpaceResolver = { mode: 'field', geo: { ...WUJIN, ground: ground() } };
const PLANAR: AudioSpaceResolver = planarResolver();

/** 场景中心，两级解算器都用它当参照点。 */
const CX = 2000;
const CY = 1125.6;

describe('resolveWorld：作者面(场景 wu) → M-world', () => {
  it('field 级：抬高只动 M-world 的 Y（真·世界上方）', () => {
    const g = resolveWorld(FIELD, { contactX: CX, contactY: CY, heightWu: 0 });
    const h = resolveWorld(FIELD, { contactX: CX, contactY: CY, heightWu: 150 });
    expect(h[0]).toBeCloseTo(g[0], 9);
    expect(h[1] - g[1]).toBeCloseTo(150, 9);
    expect(h[2]).toBeCloseTo(g[2], 9);
  });

  it('field 级：屏幕右移 ⇒ M-world +X 增大，且只增大 X', () => {
    const a = resolveWorld(FIELD, { contactX: CX, contactY: CY, heightWu: 0 });
    const b = resolveWorld(FIELD, { contactX: CX + 400, contactY: CY, heightWu: 0 });
    expect(b[0]).toBeGreaterThan(a[0]);
    expect(b[1]).toBeCloseTo(a[1], 6);
    expect(b[2]).toBeCloseTo(a[2], 6);
  });

  it('field 级：屏幕上移(y 变小) ⇒ 纵深变远（+Z 增大）', () => {
    const near = resolveWorld(FIELD, { contactX: CX, contactY: CY + 400, heightWu: 0 });
    const far = resolveWorld(FIELD, { contactX: CX, contactY: CY - 400, heightWu: 0 });
    expect(far[2]).toBeGreaterThan(near[2]);
  });

  it('planar 级：纵深符号与 field 级一致（写成正号会把前后景对调）', () => {
    const near = resolveWorld(PLANAR, { contactX: CX, contactY: CY + 400, heightWu: 0 });
    const far = resolveWorld(PLANAR, { contactX: CX, contactY: CY - 400, heightWu: 0 });
    expect(far[2]).toBeGreaterThan(near[2]);
  });

  it('planar 级：横向是精确的（1 wu 就是 1 wu）', () => {
    const a = resolveWorld(PLANAR, { contactX: CX, contactY: CY, heightWu: 0 });
    const b = resolveWorld(PLANAR, { contactX: CX + 250, contactY: CY, heightWu: 0 });
    expect(b[0] - a[0]).toBeCloseTo(250, 9);
  });
});

describe('makeListener：三轴正交化', () => {
  it('right ⊥ forward 且 right ⊥ up，三轴均为单位向量', () => {
    // 故意给一个不垂直于 forward 的 up
    const l = makeListener([0, 0, 0], [0, -1, 1], [0, 1, 0]);
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(l.right, l.forward)).toBeCloseTo(0, 9);
    expect(dot(l.right, l.up)).toBeCloseTo(0, 9);
    expect(dot(l.forward, l.up)).toBeCloseTo(0, 9);
    for (const v of [l.forward, l.up, l.right]) {
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9);
    }
  });

  it('相机听者的 right 就是 M-world 的 +X（屏幕右）—— 声像因此退化成"看到在左就听在左"', () => {
    const l = cameraListener(FIELD, CX, CY, 600);
    expect(l.right[0]).toBeCloseTo(1, 6);
    expect(l.right[1]).toBeCloseTo(0, 6);
    expect(l.right[2]).toBeCloseTo(0, 6);
  });
});

describe('cameraListener：听者站在画面后方', () => {
  it('听者到画面中心地面点的距离恰为 backWu', () => {
    const back = 600;
    const l = cameraListener(FIELD, CX, CY, back);
    const center = resolveWorld(FIELD, { contactX: CX, contactY: CY, heightWu: 0 });
    const d = Math.hypot(center[0] - l.pos[0], center[1] - l.pos[1], center[2] - l.pos[2]);
    expect(d).toBeCloseTo(back, 6);
  });

  it('听者在中心点的上方且靠近侧（45° 俯角的相机该在的位置）', () => {
    const l = cameraListener(FIELD, CX, CY, 600);
    const center = resolveWorld(FIELD, { contactX: CX, contactY: CY, heightWu: 0 });
    expect(l.pos[1]).toBeGreaterThan(center[1]); // 更高
    expect(l.pos[2]).toBeLessThan(center[2]);    // 更近（Z 小）
  });
});

describe('wuPerQUnit 的可疑值判据', () => {
  it('1 一律当可疑（真值逐场景 154–880；?? 1 的静默回落已在光照侧出过两次事故）', () => {
    expect(isSuspectWuPerQUnit(1)).toBe(true);
    expect(isSuspectWuPerQUnit(0)).toBe(true);
    expect(isSuspectWuPerQUnit(-880)).toBe(true);
    expect(isSuspectWuPerQUnit(null)).toBe(true);
    expect(isSuspectWuPerQUnit(undefined)).toBe(true);
    expect(isSuspectWuPerQUnit(NaN)).toBe(true);
  });

  it('真实取值全部放行', () => {
    for (const v of [154, 220, 573, 880]) expect(isSuspectWuPerQUnit(v)).toBe(false);
  });
});

describe('透视纵深重整（perspectiveScale 进音频距离）', () => {
  // f 只沿 x 变：near(0,·) f=2 → far(4000,·) f=0.5，中点 f=1.25
  const persp = (baseDepthWu = 600) => ({
    scaleAt: (x: number) => 2 + (0.5 - 2) * Math.min(1, Math.max(0, x / 4000)),
    baseDepthWu,
  });
  const FIELD_P: AudioSpaceResolver = {
    mode: 'field', geo: { ...WUJIN, ground: ground() }, persp: persp(),
  };
  const FWD: Vec3 = [0, -Math.SQRT1_2, Math.SQRT1_2];   // R·(0,0,1)，45° 俯角
  const depthOf = (p: Vec3) => p[0] * FWD[0] + p[1] * FWD[1] + p[2] * FWD[2];

  it('没有 persp 的解算器逐位不变——36 个场景里 30 个不配透视线，那 30 个必须零变化', () => {
    for (const [x, y] of [[0, 0], [1234, 567], [4000, 2251.2]]) {
      const a = resolveWorld(FIELD, { contactX: x, contactY: y, heightWu: 150 });
      const b = resolveWorld(
        { mode: 'field', geo: { ...WUJIN, ground: ground() } },
        { contactX: x, contactY: y, heightWu: 150 },
      );
      expect(a).toEqual(b);
    }
  });

  it('沿视线深度恰为 baseDepthWu / f —— 这是 f ∝ 1/d 的投影定义式，不是拟合出来的曲线', () => {
    for (const x of [0, 1000, 2000, 3000, 4000]) {
      const f = persp().scaleAt(x);
      const p = resolveWorld(FIELD_P, { contactX: x, contactY: 1125, heightWu: 0 });
      expect(depthOf(p)).toBeCloseTo(600 / f, 4);
    }
  });

  it('画面上人缩小 k 倍 ⇒ 深度就远 k 倍（视听不脱节的硬判据）', () => {
    const near = resolveWorld(FIELD_P, { contactX: 0, contactY: 1125, heightWu: 0 });
    const far = resolveWorld(FIELD_P, { contactX: 4000, contactY: 1125, heightWu: 0 });
    expect(depthOf(far) / depthOf(near)).toBeCloseTo(2 / 0.5, 4);   // f 从 2 掉到 0.5 = 4 倍
  });

  it('离地高度不吃透视缩放：远处的人仍是 150 wu 高，只是看着小', () => {
    for (const x of [0, 4000]) {
      const g = resolveWorld(FIELD_P, { contactX: x, contactY: 1125, heightWu: 0 });
      const h = resolveWorld(FIELD_P, { contactX: x, contactY: 1125, heightWu: 150 });
      expect(h[1] - g[1]).toBeCloseTo(150, 6);
      expect(h[0]).toBeCloseTo(g[0], 6);
      expect(h[2]).toBeCloseTo(g[2], 6);
    }
  });

  it('相机听者的视距 = 基准 × zoom比 ÷ f；两个因子相乘不相干', () => {
    expect(cameraBackWu(FIELD_P, 0, 1125, 600, 1)).toBeCloseTo(600 / 2, 6);
    expect(cameraBackWu(FIELD_P, 4000, 1125, 600, 1)).toBeCloseTo(600 / 0.5, 6);
    expect(cameraBackWu(FIELD_P, 4000, 1125, 600, 0.5)).toBeCloseTo(600 * 0.5 / 0.5, 6);
    // 没有透视标定 ⇒ 只剩 zoom 比（旧行为）
    expect(cameraBackWu(FIELD, 4000, 1125, 600, 2)).toBeCloseTo(1200, 6);
  });

  it('玩家站画面中心时，他到相机听者的距离恰是 backWu —— 透视场景里这条自洽性也不许断', () => {
    for (const x of [0, 2000, 4000]) {
      const back = cameraBackWu(FIELD_P, x, 1125, 600, 1);
      const ear = cameraListener(FIELD_P, x, 1125, back).pos;
      const foot = resolveWorld(FIELD_P, { contactX: x, contactY: 1125, heightWu: 0 });
      expect(Math.hypot(foot[0] - ear[0], foot[1] - ear[1], foot[2] - ear[2]))
        .toBeCloseTo(back, 4);
    }
  });

  it('planar 级也吃透视：没烘深度的场景（牛头凼）配了透视线一样要算', () => {
    const p: AudioSpaceResolver = { ...planarResolver(), persp: persp() };
    const near = resolveWorld(p, { contactX: 0, contactY: 400, heightWu: 0 });
    const far = resolveWorld(p, { contactX: 4000, contactY: 400, heightWu: 0 });
    const dNear = near[0] * FWD[0] + near[1] * FWD[1] + near[2] * FWD[2];
    const dFar = far[0] * FWD[0] + far[1] * FWD[1] + far[2] * FWD[2];
    expect(dNear).toBeCloseTo(600 / 2, 4);
    expect(dFar).toBeCloseTo(600 / 0.5, 4);
  });
});
