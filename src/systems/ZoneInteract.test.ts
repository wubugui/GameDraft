import { describe, expect, it, vi } from 'vitest';
import { InteractionSystem, type PlaneInteractionPolicy } from './InteractionSystem';
import { ZoneSystem } from './ZoneSystem';
import type { ZoneDef } from '../data/types';

/** 三角区，覆盖 (10,10)；玩家位置固定在里面。 */
const TRI = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }];

function makeZoneSystem(zones: ZoneDef[]) {
  const executeBatchInZoneContext = vi.fn(
    async (_batch: unknown, _origin: unknown) => undefined,
  );
  const system = new ZoneSystem(
    { emit: vi.fn() } as never,
    { checkConditions: vi.fn(() => true) } as never,
    { executeBatchInZoneContext } as never,
    { getAggregatedSlots: vi.fn(() => []), unregister: vi.fn(), clear: vi.fn() } as never,
  );
  system.setPlayerPositionGetter(() => ({ x: 10, y: 5 }));
  system.setZones(zones);
  return { system, executeBatchInZoneContext };
}

/** 最小可交互 hotspot 替身：只喂 InteractionSystem 实际读到的那几个面。 */
function fakeHotspot(id: string, x: number, y: number, range: number) {
  return {
    active: true,
    def: { id, type: 'inspect', x, y, interactionRange: range, data: { text: '看一眼' } },
    centerX: x,
    centerY: y,
    effectiveInteractionRange: range,
    setDerivedBaseEnabled: vi.fn(),
    setConditionEnabled: vi.fn(),
    showPrompt: vi.fn(),
    hidePrompt: vi.fn(),
  };
}

function makeInteractionSystem(zoneSystem: ZoneSystem, pressedE: boolean) {
  const emitted: { name: string; payload: unknown }[] = [];
  const eventBus = { emit: vi.fn((name: string, payload: unknown) => { emitted.push({ name, payload }); }) };
  const inputManager = { wasKeyJustPressed: vi.fn((code: string) => pressedE && code === 'KeyE') };
  const system = new InteractionSystem(eventBus as never, { checkConditions: () => true } as never, inputManager as never);
  system.setPlayerPositionGetter(() => ({ x: 10, y: 5 }));
  system.setZoneInteractBinding({
    peek: () => zoneSystem.getInteractableZone(),
    dispatch: (zoneId) => zoneSystem.dispatchZoneInteract(zoneId),
  });
  return { system, emitted };
}

