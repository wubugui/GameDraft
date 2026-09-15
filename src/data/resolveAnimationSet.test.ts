import { describe, it, expect } from 'vitest';
import { resolveAnimationWorldSize } from './resolveAnimationSet';

/**
 * 世界尺寸推导。⚠ 编辑器挂件预览（`tools/editor/shared/prop_preview.py::anim_world_size`）
 * 是它的跨语言镜像：`tools/editor/tests/test_prop_preview.py` 钉**同一组黄金值**，改一处必改两处。
 */
const GRID = { spritesheet: 'atlas.png', cols: 9, rows: 10, states: {} };

describe('resolveAnimationWorldSize', () => {
  it('两个都写：原样沿用（允许与格子长宽比不一致——角色帧分轴拉伸）', () => {
    expect(resolveAnimationWorldSize(
      { ...GRID, cellWidth: 219, cellHeight: 204, worldWidth: 148.214286, worldHeight: 150 }, 1971, 2040,
    )).toEqual({ worldWidth: 148.214286, worldHeight: 150 });
  });

  it('只写宽：按格子长宽比推高（保留 6 位小数）', () => {
    expect(resolveAnimationWorldSize({ ...GRID, cellWidth: 219, cellHeight: 204, worldWidth: 148 }, 1971, 2040))
      .toEqual({ worldWidth: 148, worldHeight: 137.863014 });
  });

  it('只写高：按格子长宽比推宽', () => {
    expect(resolveAnimationWorldSize({ ...GRID, cellWidth: 219, cellHeight: 204, worldHeight: 150 }, 1971, 2040))
      .toEqual({ worldWidth: 161.029412, worldHeight: 150 });
  });

  it('都没写：宽取 100', () => {
    expect(resolveAnimationWorldSize({ ...GRID, cellWidth: 219, cellHeight: 204 }, 1971, 2040))
      .toEqual({ worldWidth: 100, worldHeight: 93.150685 });
  });

  it('没写格子尺寸：由图集 ÷ 行列推', () => {
    expect(resolveAnimationWorldSize({ ...GRID, worldWidth: 50 }, 900, 2000))
      .toEqual({ worldWidth: 50, worldHeight: 100 });
  });
});
