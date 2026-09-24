/**
 * 实体脚下两样东西各自的开关：**投影剪影**（`castShadow`）与**接触 AO**（`contactAo.enabled`）。
 *
 * 制作人 2026-09-23 定：接触阴影与投影分开，**每个角色缺省都有接触阴影**。
 *
 * 此前两者合成一个开关（`castShadow: false` = 不投影也没有接触斑）。为了不投一道方向不对的
 * 影子而关掉投影的角色（雾津街头送葬队一整排），脚下就什么都没有了——站在灯前的亮地上
 * 像飘着。现在 `castShadow` 只管投影，接触 AO 只认 `contactAo.enabled`，缺省开。
 *
 * 接触 AO 的其余参数（简单 / 方向、明暗、大小……）不在这里，见 `contactAo.ts`。
 */
import type { ContactAoDef } from '../data/types';

export interface EntityShadowFlags {
  /** 画投影剪影（手调单影或绑定的剪影）。 */
  cast: boolean;
  /** 画脚底接触 AO。 */
  contact: boolean;
}

/** 热区展示图：两样都开（热区的 `castShadow` 仍是合并开关，由建实例处判定）。 */
export const ALL_SHADOWS_ON: Readonly<EntityShadowFlags> = Object.freeze({ cast: true, contact: true });

/** NPC 定义 → 两个开关。都是「缺省开、只有显式 false 才关」。 */
export function npcShadowFlags(def: { castShadow?: boolean; contactAo?: ContactAoDef }): EntityShadowFlags {
  return {
    cast: def.castShadow !== false,
    contact: def.contactAo?.enabled !== false,
  };
}

/** 玩家：投影恒开（玩家没有 castShadow 开关），接触 AO 看场景的 `playerContactAo`。 */
export function playerShadowFlags(playerContactAo: ContactAoDef | undefined): EntityShadowFlags {
  return { cast: true, contact: playerContactAo?.enabled !== false };
}
