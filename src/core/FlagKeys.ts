export const FlagKeys = {
  currentDay: 'current_day',
  /**
   * 当日时刻（0–1439 分钟）。时段（phase）是字符串、FlagStore 只收 bool/number，
   * 故**不**镜像成 flag——判时段一律走 `{ timePhase: … }` 条件叶。
   */
  minutesOfDay: 'minutes_of_day',
  hotspotPickedUp: (hotspotId: string): string => `picked_up_${hotspotId}`,
  ruleUsed: (ruleId: string): string => `rule_used_${ruleId}`,
  archiveCharacter: (characterId: string): string => `archive_character_${characterId}`,
} as const;
