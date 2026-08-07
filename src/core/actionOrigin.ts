import type { ActionOriginContext } from '../data/types';

/**
 * 动作来源上下文的构造与「对话 owner 归属」的**唯一判定源**。
 *
 * 这里定下的优先级是全项目口径：运行时按它注入，编辑器静态解算（
 * `tools/editor/shared/narrative_catalog.py` 的 `derive_dialogue_owner`）按它反推，
 * 两边由语义 parity 测试锁住（`src/core/actionOrigin.test.ts` +
 * `tools/editor/tests/test_dialogue_owner_parity.py`）。改这里必须同改那边。
 */

/** ownerType/ownerId 必须成对；缺一即无 owner，不制造"半个 owner"。 */
export function makeOwnerOrigin(
  ownerType: string | undefined | null,
  ownerId: string | undefined | null,
): ActionOriginContext | null {
  const t = String(ownerType ?? '').trim();
  const id = String(ownerId ?? '').trim();
  return t && id ? { ownerType: t, ownerId: id } : null;
}

/** 在既有来源上下文上换掉 owner（保留 zoneId 等其它来源信息）。 */
export function withOwner(
  origin: ActionOriginContext | null,
  ownerType: string | undefined | null,
  ownerId: string | undefined | null,
): ActionOriginContext | null {
  const owner = makeOwnerOrigin(ownerType, ownerId);
  if (!owner) return origin;
  return { ...(origin ?? {}), ...owner };
}

export interface DialogueOwnerInput {
  /** 动作参数上显式写的 ownerType/ownerId */
  paramOwnerType?: string;
  paramOwnerId?: string;
  /** 动作参数上的 npcId（也是说话人显示名的来源） */
  paramNpcId?: string;
  /** 放这批动作的实体（热区 / zone / 叙事图 / 任务 / 过场 / 上一张对话图…） */
  originOwnerType?: string;
  originOwnerId?: string;
  /** 场景 onEnter 窗口的隐式场景 owner（最后兜底） */
  ambientOwnerType?: string;
  ambientOwnerId?: string;
}

export interface ResolvedDialogueOwner {
  ownerType: string;
  ownerId: string;
  /** 命中的是哪一档，供调试与编辑器展示 */
  source: 'explicit' | 'npcId' | 'origin' | 'ambient' | 'none';
}

/**
 * `startDialogueGraph` 的 owner 归属判定，四档优先级：
 *
 * 1. `explicit`  —— 动作显式给了成对的 ownerType+ownerId，作者意图最高，绝不被覆盖；
 * 2. `npcId`     —— 只给了 npcId，等价于 `npc:<npcId>`（历史写法，量最大）；
 * 3. `origin`    —— 放这批动作的实体（热区 / zone / 叙事图状态 / 任务 / 过场 / 上一张对话图）；
 * 4. `ambient`   —— 场景 onEnter 窗口的 `scene:<sceneId>`。
 *
 * 硬规矩：**显式给了 ownerType 就绝不再从别处捡 ownerId**——那会把 npc 的 id
 * 偷换进 hotspot / zone 命名空间，解出一个根本不存在的 owner，比没有 owner 更难查。
 */
export function resolveDialogueOwner(input: DialogueOwnerInput): ResolvedDialogueOwner {
  const pType = String(input.paramOwnerType ?? '').trim();
  const pId = String(input.paramOwnerId ?? '').trim();
  const npcId = String(input.paramNpcId ?? '').trim();
  const oType = String(input.originOwnerType ?? '').trim();
  const oId = String(input.originOwnerId ?? '').trim();
  const aType = String(input.ambientOwnerType ?? '').trim();
  const aId = String(input.ambientOwnerId ?? '').trim();

  if (pType) {
    // 显式类型已定：id 只认显式给的那个，宁可判为 none 也不跨命名空间借。
    return pId
      ? { ownerType: pType, ownerId: pId, source: 'explicit' }
      : { ownerType: '', ownerId: '', source: 'none' };
  }
  if (pId && npcId) return { ownerType: 'npc', ownerId: pId, source: 'explicit' };
  if (npcId) return { ownerType: 'npc', ownerId: npcId, source: 'npcId' };
  if (pId) {
    // 只有 ownerId 没有 ownerType：类型沿用来源、再沿用场景 ambient；都没有则作废。
    if (oType) return { ownerType: oType, ownerId: pId, source: 'origin' };
    if (aType) return { ownerType: aType, ownerId: pId, source: 'ambient' };
    return { ownerType: '', ownerId: '', source: 'none' };
  }
  if (oType && oId) return { ownerType: oType, ownerId: oId, source: 'origin' };
  if (aType && aId) return { ownerType: aType, ownerId: aId, source: 'ambient' };
  return { ownerType: '', ownerId: '', source: 'none' };
}
