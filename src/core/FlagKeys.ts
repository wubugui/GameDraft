export const FlagKeys = {
  currentDay: 'current_day',
  hotspotPickedUp: (hotspotId: string): string => `picked_up_${hotspotId}`,
  ruleUsed: (ruleId: string): string => `rule_used_${ruleId}`,
  archiveCharacter: (characterId: string): string => `archive_character_${characterId}`,
} as const;
