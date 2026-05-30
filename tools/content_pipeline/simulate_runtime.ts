import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluateConditionExprWithTrace, type ConditionEvalContext } from '../../src/systems/graphDialogue/evaluateGraphCondition';
import { QuestStatus, type Condition, type ConditionExpr } from '../../src/data/types';
import { compareFlagOrder, looseEqualFlag } from '../../src/core/flagComparison';

type Json = Record<string, any>;

type SimEvent = {
  type: string;
  phase: string;
  label: string;
  payload?: Json;
  source?: Json | null;
};

type SimState = {
  flags: Json;
  quests: Json;
  narrative: Json;
  scenarios: Json;
  scenarioLines: Json;
  literals: Json;
  inventory: Json;
  positions: Json;
  scene: Json;
};

type RuntimeBundle = {
  sourceMap: Json;
  quests: Json[];
  narrativeGraphs: Map<string, Json>;
  dialogueGraphs: Map<string, Json>;
};

const [runtimeRootPath, statePath, sourceMapPath, outPath] = process.argv.slice(2);
if (!runtimeRootPath || !statePath || !sourceMapPath || !outPath) {
  throw new Error('usage: tsx simulate_runtime.ts <runtime_preview_root> <state.json> <source_map.json> <out.json>');
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, ''));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function asObject(value: any): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function questStatus(raw: any): QuestStatus {
  if (raw === QuestStatus.Active || raw === 'Active' || raw === 'active' || raw === 1) return QuestStatus.Active;
  if (raw === QuestStatus.Completed || raw === 'Completed' || raw === 'completed' || raw === 2) return QuestStatus.Completed;
  return QuestStatus.Inactive;
}

function questStatusName(raw: any): 'Inactive' | 'Active' | 'Completed' {
  const status = questStatus(raw);
  if (status === QuestStatus.Active) return 'Active';
  if (status === QuestStatus.Completed) return 'Completed';
  return 'Inactive';
}

function normalizeState(input: Json): SimState {
  return {
    flags: asObject(input.flags),
    quests: asObject(input.quests),
    narrative: asObject(input.narrative),
    scenarios: asObject(input.scenarios),
    scenarioLines: asObject(input.scenarioLines),
    literals: asObject(input.literals),
    inventory: asObject(input.inventory),
    positions: asObject(input.positions),
    scene: asObject(input.scene),
  };
}

