/**
 * 实例 transform 数学镜像的跨语言 parity 锁（审查 P1-2）。
 *
 * 与 `tools/editor/tests/test_entity_transform_parity.py` 钉死**同一组黄金数值**：
 * 任一侧实现漂移即红。新增/修改用例必须两个文件同步改（常量一字不差）。
 */
import { describe, expect, it } from 'vitest';
import {
  entityRotationDegOf,
  entityScaleOf,
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
});
