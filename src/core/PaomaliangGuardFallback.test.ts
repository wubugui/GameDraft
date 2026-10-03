import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
import data from '../../public/assets/data/narrative_graphs.json';
import { GameStateController } from './GameStateController';
import { InputManager } from './InputManager';
import { GameState } from '../data/types';
import { SystemNoteManager } from '../systems/SystemNoteManager';

const graphId = 'wrapper_跑马梁_风火引路';
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
afterEach(() => vi.unstubAllGlobals());
function harness(initialState = '护火教学', guardSafety = 0.6) {
  const target = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { ...target, visibilityState: 'visible' });
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  const sc = new GameStateController(new InputManager());
  const actions = new ActionExecutor(bus, flags, sc);
  const narrative = new NarrativeStateManager(bus, flags, actions);
  const held = { socket: 'right_hand', prop: 'torch', state: 'lit', burning: true,
    vitality: 0.8, guardSafety, fuel: 1, level: 1, effects: [] as string[], lock: 'none' as const };
  narrative.setConditionEvalContextFactory(() => ({ flagStore: flags, questManager: {} as any,
    scenarioState: {} as any, narrativeState: narrative, getHeldProps: () => [held] }));
  let finish!: () => void;
  const teaching = vi.fn(() => new Promise<void>((r) => { finish = r; }));
  const cutscene = vi.fn();
  actions.register('teachPropGuard', teaching);
  actions.register('startDialogueGraph', cutscene);
  actions.register('showNotification', () => {});
  const graph = structuredClone(compileNarrativeGraphs(data as unknown as NarrativeGraphsFile).find(g => g.id === graphId)!);
  graph.initialState = initialState;
  narrative.registerGraphs([graph]);
  return { bus, flags, actions, sc, narrative, held, teaching, cutscene, finish: () => finish(),
    changed: async () => { bus.emit('heldProp:changed', {}); await flush(); },
    windZone: async () => { narrative.emitNarrativeSignal({sourceType: 'zone', sourceId: '跑马梁:Zone_跑马梁_阵风', signal: '跑马梁_走进风口'}); await flush(); } };
}

describe('跑马梁：真实编排的低火值兜底', () => {
  it('自然低火弹卡后关闭说明，上一动作收尾不能取消刚启动的强制教学', async () => {
    const h = harness('迎风');
    const notes = new SystemNoteManager(h.bus, h.flags);
    notes.init({ eventBus: h.bus, flagStore: h.flags,
      strings: { get: (_c: string, key: string) => key } as never,
      assetManager: { loadJson: async () => ({ notes: [{ id: 'torch_guard', title: '护火', body: 'Q' }] }) } as never });
    await notes.loadDefs();
    let close!: () => void;
    notes.setOpener(async () => {
      const previous = h.sc.currentState;
      h.sc.setState(GameState.UIOverlay);
      try { await new Promise<void>((r) => { close = r; }); }
      finally { h.sc.setState(previous); }
    });
    h.actions.register('showSystemNote', (p) => notes.show(String(p.noteId)));
    h.actions.register('sceneWindGust', () => {});
    const canceled = vi.fn();
    h.sc.setStateChangeObserver((next) => {
      if (h.teaching.mock.calls.length && next === GameState.Exploring
        && h.held.vitality <= h.held.guardSafety) canceled();
    });
    h.held.vitality = 0.457;
    await h.changed();
    expect(h.sc.currentState).toBe(GameState.UIOverlay);
    close();
    await flush();
    expect(h.teaching).toHaveBeenCalledOnce();
    expect(canceled).not.toHaveBeenCalled();
    expect(h.sc.currentState).toBe(GameState.ActionSequence);
    h.held.state = 'guarding';
    h.held.vitality = 0.61;
    h.finish();
    await h.changed();
    expect(h.sc.currentState).toBe(GameState.Exploring);
    expect(h.narrative.getActiveState(graphId)).toBe('护好');
    await h.windZone();
    expect(h.cutscene).toHaveBeenCalledOnce();
    notes.destroy();
    h.narrative.destroy();
  });

  it.each([0.6, 0.8, 1])('火值 %s 不强制教学，原风口信号照常进过场', async (vitality) => {
    const h = harness();
    h.held.vitality = vitality;
    await h.changed();
    expect(h.teaching).not.toHaveBeenCalled();
    await h.windZone();
    expect(h.narrative.getActiveState(graphId)).toBe('阵风');
    expect(h.cutscene).toHaveBeenCalledOnce();
    h.narrative.destroy();
  });

  it.each([['护火教学', 0.6], ['护好', 0.637], ['护火教学', 0.82]] as const)('%s：预设安全线 %s 同时控制介入与放行', async (state, safety) => {
    const h = harness(state, safety);
    h.held.vitality = safety - 0.01;
    await h.changed();
    expect(h.teaching).toHaveBeenCalledOnce();
    expect(h.narrative.getActiveState(graphId)).toBe('低火护火');
    h.held.state = 'guarding';
    h.held.vitality = safety;
    await h.changed();
    expect(h.narrative.getActiveState(graphId)).toBe('低火护火');
    h.held.vitality = safety + 0.001;
    h.finish();
    await h.changed();
    expect(h.narrative.getActiveState(graphId)).toBe('护好');
    await h.windZone();
    expect(h.cutscene).toHaveBeenCalledOnce();
    h.narrative.destroy();
  });
});
