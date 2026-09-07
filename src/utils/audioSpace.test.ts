import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPATIAL_PARAMS,
  cameraListener,
  isSuspectWuPerQUnit,
  makeListener,
  planarResolver,
  resolveWorld,
  spatialize,
  targetListener,
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

describe('spatialize：增益', () => {
  const L = cameraListener(FIELD, CX, CY, 600);
  const at = (dxWu: number, dyWu: number) =>
    resolveWorld(FIELD, { contactX: CX + dxWu, contactY: CY + dyWu, heightWu: 0 });

  it('远的比近的轻，且单调', () => {
    const gains = [0, 300, 800, 1500].map(
      (d) => spatialize(L, at(d, 0), DEFAULT_SPATIAL_PARAMS).gain,
    );
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeLessThan(gains[i - 1]);
  });

  it('增益恒在 (0,1]，且参考距离以内不再变响', () => {
    const p = { ...DEFAULT_SPATIAL_PARAMS, refDistanceWu: 1200 };
    // backWu=600 < ref=1200 ⇒ 中心点与稍偏的点都在参考距离内，增益应当都是满的
    const a = spatialize(L, at(0, 0), p);
    const b = spatialize(L, at(100, 0), p);
    expect(a.gain).toBeCloseTo(1, 9);
    expect(b.gain).toBeCloseTo(1, 9);
  });

  it('照 WebAudio inverse 模型原式：d = 2·ref 时增益恰为 1/(1+rolloff)', () => {
    const l = makeListener([0, 0, 0], [0, 0, 1], [0, 1, 0]);
    const p = { ...DEFAULT_SPATIAL_PARAMS, refDistanceWu: 150, rolloff: 1 };
    const r = spatialize(l, [300, 0, 0], p);
    expect(r.distanceWu).toBeCloseTo(300, 9);
    expect(r.gain).toBeCloseTo(0.5, 9);
  });

  it('超过 maxDistanceWu 报 inaudible', () => {
    const p = { ...DEFAULT_SPATIAL_PARAMS, maxDistanceWu: 1000 };
    expect(spatialize(L, at(0, 0), p).inaudible).toBe(false);
    expect(spatialize(L, at(5000, 0), p).inaudible).toBe(true);
  });

  it('相机听者下，画面正中的声源距离恰是 backWu —— 故 maxDistanceWu 必须大于它', () => {
    // 这条锁住一个真实的踩点：max 设得比 backWu 小，脚下的声音也会被判成听不见
    expect(spatialize(L, at(0, 0), DEFAULT_SPATIAL_PARAMS).distanceWu).toBeCloseTo(600, 6);
    const tooSmall = { ...DEFAULT_SPATIAL_PARAMS, maxDistanceWu: 500 };
    expect(spatialize(L, at(0, 0), tooSmall).inaudible).toBe(true);
  });
});

describe('spatialize：声像', () => {
  const L = cameraListener(FIELD, CX, CY, 600);
  const at = (dxWu: number) =>
    resolveWorld(FIELD, { contactX: CX + dxWu, contactY: CY, heightWu: 0 });

  it('左边的声源 pan < 0，右边的 pan > 0，正中为 0', () => {
    expect(spatialize(L, at(-600), DEFAULT_SPATIAL_PARAMS).pan).toBeLessThan(0);
    expect(spatialize(L, at(600), DEFAULT_SPATIAL_PARAMS).pan).toBeGreaterThan(0);
    expect(spatialize(L, at(0), DEFAULT_SPATIAL_PARAMS).pan).toBeCloseTo(0, 9);
  });

  it('pan 绝对值不超过 panWidth', () => {
    const p = { ...DEFAULT_SPATIAL_PARAMS, panWidth: 0.7 };
    for (const d of [-100000, -1000, -10, 10, 1000, 100000]) {
      expect(Math.abs(spatialize(L, at(d), p).pan)).toBeLessThanOrEqual(0.7 + 1e-12);
    }
  });

  it('声源贴到听者位置时声像不乱跳（听者后撤 backWu 保证了这一点）', () => {
    const r = spatialize(L, [...L.pos] as Vec3, DEFAULT_SPATIAL_PARAMS);
    expect(Number.isFinite(r.pan)).toBe(true);
    expect(r.pan).toBe(0);
  });
});

