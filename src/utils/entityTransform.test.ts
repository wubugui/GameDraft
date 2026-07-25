/**
 * 实例 transform 数学镜像的跨语言 parity 锁（审查 P1-2）。
 *
 * 与 `tools/editor/tests/test_entity_transform_parity.py` 钉死**同一组黄金数值**：
 * 任一侧实现漂移即红。新增/修改用例必须两个文件同步改（常量一字不差）。
 */
import { describe, expect, it } from 'vitest';
import {
  contentTopLocalYAroundFoot,
  entityRotationDegOf,
  entityScaleOf,
  quadTopLocalYAroundFoot,
  transformLocalVector,
} from './entityTransform';

const GOLDEN_SCALE_CASES: Array<[Record<string, unknown>, number]> = [
  [{}, 1.0],
  [{ scale: 2.5 }, 2.5],
  [{ scale: 2 }, 2.0],
  [{ scale: '2' }, 1.0], // 字符串数字：双侧一律拒绝回落（防预览撒谎）
  [{ scale: true }, 1.0],
  [{ scale: 0 }, 1.0],
  [{ scale: -3 }, 1.0],
  [{ scale: Number.NaN }, 1.0],
];

const GOLDEN_ROT_CASES: Array<[Record<string, unknown>, number]> = [
  [{}, 0.0],
  [{ rotation: 37.5 }, 37.5],
  [{ rotation: -400 }, -400.0],
  [{ rotation: '90' }, 0.0],
  [{ rotation: Number.POSITIVE_INFINITY }, 0.0],
];

// (lx, ly, scale, rotDeg) -> (x, y)（与 py 侧 6 位小数一致）
const GOLDEN_LOCAL_VEC_CASES: Array<[[number, number, number, number], [number, number]]> = [
  [[10.0, 0.0, 2.0, 90.0], [0.0, 20.0]],
  [[3.0, 4.0, 1.5, 37.0], [-0.01703, 7.499981]],
  [[-5.0, -8.0, 0.5, -120.0], [-2.214102, 4.165064]],
  [[7.0, 2.0, 1.0, 0.0], [7.0, 2.0]],
];

// 头顶锚：(effW, effH, rotDeg) -> quad 顶部局部 y
const GOLDEN_QUAD_TOP_CASES: Array<[[number, number, number], number]> = [
  [[100.0, 160.0, 0.0], -160.0],
  [[100.0, 160.0, 37.0], -157.872433],
  [[80.0, 120.0, 90.0], -40.0],
  [[60.0, 60.0, 180.0], 0.0],
  [[100.0, 160.0, -120.0], -43.30127],
];

// 头顶锚：(effContentW, effContentH, effBottomGap, rotDeg) -> 内容框顶部局部 y
// 第 4 例（180°）为正值：整个实体倒过来，"内容顶"落到脚点下方，双侧都不得夹成 0。
// 第 5 例是 player_anim 躺倒帧的真实量级（内容仅 26.5 世界 px 高）。
const GOLDEN_CONTENT_TOP_CASES: Array<[[number, number, number, number], number]> = [
  [[40.0, 30.0, 5.0, 0.0], -35.0],
  [[40.0, 30.0, 5.0, 37.0], -39.988543],
  [[40.0, 30.0, 5.0, 90.0], -20.0],
  [[40.0, 30.0, 5.0, 180.0], 5.0],
  [[136.0, 26.5, 5.5, 0.0], -32.0],
  [[120.0, 150.0, 7.5, -120.0], -48.211524],
];

const RAD = Math.PI / 180;

describe('entityTransform ↔ entity_transform_math.py parity', () => {
  it('scale golden', () => {
    for (const [d, want] of GOLDEN_SCALE_CASES) {
      expect(entityScaleOf(d), JSON.stringify(d)).toBe(want);
    }
  });

  it('rotation golden', () => {
    for (const [d, want] of GOLDEN_ROT_CASES) {
      expect(entityRotationDegOf(d), JSON.stringify(d)).toBe(want);
    }
  });

  it('transformLocalVector golden', () => {
    for (const [[lx, ly, s, deg], [wx, wy]] of GOLDEN_LOCAL_VEC_CASES) {
      const v = transformLocalVector(lx, ly, { scale: s, rotation: deg });
      expect(v.x).toBeCloseTo(wx, 5);
      expect(v.y).toBeCloseTo(wy, 5);
    }
  });

  it('quadTopLocalYAroundFoot golden', () => {
    for (const [[w, h, deg], want] of GOLDEN_QUAD_TOP_CASES) {
      expect(quadTopLocalYAroundFoot(w, h, deg * RAD), `${w},${h},${deg}`).toBeCloseTo(want, 5);
    }
  });

  it('contentTopLocalYAroundFoot golden', () => {
    for (const [[w, h, gap, deg], want] of GOLDEN_CONTENT_TOP_CASES) {
      expect(contentTopLocalYAroundFoot(w, h, gap, deg * RAD), `${w},${h},${gap},${deg}`)
        .toBeCloseTo(want, 5);
    }
  });
});
