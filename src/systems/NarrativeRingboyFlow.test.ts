import { describe, expect, it, vi } from 'vitest';
import narrativeGraphsData from '../../public/assets/data/narrative_graphs.json';
import ringboyDialogueData from '../../public/assets/dialogues/graphs/滚铁环小孩.json';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { NarrativeStateManager, compileNarrativeGraphs, type NarrativeGraphsFile } from '../core/NarrativeStateManager';
import { GraphDialogueManager } from './GraphDialogueManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeRingboyRuntime() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  narrative.registerGraphs(compileNarrativeGraphs(narrativeGraphsData as unknown as NarrativeGraphsFile));

  const ctxFactory = (): ConditionEvalContext => ({
    flagStore,
    questManager: { getStatus: () => 0 } as any,
    scenarioState: {
      phaseStatusEquals: () => false,
      getScenarioPhase: () => undefined,
      getLineLifecycleState: () => 'inactive',
    } as any,
    narrativeState: narrative,
  });

  const assetManager = {
    loadJson: vi.fn(async (path: string) => {
      if (String(path).includes('滚铁环小孩')) return ringboyDialogueData;
      throw new Error(`unexpected asset path: ${path}`);
    }),
  };

  const dialogue = new GraphDialogueManager(
    eventBus,
    flagStore,
    actionExecutor,
    assetManager as any,
    {} as any,
    {} as any,
    { getStatus: () => 0 } as any,
    { getCoins: () => 0 } as any,
    ctxFactory().scenarioState as any,
  );
  dialogue.setConditionEvalContextFactory(ctxFactory);

  return { eventBus, narrative, dialogue };
}

describe('npc_ringboy narrative sample flow', () => {
  it('runs the dock water monkey chain into npc wrapper ring_taken', async () => {
    const { narrative } = makeRingboyRuntime();
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'dock_board', signal: 'board_read_done' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'zone', sourceId: 'waterside', signal: 'entered' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'minigame', sourceId: 'dock_crate_tutorial', signal: 'pull_success' });
    await flush();
    await flush();
    expect(narrative.getActiveState('flow_dock_water_monkey')).toBe('crate_minigame_done');
    expect(narrative.getPrimaryActiveStateByOwner('npc', 'npc_ringboy')).toBe('after_event');

    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'rolling_ring_boy', signal: 'ring_taken' });
    await flush();
    await flush();
    expect(narrative.getPrimaryActiveStateByOwner('npc', 'npc_ringboy')).toBe('ring_taken');
    expect(narrative.getActiveState('quest_return_ring')).toBe('active');
  });

  it('branches the real ringboy dialogue graph by owner wrapper state', async () => {
    const { eventBus, narrative, dialogue } = makeRingboyRuntime();
    let lineText = '';
    eventBus.on('dialogue:line', (payload) => { lineText = payload?.text ?? ''; });

    await dialogue.startDialogueGraph({ graphId: '滚铁环小孩', npcName: '小孩', npcId: 'npc_ringboy' });
    expect(lineText).toContain('小娃儿，这圈圈有点东西');
    dialogue.endDialogue();

    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'dock_board', signal: 'board_read_done' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'zone', sourceId: 'waterside', signal: 'entered' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'minigame', sourceId: 'dock_crate_tutorial', signal: 'pull_success' });
    await flush();
    await flush();
    expect(narrative.getPrimaryActiveStateByOwner('npc', 'npc_ringboy')).toBe('after_event');

    lineText = '';
    await dialogue.startDialogueGraph({ graphId: '滚铁环小孩', npcName: '小孩', npcId: 'npc_ringboy' });
    expect(lineText).toContain('小孩护着铁环看着你');
  });
});
