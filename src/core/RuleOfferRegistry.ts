import type { ZoneRuleSlot } from '../data/types';

/**
 * 由 enableRuleOffers / disableRuleOffers Action 登记；供 RuleUseUI 聚合当前可展示的规矩槽位。
 */
export class RuleOfferRegistry {
  private byZone: Map<string, ZoneRuleSlot[]> = new Map();

  register(zoneId: string, slots: ZoneRuleSlot[]): void {
    const copy = slots.map((s) => ({
      ruleId: s.ruleId,
      resultActions: s.resultActions,
      ...(s.requiredLayers?.length ? { requiredLayers: s.requiredLayers } : {}),
      ...(s.resultText !== undefined ? { resultText: s.resultText } : {}),
    }));
    this.byZone.set(zoneId, copy);
  }

  unregister(zoneId: string): void {
    this.byZone.delete(zoneId);
  }

  clear(): void {
    this.byZone.clear();
  }

  /** 合并所有已登记 zone 的 slots（顺序为 Map 迭代顺序）。 */
  getAggregatedSlots(): ZoneRuleSlot[] {
    const out: ZoneRuleSlot[] = [];
    for (const slots of this.byZone.values()) {
      out.push(...slots);
    }
    return out;
  }
}
