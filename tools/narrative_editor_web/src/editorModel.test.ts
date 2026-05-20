import { describe, expect, it } from 'vitest';
import {
  blockingValidationErrors,
  createTransition,
  focusValidationIssue,
  mergeValidationIssues,
  normalizeFile,
  renameGraph,
  renameStateInGraph,
  simulateSignalImpact,
  validateNarrativeData,
} from './editorModel';
import { parseTransitionAnchorId, transitionAnchorId } from './anchorCodec';
import type { NarrativeGraphsFileDef } from './types';

function sample(): NarrativeGraphsFileDef {
  return {
    schemaVersion: 2,
    compositions: [
      {
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' }, b: { id: 'b' } },
          transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'external:system:test:go' }],
        },
        elements: [
          {
            id: 'npc_el',
            kind: 'wrapperGraph',
            ownerType: 'npc',
            ownerId: 'npc',
            graph: {
              id: 'npc',
              ownerType: 'npc',
              initialState: 'before',
              states: { before: { id: 'before' }, after: { id: 'after' } },
              transitions: [{ id: 'after', from: 'before', to: 'after', signal: 'external:state:flow:b' }],
            },
          },
        ],
      },
    ],
  };
}

describe('editorModel', () => {
  it('renames states and graph-state signal references together', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const nextId = renameStateInGraph(data, flow, 'b', 'done');
    expect(nextId).toBe('done');
    expect(flow.transitions[0]!.to).toBe('done');
    const npc = data.compositions![0]!.elements![0]!.graph!;
    expect(npc.transitions[0]!.signal).toBe('external:state:flow:done');
  });

  it('renames local transition endpoints together', () => {
    const data = normalizeFile(sample());
    const npc = data.compositions![0]!.elements![0]!.graph!;
    npc.transitions.push({
      id: 'local',
      from: 'before',
      to: 'after',
      signal: 'external:system:test:enter',
    });
    const nextId = renameStateInGraph(data, npc, 'before', 'idle');
    expect(nextId).toBe('idle');
    expect(npc.transitions[0]!.from).toBe('idle');
  });

  it('creates transitions with a safe default signal', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const t = createTransition(flow, 'b', 'a');
    expect(t.id).toBe('t_1');
    expect(t.signal).toBe('');
    expect(flow.transitions).toHaveLength(2);
    expect(validateNarrativeData(data).map((issue) => issue.code)).toContain('transition.signal.empty');
  });

  it('renames graphs and known graph references together', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const npc = data.compositions![0]!.elements![0]!.graph!;
    flow.transitions.push({
      id: 'enter_npc',
      from: 'b',
      to: 'before',
      signal: 'external:state:npc:before',
      conditions: [{ narrative: 'npc', state: 'before' }],
    });
    data.compositions![0]!.elements![0]!.meta = { reads: ['npc'], emits: [] };
    const nextId = renameGraph(data, npc, 'npc_new');
    expect(nextId).toBe('npc_new');
    expect(flow.transitions[1]!.conditions).toEqual([{ narrative: 'npc_new', state: 'before' }]);
    expect(data.compositions![0]!.elements![0]!.meta!.reads).toEqual(['npc_new']);
  });

  it('simulates external and graph-state cascade transitions', () => {
    const result = simulateSignalImpact(sample(), 'external:system:test:go');
    expect(result.activeStates).toMatchObject({ flow: 'b', npc: 'after' });
    expect(result.recentTransitions.map((t) => t.transitionId)).toEqual(['go', 'after']);
  });

  it('does not simulate legacy cross-graph transition endpoints', () => {
    const data = normalizeFile(sample());
    const comp = data.compositions![0]!;
    comp.elements!.push({
      id: 'scenario_el',
      kind: 'scenarioSubgraph',
      ownerType: 'scenario',
      ownerId: 's',
      refId: 's',
      graph: {
        id: 'scenario',
        ownerType: 'scenario',
        ownerId: 's',
        initialState: 'inactive',
        entryState: 'entry',
        exitStates: ['exit'],
        states: { inactive: { id: 'inactive' }, entry: { id: 'entry' }, exit: { id: 'exit' } },
        transitions: [],
      },
    });
    comp.mainGraph.transitions.push({
      id: 'enter_scenario',
      from: 'a',
      to: { graphId: 'scenario', stateId: 'entry' },
      signal: 'external:system:test:enter',
    });
    const result = simulateSignalImpact(data, 'external:system:test:enter');
    expect(result.activeStates.flow).toBe('a');
    expect(result.activeStates.scenario).toBe('inactive');
    expect(result.recentTransitions).toHaveLength(0);
  });

  it('validates broken transitions as blocking errors', () => {
    const data = normalizeFile(sample());
    data.compositions![0]!.mainGraph.transitions[0]!.to = 'missing';
    data.compositions![0]!.mainGraph.transitions[0]!.signal = '';
    const issues = validateNarrativeData(data);
    expect(issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['transition.to.missing', 'transition.signal.empty']),
    );
  });

  it('validates legacy cross-graph transition endpoints', () => {
    const data = normalizeFile(sample());
    const comp = data.compositions![0]!;
    comp.elements!.push({
      id: 'scenario_el',
      kind: 'scenarioSubgraph',
      ownerType: 'scenario',
      ownerId: 's',
      refId: 's',
      graph: {
        id: 'scenario',
        ownerType: 'scenario',
        ownerId: 's',
        initialState: 'inactive',
        entryState: 'entry',
        exitStates: ['exit'],
        states: { inactive: { id: 'inactive' }, entry: { id: 'entry' }, middle: { id: 'middle' }, exit: { id: 'exit' } },
        transitions: [],
      },
    });
    comp.mainGraph.transitions.push({
      id: 'bad_enter',
      from: 'a',
      to: { graphId: 'scenario', stateId: 'middle' },
      signal: 'external:system:test:bad',
    });
    const codes = validateNarrativeData(data).map((issue) => issue.code);
    expect(codes).toContain('transition.crossGraphEndpoint.unsupported');
  });

  it('blocks deprecated lifecycle signals and invalid condition/action shapes', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    flow.states.a.onExitActions = [{ type: 'setNarrativeState', params: { graphId: 'flow' } }];
    flow.transitions.push({
      id: 'local_lifecycle',
      from: 'a',
      to: 'b',
      signal: 'stateEntered:flow:a',
      conditions: [
        { quest: 'q' },
        { scenario: 's', phase: 'p' },
        { scenarioLine: 'line' },
        { narrative: 'flow' },
      ],
    });
    const codes = validateNarrativeData(data).filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      'transition.signal.lifecycleDeprecated',
      'action.param.missing',
      'condition.shape',
      'stateCommand.unsafeInContent',
    ]));
  });

  it('does not commit an invalid JSON apply candidate', () => {
    const before = normalizeFile(sample());
    const candidate = normalizeFile(before);
    candidate.compositions![0]!.mainGraph.transitions[0]!.signal = '';
    const issues = validateNarrativeData(candidate);
    const committed = blockingValidationErrors(issues).length ? before : candidate;
    expect(committed.compositions![0]!.mainGraph.transitions[0]!.signal).toBe('external:system:test:go');
  });

  it('reports unbound wrapperGraph as error', () => {
    const data = normalizeFile(sample());
    const element = data.compositions![0]!.elements![0]!;
    element.ownerId = '';
    if (element.graph) element.graph.ownerId = '';
    const issues = validateNarrativeData(data);
    expect(issues.some((issue) => issue.code === 'wrapper.unbound' && issue.severity === 'error')).toBe(true);
  });

  it('reports duplicate owner bindings as error', () => {
    const issues = validateNarrativeData({
      schemaVersion: 2,
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' } },
          transitions: [],
        },
        elements: [
          {
            id: 'wrapper_a',
            kind: 'wrapperGraph',
            ownerType: 'npc',
            ownerId: 'npc_ringboy',
            graph: {
              id: 'npc_a',
              ownerType: 'npc',
              ownerId: 'npc_ringboy',
              initialState: 'idle',
              states: { idle: { id: 'idle' } },
              transitions: [],
            },
          },
          {
            id: 'wrapper_b',
            kind: 'wrapperGraph',
            ownerType: 'npc',
            ownerId: 'npc_ringboy',
            graph: {
              id: 'npc_b',
              ownerType: 'npc',
              ownerId: 'npc_ringboy',
              initialState: 'idle',
              states: { idle: { id: 'idle' } },
              transitions: [],
            },
          },
        ],
      }],
    });
    expect(issues.some((issue) => issue.code === 'owner.wrapper.duplicate' && issue.severity === 'error')).toBe(true);
  });

  it('merges local and remote validation issues without duplicates', () => {
    const local = [{ severity: 'error' as const, code: 'a', message: 'one', path: 'p1' }];
    const remote = [
      { severity: 'error' as const, code: 'a', message: 'one', path: 'p1' },
      { severity: 'warning' as const, code: 'b', message: 'two', path: 'p2' },
    ];
    const merged = mergeValidationIssues(local, remote);
    expect(merged).toHaveLength(2);
  });

  it('focusValidationIssue resolves composition state node ids', () => {
    const data = normalizeFile(sample());
    let compositionId = '';
    const result = focusValidationIssue(
      { severity: 'error', code: 'state.missing', message: 'missing', itemId: 'b', path: 'compositions[0].mainGraph.states.b' },
      data,
      {
        compositionId: 'comp',
        setCompositionId: (id) => { compositionId = id; },
        setGraphRef: () => {},
        setExpandedElementIds: (fn) => fn([]),
        setSelectedId: () => {},
      },
    );
    expect(result?.nodeIds).toContain('state:b');
    expect(compositionId).toBe('comp');
  });

  it('uses a centralized transition anchor codec and validates delimiter ids', () => {
    const id = transitionAnchorId('flow', 't');
    expect(id).toBe('transition-anchor:flow:t');
    expect(parseTransitionAnchorId(id)).toEqual({ graphId: 'flow', transitionId: 't' });

    const data = normalizeFile(sample());
    data.compositions![0]!.mainGraph.id = 'flow:bad';
    data.compositions![0]!.mainGraph.transitions[0]!.id = 't:bad';
    const codes = validateNarrativeData(data).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['graph.id.delimiter', 'transition.id.delimiter']));
  });
});
