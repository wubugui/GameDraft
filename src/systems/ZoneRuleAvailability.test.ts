import { describe, expect, it, vi } from 'vitest';
import { ZoneSystem } from './ZoneSystem';
import type { ZoneDef } from '../data/types';

/**
 * 「这儿有没有规矩可用」只在**变了**的时候播报（2026-09-23）。
 *
 * 这两个事件不只是改 HUD 那行提示，`AudioManager` 还各给挂了一声系统音效。
 * 而进区、出区各走一次播报——于是玩家每跨一条纯叙事用的 zone（跑马梁那一段有三条）
 * 就听见一声"没有规矩可用"的提示音，那一刻屏幕上什么也没发生。真机抓到过一路叮叮响。
 */

const SQUARE: ZoneDef['polygon'] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];

function makeSystem(slots: () => unknown[]) {
  const events: string[] = [];
  const system = new ZoneSystem(
    { emit: (name: string) => { events.push(name); } } as never,
    { checkConditions: vi.fn(() => true) } as never,
    { executeBatchInZoneContext: vi.fn(async () => undefined) } as never,
    { getAggregatedSlots: vi.fn(slots), unregister: vi.fn(), clear: vi.fn() } as never,
  );
  return { system, events };
}

describe('规矩可用性播报', () => {
  it('反复进出没有规矩的 zone：只在第一次播报一声「没有」，之后不再重复', () => {
    const { system, events } = makeSystem(() => []);
    let inside = true;
    system.setPlayerPositionGetter(() => (inside ? { x: 10, y: 10 } : { x: 900, y: 900 }));
    system.setZones([{ id: 'z_a', polygon: SQUARE }, { id: 'z_b', polygon: SQUARE }]);

    system.update(0);                       // 同时进两个区
    inside = false; system.update(0);       // 同时出两个区
    inside = true; system.update(0);        // 再进
    const availability = events.filter((e) => e.startsWith('zone:rule'));
    expect(availability).toEqual(['zone:ruleUnavailable']);
    expect(events.filter((e) => e === 'zone:enter')).toHaveLength(4);
  });

  it('真的从「有」变「没有」时照常播报（HUD 那行提示不能停在上一次的结论）', () => {
    let slots: unknown[] = [{ ruleId: 'r' }];
    const { system, events } = makeSystem(() => slots);
    let inside = true;
    system.setPlayerPositionGetter(() => (inside ? { x: 10, y: 10 } : { x: 900, y: 900 }));
    system.setZones([{ id: 'z_a', polygon: SQUARE }]);

    system.update(0);
    expect(events.filter((e) => e.startsWith('zone:rule'))).toEqual(['zone:ruleAvailable']);
    slots = [];
    inside = false; system.update(0);
    expect(events.filter((e) => e.startsWith('zone:rule'))).toEqual(['zone:ruleAvailable', 'zone:ruleUnavailable']);
  });

  it('换场景 / 读档之后重新播报一次（不许沿用上一局的结论）', () => {
    const { system, events } = makeSystem(() => []);
    system.setPlayerPositionGetter(() => ({ x: 10, y: 10 }));
    system.setZones([{ id: 'z_a', polygon: SQUARE }]);
    system.update(0);
    expect(events.filter((e) => e.startsWith('zone:rule'))).toEqual(['zone:ruleUnavailable']);

    system.clearZones();
    system.setZones([{ id: 'z_b', polygon: SQUARE }]);
    system.update(0);
    expect(events.filter((e) => e.startsWith('zone:rule'))).toEqual(['zone:ruleUnavailable', 'zone:ruleUnavailable']);
  });
});
