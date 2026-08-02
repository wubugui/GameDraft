import { describe, expect, it } from 'vitest';

import {
  WRAPPER_OWNER_REGISTRY,
  WRAPPER_OWNER_TYPES,
  navigationForElement,
  referenceEntriesForType,
  referenceKindForElement,
  ownerChoicesForType,
} from './appHelpers';
import { emptyCatalog, normalizeFile } from '../editorModel';
import type { CompositionElementDef } from '../types';
import { VALID_NARRATIVE_WRAPPER_OWNER_TYPES } from '../../../../src/core/narrativeGraphValidation';

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
    expect(navigationForElement({ ...base, ownerType: 'sceneGroup', ownerId: 'scene_a:guards' })).toEqual({ kind: 'sceneGroup', id: 'scene_a:guards' });
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

  it('stays in semantic parity with the runtime validator owner registry', () => {
    expect(new Set(WRAPPER_OWNER_TYPES)).toEqual(new Set(VALID_NARRATIVE_WRAPPER_OWNER_TYPES));
  });

  it('gives every navigable wrapper owner a catalog list', () => {
    for (const [ownerType, rule] of Object.entries(WRAPPER_OWNER_REGISTRY)) {
      if (!rule.navigationKind) continue;
      expect(rule.catalogKey, ownerType).toBeTruthy();
      expect(ownerChoicesForType(ownerType, emptyCatalog), ownerType).toEqual([]);
    }
  });

  it('resolves sceneGroup candidates through their dedicated catalog key', () => {
    const catalog = { ...emptyCatalog, sceneGroupRefs: ['scene_a:guards'] };
    expect(ownerChoicesForType('sceneGroup', catalog)).toEqual(['scene_a:guards']);
    expect(referenceEntriesForType('sceneGroup', catalog)).toEqual([{
      kind: 'sceneGroup',
      id: 'scene_a:guards',
      qualifiedId: 'scene_a:guards',
      label: 'scene_a:guards',
    }]);
  });
});

describe('blackbox reference source types', () => {
  it('derives constrained source types from element kinds', () => {
    const base = { id: 'el', refId: 'legacy' };
    expect(referenceKindForElement({ ...base, kind: 'dialogueBlackbox' })).toBe('dialogue');
    expect(referenceKindForElement({ ...base, kind: 'zoneBlackbox' })).toBe('zone');
    expect(referenceKindForElement({ ...base, kind: 'minigameBlackbox' })).toBe('minigame');
    expect(referenceKindForElement({ ...base, kind: 'cutsceneBlackbox' })).toBe('cutscene');
  });

  it('keeps legacy ownerType, empty and dangling refId byte-for-byte in model normalization', () => {
    const elements: CompositionElementDef[] = [
      { id: 'old', kind: 'dialogueBlackbox', ownerType: 'legacy-source', refId: 'missing_dialogue' },
      { id: 'empty', kind: 'zoneBlackbox', ownerType: '', refId: '' },
    ];
    const raw = {
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow', ownerType: 'flow', ownerId: 'legacy-note', initialState: 'a',
          states: { a: { id: 'a' } }, transitions: [],
        },
        elements,
      }],
    };
    const normalized = normalizeFile(raw);
    const roundTripped = normalized.compositions?.[0]?.elements ?? [];
    expect(roundTripped.map((element) => ({
      ownerType: element.ownerType,
      refId: element.refId,
    }))).toEqual(elements.map((element) => ({
      ownerType: element.ownerType,
      refId: element.refId,
    })));
    expect(normalized.compositions?.[0]?.mainGraph.ownerId).toBe('legacy-note');
  });
});
