import { describe, expect, it, vi } from 'vitest';
import { composeSceneEntityConditionState } from './InteractionSystem';
import { ZoneSystem } from './ZoneSystem';
import { resolveDepthFloorOffsetBoost } from '../utils/depthFloorZones';
import type { ZoneDef } from '../data/types';

describe('scene entity group runtime semantics', () => {
  it('member conditions AND group conditions while preserving member hide policy', () => {
    expect(composeSceneEntityConditionState(true, false, true)).toEqual({
      visibleByConditions: true,
      interactableByConditions: true,
    });
    expect(composeSceneEntityConditionState(false, false, true)).toEqual({
      visibleByConditions: true,
      interactableByConditions: false,
    });
    expect(composeSceneEntityConditionState(true, false, false)).toEqual({
      visibleByConditions: false,
      interactableByConditions: false,
    });
    expect(composeSceneEntityConditionState(false, true, true)).toEqual({
      visibleByConditions: false,
      interactableByConditions: false,
    });
  });

  it('Zone group condition gates enter and exits an already-active zone', () => {
    let groupOpen = false;
    const emitted: string[] = [];
    const eventBus = { emit: vi.fn((name: string) => emitted.push(name)) };
    const flagStore = { checkConditions: vi.fn(() => groupOpen) };
    const actionExecutor = { executeBatchInZoneContext: vi.fn(async () => undefined) };
    const ruleOfferRegistry = {
      getAggregatedSlots: vi.fn(() => []),
      unregister: vi.fn(),
      clear: vi.fn(),
    };
    const system = new ZoneSystem(
      eventBus as never,
      flagStore as never,
      actionExecutor as never,
      ruleOfferRegistry as never,
    );
    system.setEntityGroupConditionReader((gid) =>
      gid === 'g' ? [{ flag: 'group.open' } as never] : undefined,
    );
    system.setPlayerPositionGetter(() => ({ x: 10, y: 10 }));
    system.setZones([{
      id: 'z', group: 'g',
      polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
    }]);

    system.update(0);
    expect(emitted).not.toContain('zone:enter');
    groupOpen = true;
    system.update(0);
    expect(emitted).toContain('zone:enter');
    groupOpen = false;
    system.update(0);
    expect(emitted).toContain('zone:exit');
  });

  it('depth_floor also honors group conditions', () => {
    let groupOpen = false;
    const zones: ZoneDef[] = [{
      id: 'floor', group: 'g', zoneKind: 'depth_floor', floorOffsetBoost: 12,
      polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }],
    }];
    const flagStore = { checkConditions: vi.fn(() => groupOpen) };
    const groupConditions = () => [{ flag: 'group.open' } as never];
    expect(resolveDepthFloorOffsetBoost(
      zones, 10, 10, flagStore as never, undefined, groupConditions,
    )).toBe(0);
    groupOpen = true;
    expect(resolveDepthFloorOffsetBoost(
      zones, 10, 10, flagStore as never, undefined, groupConditions,
    )).toBe(12);
  });
});