describe('推拉镜头：唯一正确的听感变化', () => {
  const SRC = resolveWorld(FIELD, { contactX: CX + 500, contactY: CY, heightWu: 0 });
  // backWu = backAtBaseZoom × (sceneBaseZoom / zoom)
  const backAt = (zoomRatio: number) => 600 * zoomRatio;

  it('镜头拉远 ⇒ 更轻', () => {
    const near = spatialize(cameraListener(FIELD, CX, CY, backAt(1)), SRC, DEFAULT_SPATIAL_PARAMS);
    const far = spatialize(cameraListener(FIELD, CX, CY, backAt(2)), SRC, DEFAULT_SPATIAL_PARAMS);
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.distanceWu).toBeGreaterThan(near.distanceWu);
  });

  it('镜头拉远 ⇒ 声像收窄（同一个世界偏移张的角变小）', () => {
    const near = spatialize(cameraListener(FIELD, CX, CY, backAt(1)), SRC, DEFAULT_SPATIAL_PARAMS);
    const far = spatialize(cameraListener(FIELD, CX, CY, backAt(2)), SRC, DEFAULT_SPATIAL_PARAMS);
    expect(Math.abs(far.pan)).toBeLessThan(Math.abs(near.pan));
  });

  it('镜头拉近 ⇒ 更响、声像更开', () => {
    const base = spatialize(cameraListener(FIELD, CX, CY, backAt(1)), SRC, DEFAULT_SPATIAL_PARAMS);
    const close = spatialize(cameraListener(FIELD, CX, CY, backAt(0.5)), SRC, DEFAULT_SPATIAL_PARAMS);
    expect(close.gain).toBeGreaterThan(base.gain);
    expect(Math.abs(close.pan)).toBeGreaterThan(Math.abs(base.pan));
  });
});

describe('听者不写死：换成任意目标都走同一条式子', () => {
  it('听者设成实体时，声像变成那个实体的左右', () => {
    // 听者站在场景中心；声源在它右边 500 wu
    const l = targetListener(FIELD, { contactX: CX, contactY: CY, heightWu: 150 });
    const right = resolveWorld(FIELD, { contactX: CX + 500, contactY: CY, heightWu: 0 });
    const left = resolveWorld(FIELD, { contactX: CX - 500, contactY: CY, heightWu: 0 });
    expect(spatialize(l, right, DEFAULT_SPATIAL_PARAMS).pan).toBeGreaterThan(0);
    expect(spatialize(l, left, DEFAULT_SPATIAL_PARAMS).pan).toBeLessThan(0);
  });

  it('听者就在声源上时距离 ≈ 0 而不是 NaN', () => {
    const t = { contactX: CX, contactY: CY, heightWu: 0 };
    const l = targetListener(FIELD, t);
    const r = spatialize(l, resolveWorld(FIELD, t), DEFAULT_SPATIAL_PARAMS);
    expect(r.distanceWu).toBeCloseTo(0, 9);
    expect(r.gain).toBeCloseTo(1, 9);
    expect(r.pan).toBe(0);
  });
});

describe('planar 降级：横向精确、纵深近似，但方向全对', () => {
  it('左右与远近的符号与 field 级一致', () => {
    const l = cameraListener(PLANAR, CX, CY, 600);
    const right = resolveWorld(PLANAR, { contactX: CX + 500, contactY: CY, heightWu: 0 });
    const left = resolveWorld(PLANAR, { contactX: CX - 500, contactY: CY, heightWu: 0 });
    const far = resolveWorld(PLANAR, { contactX: CX, contactY: CY - 900, heightWu: 0 });
    const near = resolveWorld(PLANAR, { contactX: CX, contactY: CY, heightWu: 0 });
    expect(spatialize(l, right, DEFAULT_SPATIAL_PARAMS).pan).toBeGreaterThan(0);
    expect(spatialize(l, left, DEFAULT_SPATIAL_PARAMS).pan).toBeLessThan(0);
    expect(spatialize(l, far, DEFAULT_SPATIAL_PARAMS).gain)
      .toBeLessThan(spatialize(l, near, DEFAULT_SPATIAL_PARAMS).gain);
  });

  it('planar 级的距离仍然是 wu —— 所以 refDistanceWu 在两级里意思相同', () => {
    const l = cameraListener(PLANAR, CX, CY, 0);
    const src = resolveWorld(PLANAR, { contactX: CX + 300, contactY: CY, heightWu: 0 });
    expect(spatialize(l, src, DEFAULT_SPATIAL_PARAMS).distanceWu).toBeCloseTo(300, 6);
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
