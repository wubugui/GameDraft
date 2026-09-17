import { describe, expect, it } from 'vitest';
import type { HeldPropConditionStatus } from '../../data/types';
import { EventBus } from '../../core/EventBus';
import { FlagStore } from '../../core/FlagStore';
import { ActionExecutor } from '../../core/ActionExecutor';
import { NarrativeStateManager } from '../../core/NarrativeStateManager';
import { evaluateConditionExpr, evaluateConditionExprWithTrace, type ConditionEvalContext } from './evaluateGraphCondition';

const torch = (over: Partial<HeldPropConditionStatus> = {}): HeldPropConditionStatus => ({
  socket: 'right_hand', prop: 'xianteng_torch', state: 'lit', burning: true, vitality: 1, level: 1, fuel: 1,
  effects: [], lock: 'none', ...over,
});

function ctxWith(held: Record<string, HeldPropConditionStatus[]>): ConditionEvalContext {
  const eventBus = new EventBus();
  return {
    flagStore: new FlagStore(eventBus),
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {} as never,
    getHeldProps: (who) => held[who] ?? [],
  };
}

describe('heldProp 条件叶：手持挂件是全局玩法状态', () => {
  it('写了的每一项都要满足，没写的不限；手上没东西为假；not 表示"没拿着这样一件"', () => {
    const ctx = ctxWith({ player: [torch({ vitality: 0.4 })] });
    expect(evaluateConditionExpr({ heldProp: 'player' }, ctx)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', prop: 'xianteng_torch', burning: true }, ctx)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', prop: 'lantern' }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'player', propState: 'out' }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'player', socket: 'left_hand' }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'player', vitalityOp: '<', vitality: 0.5 }, ctx)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', vitalityOp: '>=', vitality: 0.5 }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'player', lock: 'lit' }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'npc_a' }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ not: { heldProp: 'player', burning: false } }, ctx)).toBe(true);
    // 没注入（编辑器预览等）⇒ 恒假
    const bare = { ...ctx, getHeldProps: undefined };
    expect(evaluateConditionExpr({ heldProp: 'player' }, bare)).toBe(false);
  });

  it('燃料与效果：剩几成燃料的比较、效果块 id 与标签都认；没写的项不限', () => {
    const ctx = ctxWith({ player: [torch({ fuel: 0.15, effects: ['songming', '招东西'] })] });
    expect(evaluateConditionExpr({ heldProp: 'player', fuelOp: '<', fuel: 0.2 }, ctx)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', fuelOp: '>=', fuel: 0.2 }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'player', effect: 'songming' }, ctx)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', effect: '招东西' }, ctx)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', effect: '驱虫' }, ctx)).toBe(false);
    // 没有耐久、没挂效果的火把：燃料恒满、效果一个都不命中
    const plain = ctxWith({ player: [torch()] });
    expect(evaluateConditionExpr({ heldProp: 'player', fuelOp: '>=', fuel: 1 }, plain)).toBe(true);
    expect(evaluateConditionExpr({ heldProp: 'player', effect: 'songming' }, plain)).toBe(false);
    const r = evaluateConditionExprWithTrace({ heldProp: 'player', effect: '驱虫' }, ctx);
    expect((r.trace as { label: string }).label).toContain('效果=');
  });

  it('两件挂件：要有同一件同时满足，不能东一项西一项凑', () => {
    const ctx = ctxWith({ player: [torch({ burning: false, state: 'out' }), torch({ socket: 'left_hand', prop: 'lantern' })] });
    expect(evaluateConditionExpr({ heldProp: 'player', prop: 'xianteng_torch', burning: true }, ctx)).toBe(false);
    expect(evaluateConditionExpr({ heldProp: 'player', prop: 'lantern', burning: true }, ctx)).toBe(true);
  });

  it('trace 写出期望与每件的实际', () => {
    const ctx = ctxWith({ player: [torch({ state: 'ember', vitality: 0.2 })] });
    const r = evaluateConditionExprWithTrace({ heldProp: 'player', propState: 'lit' }, ctx);
    expect(r.result).toBe(false);
    expect(r.trace.kind).toBe('heldProp');
    expect((r.trace as { label: string }).label).toContain('状态=ember');
  });

  it('heldProp:changed 唤醒叙事 reactive 重评（不用 flag 转一道）', async () => {
    const eventBus = new EventBus();
    const flagStore = new FlagStore(eventBus);
    const narrative = new NarrativeStateManager(eventBus, flagStore, new ActionExecutor(eventBus, flagStore));
    const held: HeldPropConditionStatus[] = [torch()];
    narrative.setConditionEvalContextFactory(() => ({
      flagStore,
      questManager: { getStatus: () => 0 } as never,
      scenarioState: {} as never,
      narrativeState: narrative,
      getHeldProps: (who) => (who === 'player' ? held : []),
    }));
    narrative.registerGraphs([{
      id: 'cave',
      ownerType: 'flow',
      initialState: 'lit',
      states: { lit: { id: 'lit' }, dark: { id: 'dark' } },
      transitions: [{
        id: 'went_dark', from: 'lit', to: 'dark', signal: '__draft__', trigger: 'reactiveAll',
        conditions: [{ not: { heldProp: 'player', burning: true } }],
      }],
    }]);
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    await flush();
    expect(narrative.getActiveState('cave')).toBe('lit');
    held[0] = torch({ state: 'out', burning: false });
    eventBus.emit('heldProp:changed', {});
    await flush();
    expect(narrative.getActiveState('cave')).toBe('dark');
  });
});
