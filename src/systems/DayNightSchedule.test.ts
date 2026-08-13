import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { FlagKeys } from '../core/FlagKeys';
import { DayManager } from './DayManager';
import { NpcScheduleSystem, type NpcScheduleRuntimeBinding } from './NpcScheduleSystem';
import type { NpcDef, SceneData } from '../data/types';
import {
  forwardDistance,
  isEntityInPhase,
  NPC_DEFAULT_PHASES,
  isWithinRange,
  parseClock,
  phaseAt,
  resolvePhases,
} from '../utils/dayTime';

/**
 * 日夜循环三组：时刻工具（跨零点）、DayManager 推进（跨日 / 时段边沿 / 存档）、
 * NpcScheduleSystem 查表与**离场宽限集**（"绝不当着玩家的面消失"的判据就在这一组）。
 */

// ---------------------------------------------------------------- 时刻工具

describe('dayTime 时刻工具', () => {
  it('parseClock 认 HH:MM、拒非法', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('7:05')).toBe(425);
    expect(parseClock('23:59')).toBe(1439);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('晚上')).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });

  it('phaseAt 在第一段起点之前回绕到最后一段（跨零点，勿"修"成回落第一段）', () => {
    const phases = resolvePhases([
      { id: 'dawn', from: '05:00' },
      { id: 'day', from: '07:00' },
      { id: 'night', from: '20:00' },
    ]);
    expect(phaseAt(phases, parseClock('01:40')!)).toBe('night');
    expect(phaseAt(phases, parseClock('05:00')!)).toBe('dawn');
    expect(phaseAt(phases, parseClock('06:59')!)).toBe('dawn');
    expect(phaseAt(phases, parseClock('12:00')!)).toBe('day');
    expect(phaseAt(phases, parseClock('23:30')!)).toBe('night');
  });

  it('resolvePhases 丢弃坏行；全坏时回落内置四段（恒有至少一段可用）', () => {
    const bad = resolvePhases([
      { id: '', from: '05:00' },
      { id: 'x', from: '不是时刻' },
    ] as never);
    expect(bad.map((p) => p.id)).toEqual(['dawn', 'day', 'dusk', 'night']);
  });

  it('isWithinRange 支持跨零点；起止相等＝整天', () => {
    const from = parseClock('19:00')!;
    const to = parseClock('06:00')!;
    expect(isWithinRange(parseClock('23:00')!, from, to)).toBe(true);
    expect(isWithinRange(parseClock('02:00')!, from, to)).toBe(true);
    expect(isWithinRange(parseClock('12:00')!, from, to)).toBe(false);
    expect(isWithinRange(parseClock('19:00')!, from, to)).toBe(true);
    expect(isWithinRange(parseClock('06:00')!, from, to)).toBe(false);
    // 起止相等 = 整天，不是零长度区间
    expect(isWithinRange(0, 480, 480)).toBe(true);
  });

  it('isEntityInPhase：写了就按白名单判；取不到时段一律 fail-open', () => {
    expect(isEntityInPhase(['dawn', 'day', 'dusk'], 'day')).toBe(true);
    expect(isEntityInPhase(['dawn', 'day', 'dusk'], 'night')).toBe(false);
    expect(isEntityInPhase(['day'], '')).toBe(true);
  });

  it('没写 phases 时用 fallback：NPC 缺省只白日，热点/zone 不传 fallback＝全时段', () => {
    // NPC：缺省 = 只在白日出没（内容定调，不是"全天都在"）
    expect(isEntityInPhase(undefined, 'day', NPC_DEFAULT_PHASES)).toBe(true);
    expect(isEntityInPhase(undefined, 'night', NPC_DEFAULT_PHASES)).toBe(false);
    expect(isEntityInPhase(undefined, 'dusk', NPC_DEFAULT_PHASES)).toBe(false);
    expect(isEntityInPhase([], 'night', NPC_DEFAULT_PHASES)).toBe(false);
    // 热点 / zone：不传 fallback = 全时段都在（门、路牌夜里当然还在）
    expect(isEntityInPhase(undefined, 'night')).toBe(true);
    expect(isEntityInPhase([], 'night')).toBe(true);
    // 显式写了就覆盖缺省
    expect(isEntityInPhase(['night'], 'night', NPC_DEFAULT_PHASES)).toBe(true);
  });

  it('forwardDistance 绕一圈算跨零点距离', () => {
    expect(forwardDistance(parseClock('23:00')!, parseClock('01:00')!)).toBe(120);
    expect(forwardDistance(parseClock('08:00')!, parseClock('08:00')!)).toBe(0);
  });
});

// ---------------------------------------------------------------- 世界时钟

