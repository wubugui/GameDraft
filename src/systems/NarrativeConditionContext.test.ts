import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { DocumentRevealManager } from './DocumentRevealManager';
import { GraphDialogueManager } from './GraphDialogueManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';

function baseContext(active = true): { eventBus: EventBus; flagStore: FlagStore; ctx: ConditionEvalContext } {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const narrativeState = {
    getActiveState: (graphId: string) => (graphId === 'flow' && active ? 'ready' : 'other'),
    isStateActive: (graphId: string, stateId: string) => graphId === 'flow' && stateId === 'ready' && active,
  };
  return {
    eventBus,
    flagStore,
    ctx: {
      flagStore,
      questManager: { getStatus: () => 0 } as any,
      scenarioState: {
        phaseStatusEquals: () => false,
        getScenarioPhase: () => undefined,
        getLineLifecycleState: () => 'inactive',
      } as any,
      narrativeState,
    },
  };
}

function graphDialogue(active = true, graph: any) {
  const { eventBus, flagStore, ctx } = baseContext(active);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const assetManager = {
    loadJson: vi.fn(async () => graph),
  };
  const manager = new GraphDialogueManager(
    eventBus,
    flagStore,
    actionExecutor,
    assetManager as any,
    {} as any,
    {} as any,
    ctx.questManager as any,
    { getCoins: () => 0 } as any,
    ctx.scenarioState as any,
  );
  manager.setConditionEvalContextFactory(() => ctx);
  return { eventBus, manager };
}

describe('narrative condition context injection', () => {
  it('lets graph dialogue preconditions read narrative state', async () => {
    const graph = {
      id: 'd',
      entry: 'line',
      preconditions: [{ narrative: 'flow', state: 'ready' }],
      nodes: {
        line: { type: 'line', speaker: 'npc', text: 'ok', next: 'end' },
        end: { type: 'end' },
      },
    };
    const blocked = graphDialogue(false, graph);
    let starts = 0;
    blocked.eventBus.on('dialogue:start', () => { starts += 1; });
    await blocked.manager.startDialogueGraph({ graphId: 'd', npcName: 'NPC' });
    expect(starts).toBe(0);

    const allowed = graphDialogue(true, graph);
    allowed.eventBus.on('dialogue:start', () => { starts += 1; });
    await allowed.manager.startDialogueGraph({ graphId: 'd', npcName: 'NPC' });
    expect(starts).toBe(1);
  });

  it('lets graph dialogue choice and switch conditions read narrative state', async () => {
    const choiceGraph = {
      id: 'choice',
      entry: 'choice',
      nodes: {
        choice: {
          type: 'choice',
          options: [
            { text: 'allowed', next: 'end', requireCondition: { narrative: 'flow', state: 'ready' } },
          ],
        },
        end: { type: 'end' },
      },
    };
    const choice = graphDialogue(true, choiceGraph);
    let enabled = false;
    choice.eventBus.on('dialogue:choices', (payload) => { enabled = payload?.[0]?.enabled === true; });
    await choice.manager.startDialogueGraph({ graphId: 'choice', npcName: 'NPC' });
    expect(enabled).toBe(true);

    const switchGraph = {
      id: 'switch',
      entry: 'switch',
      nodes: {
        switch: {
          type: 'switch',
          defaultNext: 'fallback',
          cases: [{ condition: { narrative: 'flow', state: 'ready' }, next: 'hit' }],
        },
        hit: { type: 'line', speaker: 'npc', text: 'hit', next: 'end' },
        fallback: { type: 'line', speaker: 'npc', text: 'miss', next: 'end' },
        end: { type: 'end' },
      },
    };
    const switched = graphDialogue(true, switchGraph);
    let lineText = '';
    switched.eventBus.on('dialogue:line', (payload) => { lineText = payload?.text ?? ''; });
    await switched.manager.startDialogueGraph({ graphId: 'switch', npcName: 'NPC' });
    expect(lineText).toBe('hit');
  });

  it('lets document reveal conditions read narrative state', async () => {
    const { eventBus, flagStore, ctx } = baseContext(true);
    const manager = new DocumentRevealManager(
      { loadJson: vi.fn(async () => [{
        id: 'doc',
        blurredImagePath: 'blur.png',
        clearImagePath: 'clear.png',
        revealCondition: { narrative: 'flow', state: 'ready' },
      }]) } as any,
      eventBus,
      flagStore,
      ctx.questManager as any,
      ctx.scenarioState as any,
    );
    manager.setConditionEvalContextFactory(() => ctx);
    const blend = vi.fn(async () => {});
    manager.setBlendExecutor(blend);
    await manager.loadDefinitions();
    await manager.checkAndReveal('doc');
    expect(blend).toHaveBeenCalledOnce();
    expect(manager.isRevealed('doc')).toBe(true);
  });
});