function readBundle(root: string, sourceMapPathArg: string): RuntimeBundle {
  const sourceMap = readJson(sourceMapPathArg);
  const quests = readJson(join(root, 'public/assets/data/quests.json')) as Json[];
  const narrative = readJson(join(root, 'public/assets/data/narrative_graphs.json'));
  const narrativeGraphs = new Map<string, Json>();
  const addNarrativeGraph = (graph: Json) => {
    if (graph.id) narrativeGraphs.set(String(graph.id), graph);
  };
  for (const comp of narrative.compositions ?? []) {
    addNarrativeGraph(comp.mainGraph ?? {});
    for (const element of comp.elements ?? []) {
      addNarrativeGraph(element?.graph ?? {});
    }
  }
  const dialogueGraphs = new Map<string, Json>();
  const dialogueDir = join(root, 'public/assets/dialogues/graphs');
  for (const entry of readdirSync(dialogueDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const graph = readJson(join(dialogueDir, entry.name));
    if (graph.id) dialogueGraphs.set(String(graph.id), graph);
  }
  return { sourceMap, quests, narrativeGraphs, dialogueGraphs };
}

function sourceFor(runtimeRef: string | undefined, sourceMap: Json): any {
  if (!runtimeRef) return null;
  const sourceId = sourceMap.runtimeToSource?.[runtimeRef];
  return sourceId ? { sourceId, ...(sourceMap.sources?.[sourceId] ?? {}) } : null;
}

function conditionContext(state: SimState, bundle: RuntimeBundle): ConditionEvalContext {
  return {
    flagStore: {
      evalPureFlagConjunction(conditions: Condition[]): boolean {
        for (const cond of conditions) {
          const expected = cond.value === undefined || cond.value === null ? true : cond.value;
          const raw = state.flags[cond.flag];
          const actual = raw !== undefined ? raw : typeof expected === 'boolean' ? false : typeof expected === 'number' ? 0 : '';
          const op = cond.op ?? '==';
          if (op === '==' && !looseEqualFlag(actual, expected)) return false;
          if (op === '!=' && looseEqualFlag(actual, expected)) return false;
          if ((op === '>' || op === '<' || op === '>=' || op === '<=') && !compareFlagOrder(actual, expected, op)) return false;
        }
        return true;
      },
    } as any,
    questManager: {
      getStatus(id: string): QuestStatus {
        return questStatus(state.quests[id]);
      },
    } as any,
    scenarioState: {
      phaseStatusEquals(scenario: string, phase: string, status: string): boolean {
        return state.scenarios?.[scenario]?.[phase]?.status === status;
      },
      getScenarioPhase(scenario: string, phase: string): any {
        return state.scenarios?.[scenario]?.[phase];
      },
      getLineLifecycleState(id: string): any {
        return state.scenarioLines[id] ?? 'inactive';
      },
    } as any,
    narrativeState: {
      getActiveState(id: string): string | undefined {
        const graph = bundle.narrativeGraphs.get(id);
        return state.narrative[id] ?? graph?.initialState;
      },
      isStateActive(id: string, stateId: string): boolean {
        const graph = bundle.narrativeGraphs.get(id);
        return (state.narrative[id] ?? graph?.initialState) === stateId;
      },
      getGraph(id: string): any {
        return bundle.narrativeGraphs.get(id);
      },
      getGraphIdsByOwner(ownerType: string, ownerId: string): string[] {
        return [...bundle.narrativeGraphs.values()]
          .filter((g) => g.ownerType === ownerType && g.ownerId === ownerId)
          .map((g) => String(g.id));
      },
      getPrimaryGraphByOwner(ownerType: string, ownerId: string): any {
        return [...bundle.narrativeGraphs.values()].find((g) => g.ownerType === ownerType && g.ownerId === ownerId);
      },
      getPrimaryActiveStateByOwner(ownerType: string, ownerId: string): string | undefined {
        const graph = [...bundle.narrativeGraphs.values()].find((g) => g.ownerType === ownerType && g.ownerId === ownerId);
        return graph ? (state.narrative[graph.id] ?? graph.initialState) : undefined;
      },
      isOwnerStateActive(ownerType: string, ownerId: string, stateId: string): boolean {
        const graph = [...bundle.narrativeGraphs.values()].find((g) => g.ownerType === ownerType && g.ownerId === ownerId);
        return Boolean(graph && (state.narrative[graph.id] ?? graph.initialState) === stateId);
      },
    },
    resolveConditionLiteral(raw: string): string {
      return String(state.literals?.[raw] ?? raw);
    },
  };
}

function wrapCondition(expr: ConditionExpr[] | ConditionExpr | undefined, mode: 'default' | 'reactiveAll' | 'reactiveAny' = 'default'): ConditionExpr | undefined {
  if (!expr) return undefined;
  if (Array.isArray(expr)) {
    if (expr.length === 0) return undefined;
    if (mode === 'reactiveAny') return { any: expr };
    return { all: expr };
  }
  return expr;
}

function evaluateConditions(expr: ConditionExpr[] | ConditionExpr | undefined, state: SimState, bundle: RuntimeBundle, runtimeRef?: string, mode?: 'default' | 'reactiveAll' | 'reactiveAny') {
  const wrapped = wrapCondition(expr, mode);
  if (!wrapped) {
    return { result: true, trace: { kind: 'all', result: true, items: [] }, runtimeRef };
  }
  const evaluated = evaluateConditionExprWithTrace(wrapped, conditionContext(state, bundle));
  return { result: evaluated.result, trace: evaluated.trace, runtimeRef, source: sourceFor(runtimeRef, bundle.sourceMap) };
}

function pushEvent(events: SimEvent[], bundle: RuntimeBundle, event: Omit<SimEvent, 'source'>): void {
  const runtimeRef = event.payload?.runtimeRef;
  events.push({ ...event, source: sourceFor(runtimeRef, bundle.sourceMap) });
}

function setQuestState(state: SimState, questId: string, status: 'Inactive' | 'Active' | 'Completed'): void {
  if (!questId) return;
  state.quests[questId] = status;
  state.flags[`quest_${questId}_status`] = QuestStatus[status];
}

class Simulator {
  readonly events: SimEvent[] = [];
  readonly conditions: Json[] = [];
  readonly route: Json[] = [];
  readonly blocked: Json[] = [];
  private signalDepth = 0;

  constructor(readonly bundle: RuntimeBundle, readonly state: SimState, readonly request: Json) {}

  run(): void {
    this.evaluateQuests();
    const simulate = asObject(this.request.simulate);
    const type = String(simulate.type ?? 'summary');
    if (type === 'dialogueRoute') {
      this.runDialogueRoute(simulate);
    } else if (type === 'emitSignal') {
      this.emitSignal(String(simulate.signal ?? ''));
    } else if (type === 'actions') {
      this.runActions(Array.isArray(simulate.actions) ? simulate.actions : [], 'simulate.actions');
    } else if (type !== 'summary') {
      this.blocked.push({ reason: 'unknownSimulationType', type });
    }
    if (type !== 'summary') {
      this.evaluateQuests();
      this.evaluateReactiveTransitions();
    }
  }

  runActions(actions: any[], runtimeRefPrefix: string): void {
    for (let i = 0; i < actions.length; i += 1) {
      this.runAction(actions[i], `${runtimeRefPrefix}[${i}]`);
    }
  }

  runAction(action: Json, runtimeRef: string): void {
    const type = String(action?.type ?? '');
    const params = asObject(action?.params);
    const before = deepClone(this.state);
    pushEvent(this.events, this.bundle, {
      type: 'action',
      phase: 'run',
      label: type || 'unknown',
      payload: { actionType: type, params, runtimeRef },
    });

    if (type === 'setFlag') {
      const key = String(params.key ?? '');
      if (key) this.state.flags[key] = params.value;
    } else if (type === 'appendFlag') {
      const key = String(params.key ?? '');
      const value = params.text ?? params.value ?? '';
      if (key) {
        const current = this.state.flags[key];
        this.state.flags[key] = Array.isArray(current) ? [...current, value] : current === undefined ? [value] : [current, value];
      }
    } else if (type === 'emitNarrativeSignal') {
      this.emitSignal(String(params.signal ?? ''), runtimeRef);
    } else if (type === 'updateQuest') {
      this.acceptQuest(String(params.id ?? params.questId ?? ''), runtimeRef);
    } else if (type === 'setNarrativeState') {
      const graphId = String(params.graphId ?? '');
      const stateId = String(params.stateId ?? '');
      if (graphId && stateId) this.state.narrative[graphId] = stateId;
    } else if (type === 'runActions') {
      this.runActions(Array.isArray(params.actions) ? params.actions : [], `${runtimeRef}.params.actions`);
    } else if (type === 'setScenarioPhase') {
      const scenarioId = String(params.scenarioId ?? '');
      const phase = String(params.phase ?? '');
      if (scenarioId && phase) {
        const bucket = (this.state.scenarios[scenarioId] ??= {});
        bucket[phase] = { status: String(params.status ?? 'active'), ...(params.outcome === undefined ? {} : { outcome: params.outcome }) };
      }
    } else if (type === 'activateScenario') {
      const scenarioId = String(params.scenarioId ?? '');
      if (scenarioId) this.state.scenarioLines[scenarioId] = 'active';
    } else if (type === 'completeScenario') {
      const scenarioId = String(params.scenarioId ?? '');
      if (scenarioId) this.state.scenarioLines[scenarioId] = 'completed';
    } else if (type === 'giveItem' || type === 'removeItem') {
      const id = String(params.id ?? '');
      const count = Number(params.count ?? 1);
      if (id && Number.isFinite(count)) {
        const current = Number(this.state.inventory[id] ?? 0);
        this.state.inventory[id] = type === 'giveItem' ? current + count : Math.max(0, current - count);
      }
    } else if (type === 'giveCurrency' || type === 'removeCurrency') {
      const amount = Number(params.amount ?? 0);
      if (Number.isFinite(amount)) {
        const current = Number(this.state.inventory.coins ?? 0);
        this.state.inventory.coins = type === 'giveCurrency' ? current + amount : Math.max(0, current - amount);
      }
    } else if (type === 'switchScene' || type === 'transitionScene') {
      const targetScene = String(params.targetScene ?? params.sceneId ?? '');
      if (targetScene) this.state.scene.current = targetScene;
    } else if (type === 'moveEntityTo' || type === 'persistEntityPosition' || type === 'setEntityPosition') {
      const entityId = String(params.entityId ?? params.id ?? 'player');
      this.state.positions[entityId] = { ...this.state.positions[entityId], ...params };
    }

    this.evaluateQuests();
    this.evaluateReactiveTransitions();
    const diff = diffState(before, this.state);
    pushEvent(this.events, this.bundle, {
      type: 'action',
      phase: 'diff',
      label: type || 'unknown',
      payload: { actionType: type, runtimeRef, diff },
    });
  }

  emitSignal(signal: string, runtimeRef?: string): void {
    if (!signal) {
      this.blocked.push({ reason: 'missingSignal', runtimeRef });
      return;
    }
    if (this.signalDepth > 64) {
      this.blocked.push({ reason: 'signalCascadeMaxDepth', signal, runtimeRef, maxDepth: 64 });
      return;
    }
    this.signalDepth += 1;
    pushEvent(this.events, this.bundle, {
      type: 'signal',
      phase: 'emit',
      label: signal,
      payload: { signal, runtimeRef },
    });
    for (const graph of this.bundle.narrativeGraphs.values()) {
      this.applyBestTransition(graph, (t) => t.signal === signal, signal);
    }
    this.evaluateReactiveTransitions();
    this.signalDepth -= 1;
  }

  evaluateReactiveTransitions(maxPasses = 32): void {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let changed = false;
      for (const graph of this.bundle.narrativeGraphs.values()) {
        const applied = this.applyBestTransition(
          graph,
          (t) => t.trigger && t.trigger !== 'signal',
          '__reactive__',
          true,
        );
        changed = changed || applied;
      }
      if (!changed) return;
    }
    this.blocked.push({ reason: 'reactiveMaxPasses', maxPasses });
  }

  applyBestTransition(graph: Json, predicate: (transition: Json) => boolean, triggerKey: string, reactive = false): boolean {
    const active = String(this.state.narrative[graph.id] ?? graph.initialState ?? '');
    const candidates = (graph.transitions ?? [])
      .map((t: Json, index: number) => ({ t, index }))
      .filter(({ t }: { t: Json }) => {
        const runtimeRef = `narrative:${graph.id}.transition:${t.id}`;
        if (!predicate(t)) return false;
        if (String(t.from ?? '') !== active) {
          this.conditions.push({ runtimeRef, result: false, reason: 'inactiveSource', active, from: t.from, source: sourceFor(runtimeRef, this.bundle.sourceMap) });
          return false;
        }
        const mode = reactive && t.trigger === 'reactiveAny' ? 'reactiveAny' : reactive && t.trigger === 'reactiveAll' ? 'reactiveAll' : 'default';
        const result = evaluateConditions(t.conditions, this.state, this.bundle, `${runtimeRef}.conditions`, mode);
        this.conditions.push({ ...result, graphId: graph.id, transitionId: t.id, triggerKey });
        return result.result;
      })
      .sort((a: any, b: any) => {
        const pa = a.t.priority ?? 0;
        const pb = b.t.priority ?? 0;
        return pa !== pb ? pb - pa : a.index - b.index;
      });
    const selected = candidates[0]?.t;
    if (!selected) return false;
    this.applyTransition(graph, selected, triggerKey);
    return true;
  }

  applyTransition(graph: Json, transition: Json, triggerKey: string): void {
    const from = String(transition.from ?? '');
    const to = String(transition.to ?? '');
    const runtimeRef = `narrative:${graph.id}.transition:${transition.id}`;
    const fromState = graph.states?.[from];
    const toState = graph.states?.[to];
    if (Array.isArray(fromState?.onExitActions)) this.runActions(fromState.onExitActions, `narrative:${graph.id}.state:${from}.onExitActions`);
    this.state.narrative[graph.id] = to;
    pushEvent(this.events, this.bundle, {
      type: 'narrative',
      phase: 'change',
      label: `${graph.id}: ${from} -> ${to}`,
      payload: { graphId: graph.id, transitionId: transition.id, from, to, triggerKey, runtimeRef },
    });
    if (Array.isArray(toState?.onEnterActions)) this.runActions(toState.onEnterActions, `narrative:${graph.id}.state:${to}.onEnterActions`);
    if (toState?.broadcastOnEnter === true) {
      this.emitSignal(`state:${graph.id}:${to}`, `narrative:${graph.id}.state:${to}.broadcastOnEnter`);
    }
  }

  acceptQuest(questId: string, runtimeRef?: string): void {
    if (!questId || questStatus(this.state.quests[questId]) !== QuestStatus.Inactive) return;
    setQuestState(this.state, questId, 'Active');
    const def = this.bundle.quests.find((q) => q.id === questId);
    pushEvent(this.events, this.bundle, {
      type: 'quest',
      phase: 'accepted',
      label: questId,
      payload: { questId, runtimeRef: runtimeRef ?? `quest:${questId}` },
    });
    if (Array.isArray(def?.acceptActions)) this.runActions(def.acceptActions, `quest:${questId}.acceptActions`);
  }

  completeQuest(questId: string): void {
    if (!questId || questStatus(this.state.quests[questId]) === QuestStatus.Completed) return;
    const def = this.bundle.quests.find((q) => q.id === questId);
    setQuestState(this.state, questId, 'Completed');
    pushEvent(this.events, this.bundle, {
      type: 'quest',
      phase: 'completed',
      label: questId,
      payload: { questId, runtimeRef: `quest:${questId}` },
    });
    if (Array.isArray(def?.rewards)) this.runActions(def.rewards, `quest:${questId}.rewards`);
    for (const edge of def?.nextQuests ?? []) {
      const result = evaluateConditions(edge.conditions, this.state, this.bundle, `quest:${questId}.nextQuest:${edge.questId}.conditions`);
      this.conditions.push({ ...result, questId, nextQuestId: edge.questId, phase: 'nextQuestConditions' });
      if (!result.result) continue;
      if (!edge.bypassPreconditions) {
        const targetDef = this.bundle.quests.find((q) => q.id === edge.questId);
        const pre = evaluateConditions(targetDef?.preconditions, this.state, this.bundle, `quest:${edge.questId}.preconditions`);
        this.conditions.push({ ...pre, questId: edge.questId, phase: 'preconditions' });
        if (!pre.result) continue;
      }
      this.acceptQuest(String(edge.questId ?? ''));
    }
  }

  evaluateQuests(): void {
    for (const def of this.bundle.quests) {
      const status = questStatus(this.state.quests[def.id]);
      if (status === QuestStatus.Inactive && Array.isArray(def.preconditions) && def.preconditions.length > 0) {
        const result = evaluateConditions(def.preconditions, this.state, this.bundle, `quest:${def.id}.preconditions`);
        this.conditions.push({ ...result, questId: def.id, phase: 'preconditions' });
        if (result.result) this.acceptQuest(String(def.id));
      } else if (status === QuestStatus.Active && Array.isArray(def.completionConditions) && def.completionConditions.length > 0) {
        const result = evaluateConditions(def.completionConditions, this.state, this.bundle, `quest:${def.id}.completionConditions`);
        this.conditions.push({ ...result, questId: def.id, phase: 'completionConditions' });
        if (result.result) this.completeQuest(String(def.id));
      }
    }
  }

  runDialogueRoute(simulate: Json): void {
    const graphId = String(simulate.graphId ?? '');
    const graph = this.bundle.dialogueGraphs.get(graphId);
    if (!graph) {
      this.blocked.push({ reason: 'dialogueGraphMissing', graphId });
      return;
    }
    let nodeId = String(simulate.entry ?? graph.entry ?? 'start');
    const maxSteps = Number.isFinite(Number(simulate.maxSteps)) ? Number(simulate.maxSteps) : 100;
    const choices = asObject(simulate.choices);
    const owner = asObject(simulate.owner);
    for (let step = 0; step < maxSteps; step += 1) {
      const node = graph.nodes?.[nodeId];
      const runtimeRef = `dialogue:${graphId}.node:${nodeId}`;
      if (!node) {
        this.blocked.push({ reason: 'dialogueNodeMissing', graphId, nodeId, runtimeRef, source: sourceFor(runtimeRef, this.bundle.sourceMap) });
        return;
      }
      const type = String(node.type ?? 'line');
      this.route.push({ step, graphId, nodeId, type, runtimeRef, source: sourceFor(runtimeRef, this.bundle.sourceMap) });

      if (type === 'end') return;
      if (type === 'line') {
        nodeId = String(node.next ?? '');
      } else if (type === 'runActions') {
        this.runActions(Array.isArray(node.actions) ? node.actions : [], `${runtimeRef}.actions`);
        nodeId = String(node.next ?? '');
      } else if (type === 'switch') {
        const picked = (node.cases ?? []).find((c: Json, index: number) => {
          const result = evaluateConditions(c.condition ?? c.conditions, this.state, this.bundle, `${runtimeRef}.case[${index}].condition`);
          this.conditions.push({ ...result, graphId, nodeId, caseIndex: index, phase: 'dialogueSwitch' });
          return result.result;
        });
        nodeId = String(picked?.next ?? node.defaultNext ?? '');
      } else if (type === 'contextState') {
        const graphState = this.state.narrative[node.graphId] ?? this.bundle.narrativeGraphs.get(String(node.graphId))?.initialState;
        const picked = (node.cases ?? []).find((c: Json) => String(c.state ?? '') === String(graphState ?? ''));
        nodeId = String(picked?.next ?? node.defaultNext ?? '');
      } else if (type === 'ownerState') {
        const ownerType = String(owner.type ?? owner.ownerType ?? '');
        const ownerId = String(owner.id ?? owner.ownerId ?? '');
        const graph = String(node.wrapperGraphId ?? '')
          ? this.bundle.narrativeGraphs.get(String(node.wrapperGraphId))
          : [...this.bundle.narrativeGraphs.values()].find((g) => g.ownerType === ownerType && g.ownerId === ownerId);
        const graphState = graph ? this.state.narrative[graph.id] ?? graph.initialState : undefined;
        const picked = (node.cases ?? []).find((c: Json) => String(c.state ?? '') === String(graphState ?? ''));
        nodeId = String(picked?.next ?? (graph ? node.defaultNext : node.missingWrapperNext) ?? '');
      } else if (type === 'choice') {
        const enabled = (node.options ?? []).filter((opt: Json, index: number) => this.optionEnabled(opt, `${runtimeRef}.options[${index}]`, graphId, nodeId, index));
        const requestChoice = choices[nodeId];
        const picked = this.pickChoice(enabled, requestChoice);
        if (!picked) {
          this.blocked.push({ reason: 'noEnabledChoice', graphId, nodeId, runtimeRef });
          return;
        }
        this.route[this.route.length - 1].choice = { id: picked.id, text: picked.text, next: picked.next };
        if (Array.isArray(picked.actions)) this.runActions(picked.actions, `${runtimeRef}.option.${picked.id ?? 'selected'}.actions`);
        nodeId = String(picked.next ?? '');
      } else {
        this.blocked.push({ reason: 'unsupportedDialogueNodeType', graphId, nodeId, type, runtimeRef });
        return;
      }
      if (!nodeId) {
        this.blocked.push({ reason: 'missingNext', graphId, runtimeRef });
        return;
      }
    }
    this.blocked.push({ reason: 'dialogueMaxSteps', graphId, maxSteps });
  }

  optionEnabled(opt: Json, runtimeRef: string, graphId: string, nodeId: string, optionIndex: number): boolean {
    if (opt.requireFlag) {
      const key = String(opt.requireFlag);
      if (!this.state.flags[key]) {
        this.conditions.push({ runtimeRef, result: false, reason: 'requireFlag', flag: key, graphId, nodeId, optionIndex });
        return false;
      }
    }
    if (opt.requireCondition) {
      const result = evaluateConditions(opt.requireCondition, this.state, this.bundle, `${runtimeRef}.requireCondition`);
      this.conditions.push({ ...result, graphId, nodeId, optionIndex, phase: 'choiceRequireCondition' });
      if (!result.result) return false;
    }
    if (opt.costCoins !== undefined && Number(this.state.inventory.coins ?? 0) < Number(opt.costCoins)) {
      this.conditions.push({ runtimeRef, result: false, reason: 'costCoins', required: opt.costCoins, actual: this.state.inventory.coins ?? 0, graphId, nodeId, optionIndex });
      return false;
    }
    return true;
  }

  pickChoice(enabled: Json[], requestChoice: any): Json | undefined {
    if (requestChoice === undefined || requestChoice === null || requestChoice === '') return enabled[0];
    if (typeof requestChoice === 'number') return enabled[requestChoice];
    const needle = String(requestChoice);
    return enabled.find((opt) => String(opt.id ?? '') === needle || String(opt.text ?? '') === needle) ?? enabled[0];
  }
}

function diffState(before: SimState, after: SimState): Json {
  const out: Json = {};
  for (const key of ['flags', 'quests', 'narrative', 'scenarios', 'scenarioLines', 'inventory', 'positions', 'scene'] as const) {
    const bucket: Json[] = [];
    const left = asObject((before as any)[key]);
    const right = asObject((after as any)[key]);
    for (const id of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (JSON.stringify(left[id]) !== JSON.stringify(right[id])) bucket.push({ id, before: left[id], after: right[id] });
    }
    if (bucket.length) out[key] = bucket;
  }
  return out;
}

const root = resolve(runtimeRootPath);
const request = readJson(statePath);
const bundle = readBundle(root, resolve(sourceMapPath));
const initialState = normalizeState(deepClone(request));
const finalState = normalizeState(deepClone(request));
const simulator = new Simulator(bundle, finalState, request);
simulator.run();

const result = {
  ok: simulator.blocked.length === 0,
  input: { simulate: request.simulate ?? { type: 'summary' } },
  initialState,
  finalState,
  diff: diffState(initialState, finalState),
  events: simulator.events,
  route: simulator.route,
  blocked: simulator.blocked,
  conditions: simulator.conditions,
};

writeFileSync(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
