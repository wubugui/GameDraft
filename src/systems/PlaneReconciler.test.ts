import { describe, expect, it } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { NarrativeStateManager, type NarrativeGraph } from '../core/NarrativeStateManager';
import { PlaneReconciler } from './PlaneReconciler';
import type { PlaneDef } from './plane/types';
import type { PlayerMovementModifier } from '../entities/Player';
import type { PlaneInteractionPolicy } from './InteractionSystem';
import type { SceneLightEnv } from '../data/types';
import { CUTSCENE_ACTION_WHITELIST, GameState } from '../data/types';

/** 照 NarrativeStateManager.test.ts 真实例范式：真 EventBus/FlagStore/ActionExecutor/叙事管理器。 */
function makeRuntime() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  narrative.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as any,
    scenarioState: {} as any,
    narrativeState: narrative,
  }));

  const reconciler = new PlaneReconciler(eventBus);
  reconciler.init({ eventBus, flagStore, strings: {} as any, assetManager: {} as any });

  const calls: string[] = [];
  const state = {
    movementFn: null as (() => PlayerMovementModifier) | null,
    policyFn: null as (() => PlaneInteractionPolicy) | null,
    lighting: null as SceneLightEnv | null,
    gameState: GameState.Exploring,
  };
  reconciler.bindRuntime({
    narrative: {
      getGraphs: () => narrative.getGraphs(),
      getActiveState: (graphId: string) => narrative.getActiveState(graphId),
    },
    setPlayerMovementModifier: (fn) => {
      state.movementFn = fn;
      calls.push(`movement:${fn ? 'set' : 'clear'}`);
    },
    setPlaneInteractionPolicy: (fn) => {
      state.policyFn = fn;
      calls.push(`policy:${fn ? 'set' : 'clear'}`);
    },
    refreshEntitiesForPlaneChange: () => {
      calls.push('refresh');
    },
    refreshZonesForPlaneChange: () => {
      calls.push('refresh-zones');
    },
    setCameraZoom: (zoom) => {
      calls.push(`zoom:${zoom}`);
    },
    restoreSceneCameraZoom: () => {
      calls.push('zoom:restore');
    },
    applyPlaneLightEnvOverride: (partial) => {
      state.lighting = partial;
      calls.push(`lighting:${partial ? 'set' : 'clear'}`);
    },
    damagePlayer: async (amount) => {
      calls.push(`damage:${amount}`);
    },
    getGameState: () => state.gameState,
  });
  return { eventBus, flagStore, actionExecutor, narrative, reconciler, calls, state };
}

function flush(): Promise<void> {
  return new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}

const carryGraph: NarrativeGraph = {
  id: 'carry',
  ownerType: 'flow',
  initialState: 'idle',
  states: {
    idle: { id: 'idle' },
    carrying: { id: 'carrying', activePlane: '背尸' },
    done: { id: 'done' },
  },
  transitions: [
    { id: 't1', from: 'idle', to: 'carrying', signal: 'pick' },
    { id: 't2', from: 'carrying', to: 'done', signal: 'drop' },
  ],
};

const callGraph: NarrativeGraph = {
  id: 'call',
  ownerType: 'flow',
  initialState: 'quiet',
  states: {
    quiet: { id: 'quiet' },
    calling: { id: 'calling', activePlane: '喊名' },
  },
  transitions: [
    { id: 't1', from: 'quiet', to: 'calling', signal: 'call_start' },
    { id: 't2', from: 'calling', to: 'quiet', signal: 'call_end' },
  ],
};

const defs: PlaneDef[] = [
  { id: 'normal', label: '常态' },
  {
    id: '背尸',
    label: '背尸位面',
    movement: { driftX: -28, speedScale: 0.62, allowRun: false },
    interaction: { canPickup: false },
    camera: { zoom: 1.25 },
    healthDrainPerSec: 0.35,
  },
  { id: '喊名', label: '喊名位面', movement: { driftX: 10 } },
];

