export const FlagKeys = {
  currentDay: 'current_day',
  hotspotPickedUp: (hotspotId: string): string => `picked_up_${hotspotId}`,
  archiveCharacter: (characterId: string): string => `archive_character_${characterId}`,
} as const;
