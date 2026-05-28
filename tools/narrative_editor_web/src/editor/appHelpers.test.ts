import { describe, expect, it } from 'vitest';

import {
  WRAPPER_OWNER_REGISTRY,
  WRAPPER_OWNER_TYPES,
  navigationForElement,
  ownerChoicesForType,
} from './appHelpers';
import { emptyCatalog } from '../editorModel';
import type { CompositionElementDef } from '../types';

describe('navigationForElement', () => {
  it('preserves wrapper ownerType for resource navigation', () => {
    const base: CompositionElementDef = {
      id: 'wrapper',
      kind: 'wrapperGraph',
      ownerType: 'npc',
      ownerId: 'scene_a:npc_1',
    };

    expect(navigationForElement(base)).toEqual({ kind: 'npc', id: 'scene_a:npc_1' });
    expect(navigationForElement({ ...base, ownerType: 'hotspot', ownerId: 'scene_a:door' })).toEqual({ kind: 'hotspot', id: 'scene_a:door' });
    expect(navigationForElement({ ...base, ownerType: 'zone', ownerId: 'scene_a:entry' })).toEqual({ kind: 'zone', id: 'scene_a:entry' });
    expect(navigationForElement({ ...base, ownerType: 'quest', ownerId: 'quest_a' })).toEqual({ kind: 'quest', id: 'quest_a' });
    expect(navigationForElement({ ...base, ownerType: 'minigame', ownerId: 'water_a' })).toEqual({ kind: 'minigame', id: 'water_a' });
    expect(navigationForElement({ ...base, ownerType: 'cutscene', ownerId: 'intro' })).toEqual({ kind: 'cutscene', id: 'intro' });
    expect(navigationForElement({ ...base, ownerType: 'system', ownerId: 'global' })).toBeNull();
  });
});

describe('WRAPPER_OWNER_REGISTRY', () => {
  it('is the single source for wrapper owner type options', () => {
    expect(WRAPPER_OWNER_TYPES).toEqual(Object.keys(WRAPPER_OWNER_REGISTRY));
  });

  it('gives every navigable wrapper owner a catalog list', () => {
    for (const [ownerType, rule] of Object.entries(WRAPPER_OWNER_REGISTRY)) {
      if (!rule.navigationKind) continue;
      expect(rule.catalogKey, ownerType).toBeTruthy();
      expect(ownerChoicesForType(ownerType, emptyCatalog), ownerType).toEqual([]);
    }
  });
});
