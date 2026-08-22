/**
 * 实体层前后次序的**唯一规则**（从 `Renderer.sortEntityLayer` 抽出的纯函数）。
 *
 * ## 为什么单独一个模块
 *
 * 这条规则决定"玩家走过去时挡不挡得住那口井"，是玩家唯一能直接看见的排序结果，
 * 却同时被三处消费：
 *
 *   1. 运行时 `Renderer.sortEntityLayer`（本文件的唯一生产调用方）
 *   2. 场景编辑器画布 —— `tools/editor/shared/entity_sort_math.py` 是本文件的 **Python 镜像**
 *   3. 两侧的 parity 测试（`entitySortRule.test.ts` ↔ `tools/editor/tests/test_entity_sort_parity.py`）
 *
 * 抽出来之前它是 `sortEntityLayer` 里一段就地写 `child.zIndex` 的循环，**没有任何测试**，
 * 而编辑器画布用的是一张写死的固定层表 —— 两边算的根本不是一回事，编辑器里 NPC 恒被
 * 热点展示图压住。规则只留一处、两侧共用同一组黄金用例，是唯一能止住这类漂移的办法
 * （norms 第 8 条：手工镜像必配语义级 parity，注释写"同口径"不算护栏）。
 *
 * ## 规则本身
 *
 * **三档 × 档内按脚底 y**：
 * - 静态档位来自 `entitySortBand`（热点展示图 / NPC 的 `spriteSort`）。
 * - 携带 `entityOcclusionPolygon`（只有热点会带）时，**动态遮挡带覆盖静态档位**：
 *   玩家脚点比这块碰撞面更近（below）→ 物件排到玩家后面；更远或站在面上
 *   （above / inside）→ 排到玩家前面。
 * - 玩家 x 落在多边形水平跨度之外时 `pointPolygonVerticalSide` 返回 `null`，
 *   此时**保留静态档位、不覆盖**（既不是 front 也不是 back）。
 * - 脚底 y 取 `entitySortFootY ?? y`。前者只在实体带旋转时由实体自己维护
 *   （旋转后 quad 的接地线），缺省即回落容器锚点 y。
 *
 * 三个档位区间宽 {@link ENTITY_SORT_BAND}，远大于任何场景的世界高度，故绝不重叠。
 */

import { pointPolygonVerticalSide } from '../utils/zoneGeometry';

/** 档位偏移：远大于任何场景世界高度，保证三档区间不重叠。 */
export const ENTITY_SORT_BAND = 10_000_000;

export type EntitySortBand = 'back' | 'front';

/** 参与排序所需的全部输入（运行时从容器上读，编辑器从场景 JSON 派生）。 */
export type EntitySortInput = {
  /** 静态档位；缺省 = 不强制档位，纯按脚底 y 排 */
  band?: EntitySortBand;
  /** 动态遮挡带的判据多边形（世界坐标、已含实例 transform 与透视系数）；只有热点会带 */
  occlusionPolygon?: ReadonlyArray<{ x: number; y: number }>;
  /** 旋转态的接地线 y；缺省回落 `y` */
  sortFootY?: number;
  /** 容器锚点 y（= 脚底，`SpriteEntity` 内层 anchor 为底中） */
  y: number;
};

/**
 * 解析本次生效的档位：动态遮挡带优先于静态档位，`side === null` 时不覆盖。
 * 抽出来单测，因为"null 不覆盖"这一条最容易在镜像时写成 else 分支而错。
 */
export function resolveEntitySortBand(
  input: EntitySortInput,
  playerFootX?: number,
  playerFootY?: number,
): EntitySortBand | undefined {
  let band = input.band;
  const hasPlayer = playerFootX !== undefined && playerFootY !== undefined;
  const poly = input.occlusionPolygon;
  if (hasPlayer && poly && poly.length >= 3) {
    const side = pointPolygonVerticalSide(poly, playerFootX, playerFootY);
    if (side === 'below') {
      band = 'back';
    } else if (side === 'above' || side === 'inside') {
      band = 'front';
    }
    // side === null（玩家 x 不在多边形水平跨度内）→ 保留静态 band
  }
  return band;
}

/** 单个实体的 zIndex。档内按脚底 y 升序，故 z 越大越靠前。 */
export function entitySortZ(
  input: EntitySortInput,
  playerFootX?: number,
  playerFootY?: number,
): number {
  const band = resolveEntitySortBand(input, playerFootX, playerFootY);
  const footY = input.sortFootY ?? input.y;
  if (band === 'back') return -ENTITY_SORT_BAND + footY;
  if (band === 'front') return ENTITY_SORT_BAND + footY;
  return footY;
}
