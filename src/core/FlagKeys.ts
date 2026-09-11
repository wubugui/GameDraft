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
  /** 三把火 HUD 读数当前显不显示（玩法清单 G.5：默认不显、动作控显、入存档） */
  threeFiresVisible: 'three_fires_visible',
  /** 气味指示器（鼻子）当前显不显示（玩法清单 G.6：默认不显、动作控显、入存档） */
  smellHudVisible: 'smell_hud_visible',
  /** 气缕飘向追踪开关（G.6：飘向反方向=气味源；关了一直是直的；缺省开） */
  smellTracking: 'smell_tracking',
  /** 系统说明卡「弹过没有」（K4 系统说明卡；见闻录条目的 unlockConditions 引用同一键） */
  systemNoteShown: (noteId: string): string => `sysnote_${noteId}`,
} as const;
