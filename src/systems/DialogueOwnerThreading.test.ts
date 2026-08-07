import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { GraphDialogueManager } from './GraphDialogueManager';
import type { ActionOriginContext } from '../data/types';

/**
 * 对话内动作批的**来源上下文**必须带上本段对话的 owner——否则"对话里再开一张图"
 * 这一档链式接续会把 owner 丢掉，下一张图的 ownerState 静默走 fallback。
 * 历史上这条链是断的（Game 桥接只认 显式参数 / npcId / 场景 onEnter ambient 三档）。
 */
function harness(graph: unknown) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const seen: (ActionOriginContext | null)[] = [];
  actionExecutor.register('probeOrigin', (_p, ctx) => { seen.push(ctx); });
  const manager = new GraphDialogueManager(
    eventBus,
    flagStore,
    actionExecutor,
    { loadJson: vi.fn(async () => graph) } as any,
    {} as any,
    {} as any,
    { getStatus: () => 0 } as any,
    { getCoins: () => 0 } as any,
    {
      phaseStatusEquals: () => false,
      getScenarioPhase: () => undefined,
      getLineLifecycleState: () => 'inactive',
    } as any,
  );
  manager.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as any,
    scenarioState: {
      phaseStatusEquals: () => false,
      getScenarioPhase: () => undefined,
      getLineLifecycleState: () => 'inactive',
    } as any,
    narrativeState: undefined,
  }) as any);
  return { manager, seen };
}

const runActionsGraph = {
  id: 'chain',
  entry: 'act',
  nodes: {
    act: { type: 'runActions', actions: [{ type: 'probeOrigin', params: {} }], next: 'end' },
    end: { type: 'end' },
  },
};

describe('对话 runActions 的来源上下文', () => {
  it('带上本段对话的 owner（显式 owner）', async () => {
    const { manager, seen } = harness(runActionsGraph);
    await manager.startDialogueGraph({
      graphId: 'chain',
      npcName: '旁白',
      ownerType: 'hotspot',
      ownerId: 'h_coffin',
    });
    expect(seen).toEqual([{ ownerType: 'hotspot', ownerId: 'h_coffin' }]);
  });

  it('带上本段对话的 owner（npcId 推导出的 npc owner）', async () => {
    const { manager, seen } = harness(runActionsGraph);
    await manager.startDialogueGraph({ graphId: 'chain', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(seen).toEqual([{ ownerType: 'npc', ownerId: 'npc_ringboy' }]);
  });

  it('本段对话没有 owner 时传 null，不伪造', async () => {
    const { manager, seen } = harness(runActionsGraph);
    await manager.startDialogueGraph({ graphId: 'chain', npcName: '旁白' });
    expect(seen).toEqual([null]);
  });

  it('显式 ownerType 缺 ownerId 时不借 npcId，来源判为 null', async () => {
    const { manager, seen } = harness(runActionsGraph);
    await manager.startDialogueGraph({
      graphId: 'chain',
      npcName: 'NPC',
      npcId: 'npc_ringboy',
      ownerType: 'sceneGroup',
    });
    expect(seen).toEqual([null]);
  });
});
