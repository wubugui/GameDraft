import { describe, expect, it } from 'vitest';
import type { PerspectiveScaleConfig } from '../data/types';
import {
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
