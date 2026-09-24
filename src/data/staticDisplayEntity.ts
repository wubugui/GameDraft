import type { AnimationSetDefInput } from './resolveAnimationSet';
import type { HotspotDisplayImage, NpcDef } from './types';

/**
 * 静态贴图实体（没有动画包、只写了一张展示图的道具）的两件事：**算不算数**、**怎么合成**。
 *
 * 放在 `data/` 而不是某个 system 里，是因为它有两个宿主：主场景的 `SceneManager`
 * 与窗户世界的 `WindowWorldEntities`（法宝「窥夜」的 fork）。两者同层，谁 import 谁都是
 * 同层互持（架构铁律 2）；更要紧的是**两边必须是同一份判据** —— 窗里"这只算不算静态贴图"
 * 与主场景答案不同，表现就是同一个实体窗里有主世界没有（或反过来），而且一句报错都没有。
 */

/**
 * 把 `NpcDef.displayImage` 合成**一份单帧动画集**，喂给与普通 NPC 逐字相同的
 * `SpriteEntity` 路径。
 *
 * 这是本特性唯一的实现手段 —— **不新开实体族、不新开渲染分支**。合成之后，阴影 /
 * 透视 / 深度遮挡 / 内容层排序 / 逐 entity 光照 / 位面 / 分组 / cameraFollowActor /
 * attachToSocket 全都走 NPC 那一条，一处也不需要写"如果是静态贴图就……"。
 *
 * `worldWidth` / `worldHeight` 原样透传给 `normalizeAnimationSetDef`：它对 `undefined`
 * 与非正数一视同仁（见 `resolveAnimationWorldSize`），只填一维时按单格像素长宽比推另一维，
 * 两维都缺时回落 `DEFAULT_WORLD_WIDTH`。`resolvedSheetUrl` 由调用方传 `di.image`，
 * 于是法线图集按 `<图名>.normal.png` 的同一套约定寻址（烘过就用、没烘就平面法线）。
 */
export function buildStaticDisplayAnimationSet(di: HotspotDisplayImage): AnimationSetDefInput {
  return {
    spritesheet: di.image,
    cols: 1,
    rows: 1,
    worldWidth: di.worldWidth,
    worldHeight: di.worldHeight,
    states: { idle: { frames: [0], frameRate: 1, loop: true } },
  };
}

/**
 * 静态贴图实体是否成立：只看图路径。尺寸交给 `normalizeAnimationSetDef` 兜底推导，
 * 这里不再复述一遍"多大才算有效"（复述就是第二处真相）。
 */
export function staticDisplayImageOf(def: NpcDef): HotspotDisplayImage | null {
  if (def.animFile) return null; // 两者都写时以动画包为准（types.ts NpcDef.displayImage 契约）
  const di = def.displayImage;
  return di && typeof di.image === 'string' && di.image.trim() ? di : null;
}