describe('PlaneReconciler', () => {
  it('叙事点名派生激活位面并对账各槽；normal 兜底', async () => {
    const { narrative, reconciler, calls, state } = makeRuntime();
    reconciler.registerDefs(defs);
    narrative.registerGraphs([carryGraph]);
    expect(reconciler.getActivePlaneId()).toBe('normal');

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'pick' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('背尸');
    expect(calls).toContain('refresh');
    expect(calls).toContain('zoom:1.25');
    const mod = state.movementFn?.();
    expect(mod).toEqual({ driftX: -28, driftY: 0, speedScale: 0.62, allowRun: false });
    const policy = state.policyFn?.();
    expect(policy).toEqual({ canPickup: false, canInteractHotspots: true, canTalkNpcs: true });

    // 离开点名状态 → normal 兜底：槽全清、相机恢复场景默认
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'drop' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('normal');
    expect(state.movementFn).toBeNull();
    expect(state.policyFn).toBeNull();
    expect(state.lighting).toBeNull();
    expect(calls).toContain('zoom:restore');
  });

  it('多图点名后进者胜；退出后回落到仍点名的图', async () => {
    const { narrative, reconciler } = makeRuntime();
    reconciler.registerDefs(defs);
    narrative.registerGraphs([carryGraph, callGraph]);

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'pick' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('背尸');

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'call_start' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('喊名'); // 后进者胜

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'call_end' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('背尸'); // 回落到仍点名的 carry
  });

  it('manual override 压过叙事点名；清 override 回叙事', async () => {
    const { narrative, reconciler } = makeRuntime();
    reconciler.registerDefs(defs);
    narrative.registerGraphs([carryGraph]);

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'pick' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('背尸');

    reconciler.activatePlaneManually('喊名');
    expect(reconciler.getActivePlaneId()).toBe('喊名');
    expect(reconciler.getDebugState().source).toBe('manual');

    // 未注册的位面：warn + 忽略，不改激活位面
    reconciler.activatePlaneManually('不存在的位面');
    expect(reconciler.getActivePlaneId()).toBe('喊名');

    reconciler.deactivateManualPlane();
    expect(reconciler.getActivePlaneId()).toBe('背尸');
    expect(reconciler.getDebugState().source).toBe('narrative');
  });

  it('掉阳气按 dt 累计、节流成整数经 damage 扣；非 Exploring 不扣', async () => {
    const { narrative, reconciler, calls, state } = makeRuntime();
    reconciler.registerDefs(defs);
    narrative.registerGraphs([carryGraph]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'pick' });
    await flush();

    reconciler.update(2); // 0.35*2 = 0.7 未到 1
    expect(calls.filter((c) => c.startsWith('damage:'))).toEqual([]);
    reconciler.update(1); // 累计 1.05 → 扣 1、余 0.05
    expect(calls.filter((c) => c.startsWith('damage:'))).toEqual(['damage:1']);

    state.gameState = GameState.Dialogue;
    reconciler.update(10); // 非 Exploring：不累计不扣
    expect(calls.filter((c) => c.startsWith('damage:'))).toEqual(['damage:1']);
  });

  it('serialize/deserialize 往返后经 scene:ready 重算激活位面', async () => {
    const { narrative, reconciler } = makeRuntime();
    reconciler.registerDefs(defs);
    narrative.registerGraphs([carryGraph]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'pick' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('背尸');
    const saved = JSON.parse(JSON.stringify(narrative.serialize()));
    const savedPlane = JSON.parse(JSON.stringify(reconciler.serialize()));
    expect(savedPlane).toEqual({}); // 零持久化：激活位面从叙事重派生

    const fresh = makeRuntime();
    fresh.reconciler.registerDefs(defs);
    fresh.narrative.registerGraphs([carryGraph]);
    expect(fresh.reconciler.getActivePlaneId()).toBe('normal');

    // 照 distributeSaveData 名册序：叙事先恢复（不发事件）、随后 planeReconciler.deserialize
    fresh.narrative.deserialize(saved);
    fresh.reconciler.deserialize(savedPlane);
    expect(fresh.reconciler.getActivePlaneId()).toBe('背尸'); // deserialize 即重派生（装载期 zone 过滤用）

    // 读档必经 reloadScene → scene:ready：全量重算 + 对账
    fresh.calls.length = 0;
    fresh.eventBus.emit('scene:ready');
    expect(fresh.reconciler.getActivePlaneId()).toBe('背尸');
    expect(fresh.calls).toContain('refresh');
    expect(fresh.state.movementFn?.()).toEqual({ driftX: -28, driftY: 0, speedScale: 0.62, allowRun: false });
  });

  it('destroy 摘干净：槽全清、事件退订、状态复位（§1.8）', async () => {
    const { narrative, reconciler, calls, state } = makeRuntime();
    reconciler.registerDefs(defs);
    narrative.registerGraphs([carryGraph]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'pick' });
    await flush();
    expect(reconciler.getActivePlaneId()).toBe('背尸');

    reconciler.destroy();
    expect(state.movementFn).toBeNull();
    expect(state.policyFn).toBeNull();
    expect(state.lighting).toBeNull();
    expect(calls).toContain('zoom:restore'); // 曾施加过 zoom，destroy 时恢复
    expect(reconciler.getActivePlaneId()).toBe('normal');

    // 事件已退订：destroy 后的叙事变化不再影响
    calls.length = 0;
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'drop' });
    await flush();
    expect(calls).toEqual([]);
    expect(reconciler.getActivePlaneId()).toBe('normal');
  });

  it('activatePlane/deactivatePlane 收录进过场白名单（决策锁定：可作过场 present 步）', () => {
    expect(CUTSCENE_ACTION_WHITELIST.has('activatePlane')).toBe(true);
    expect(CUTSCENE_ACTION_WHITELIST.has('deactivatePlane')).toBe(true);
  });
});
