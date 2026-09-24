import { describe, expect, it } from 'vitest';
import type { PerspectiveScaleConfig } from '../data/types';
import {
  createPerspectiveCameraFollowResolver,
  createPerspectiveScaleResolver,
  hasPerspectiveScale,
  perspectiveAffectsSpeed,
  perspectiveScaleAt,
} from './perspectiveScale';

/**
 * 透视缩放数学镜像的跨语言 parity 锁。
 * 本文件与 `tools/editor/tests/test_perspective_scale_parity.py` 钉死**同一组黄金数值**，
 * 任一侧漂移即红（编辑器 norms 第 8 条：手工镜像必配语义级 parity）。
 * 新增/修改用例时必须同步改两个文件（黄金常量一字不差）。
 */

// 竖直轴（近端底部大 → 远端顶部小），复现旧"水平线"行为
const VERT: PerspectiveScaleConfig = {
  near: { x: 0, y: 500, scale: 1.0 },
  far: { x: 0, y: 100, scale: 0.5 },
};
// 45° 斜街：near 左下大 → far 右上小；等缩放等值线垂直于轴（fx+fy 相同 → 系数相同）
const DIAG: PerspectiveScaleConfig = {
  near: { x: 100, y: 100, scale: 1.0 },
  far: { x: 500, y: 500, scale: 0.4 },
};
// 竖直轴带中途点（非线性纵深）
const MID: PerspectiveScaleConfig = {
  near: { x: 0, y: 0, scale: 0.2 },
  far: { x: 0, y: 200, scale: 1.0 },
  midStops: [{ pos: 0.5, scale: 0.4 }],
};
const DEGEN: PerspectiveScaleConfig = {
  near: { x: 0, y: 0, scale: 1.0 },
  far: { x: 0, y: 0, scale: 0.5 },
};
const TINY: PerspectiveScaleConfig = {
  near: { x: 0, y: 0, scale: 0.001 },
  far: { x: 0, y: 100, scale: 0.001 },
};

// (cfg, footX, footY) -> 期望系数（黄金常量，与 Python 侧完全一致）
const GOLDEN: Array<[PerspectiveScaleConfig | null, number, number, number]> = [
  [VERT, 0, 500, 1.0],
  [VERT, 0, 100, 0.5],
  [VERT, 0, 300, 0.75],
  [VERT, 999, 300, 0.75], // 竖直轴：fx 无关
  [VERT, 0, 600, 1.0], // 近端外钳
  [VERT, 0, 0, 0.5], // 远端外钳
  [DIAG, 100, 100, 1.0],
  [DIAG, 500, 500, 0.4],
  [DIAG, 300, 300, 0.7],
  [DIAG, 100, 500, 0.7], // 垂直等值线：与 (300,300) 同投影
  [DIAG, 500, 100, 0.7],
  [DIAG, 0, 0, 1.0], // 近端外钳
  [DIAG, 700, 700, 0.4], // 远端外钳
  [MID, 0, 0, 0.2],
  [MID, 0, 100, 0.4],
  [MID, 0, 150, 0.7],
  [MID, 0, 200, 1.0],
  [MID, 0, 50, 0.3],
  [DEGEN, 0, 0, 1.0], // 退化轴 near≈far
  [TINY, 0, 50, 0.01], // 系数下限钳制
  [VERT, Number.NaN, 300, 1.0], // 非有限脚底
  [null, 0, 300, 1.0],
];

