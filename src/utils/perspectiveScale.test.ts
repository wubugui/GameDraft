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

const TWO = { rulers: [{ y: 100, scale: 0.5 }, { y: 500, scale: 1.0 }] };
const TWO_UNSORTED = { rulers: [{ y: 500, scale: 1.0 }, { y: 100, scale: 0.5 }] };
const THREE = {
  rulers: [{ y: 0, scale: 0.2 }, { y: 100, scale: 0.4 }, { y: 300, scale: 1.0 }],
};
const WITH_INVALID = {
  rulers: [
    { y: Number.NaN, scale: 1 },
    { y: 100, scale: 0.5 },
    { y: 0, scale: 0 },
    { y: 500, scale: 2.0 },
  ],
};
const DUP_Y = {
  rulers: [{ y: 100, scale: 0.5 }, { y: 100, scale: 0.8 }, { y: 200, scale: 1.0 }],
};
const TINY = { rulers: [{ y: 0, scale: 0.001 }, { y: 100, scale: 0.001 }] };

// (cfg, footY) -> 期望系数（黄金常量，与 Python 侧完全一致）
const GOLDEN_SCALE_AT: Array<[PerspectiveScaleConfig | null, number, number]> = [
  [null, 300, 1.0],
  [{ rulers: [{ y: 100, scale: 0.5 }] }, 100, 1.0],
  [TWO, 100, 0.5],
  [TWO, 500, 1.0],
  [TWO, 300, 0.75],
  [TWO, 0, 0.5],
  [TWO, 600, 1.0],
  [TWO_UNSORTED, 300, 0.75],
  [THREE, 50, 0.3],
  [THREE, 200, 0.7],
  [WITH_INVALID, 300, 1.25],
  [DUP_Y, 100, 0.5],
  [DUP_Y, 150, 0.9],
  [TINY, 50, 0.01],
  [TWO, Number.NaN, 1.0],
];

describe('perspectiveScaleAt（黄金 parity，与 Python 侧同数值）', () => {
  it('golden cases', () => {
    for (const [cfg, footY, want] of GOLDEN_SCALE_AT) {
      expect(perspectiveScaleAt(cfg, footY), `cfg=${JSON.stringify(cfg)} y=${footY}`)
        .toBeCloseTo(want, 6);
    }
  });

  it('resolver 与纯函数同值', () => {
    for (const [cfg, footY, want] of GOLDEN_SCALE_AT) {
      const r = createPerspectiveScaleResolver(cfg);
      expect(r ? r.scaleAt(footY) : 1.0).toBeCloseTo(want, 6);
    }
  });

  it('hasPerspectiveScale / affectsSpeed', () => {
    expect(hasPerspectiveScale(null)).toBe(false);
    expect(hasPerspectiveScale({ rulers: [{ y: 1, scale: 1 }] })).toBe(false);
    expect(hasPerspectiveScale(TWO)).toBe(true);
    expect(perspectiveAffectsSpeed(TWO)).toBe(true);
    expect(perspectiveAffectsSpeed({ ...TWO, affectsSpeed: false })).toBe(false);
    expect(perspectiveAffectsSpeed(null)).toBe(false);
  });
});
