import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { DocumentRevealManager } from './DocumentRevealManager';
import { GraphDialogueManager } from './GraphDialogueManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';

function baseContext(active = true, multiOwner = false): { eventBus: EventBus; flagStore: FlagStore; ctx: ConditionEvalContext } {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const ownerGraphIds = multiOwner ? ['npc_ringboy_a', 'npc_ringboy_b'] : ['npc_ringboy_a'];
  const narrativeState = {
    getActiveState: (graphId: string) => {
      if (graphId === 'flow') return active ? 'ready' : 'other';
      if (graphId === 'npc_ringboy_a') return active ? 'after_event' : 'before_event';
      if (graphId === 'npc_ringboy_b') return active ? 'ring_taken' : 'before_event';
      return 'other';
    },
    isStateActive: (graphId: string, stateId: string) => graphId === 'flow' && stateId === 'ready' && active,
    getGraph: (graphId: string) => {
      if (graphId === 'npc_ringboy_a' || graphId === 'npc_ringboy_b') return { id: graphId };
      return undefined;
    },
    getGraphIdsByOwner: (ownerType: string, ownerId: string) =>
      ownerType === 'npc' && ownerId === 'npc_ringboy' ? ownerGraphIds : [],
    getPrimaryActiveStateByOwner: (ownerType: string, ownerId: string) =>
      ownerType === 'npc' && ownerId === 'npc_ringboy' && active && ownerGraphIds.length === 1
        ? 'after_event'
        : undefined,
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

function graphDialogue(active = true, graph: any, multiOwner = false) {
  const { eventBus, flagStore, ctx } = baseContext(active, multiOwner);
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

  it('lets ownerState nodes branch by the current owner wrapper state', async () => {
    const ownerGraph = {
      id: 'owner',
      entry: 'owner_state',
      nodes: {
        owner_state: {
          type: 'ownerState',
          cases: [{ state: 'after_event', next: 'hit' }],
          defaultNext: 'fallback',
          missingWrapperNext: 'missing',
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'fallback', next: 'end' },
        missing: { type: 'line', speaker: { kind: 'npc' }, text: 'missing', next: 'end' },
        end: { type: 'end' },
      },
    };
    const hit = graphDialogue(true, ownerGraph);
    let hitText = '';
    hit.eventBus.on('dialogue:line', (payload) => { hitText = payload?.text ?? ''; });
    await hit.manager.startDialogueGraph({ graphId: 'owner', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(hitText).toBe('hit');

    const missing = graphDialogue(false, ownerGraph);
    let missingText = '';
    missing.eventBus.on('dialogue:line', (payload) => { missingText = payload?.text ?? ''; });
    await missing.manager.startDialogueGraph({ graphId: 'owner', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(missingText).toBe('missing');
  });

  it('routes ownerState to defaultNext when wrapper state does not match any case', async () => {
    const ownerGraph = {
      id: 'owner_default',
      entry: 'owner_state',
      nodes: {
        owner_state: {
          type: 'ownerState',
          cases: [{ state: 'ring_taken', next: 'taken' }],
          defaultNext: 'fallback',
        },
        taken: { type: 'line', speaker: { kind: 'npc' }, text: 'taken', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'fallback', next: 'end' },
        end: { type: 'end' },
      },
    };
    const runtime = graphDialogue(true, ownerGraph);
    let lineText = '';
    runtime.eventBus.on('dialogue:line', (payload) => { lineText = payload?.text ?? ''; });
    await runtime.manager.startDialogueGraph({ graphId: 'owner_default', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(lineText).toBe('fallback');
  });

  it('routes ownerState to missingWrapperNext when owner has multiple wrappers but no wrapperGraphId', async () => {
    const ownerGraph = {
      id: 'owner_multi_missing',
      entry: 'owner_state',
      nodes: {
        owner_state: {
          type: 'ownerState',
          cases: [{ state: 'after_event', next: 'hit' }],
          defaultNext: 'fallback',
          missingWrapperNext: 'missing',
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'fallback', next: 'end' },
        missing: { type: 'line', speaker: { kind: 'npc' }, text: 'missing', next: 'end' },
        end: { type: 'end' },
      },
    };
    const runtime = graphDialogue(true, ownerGraph, true);
    let lineText = '';
    runtime.eventBus.on('dialogue:line', (payload) => { lineText = payload?.text ?? ''; });
    await runtime.manager.startDialogueGraph({ graphId: 'owner_multi_missing', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(lineText).toBe('missing');
  });

  it('lets ownerState read explicit wrapperGraphId when owner has multiple wrappers', async () => {
    const ownerGraph = {
      id: 'owner_multi_explicit',
      entry: 'owner_state',
      nodes: {
        owner_state: {
          type: 'ownerState',
          wrapperGraphId: 'npc_ringboy_b',
          cases: [{ state: 'ring_taken', next: 'hit' }],
          defaultNext: 'fallback',
          missingWrapperNext: 'missing',
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'fallback', next: 'end' },
        missing: { type: 'line', speaker: { kind: 'npc' }, text: 'missing', next: 'end' },
        end: { type: 'end' },
      },
    };
    const runtime = graphDialogue(true, ownerGraph, true);
    let lineText = '';
    runtime.eventBus.on('dialogue:line', (payload) => { lineText = payload?.text ?? ''; });
    await runtime.manager.startDialogueGraph({ graphId: 'owner_multi_explicit', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(lineText).toBe('hit');
  });

  it('routes ownerState to missingWrapperNext when dialogue owner context is missing', async () => {
    const ownerGraph = {
      id: 'owner_missing_ctx',
      entry: 'owner_state',
      nodes: {
        owner_state: {
          type: 'ownerState',
          cases: [{ state: 'after_event', next: 'hit' }],
          defaultNext: 'fallback',
          missingWrapperNext: 'missing',
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'fallback', next: 'end' },
        missing: { type: 'line', speaker: { kind: 'npc' }, text: 'missing', next: 'end' },
        end: { type: 'end' },
      },
    };
    const runtime = graphDialogue(true, ownerGraph);
    let lineText = '';
    runtime.eventBus.on('dialogue:line', (payload) => { lineText = payload?.text ?? ''; });
    await runtime.manager.startDialogueGraph({ graphId: 'owner_missing_ctx', npcName: 'NPC' });
    expect(lineText).toBe('missing');
  });

  it('lets contextState nodes branch by explicit flow graph state', async () => {
    const contextGraph = {
      id: 'ctx',
      entry: 'ctx_state',
      nodes: {
        ctx_state: {
          type: 'contextState',
          graphId: 'flow',
          cases: [{ state: 'ready', next: 'hit' }],
          defaultNext: 'fallback',
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'flow-hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'flow-miss', next: 'end' },
        end: { type: 'end' },
      },
    };
    const hit = graphDialogue(true, contextGraph);
    let text = '';
    hit.eventBus.on('dialogue:line', (payload) => { text = payload?.text ?? ''; });
    await hit.manager.startDialogueGraph({ graphId: 'ctx', npcName: 'NPC' });
    expect(text).toBe('flow-hit');

    const miss = graphDialogue(false, contextGraph);
    miss.eventBus.on('dialogue:line', (payload) => { text = payload?.text ?? ''; });
    await miss.manager.startDialogueGraph({ graphId: 'ctx', npcName: 'NPC' });
    expect(text).toBe('flow-miss');
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
