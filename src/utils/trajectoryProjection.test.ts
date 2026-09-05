/**
 * 世界空间帧 → 画面空间帧的投影：与 Python 侧（`tools/trajectory_workbench/projection.py`）
 * 共用 `trajectoryProjection.golden.json`。**两侧必须同数**——工作台落盘的回落帧
 * 与运行时开播时投出来的帧是同一条数学，哪边改了另一边不跟着改就是"编辑器骗人"。
 */
import { describe, expect, it } from 'vitest';
import goldenRaw from './trajectoryProjection.golden.json';
import {
  basisRowsFromDepthConfigR,
  flipTrajectoryKeyframes,
  projectWorldKeyframes,
  projectWorldOffset,
} from './trajectoryProjection';
import type { TrajectoryKeyframe, TrajectoryWorldKeyframe } from '../data/types';

interface GoldenCase {
  name: string;
  note: string;
  R: number[][];
  frames: TrajectoryWorldKeyframe[];
  expect: TrajectoryKeyframe[];
}

const CASES = goldenRaw as unknown as GoldenCase[];

describe('trajectoryProjection · 金标（跨语言）', () => {
  it('金标至少三例，且每例帧数与期望数相等（防被掏空）', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(3);
    for (const c of CASES) expect(c.expect.length).toBe(c.frames.length);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const rows = basisRowsFromDepthConfigR(c.R);
      expect(rows).not.toBeNull();
      const got = projectWorldKeyframes(c.frames, rows!);
      expect(got.length).toBe(c.expect.length);
      for (let i = 0; i < got.length; i++) {
        const g = got[i]! as unknown as Record<string, unknown>;
        const e = c.expect[i]! as unknown as Record<string, unknown>;
        expect(Object.keys(g).sort()).toEqual(Object.keys(e).sort());
        for (const k of Object.keys(e)) {
          expect(g[k]).toBeCloseTo(e[k] as number, 9);
        }
      }
    });
  }
});

describe('trajectoryProjection · 基', () => {
  it('depthConfig.M.R 形状不对 / det 不是 +1 时返回 null（实验室 det=−1 的那份不许进来）', () => {
    expect(basisRowsFromDepthConfigR(undefined)).toBeNull();
    expect(basisRowsFromDepthConfigR([[1, 0], [0, 1]])).toBeNull();
    expect(basisRowsFromDepthConfigR([[1, 0, 0], [0, 1, 0], [0, 0, 'x']])).toBeNull();
    const c = Math.SQRT1_2;
    expect(basisRowsFromDepthConfigR([[1, 0, 0], [0, c, -c], [0, -c, -c]])).toBeNull();   // det = −1
    expect(basisRowsFromDepthConfigR([[1, 0, 0], [0, c, -c], [0, c, c]])).toEqual([1, 0, 0, 0, c, -c, 0, c, c]);
  });

  it('正交投影是线性的：同一位移在任何锚点上投出同一偏移（这是"资产与位置无关"的数学根据）', () => {
    const rows = [1, 0, 0, 0, 0.8, -0.6, 0, 0.6, 0.8];
    const a = projectWorldOffset(rows, 10, 20, 30);
    const b = projectWorldOffset(rows, 10 + 999, 20 - 123, 30 + 5);
    const base = projectWorldOffset(rows, 999, -123, 5);
    expect(b.x - base.x).toBeCloseTo(a.x, 9);
    expect(b.y - base.y).toBeCloseTo(a.y, 9);
  });

  it('往上（+y）与往远（+z）都让画面 y 减小；往右（+x）画面 x 增大', () => {
    const rows = [1, 0, 0, 0, Math.SQRT1_2, -Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2];
    expect(projectWorldOffset(rows, 0, 100, 0).y).toBeLessThan(0);
    expect(projectWorldOffset(rows, 0, 0, 100).y).toBeLessThan(0);
    expect(projectWorldOffset(rows, 100, 0, 0)).toEqual({ x: 100, y: -0 });
  });
});

describe('trajectoryProjection · flipX', () => {
  it('x 与叠加旋转取反，其余通道原样', () => {
    const got = flipTrajectoryKeyframes([
      { atMs: 0, x: 10, y: 20, rotation: 30, scaleX: 2, scaleY: 0.5, alpha: 0.7, sortY: 25 },
      { atMs: 10, x: -3, y: 4 },
    ]);
    expect(got).toEqual([
      { atMs: 0, x: -10, y: 20, rotation: -30, scaleX: 2, scaleY: 0.5, alpha: 0.7, sortY: 25 },
      { atMs: 10, x: 3, y: 4 },
    ]);
  });
});