describe('perspectiveScaleAt（黄金 parity，与 Python 侧同数值）', () => {
  it('golden cases', () => {
    for (const [cfg, fx, fy, want] of GOLDEN) {
      expect(perspectiveScaleAt(cfg, fx, fy), `cfg=${JSON.stringify(cfg)} (${fx},${fy})`)
        .toBeCloseTo(want, 6);
    }
  });

  it('resolver 与纯函数同值', () => {
    for (const [cfg, fx, fy, want] of GOLDEN) {
      const r = createPerspectiveScaleResolver(cfg);
      expect(r ? r.scaleAt(fx, fy) : 1.0).toBeCloseTo(want, 6);
    }
  });

  it('hasPerspectiveScale / affectsSpeed', () => {
    expect(hasPerspectiveScale(null)).toBe(false);
    expect(hasPerspectiveScale(DEGEN)).toBe(false); // 退化轴不生效
    expect(hasPerspectiveScale({ near: VERT.near } as PerspectiveScaleConfig)).toBe(false);
    expect(hasPerspectiveScale(VERT)).toBe(true);
    expect(perspectiveAffectsSpeed(VERT)).toBe(true);
    expect(perspectiveAffectsSpeed({ ...VERT, affectsSpeed: false })).toBe(false);
    expect(perspectiveAffectsSpeed(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 相机跟随透视（需求清单 A3.5）——同样与 Python 侧钉死同一组黄金数值
 * ------------------------------------------------------------------ */

/** 竖直轴 f: 2.0 →(0.5) 1.0 → 0.5；f(0.25)=1.5、f(0.75)=0.75 */
const FOLLOW_AXIS = {
  near: { x: 0, y: 0, scale: 2.0 },
  far: { x: 0, y: 100, scale: 0.5 },
  midStops: [{ pos: 0.5, scale: 1.0 }],
};
/** 全段跟随，上限放开（只验累计数学） */
const FOLLOW_ALL: PerspectiveScaleConfig = {
  ...FOLLOW_AXIS,
  cameraFollow: { maxZoomRatio: 10 },
};
/** 第一段关：近→中途点那截不跟随 */
const FOLLOW_OFF_FIRST: PerspectiveScaleConfig = {
  ...FOLLOW_AXIS,
  cameraFollow: { firstSegment: false, maxZoomRatio: 10 },
};
/** 第二段关：中途点→远端那截不跟随（倍数原样带到底） */
const FOLLOW_OFF_SECOND: PerspectiveScaleConfig = {
  ...FOLLOW_AXIS,
  midStops: [{ pos: 0.5, scale: 1.0, cameraFollow: false }],
  cameraFollow: { maxZoomRatio: 10 },
};
/** 基准点挪到轴中点：该处恰为基线，近端反而变成拉远 */
const FOLLOW_REF_MID: PerspectiveScaleConfig = {
  ...FOLLOW_AXIS,
  cameraFollow: { refPos: 0.5, maxZoomRatio: 10 },
};
/** 缺省上限 1.5：撞上限即停止补偿 */
const FOLLOW_CLAMPED: PerspectiveScaleConfig = { ...FOLLOW_AXIS, cameraFollow: {} };

// (cfg, footX, footY) -> 期望 zoom 倍数（黄金常量，与 Python 侧完全一致）
const FOLLOW_GOLDEN: Array<[PerspectiveScaleConfig, number, number, number]> = [
  [FOLLOW_ALL, 0, 0, 1.0],
  [FOLLOW_ALL, 0, 25, 4 / 3],
  [FOLLOW_ALL, 0, 50, 2.0],
  [FOLLOW_ALL, 0, 75, 8 / 3],
  [FOLLOW_ALL, 0, 100, 4.0], // 全开走到底 = f近/f远
  [FOLLOW_ALL, 0, -50, 1.0], // 近端外钳
  [FOLLOW_ALL, 0, 500, 4.0], // 远端外钳
  [FOLLOW_OFF_FIRST, 0, 25, 1.0],
  [FOLLOW_OFF_FIRST, 0, 50, 1.0],
  [FOLLOW_OFF_FIRST, 0, 75, 4 / 3],
  [FOLLOW_OFF_FIRST, 0, 100, 2.0],
  [FOLLOW_OFF_SECOND, 0, 25, 4 / 3],
  [FOLLOW_OFF_SECOND, 0, 50, 2.0],
  [FOLLOW_OFF_SECOND, 0, 75, 2.0], // 关闭段：原样带过去，不回落基线
  [FOLLOW_OFF_SECOND, 0, 100, 2.0],
  [FOLLOW_REF_MID, 0, 0, 0.5],
  [FOLLOW_REF_MID, 0, 50, 1.0],
  [FOLLOW_REF_MID, 0, 100, 2.0],
  [FOLLOW_CLAMPED, 0, 25, 4 / 3],
  [FOLLOW_CLAMPED, 0, 50, 1.5], // raw 2.0 撞缺省上限
  [FOLLOW_CLAMPED, 0, 100, 1.5],
];

describe('createPerspectiveCameraFollowResolver（黄金 parity，与 Python 侧同数值）', () => {
  it('golden cases', () => {
    for (const [cfg, fx, fy, want] of FOLLOW_GOLDEN) {
      const r = createPerspectiveCameraFollowResolver(cfg);
      expect(r, `cfg=${JSON.stringify(cfg)}`).not.toBeNull();
      expect(r!.zoomRatioAt(fx, fy), `cfg=${JSON.stringify(cfg)} (${fx},${fy})`)
        .toBeCloseTo(want, 6);
    }
  });

  it('不写 cameraFollow 键 = 不跟随（造不出句柄，运行时一次 zoom 都不多写）', () => {
    expect(createPerspectiveCameraFollowResolver(VERT)).toBeNull();
    expect(createPerspectiveCameraFollowResolver(MID)).toBeNull();
    expect(createPerspectiveCameraFollowResolver(null)).toBeNull();
    expect(createPerspectiveCameraFollowResolver(undefined)).toBeNull();
  });

  it('写了键但轴退化 / 端点非法 = 不跟随', () => {
    expect(createPerspectiveCameraFollowResolver({ ...DEGEN, cameraFollow: {} })).toBeNull();
    expect(createPerspectiveCameraFollowResolver(
      { near: VERT.near, cameraFollow: {} } as unknown as PerspectiveScaleConfig,
    )).toBeNull();
  });

  it('rawRatioAtFar 是未钳的整轴倍数（编辑器/校验器报「背景会被放大几倍」用它）', () => {
    expect(createPerspectiveCameraFollowResolver(FOLLOW_CLAMPED)!.rawRatioAtFar).toBeCloseTo(4.0, 6);
    expect(createPerspectiveCameraFollowResolver(FOLLOW_CLAMPED)!.maxZoomRatio).toBeCloseTo(1.5, 6);
    expect(createPerspectiveCameraFollowResolver(FOLLOW_OFF_FIRST)!.rawRatioAtFar).toBeCloseTo(2.0, 6);
    expect(createPerspectiveCameraFollowResolver(FOLLOW_OFF_SECOND)!.rawRatioAtFar).toBeCloseTo(2.0, 6);
  });

  it('midStops 乱序不影响结果（开关挂在停靠点上，对排序免疫）', () => {
    const ordered: PerspectiveScaleConfig = {
      near: { x: 0, y: 0, scale: 2.0 },
      far: { x: 0, y: 100, scale: 0.5 },
      midStops: [
        { pos: 0.25, scale: 1.5, cameraFollow: false },
        { pos: 0.5, scale: 1.0 },
      ],
      cameraFollow: { maxZoomRatio: 10 },
    };
    const shuffled: PerspectiveScaleConfig = {
      ...ordered,
      midStops: [ordered.midStops![1], ordered.midStops![0]],
    };
    const a = createPerspectiveCameraFollowResolver(ordered)!;
    const b = createPerspectiveCameraFollowResolver(shuffled)!;
    for (const y of [0, 10, 25, 40, 50, 75, 100]) {
      expect(b.zoomRatioAt(0, y), `y=${y}`).toBeCloseTo(a.zoomRatioAt(0, y), 9);
    }
    // 0→0.25 跟随（2.0/1.5），0.25→0.5 关闭（原样），0.5→1 跟随（×1.0/0.5）
    expect(a.zoomRatioAt(0, 25)).toBeCloseTo(4 / 3, 6);
    expect(a.zoomRatioAt(0, 50)).toBeCloseTo(4 / 3, 6);
    expect(a.zoomRatioAt(0, 100)).toBeCloseTo(8 / 3, 6);
  });

  it('正走反走同一点景别一样（只由位置决定，跨段不跳变）', () => {
    const r = createPerspectiveCameraFollowResolver(FOLLOW_OFF_SECOND)!;
    const forward = [0, 20, 49.999, 50, 50.001, 80, 100].map((y) => r.zoomRatioAt(0, y));
    const backward = [100, 80, 50.001, 50, 49.999, 20, 0].map((y) => r.zoomRatioAt(0, y));
    expect(backward.slice().reverse()).toEqual(forward);
    // 段边界两侧连续（关闭段把倍数原样带过去，不跳回基线）
    expect(r.zoomRatioAt(0, 50.001)).toBeCloseTo(r.zoomRatioAt(0, 49.999), 4);
  });
});
