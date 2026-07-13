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
  // 与真实 NarrativeStateManager 一致：isStateActive ≡ getActiveState(graphId) === stateId
  const getActiveState = (graphId: string) => {
    if (graphId === 'flow') return active ? 'ready' : 'other';
    if (graphId === 'npc_ringboy_a') return active ? 'after_event' : 'before_event';
    if (graphId === 'npc_ringboy_b') return active ? 'ring_taken' : 'before_event';
    if (graphId === 'scene_wrapper') return active ? 'scene_open' : 'scene_closed';
    return 'other';
  };
  const narrativeState = {
    getActiveState,
    isStateActive: (graphId: string, stateId: string) => getActiveState(graphId) === stateId,
    getGraph: (graphId: string) => {
      if (graphId === 'npc_ringboy_a' || graphId === 'npc_ringboy_b' || graphId === 'scene_wrapper') return { id: graphId };
      return undefined;
    },
    getGraphIdsByOwner: (ownerType: string, ownerId: string) =>
      ownerType === 'npc' && ownerId === 'npc_ringboy' ? ownerGraphIds : [],
    getPrimaryGraphByOwner: (ownerType: string, ownerId: string) => {
      if (ownerType === 'npc' && ownerId === 'npc_ringboy' && ownerGraphIds.length === 1) return { id: ownerGraphIds[0] };
      if (ownerType === 'scene' && ownerId === 'scene_test') return { id: 'scene_wrapper' };
      return undefined;
    },
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
      currentSceneId: 'scene_test',
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
  it('evaluates reached-state leaves via hasReachedState (with isStateActive fallback)', async () => {
    const { evaluateConditionExprList } = await import('./graphDialogue/conditionEvalBridge');
    const { ctx } = baseContext(false);
    // 当前不在 ready，但「到达过」——reached 叶子为真，等值叶子为假
    (ctx.narrativeState as any).hasReachedState = (g: string, s: string) => g === 'flow' && s === 'ready';
    expect(evaluateConditionExprList([{ narrative: 'flow', state: 'ready', reached: true } as any], ctx)).toBe(true);
    expect(evaluateConditionExprList([{ narrative: 'flow', state: 'ready' } as any], ctx)).toBe(false);
    // 未注入 hasReachedState 时 reached 退化为 isStateActive
    delete (ctx.narrativeState as any).hasReachedState;
    expect(evaluateConditionExprList([{ narrative: 'flow', state: 'ready', reached: true } as any], ctx)).toBe(false);
  });

  it('keeps the trace evaluator aligned with the non-trace evaluator on reached leaves', async () => {
    const { evaluateConditionExpr, evaluateConditionExprWithTrace } =
      await import('./graphDialogue/evaluateGraphCondition');
    const { ctx } = baseContext(false);
    (ctx.narrativeState as any).hasReachedState = (g: string, s: string) => g === 'flow' && s === 'ready';
    const reachedExpr = { narrative: 'flow', state: 'ready', reached: true } as any;
    const activeExpr = { narrative: 'flow', state: 'ready' } as any;
    // 对话图 switch / preconditions 走的 trace 版必须与非 trace 版同判（R7 曾缺 reached 分支）
    expect(evaluateConditionExprWithTrace(reachedExpr, ctx).result).toBe(evaluateConditionExpr(reachedExpr, ctx));
    expect(evaluateConditionExprWithTrace(reachedExpr, ctx).result).toBe(true);
    expect(evaluateConditionExprWithTrace(activeExpr, ctx).result).toBe(evaluateConditionExpr(activeExpr, ctx));
    expect(evaluateConditionExprWithTrace(activeExpr, ctx).result).toBe(false);
    // 未注入 hasReachedState 时两版一致退化为 isStateActive
    delete (ctx.narrativeState as any).hasReachedState;
    expect(evaluateConditionExprWithTrace(reachedExpr, ctx).result).toBe(evaluateConditionExpr(reachedExpr, ctx));
    expect(evaluateConditionExprWithTrace(reachedExpr, ctx).result).toBe(false);
  });

  it('evaluates plane leaves against the injected active plane (normal fallback when absent)', async () => {
    const { evaluateConditionExprList } = await import('./graphDialogue/conditionEvalBridge');
    const { evaluateConditionExpr, evaluateConditionExprWithTrace } =
      await import('./graphDialogue/evaluateGraphCondition');
    const { ctx } = baseContext(true);
    // 未注入 getActivePlaneId：按 normal 比较
    expect(evaluateConditionExprList([{ plane: 'normal' } as any], ctx)).toBe(true);
    expect(evaluateConditionExprList([{ plane: '背尸' } as any], ctx)).toBe(false);
    // 注入后按激活位面比较；trace 版与非 trace 版同判
    ctx.getActivePlaneId = () => '背尸';
    const leaf = { plane: '背尸' } as any;
    expect(evaluateConditionExpr(leaf, ctx)).toBe(true);
    expect(evaluateConditionExprWithTrace(leaf, ctx).result).toBe(true);
    // 组合语义：非 normal
    expect(evaluateConditionExpr({ not: { plane: 'normal' } } as any, ctx)).toBe(true);
    // 空 id 判 false
    expect(evaluateConditionExpr({ plane: '' } as any, ctx)).toBe(false);
  });

  it('fails closed on unknown flag condition operators and warns once per operator', async () => {
    const { evaluateConditionExprList } = await import('./graphDialogue/conditionEvalBridge');
    const { flagStore, ctx } = baseContext(true);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    flagStore.set('x', 1);
    // 非法 op（如 '===' 笔误）判 false，而非被静默跳过恒真
    expect(evaluateConditionExprList([{ flag: 'x', op: '===', value: 1 } as any], ctx)).toBe(false);
    expect(evaluateConditionExprList([{ flag: 'x', op: '==', value: 1 } as any], ctx)).toBe(true);
    evaluateConditionExprList([{ flag: 'x', op: '===', value: 1 } as any], ctx);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('未知运算符')).length).toBe(1);
    spy.mockRestore();
  });

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

  it('resolves @owner switch condition to the dialogue owner wrapper', async () => {
    const switchGraph = {
      id: 'owner_token',
      entry: 'switch',
      nodes: {
        switch: {
          type: 'switch',
          defaultNext: 'fallback',
          cases: [{ condition: { narrative: '@owner', state: 'after_event' }, next: 'hit' }],
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'owner-hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'owner-miss', next: 'end' },
        end: { type: 'end' },
      },
    };
    const runtime = graphDialogue(true, switchGraph);
    let text = '';
    runtime.eventBus.on('dialogue:line', (payload) => { text = payload?.text ?? ''; });
    await runtime.manager.startDialogueGraph({ graphId: 'owner_token', npcName: 'NPC', npcId: 'npc_ringboy' });
    expect(text).toBe('owner-hit');
  });

  it('resolves @scene switch condition to the current scene wrapper (onEnter owner inheritance)', async () => {
    const switchGraph = {
      id: 'scene_token',
      entry: 'switch',
      nodes: {
        switch: {
          type: 'switch',
          defaultNext: 'fallback',
          cases: [{ condition: { narrative: '@scene', state: 'scene_open' }, next: 'hit' }],
        },
        hit: { type: 'line', speaker: { kind: 'npc' }, text: 'scene-hit', next: 'end' },
        fallback: { type: 'line', speaker: { kind: 'npc' }, text: 'scene-miss', next: 'end' },
        end: { type: 'end' },
      },
    };
    // 模拟 onEnter：以场景为 owner 启动（无 npcId），@scene 解析为 scene_test 的 wrapper。
    const hit = graphDialogue(true, switchGraph);
    let text = '';
    hit.eventBus.on('dialogue:line', (payload) => { text = payload?.text ?? ''; });
    await hit.manager.startDialogueGraph({ graphId: 'scene_token', npcName: 'NPC', ownerType: 'scene', ownerId: 'scene_test' });
    expect(text).toBe('scene-hit');

    const miss = graphDialogue(false, switchGraph);
    let missText = '';
    miss.eventBus.on('dialogue:line', (payload) => { missText = payload?.text ?? ''; });
    await miss.manager.startDialogueGraph({ graphId: 'scene_token', npcName: 'NPC', ownerType: 'scene', ownerId: 'scene_test' });
    expect(missText).toBe('scene-miss');
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
