/**
 * 实体 z 序规则的黄金用例 —— 与 `tools/editor/tests/test_entity_sort_parity.py` **一字不差**。
 *
 * 本文件与 Python 侧共同构成 norms 第 8 条要求的语义级 parity：
 * `src/rendering/entitySortRule.ts` ↔ `tools/editor/shared/entity_sort_math.py` 是手工镜像，
 * 任一侧漂移即红。新增/修改用例必须同步改两个文件（黄金常量一字不差）。
 *
 * 这条规则在抽出来之前**没有任何测试**，而它决定玩家能不能被井沿挡住。
 */
import { describe, it, expect } from 'vitest';
import {
  ENTITY_SORT_BAND,
  entitySortZ,
  resolveEntitySortBand,
  type EntitySortInput,
} from './entitySortRule';

/** 一个横跨 x∈[100,200]、y∈[300,400] 的四边形碰撞面（黄金常量，两侧共用）。 */
const GOLDEN_POLY = [
  { x: 100, y: 300 },
  { x: 200, y: 300 },
  { x: 200, y: 400 },
  { x: 100, y: 400 },
];

/** [说明, 输入, 玩家脚点(可空), 期望 band, 期望 z] —— 与 Python 侧同序同值。 */
const GOLDEN_CASES: Array<[string, EntitySortInput, [number, number] | null, string | undefined, number]> = [
  // —— 无档位：纯按脚底 y ——
  ['裸实体：z 就是 y', { y: 250 }, null, undefined, 250],
  ['裸实体：y 可为负', { y: -40 }, null, undefined, -40],
  ['裸实体：y 为 0', { y: 0 }, null, undefined, 0],

  // —— 静态档位 ——
  ['静态 back', { band: 'back', y: 250 }, null, 'back', -ENTITY_SORT_BAND + 250],
  ['静态 front', { band: 'front', y: 250 }, null, 'front', ENTITY_SORT_BAND + 250],

  // —— sortFootY 覆盖 y（?? 是 nullish：0 也算有效值）——
  ['sortFootY 覆盖 y', { y: 250, sortFootY: 377 }, null, undefined, 377],
  ['sortFootY 为 0 仍生效（不是 falsy 回落）', { y: 250, sortFootY: 0 }, null, undefined, 0],
  ['sortFootY 与 band 叠加', { band: 'back', y: 250, sortFootY: 377 }, null, 'back', -ENTITY_SORT_BAND + 377],

  // —— 动态遮挡带：玩家在面下方（更近）→ 物件排到玩家后面 ——
  ['遮挡：玩家在面下方 → back', { y: 350, occlusionPolygon: GOLDEN_POLY }, [150, 500], 'back', -ENTITY_SORT_BAND + 350],
  // —— 玩家在面上方（更远）或站在面上 → 物件排到玩家前面 ——
  ['遮挡：玩家在面上方 → front', { y: 350, occlusionPolygon: GOLDEN_POLY }, [150, 200], 'front', ENTITY_SORT_BAND + 350],
  ['遮挡：玩家站在面上 → front', { y: 350, occlusionPolygon: GOLDEN_POLY }, [150, 350], 'front', ENTITY_SORT_BAND + 350],

  // —— 动态覆盖静态 ——
  ['遮挡覆盖静态 front → back', { band: 'front', y: 350, occlusionPolygon: GOLDEN_POLY }, [150, 500], 'back', -ENTITY_SORT_BAND + 350],
  ['遮挡覆盖静态 back → front', { band: 'back', y: 350, occlusionPolygon: GOLDEN_POLY }, [150, 200], 'front', ENTITY_SORT_BAND + 350],

  // —— side === null：玩家 x 在多边形水平跨度之外 → **保留静态档位，不覆盖** ——
  ['跨度外：保留静态 back', { band: 'back', y: 350, occlusionPolygon: GOLDEN_POLY }, [900, 500], 'back', -ENTITY_SORT_BAND + 350],
  ['跨度外：无静态档位则仍无档位', { y: 350, occlusionPolygon: GOLDEN_POLY }, [900, 500], undefined, 350],

  // —— 没有玩家脚点（编辑器未放探针 / 运行时装配期）：完全不看多边形 ——
  ['无玩家：遮挡多边形不生效', { band: 'front', y: 350, occlusionPolygon: GOLDEN_POLY }, null, 'front', ENTITY_SORT_BAND + 350],

  // —— 退化多边形：点数 < 3 不参与 ——
  ['多边形只有两点：不参与', { y: 350, occlusionPolygon: [{ x: 100, y: 300 }, { x: 200, y: 300 }] }, [150, 500], undefined, 350],
  ['多边形为空：不参与', { y: 350, occlusionPolygon: [] }, [150, 500], undefined, 350],
];

