import type {
  EncounterTriggerData,
  HotspotDef,
  InspectData,
  NpcHotspotData,
  PickupData,
  TransitionData,
} from '../data/types';

/** inspect 至少有图对话 / 正文 / actions 其一，才可对玩家按下 E（避免空 inspectBox） */
export function inspectDataHasInteractablePayload(data: InspectData): boolean {
  const graphId = 'graphId' in data && typeof data.graphId === 'string' ? data.graphId.trim() : '';
  if (graphId) return true;
  const text = 'text' in data && typeof data.text === 'string' ? data.text.trim() : '';
  if (text) return true;
  return !!(data.actions && data.actions.length > 0);
}

/**
 * 热区是否应向玩家提示 E / 接纳触发（占位空 inspect、缺字段的 transition 等剔除）。
 */
export function hotspotOffersPlayerInteraction(def: HotspotDef): boolean {
  switch (def.type) {
    case 'inspect':
      return inspectDataHasInteractablePayload(def.data as InspectData);
    case 'pickup': {
      const d = def.data as PickupData;
      return typeof d.itemId === 'string' && d.itemId.trim().length > 0;
    }
    case 'transition': {
      const d = def.data as TransitionData;
      return typeof d.targetScene === 'string' && d.targetScene.trim().length > 0;
    }
    case 'encounter': {
      const d = def.data as EncounterTriggerData;
      return typeof d.encounterId === 'string' && d.encounterId.trim().length > 0;
    }
    case 'npc': {
      const d = def.data as NpcHotspotData;
      return typeof d.npcId === 'string' && d.npcId.trim().length > 0;
    }
    default:
      return false;
  }
}
