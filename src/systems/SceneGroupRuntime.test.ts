import { describe, expect, it, vi } from 'vitest';
import { InteractionSystem, composeSceneEntityConditionState } from './InteractionSystem';
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

  it('refreshVisibilityChannels 在交互循环整个不跑时也能重贴条件通道', () => {
    // 为什么要有这条：`update` 只挂在 Game.tick 的 Exploring 分支里，而时刻多半是在
    // 过场/对话里推进的。那时派生基底被 SceneManager 当场重贴了、条件通道却停在上一帧，
    // 跨时段时就成了半条街按新时辰走、另半条留在旧时辰。
    // 判据刻意选「连 playerPosGetter 都没注入」——此时 `update` 第一行就 return，
    // 所以下面能通过就证明补刷这条路与交互循环完全无关。
    let groupOpen = false;
    const flagStore = { checkConditions: vi.fn(() => groupOpen) };
    const system = new InteractionSystem(
      { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
      flagStore as never,
      { wasKeyJustPressed: vi.fn(() => false) } as never,
    );
    system.setEntityGroupConditionReader((gid) =>
      gid === 'g' ? [{ flag: 'group.open' } as never] : undefined,
    );

    const hsCond: boolean[] = [];
    const npcCond: boolean[] = [];
    system.setHotspots([{
      def: { id: 'h', group: 'g' },
      setDerivedBaseEnabled: vi.fn(),
      setConditionEnabled: (v: boolean) => hsCond.push(v),
    } as never]);
    system.setNpcs([{
      def: { id: 'n', group: 'g' },
      setDerivedBaseVisible: vi.fn(),
      setConditionVisible: (v: boolean) => npcCond.push(v),
    } as never]);

    system.update(0);                      // 没有 playerPosGetter：整个交互循环不跑
    expect(hsCond).toEqual([]);
    expect(npcCond).toEqual([]);

    system.refreshVisibilityChannels();    // 组条件为假 ⇒ 整组隐藏
    expect(hsCond).toEqual([false]);
    expect(npcCond).toEqual([false]);

    groupOpen = true;
    system.refreshVisibilityChannels();    // 时刻走到组允许的那一段 ⇒ 当场放出来
    expect(hsCond).toEqual([false, true]);
    expect(npcCond).toEqual([false, true]);
  });
});