describe('entitySortRule 黄金用例（与 Python 镜像一字不差）', () => {
  for (const [name, input, player, wantBand, wantZ] of GOLDEN_CASES) {
    it(name, () => {
      const px = player ? player[0] : undefined;
      const py = player ? player[1] : undefined;
      expect(resolveEntitySortBand(input, px, py)).toBe(wantBand);
      expect(entitySortZ(input, px, py)).toBe(wantZ);
    });
  }
});

/**
 * 轨迹动画的 `sortY` 通道 —— **运行时独有**，刻意不进上面那张黄金表：
 * 那张表与 `tools/editor/tests/test_entity_sort_parity.py` 一字不差，动它就要同时动
 * 编辑器侧的镜像。这里用的是**既有**的 `sortFootY` 输入（`TrajectoryKeyframe.sortY`
 * 由实体适配写进容器的 `entitySortFootY`），排序规则本身一行未改。
 *
 * 存在的理由：飞在空中的物件，画面上的脚点 y 是"当前高度"，而前后关系要按**落点**算。
 * 没有这条通道，一口被抛起的箱子会在飞到最高点时突然跑到所有人前面。
 */
describe('轨迹 sortY：飞在空中的物件按"落点"排前后', () => {
  it('sortY 顶掉当前 y —— 抛到半空（y 变小）仍按落点排', () => {
    const landing = 420;
    const midAir: EntitySortInput = { y: 180, sortFootY: landing };
    const onGround: EntitySortInput = { y: landing };
    expect(entitySortZ(midAir)).toBe(entitySortZ(onGround));
  });

  it('没有 sortY 时会随高度乱窜（这正是这条通道要防的）', () => {
    expect(entitySortZ({ y: 180 })).not.toBe(entitySortZ({ y: 420 }));
  });

  it('sortY 与静态档位叠加：档位仍决定大区间，sortY 只管档内次序', () => {
    expect(entitySortZ({ band: 'front', y: 180, sortFootY: 420 }))
      .toBe(ENTITY_SORT_BAND + 420);
    expect(entitySortZ({ band: 'back', y: 180, sortFootY: 420 }))
      .toBe(-ENTITY_SORT_BAND + 420);
  });

  it('sortY 不参与遮挡带判定（那条看的是玩家脚点与多边形，与被排的实体无关）', () => {
    const input: EntitySortInput = { y: 350, sortFootY: 0, occlusionPolygon: GOLDEN_POLY };
    expect(resolveEntitySortBand(input, 150, 500)).toBe('back');
    expect(entitySortZ(input, 150, 500)).toBe(-ENTITY_SORT_BAND + 0);
  });
});

describe('三档区间绝不重叠', () => {
  it('back 档最高的实体仍低于无档位最低的实体', () => {
    // 世界高度上限按 100000 取（远大于任何真实场景）
    const H = 100_000;
    const backTop = entitySortZ({ band: 'back', y: H });
    const noneBottom = entitySortZ({ y: -H });
    expect(backTop).toBeLessThan(noneBottom);
  });

  it('无档位最高的实体仍低于 front 档最低的实体', () => {
    const H = 100_000;
    const noneTop = entitySortZ({ y: H });
    const frontBottom = entitySortZ({ band: 'front', y: -H });
    expect(noneTop).toBeLessThan(frontBottom);
  });
});