describe('zone 级按 E 交互（ZoneDef.onInteract）', () => {
  it('走进区里不执行 onInteract，按 E 才执行', async () => {
    const zone: ZoneDef = {
      id: 'z_mat', polygon: TRI,
      onInteract: [{ type: 'showNotification', params: { text: '草席下有东西' } } as never],
    };
    const { system: zoneSystem, executeBatchInZoneContext } = makeZoneSystem([zone]);
    zoneSystem.update(0);
    // 进区本身零副作用（没有 onEnter，onInteract 不该被当成 onEnter 跑）
    expect(executeBatchInZoneContext).not.toHaveBeenCalled();

    const { system: interaction, emitted } = makeInteractionSystem(zoneSystem, false);
    interaction.update(0);
    expect(interaction.getPromptedZoneId()).toBe('z_mat');
    expect(emitted.filter((e) => e.name === 'zone:interactAvailable')).toHaveLength(1);
    expect(executeBatchInZoneContext).not.toHaveBeenCalled();

    const { system: pressing } = makeInteractionSystem(zoneSystem, true);
    pressing.update(0);
    // 动作批走 zone 串行队列（微任务），不在 update 里同步跑
    await Promise.resolve();
    expect(executeBatchInZoneContext).toHaveBeenCalledTimes(1);
    // zone 上下文按参数线程化（含 owner 归属），不走全局栈
    expect(executeBatchInZoneContext.mock.calls[0][1]).toMatchObject({ zoneId: 'z_mat' });
  });

  it('提示只发一次，文案随 interactLabel 走', () => {
    const zone: ZoneDef = {
      id: 'z', polygon: TRI, interactLabel: '[E] 掀开草席',
      onInteract: [{ type: 'showNotification', params: { text: 'x' } } as never],
    };
    const { system: zoneSystem } = makeZoneSystem([zone]);
    zoneSystem.update(0);
    const { system, emitted } = makeInteractionSystem(zoneSystem, false);
    system.update(0);
    system.update(0);
    system.update(0);
    const avail = emitted.filter((e) => e.name === 'zone:interactAvailable');
    expect(avail).toHaveLength(1);
    expect(avail[0].payload).toEqual({ zoneId: 'z', label: '[E] 掀开草席' });
  });

  it('目标级优先：附近有可交互热点时本区不出提示、E 不落到区上', async () => {
    const zone: ZoneDef = {
      id: 'z', polygon: TRI,
      onInteract: [{ type: 'showNotification', params: { text: 'x' } } as never],
    };
    const { system: zoneSystem, executeBatchInZoneContext } = makeZoneSystem([zone]);
    zoneSystem.update(0);
    const { system, emitted } = makeInteractionSystem(zoneSystem, true);
    system.setHotspots([fakeHotspot('h', 12, 5, 60)] as never);
    system.update(0);
    await Promise.resolve();
    expect(system.getPromptedZoneId()).toBeNull();
    expect(emitted.some((e) => e.name === 'zone:interactAvailable')).toBe(false);
    expect(executeBatchInZoneContext).not.toHaveBeenCalled();
  });

  it('位面禁交互时区域交互一并禁（不出提示、按 E 无效）', async () => {
    const zone: ZoneDef = {
      id: 'z', polygon: TRI,
      onInteract: [{ type: 'showNotification', params: { text: 'x' } } as never],
    };
    const { system: zoneSystem, executeBatchInZoneContext } = makeZoneSystem([zone]);
    zoneSystem.update(0);
    const { system } = makeInteractionSystem(zoneSystem, true);
    const policy: PlaneInteractionPolicy = {
      canInteractHotspots: false, canTalkNpcs: true, canPickup: false, allowedVerbs: null,
    };
    system.setPlaneInteractionPolicy(() => policy);
    system.update(0);
    await Promise.resolve();
    expect(system.getPromptedZoneId()).toBeNull();
    expect(executeBatchInZoneContext).not.toHaveBeenCalled();
  });

  it('走出区后提示收起；此后按 E 不再触发（提示是快照，派发以当下为准）', () => {
    const zone: ZoneDef = {
      id: 'z', polygon: TRI,
      onInteract: [{ type: 'showNotification', params: { text: 'x' } } as never],
    };
    const { system: zoneSystem, executeBatchInZoneContext } = makeZoneSystem([zone]);
    zoneSystem.update(0);
    const { system, emitted } = makeInteractionSystem(zoneSystem, false);
    system.update(0);
    expect(system.getPromptedZoneId()).toBe('z');

    // 玩家走出去：活跃集清空
    zoneSystem.setZones([]);
    system.update(0);
    expect(system.getPromptedZoneId()).toBeNull();
    expect(emitted.some((e) => e.name === 'zone:interactUnavailable')).toBe(true);
    expect(zoneSystem.dispatchZoneInteract('z')).toBe(false);
    expect(executeBatchInZoneContext).not.toHaveBeenCalled();
  });

  it('depth_floor 区与空 onInteract 不参与（不出提示、派发拒绝）', () => {
    const { system: zoneSystem } = makeZoneSystem([
      { id: 'floor', zoneKind: 'depth_floor', floorOffsetBoost: 8, polygon: TRI, onInteract: [{ type: 'showNotification', params: {} } as never] },
      { id: 'empty', polygon: TRI, onInteract: [] },
    ]);
    zoneSystem.update(0);
    expect(zoneSystem.getInteractableZone()).toBeNull();
    expect(zoneSystem.dispatchZoneInteract('floor')).toBe(false);
    expect(zoneSystem.dispatchZoneInteract('empty')).toBe(false);
  });

  it('多个可交互区重叠时按声明顺序取第一个', () => {
    const mk = (id: string): ZoneDef => ({
      id, polygon: TRI, onInteract: [{ type: 'showNotification', params: { text: id } } as never],
    });
    const { system: zoneSystem } = makeZoneSystem([mk('first'), mk('second')]);
    zoneSystem.update(0);
    expect(zoneSystem.getInteractableZone()?.zoneId).toBe('first');
  });
});