function makeClock() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const day = new DayManager(eventBus, flagStore, actionExecutor);
  day.init({ eventBus, flagStore, strings: {} as never, assetManager: {} as never });
  day.configure({
    phases: [
      { id: 'day', from: '07:00' },
      { id: 'night', from: '20:00' },
    ],
    startAt: '08:00',
  });
  return { eventBus, flagStore, day };
}

describe('DayManager 时刻推进', () => {
  it('configure 在时刻未被动过时同步开局时刻', () => {
    const { day } = makeClock();
    expect(day.minutesOfDay).toBe(parseClock('08:00'));
    expect(day.currentPhase).toBe('day');
  });

  it('推进跨过时段边界时发 time:phaseChanged，并透传 transition', () => {
    const { eventBus, day } = makeClock();
    const seen: Array<{ from: string; to: string; transition: string }> = [];
    eventBus.on('time:phaseChanged', (p) => seen.push(p as never));
    return day.advanceTime(13 * 60, 'seamless').then(() => {
      expect(day.currentPhase).toBe('night');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ from: 'day', to: 'night', transition: 'seamless' });
    });
  });

  it('同一时段内推进不发 phaseChanged，但发 time:changed', async () => {
    const { eventBus, day } = makeClock();
    const phase = vi.fn();
    const changed = vi.fn();
    eventBus.on('time:phaseChanged', phase);
    eventBus.on('time:changed', changed);
    await day.advanceTime(60, 'seamless');
    expect(phase).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('跨零点＝新的一天：连带跑 endDay（day:end / day:start），时刻先写后跑', async () => {
    const { eventBus, day } = makeClock();
    const order: string[] = [];
    let minutesAtDayStart = -1;
    eventBus.on('day:end', () => order.push('end'));
    eventBus.on('day:start', () => {
      order.push('start');
      minutesAtDayStart = day.minutesOfDay;
    });
    await day.advanceTime(18 * 60, 'timelapse'); // 08:00 → 次日 02:00
    expect(day.currentDay).toBe(2);
    expect(day.minutesOfDay).toBe(parseClock('02:00'));
    expect(order).toEqual(['end', 'start']);
    // day:start 的监听方必须读到推进后的时刻，不是旧时刻
    expect(minutesAtDayStart).toBe(parseClock('02:00'));
  });

  it('负数 / 非有限值被拒（时间倒流会让日程与延迟事件全部失序）', async () => {
    const { day } = makeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await day.advanceTime(-30, 'cut');
    await day.advanceTime(Number.NaN, 'cut');
    expect(day.minutesOfDay).toBe(parseClock('08:00'));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('advanceTimeTo：已在目标时段＝空操作；否则推到该时段起点', async () => {
    const { day } = makeClock();
    await day.advanceTimeTo('day');
    expect(day.minutesOfDay).toBe(parseClock('08:00'));
    await day.advanceTimeTo('night');
    expect(day.minutesOfDay).toBe(parseClock('20:00'));
    expect(day.currentPhase).toBe('night');
  });

  it('时刻镜像进 flag，且存档往返保真；旧档无时刻字段时回落开局时刻', async () => {
    const { flagStore, day } = makeClock();
    await day.advanceTime(90, 'cut');
    expect(flagStore.get(FlagKeys.minutesOfDay)).toBe(parseClock('09:30'));
    const saved = day.serialize() as { minutesOfDay?: number };
    expect(saved.minutesOfDay).toBe(parseClock('09:30'));

    day.deserialize({ currentDay: 3, minutesOfDay: parseClock('21:00')! });
    expect(day.currentPhase).toBe('night');

    day.deserialize({ currentDay: 1 }); // 旧档：没有时刻字段
    expect(day.minutesOfDay).toBe(parseClock('08:00'));
  });

  it('destroy 后重 init 行为与首次一致（律8）', () => {
    const { day } = makeClock();
    day.destroy();
    day.init({ eventBus: new EventBus(), flagStore: {} as never, strings: {} as never, assetManager: {} as never });
    expect(day.currentDay).toBe(1);
    expect(day.minutesOfDay).toBe(parseClock('08:00'));
  });
});

// ---------------------------------------------------------------- NPC 日程

/** 最小 NPC 替身：只实现日程系统真正用到的面（位置 / id / def / moveTo / 动画）。 */
function makeNpc(id: string, characterId: string, x = 100, y = 100) {
  const moveCalls: Array<{ x: number; y: number }> = [];
  let resolveMove: (() => void) | null = null;
  const npc = {
    id,
    x,
    y,
    def: { id, characterId, name: id, x, y, interactionRange: 40 } as NpcDef,
    playAnimation: vi.fn(),
    moveTo(tx: number, ty: number) {
      moveCalls.push({ x: tx, y: ty });
      return new Promise<void>((res) => {
        resolveMove = res;
      });
    },
  };
  return {
    npc,
    moveCalls,
    /** 模拟"走到了"：把坐标搬过去并结束这一段 moveTo。 */
    arrive() {
      const last = moveCalls[moveCalls.length - 1];
      if (last) {
        npc.x = last.x;
        npc.y = last.y;
      }
      resolveMove?.();
    },
    /** 模拟"被对话打断"：moveTo 的 Promise 落定但**没走到**。 */
    interrupt() {
      resolveMove?.();
    },
  };
}

function makeScheduleRuntime(opts: {
  scene: Partial<SceneData> & { id: string };
  npcs: ReturnType<typeof makeNpc>[];
  minutes: number;
}) {
  const eventBus = new EventBus();
  const sys = new NpcScheduleSystem(eventBus);
  sys.init({ eventBus, flagStore: {} as never, strings: {} as never, assetManager: {} as never });
  const state = { minutes: opts.minutes, exploring: true };
  const sceneData = { worldWidth: 800, worldHeight: 600, ...opts.scene } as SceneData;
  const spoke: string[] = [];
  const binding: NpcScheduleRuntimeBinding = {
    getMinutesOfDay: () => state.minutes,
    getCurrentSceneId: () => sceneData.id,
    getCurrentSceneData: () => sceneData,
    getCurrentNpcs: () => opts.npcs.map((n) => n.npc) as never,
    isExploring: () => state.exploring,
    evalConditions: () => true,
    speak: (_n, text) => spoke.push(text),
    refreshEntityVisibility: () => {},
  };
  sys.bindRuntime(binding);
  return { sys, eventBus, state, sceneData, spoke };
}

const DAY_SCENE = { id: 'teahouse', dayNight: { enabled: true } };

describe('NpcScheduleSystem 查表', () => {
  it('没配日程 / 没 characterId 的 NPC 不受管（旧数据零影响）', () => {
    const a = makeNpc('npc_a', '');
    const { sys } = makeScheduleRuntime({ scene: DAY_SCENE, npcs: [a], minutes: 0 });
    sys.registerDefs([]);
    expect(sys.isNpcPresentNow(a.npc.def)).toBe(true);
  });

  it('场景没开 dayNight 时日程完全不生效', () => {
    const a = makeNpc('npc_a', 'ergou');
    const { sys } = makeScheduleRuntime({
      scene: { id: 'teahouse' }, // 未开日夜
      npcs: [a],
      minutes: parseClock('23:00')!,
    });
    sys.registerDefs([
      { characterId: 'ergou', entries: [{ from: '06:00', to: '19:00', scene: 'teahouse' }] },
    ]);
    expect(sys.isNpcPresentNow(a.npc.def)).toBe(true);
  });

  it('按时刻决定在不在本场景，跨零点条目正确命中', () => {
    const a = makeNpc('npc_a', 'ergou');
    const rt = makeScheduleRuntime({ scene: DAY_SCENE, npcs: [a], minutes: parseClock('12:00')! });
    rt.sys.registerDefs([
      {
        characterId: 'ergou',
        entries: [
          { from: '06:00', to: '19:00', scene: 'teahouse' },
          { from: '19:00', to: '06:00', scene: null },
        ],
      },
    ]);
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(true);
    rt.state.minutes = parseClock('22:00')!;
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
    rt.state.minutes = parseClock('03:00')!; // 跨零点那一段
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
  });

  it('日程指向别的场景时，在本场景判为不在场', () => {
    const a = makeNpc('npc_a', 'ergou');
    const rt = makeScheduleRuntime({ scene: DAY_SCENE, npcs: [a], minutes: parseClock('12:00')! });
    rt.sys.registerDefs([
      { characterId: 'ergou', entries: [{ from: '00:00', to: '23:59', scene: '雾津街头' }] },
    ]);
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
  });

  it('剧情覆盖跳过日程表，clear 后交还日程', () => {
    const a = makeNpc('npc_a', 'ergou');
    const rt = makeScheduleRuntime({ scene: DAY_SCENE, npcs: [a], minutes: parseClock('22:00')! });
    // 必须覆盖全天：日程**没覆盖到**的时段等于"不受管"（回落常驻），
    // 那是 validator「日程没覆盖全天」warning 要提醒的另一回事。
    rt.sys.registerDefs([
      {
        characterId: 'ergou',
        entries: [
          { from: '06:00', to: '19:00', scene: 'teahouse' },
          { from: '19:00', to: '06:00', scene: null },
        ],
      },
    ]);
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
    rt.sys.setOverride('ergou', { scene: 'teahouse' });
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(true);
    rt.sys.setOverride('ergou', null);
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
  });
});

describe('NpcScheduleSystem 离场演出（绝不当着玩家的面消失）', () => {
  function setupLeaving() {
    const a = makeNpc('npc_a', 'ergou', 100, 300);
    const rt = makeScheduleRuntime({
      scene: {
        ...DAY_SCENE,
        exitAnchors: [{ id: '门', x: 700, y: 300 }],
      },
      npcs: [a],
      minutes: parseClock('12:00')!,
    });
    rt.sys.registerDefs([
      {
        characterId: 'ergou',
        exitLine: '天不早咯',
        entries: [
          { from: '06:00', to: '19:00', scene: 'teahouse' },
          { from: '19:00', to: '06:00', scene: null },
        ],
      },
    ]);
    rt.sys.update(0.016); // 建立在场基线
    return { a, rt };
  }

  it('到点后先说话、走向出口；**没走到之前一直判为在场**', async () => {
    const { a, rt } = setupLeaving();
    rt.state.minutes = parseClock('20:00')!;
    rt.sys.update(0.016);

    expect(rt.spoke).toEqual(['天不早咯']);
    expect(a.moveCalls[0]).toEqual({ x: 700, y: 300 });
    // 关键不变量：正在走的路上仍然在场（否则每帧派生回写会把它在半路抹掉）
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(true);

    a.arrive();
    await Promise.resolve();
    rt.sys.update(0.016);
    // 走到出口才隐去
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
  });

  it('moveTo 被打断（对话）但没走到时不算到达，回探索态自动续走', async () => {
    const { a, rt } = setupLeaving();
    rt.state.minutes = parseClock('20:00')!;
    rt.sys.update(0.016);
    expect(a.moveCalls).toHaveLength(1);

    a.interrupt(); // Promise 落定，但坐标没变
    // moveTo 的 .catch().finally() 各占一层微任务，让出一个宏任务确保 moving 已复位
    await new Promise((r) => setTimeout(r, 0));
    rt.state.exploring = false;
    rt.sys.update(0.016);
    expect(a.moveCalls).toHaveLength(1); // 非探索态不重发
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(true); // 仍在场，没被抹掉

    rt.state.exploring = true;
    rt.sys.update(0.016);
    expect(a.moveCalls).toHaveLength(2); // 回探索态续走
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(true);
  });

  it('没配出口锚点时走到场景边界外，而不是原地消失', () => {
    const a = makeNpc('npc_a', 'ergou', 100, 300);
    const rt = makeScheduleRuntime({
      scene: DAY_SCENE, // 无 exitAnchors
      npcs: [a],
      minutes: parseClock('12:00')!,
    });
    rt.sys.registerDefs([
      {
        characterId: 'ergou',
        entries: [
          { from: '06:00', to: '19:00', scene: 'teahouse' },
          { from: '19:00', to: '06:00', scene: null },
        ],
      },
    ]);
    rt.sys.update(0.016);
    rt.state.minutes = parseClock('20:00')!;
    rt.sys.update(0.016);
    // x=100 离左边界近 → 往画面左外走
    expect(a.moveCalls[0].x).toBeLessThan(0);
  });

  it('有画面遮挡的推进（timelapse）不演离场，直接重贴', () => {
    const { a, rt } = setupLeaving();
    rt.state.minutes = parseClock('20:00')!;
    rt.eventBus.emit('time:changed', { transition: 'timelapse' });
    rt.sys.update(0.016);
    expect(a.moveCalls).toHaveLength(0);
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(false);
  });

  it('入场从出口走进来，不原地冒出', () => {
    const a = makeNpc('npc_a', 'ergou', 100, 300);
    const rt = makeScheduleRuntime({
      scene: { ...DAY_SCENE, exitAnchors: [{ id: '门', x: 700, y: 300 }] },
      npcs: [a],
      minutes: parseClock('22:00')!,
    });
    rt.sys.registerDefs([
      {
        characterId: 'ergou',
        entries: [
          { from: '06:00', to: '19:00', scene: 'teahouse', spot: { x: 250, y: 300 } },
          { from: '19:00', to: '06:00', scene: null },
        ],
      },
    ]);
    rt.sys.update(0.016); // 基线：不在场
    rt.state.minutes = parseClock('08:00')!;
    rt.sys.update(0.016);
    // 先被瞬移到出口，再走向驻留点
    expect(a.npc.x).toBe(700);
    expect(a.moveCalls[0]).toEqual({ x: 250, y: 300 });
    expect(rt.sys.isNpcPresentNow(a.npc.def)).toBe(true);
  });

  it('serialize 只存剧情覆盖，日程本身不入档', () => {
    const { rt } = setupLeaving();
    rt.sys.setOverride('ergou', { scene: 'teahouse', activity: 'sit' });
    const saved = rt.sys.serialize() as { overrides: Array<Record<string, unknown>> };
    expect(saved.overrides).toEqual([
      { characterId: 'ergou', scene: 'teahouse', activity: 'sit' },
    ]);
  });
});
