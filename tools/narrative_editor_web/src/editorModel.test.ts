import { describe, expect, it } from 'vitest';
import {
  blockingValidationErrors,
  createTransition,
  mergeValidationIssues,
  normalizeFile,
  renameGraph,
  renameStateInGraph,
  simulateSignalImpact,
  validateNarrativeData,
} from './editorModel';
import { focusValidationIssue, issueBelongsToActiveGraph, resolveValidationIssueFocus } from './focusIssueResolution';
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
    expect(npc.transitions[0]!.signal).toBe('state:flow:done');
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

  it('renames narrative state references in conditions, state commands, and projection commands', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const npcElement = data.compositions![0]!.elements![0]!;
    const npc = npcElement.graph!;
    flow.transitions.push({
      id: 'read_npc_state',
      from: 'a',
      to: 'b',
      signal: 'go',
      conditions: [{ narrative: 'npc', state: 'after' }],
    });
    npc.states.before.onEnterActions = [
      { type: 'setNarrativeState', params: { graphId: 'npc', stateId: 'after' } },
    ];
    npcElement.meta = { commands: ['npc.after', 'npc:after'] };

    const nextId = renameStateInGraph(data, npc, 'after', 'done');

    expect(nextId).toBe('done');
    expect(flow.transitions.at(-1)?.conditions).toEqual([{ narrative: 'npc', state: 'done' }]);
    expect(npc.states.before.onEnterActions?.[0]?.params).toEqual({ graphId: 'npc', stateId: 'done' });
    expect(npcElement.meta.commands).toEqual(['npc.done', 'npc:done']);
  });

  it('creates transitions with draft default signal', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const t = createTransition(flow, 'b', 'a');
    expect(t.id).toBe('t_1');
    expect(t.signal).toBe('__draft__');
    expect(flow.transitions).toHaveLength(2);
    expect(validateNarrativeData(data).map((issue) => issue.code)).toContain('transition.signal.draft');
  });

  it('renames graphs and known graph references together', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const npc = data.compositions![0]!.elements![0]!.graph!;
    flow.transitions.push({
      id: 'enter_npc',
      from: 'b',
      to: 'before',
      signal: 'state:npc:before',
      conditions: [{ narrative: 'npc', state: 'before' }],
    });
    data.compositions![0]!.elements![0]!.meta = { reads: ['npc'], emits: [] };
    const nextId = renameGraph(data, npc, 'npc_new');
    expect(nextId).toBe('npc_new');
    expect(flow.transitions[1]!.conditions).toEqual([{ narrative: 'npc_new', state: 'before' }]);
    expect(data.compositions![0]!.elements![0]!.meta!.reads).toEqual(['npc_new']);
  });

  it('simulates external and graph-state cascade transitions', () => {
    const result = simulateSignalImpact(sample(), 'go');
    expect(result.activeStates).toMatchObject({ flow: 'b', npc: 'after' });
    expect(result.recentTransitions.map((t) => t.transitionId)).toEqual(['go', 'after']);
  });

  it('simulates from supplied runtime active states when available', () => {
    const data = normalizeFile(sample());
    data.compositions![0]!.mainGraph.transitions.push({ id: 'back', from: 'b', to: 'a', signal: 'back' });
    const result = simulateSignalImpact(data, 'back', { flow: 'b', npc: 'before' });
    expect(result.activeStates.flow).toBe('a');
    expect(result.recentTransitions.map((t) => t.transitionId)).toEqual(['back']);
  });

  it('guards local simulation against reactive transition loops', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    flow.transitions = [
      {
        id: 'to_b',
        from: 'a',
        to: 'b',
        signal: '__draft__',
        trigger: 'reactiveAll',
        conditions: [{ narrative: 'flow', state: 'a' }],
      },
      {
        id: 'to_a',
        from: 'b',
        to: 'a',
        signal: '__draft__',
        trigger: 'reactiveAll',
        conditions: [{ narrative: 'flow', state: 'b' }],
      },
    ];

    const result = simulateSignalImpact(data, 'noop');
    expect(result.loopGuardTripped).toBe(true);
    expect(result.log.at(-1)).toBe('loop guard tripped at 128 reactive transitions');
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
      to: { graphId: 'scenario', stateId: 'entry' } as unknown as string,
      signal: 'external:system:test:enter',
    });
    const result = simulateSignalImpact(data, 'enter');
    expect(result.activeStates.flow).toBe('a');
    expect(result.activeStates.scenario).toBe('inactive');
    expect(result.recentTransitions).toHaveLength(0);
  });

  it('validates broken transitions as blocking errors', () => {
    const data = normalizeFile(sample());
    data.compositions![0]!.mainGraph.transitions[0]!.to = 'missing';
    data.compositions![0]!.mainGraph.transitions[0]!.signal = '__draft__';
    const issues = validateNarrativeData(data);
    expect(issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['transition.to.missing']),
    );
    expect(issues.map((issue) => issue.code)).toContain('transition.signal.draft');
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
      to: { graphId: 'scenario', stateId: 'middle' } as unknown as string,
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
      'transition.signal.legacyFormat',
      'action.type.unknown',
      'condition.shape',
      'stateCommand.unsafeInContent',
      'stateCommand.target.missing',
    ]));
  });

  it('validates narrative condition graph and state references', () => {
    const data = normalizeFile(sample());
    data.compositions![0]!.mainGraph.transitions.push({
      id: 'missing_narrative_state',
      from: 'a',
      to: 'b',
      signal: 'go',
      conditions: [{ narrative: 'npc', state: 'missing' }],
    });
    const codes = validateNarrativeData(data).filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    expect(codes).toContain('condition.narrative.stateMissing');
  });

  it('does not commit an invalid JSON apply candidate', () => {
    const before = normalizeFile(sample());
    const candidate = normalizeFile(before);
    candidate.compositions![0]!.mainGraph.transitions[0]!.to = 'missing';
    const issues = validateNarrativeData(candidate);
    const committed = blockingValidationErrors(issues).length ? before : candidate;
    expect(committed.compositions![0]!.mainGraph.transitions[0]!.to).toBe('b');
  });

  it('reports unbound wrapperGraph as error', () => {
    const data = normalizeFile(sample());
    const element = data.compositions![0]!.elements![0]!;
    element.ownerId = '';
    if (element.graph) element.graph.ownerId = '';
    const issues = validateNarrativeData(data);
    expect(issues.some((issue) => issue.code === 'wrapper.unbound' && issue.severity === 'error')).toBe(true);
    expect(issues.find((issue) => issue.code === 'wrapper.unbound')?.target).toEqual({
      kind: 'element',
      compositionId: 'comp',
      elementId: 'npc_el',
    });
  });

  it('reports multi-wrapper owner bindings as warning', () => {
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
    expect(issues.some((issue) => issue.code === 'owner.wrapper.multi' && issue.severity === 'warning')).toBe(true);
  });

  it('does not report owner wrapper warnings for non-wrapper graphs', () => {
    const issues = validateNarrativeData({
      schemaVersion: 2,
      compositions: [
        {
          id: 'comp_a',
          mainGraph: {
            id: 'flow_a',
            ownerType: 'flow',
            ownerId: 'shared_flow_owner',
            initialState: 'idle',
            states: { idle: { id: 'idle' } },
            transitions: [],
          },
          elements: [{
            id: 'scenario_a',
            kind: 'scenarioSubgraph',
            graph: {
              id: 'scenario_a_graph',
              ownerType: 'scenario',
              ownerId: 'shared_scenario_owner',
              initialState: 'idle',
              states: { idle: { id: 'idle' } },
              transitions: [],
            },
          }],
        },
        {
          id: 'comp_b',
          mainGraph: {
            id: 'flow_b',
            ownerType: 'flow',
            ownerId: 'shared_flow_owner',
            initialState: 'idle',
            states: { idle: { id: 'idle' } },
            transitions: [],
          },
          elements: [{
            id: 'scenario_b',
            kind: 'scenarioSubgraph',
            graph: {
              id: 'scenario_b_graph',
              ownerType: 'scenario',
              ownerId: 'shared_scenario_owner',
              initialState: 'idle',
              states: { idle: { id: 'idle' } },
              transitions: [],
            },
          }],
        },
      ],
    });
    expect(issues.some((issue) => issue.code.startsWith('owner.wrapper.'))).toBe(false);
  });

  it('merges local and remote validation issues without duplicates', () => {
    const target = { kind: 'state' as const, compositionId: 'comp', graphId: 'flow', stateId: 'a' };
    const local = [{ severity: 'error' as const, code: 'a', message: 'one', path: 'p1', itemId: 'x', target }];
    const remote = [
      { severity: 'error' as const, code: 'a', message: 'one (remote)', path: 'p1', itemId: 'x', target },
      { severity: 'warning' as const, code: 'b', message: 'two', path: 'p2' },
    ];
    const merged = mergeValidationIssues(local, remote);
    expect(merged).toHaveLength(2);
  });

  it('keeps validation issues separate when only target differs', () => {
    const local = [{
      severity: 'error' as const,
      code: 'state.id.empty',
      message: 'same',
      path: 'same',
      itemId: 'same',
      target: { kind: 'state' as const, compositionId: 'comp', graphId: 'flow', stateId: 'a' },
    }];
    const remote = [{
      severity: 'error' as const,
      code: 'state.id.empty',
      message: 'same',
      path: 'same',
      itemId: 'same',
      target: { kind: 'state' as const, compositionId: 'comp', graphId: 'npc', elementId: 'npc_el', stateId: 'a' },
    }];
    expect(mergeValidationIssues(local, remote)).toHaveLength(2);
  });

  it('focusValidationIssue resolves mainGraph transition issues from path', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [
        {
          id: 'comp_a',
          mainGraph: {
            id: 'flow_a',
            ownerType: 'flow',
            initialState: 'a',
            states: { a: { id: 'a' }, b: { id: 'b' } },
            transitions: [{ id: 't_other', from: 'a', to: 'b', signal: 'go' }],
          },
          elements: [],
        },
        {
          id: 'comp_b',
          mainGraph: {
            id: 'flow_1',
            ownerType: 'flow',
            initialState: 'initial',
            states: { initial: { id: 'initial' }, state_1: { id: 'state_1' } },
            transitions: [{ id: 't_1', from: 'initial', to: 'state_1', signal: '__draft__' }],
          },
          elements: [],
        },
      ],
    });
    let compositionId = '';
    let selectedId = '';
    const result = focusValidationIssue(
      {
        severity: 'warning',
        code: 'transition.signal.draft',
        message: 'flow_1.t_1: transition still uses draft signal __draft__',
        path: 'compositions[1].mainGraph.transitions[0].signal',
        itemId: 'flow_1.t_1',
      },
      data,
      {
        compositionId: 'comp_a',
        setCompositionId: (id) => { compositionId = id; },
        setGraphRef: () => {},
        setExpandedElementIds: (fn) => fn([]),
        setSelectedId: (id) => { selectedId = id; },
      },
    );
    expect(compositionId).toBe('comp_b');
    expect(selectedId).toBe('transition:t_1');
    expect(result?.nodeIds).toContain('transition-anchor:flow_1:t_1');
  });

  it('focusValidationIssue resolves mainGraph transition issues from target', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' }, b: { id: 'b' } },
          transitions: [{ id: 't_1', from: 'a', to: 'b', signal: '__draft__' }],
        },
        elements: [],
      }],
    });
    const result = resolveValidationIssueFocus(
      {
        severity: 'warning',
        code: 'transition.signal.draft',
        message: 'draft',
        target: { kind: 'transition', compositionId: 'comp', graphId: 'flow', transitionId: 't_1', field: 'signal' },
      },
      data,
    );
    expect(result?.graphRef).toBe('main');
    expect(result?.selectedId).toBe('transition:t_1');
    expect(result?.nodeIds).toContain('transition-anchor:flow:t_1');
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

  it('resolveValidationIssueFocus focuses a dotted state id with a field suffix (path tail not truncated)', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' }, 's.1': { id: 's.1' } },
          transitions: [],
        },
        elements: [],
      }],
    });
    // state id 含 '.' 且 path 尾串带字段后缀——旧 `([^.[\]]+)` 会截成 's' 导致聚焦失败。
    const result = resolveValidationIssueFocus(
      {
        severity: 'error',
        code: 'state.onEnterActions',
        message: 'bad',
        path: 'compositions[0].mainGraph.states.s.1.onEnterActions[0]',
      },
      data,
    );
    expect(result?.selectedId).toBe('state:s.1');
    expect(result?.nodeIds).toContain('state:s.1');
  });

  it('normalizeFile keeps duplicate author signals (validation flags them) but drops empty/reserved', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [{ id: 'go' }, { id: 'go', label: 'dup' }, { id: '' }, { id: '__draft__' }],
      compositions: [],
    } as unknown as Parameters<typeof normalizeFile>[0]);
    // 重复 id 不再静默丢弃（保留交给 signal.id.duplicate 校验）；空 id / 保留字前缀仍剔除。
    expect(data.signals?.map((s) => s.id)).toEqual(['go', 'go']);
  });

  it('focusValidationIssue opens exclusive subgraph editor for element transitions', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' } },
          transitions: [],
        },
        elements: [{
          id: 'wrap',
          kind: 'wrapperGraph',
          graph: {
            id: 'npc',
            ownerType: 'npc',
            initialState: 's1',
            states: { s1: { id: 's1' }, s2: { id: 's2' } },
            transitions: [{ id: 't_inner', from: 's1', to: 's2', signal: '__draft__' }],
          },
        }],
      }],
    });
    let selectedId = '';
    let graphRef = 'main';
    let expanded: string[] = ['wrap'];
    const result = focusValidationIssue(
      {
        severity: 'warning',
        code: 'transition.signal.draft',
        message: 'draft',
        path: 'compositions[0].elements[0].graph.transitions[0].signal',
        itemId: 'npc.t_inner',
      },
      data,
      {
        compositionId: 'comp',
        setCompositionId: () => {},
        setGraphRef: (ref) => { graphRef = ref; },
        setExpandedElementIds: (fn) => { expanded = fn(expanded); },
        setSelectedId: (id) => { selectedId = id; },
      },
    );
    expect(expanded).not.toContain('wrap');
    expect(graphRef).toBe('element:wrap');
    expect(selectedId).toBe('transition:t_inner');
    expect(result?.graphRef).toBe('element:wrap');
    expect(result?.nodeIds).toContain('state:s1');
    expect(result?.nodeIds).toContain('state:s2');
    expect(result?.nodeIds).toContain('transition-anchor:npc:t_inner');
  });

  it('focusValidationIssue opens exclusive subgraph editor from target', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' }, b: { id: 'b' } },
          transitions: [{ id: 't_1', from: 'a', to: 'b', signal: 'go' }],
        },
        elements: [{
          id: 'wrap',
          kind: 'wrapperGraph',
          graph: {
            id: 'quest',
            ownerType: 'quest',
            initialState: 's1',
            states: { s1: { id: 's1' }, s2: { id: 's2' } },
            transitions: [{ id: 't_1', from: 's1', to: 's2', signal: '__draft__' }],
          },
        }],
      }],
    });
    const result = resolveValidationIssueFocus(
      {
        severity: 'warning',
        code: 'transition.signal.draft',
        message: 'draft',
        target: { kind: 'transition', compositionId: 'comp', graphId: 'quest', elementId: 'wrap', transitionId: 't_1' },
      },
      data,
    );
    expect(result?.graphRef).toBe('element:wrap');
    expect(result?.selectedId).toBe('transition:t_1');
    expect(result?.nodeIds).toContain('transition-anchor:quest:t_1');
    expect(result?.nodeIds).toContain('state:s1');
  });

  it('focusValidationIssue opens element inspector for unbound wrapperGraph', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' } },
          transitions: [],
        },
        elements: [{
          id: 'wrapper_1',
          kind: 'wrapperGraph',
          ownerType: 'npc',
          ownerId: '',
          graph: {
            id: 'npc_inner',
            ownerType: 'npc',
            ownerId: '',
            initialState: 'idle',
            states: { idle: { id: 'idle' } },
            transitions: [],
          },
        }],
      }],
    });
    let selectedId = '';
    let graphRef = 'main';
    const result = focusValidationIssue(
      {
        severity: 'error',
        code: 'wrapper.unbound',
        message: 'wrapper_1: wrapper has no ownerId binding',
        path: 'compositions[0].elements[0]',
        itemId: 'wrapper_1',
      },
      data,
      {
        compositionId: 'comp',
        setCompositionId: () => {},
        setGraphRef: (ref) => { graphRef = ref; },
        setExpandedElementIds: () => {},
        setSelectedId: (id) => { selectedId = id; },
      },
    );
    expect(graphRef).toBe('main');
    expect(selectedId).toBe('element:wrapper_1');
    expect(result?.nodeIds).toEqual(['element:wrapper_1']);
  });

  it('focusValidationIssue opens graph and state inspectors from targets', () => {
    const data = normalizeFile(sample());
    expect(resolveValidationIssueFocus(
      {
        severity: 'error',
        code: 'graph.initialState.invalid',
        message: 'bad graph',
        target: { kind: 'graph', compositionId: 'comp', graphId: 'flow', field: 'initialState' },
      },
      data,
    )).toMatchObject({ graphRef: 'main', selectedId: 'graph:flow' });
    expect(resolveValidationIssueFocus(
      {
        severity: 'error',
        code: 'action.param.missing',
        message: 'bad state action',
        target: { kind: 'state', compositionId: 'comp', graphId: 'npc', elementId: 'npc_el', stateId: 'before', field: 'onEnterActions' },
      },
      data,
    )).toMatchObject({ graphRef: 'element:npc_el', selectedId: 'state:before' });
  });

  it('resolveValidationIssueFocus prefers subgraph when bare transition id collides with main', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' }, b: { id: 'b' } },
          transitions: [{ id: 't_1', from: 'a', to: 'b', signal: 'go' }],
        },
        elements: [{
          id: 'wrap',
          kind: 'wrapperGraph',
          graph: {
            id: 'quest',
            ownerType: 'quest',
            initialState: 's1',
            states: { s1: { id: 's1' }, s2: { id: 's2' } },
            transitions: [{ id: 't_1', from: 's1', to: 's2', signal: '__draft__' }],
          },
        }],
      }],
    });
    const result = resolveValidationIssueFocus(
      { severity: 'warning', code: 'transition.signal.draft', message: 'draft', itemId: 't_1', path: '' },
      data,
    );
    expect(result?.graphRef).toBe('element:wrap');
    expect(result?.selectedId).toBe('transition:t_1');
  });

  it('requires broadcastOnEnter source state to exist for derived listeners', () => {
    const data = normalizeFile(sample());
    const npc = data.compositions![0]!.elements![0]!.graph!;
    npc.transitions.push({
      id: 'listen_flow',
      from: 'before',
      to: 'after',
      signal: 'state:flow:missing',
    });
    expect(
      validateNarrativeData(data).some((issue) => issue.code === 'state.broadcast.sourceMissing'),
    ).toBe(true);
  });

  it('auto-marks broadcastOnEnter for derived signal listeners during normalize', () => {
    const data = normalizeFile(sample());
    const npc = data.compositions![0]!.elements![0]!.graph!;
    npc.transitions[0]!.signal = 'state:flow:b';
    delete data.compositions![0]!.mainGraph.states.b!.broadcastOnEnter;
    const normalized = normalizeFile(data);
    expect(normalized.compositions![0]!.mainGraph.states.b?.broadcastOnEnter).toBe(true);
  });

  it('simulation only queues derived signals for broadcastOnEnter states', () => {
    const data: NarrativeGraphsFileDef = {
      schemaVersion: 3,
      signals: [{ id: 'go' }],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: {
            a: { id: 'a' },
            b: { id: 'b', broadcastOnEnter: true },
          },
          transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
        },
        elements: [],
      }],
    };
    const withBroadcast = simulateSignalImpact(data, 'go');
    expect(withBroadcast.log.some((line) => line.includes('state:flow:b'))).toBe(true);

    const withoutBroadcast = simulateSignalImpact({
      ...data,
      compositions: [{
        ...data.compositions![0]!,
        mainGraph: {
          ...data.compositions![0]!.mainGraph,
          states: { a: { id: 'a' }, b: { id: 'b' } },
        },
      }],
    }, 'go');
    expect(withoutBroadcast.log.some((line) => line.includes('state:flow:b'))).toBe(false);
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

  it('issueBelongsToActiveGraph separates main graph and subgraph issues', () => {
    const data = normalizeFile({
      schemaVersion: 3,
      signals: [],
      compositions: [
        {
          id: 'comp_a',
          mainGraph: {
            id: 'flow_a',
            ownerType: 'flow',
            initialState: 'a',
            states: { a: { id: 'a' }, b: { id: 'b' } },
            transitions: [{ id: 't_a', from: 'a', to: 'missing', signal: 'external:system:test:go' }],
          },
          elements: [],
        },
        {
          id: 'comp_b',
          mainGraph: {
            id: 'flow_b',
            ownerType: 'flow',
            initialState: 'a',
            states: { a: { id: 'a' }, b: { id: 'b' } },
            transitions: [{ id: 't_b', from: 'a', to: 'missing', signal: 'external:system:test:go' }],
          },
          elements: [
            {
              id: 'npc_el',
              kind: 'wrapperGraph',
              ownerType: 'npc',
              ownerId: '',
              graph: {
                id: 'npc',
                ownerType: 'npc',
                initialState: 'before',
                states: { before: { id: 'before' }, after: { id: 'after' } },
                transitions: [{ id: 't_npc', from: 'before', to: 'missing', signal: 'external:system:test:go' }],
              },
            },
          ],
        },
      ],
    });
    const issues = validateNarrativeData(data);
    const mainIssues = issues.filter((issue) => issueBelongsToActiveGraph(issue, 'comp_b', 'main', data));
    const subgraphIssues = issues.filter((issue) => issueBelongsToActiveGraph(issue, 'comp_b', 'element:npc_el', data));

    expect(mainIssues.length).toBeGreaterThan(0);
    expect(subgraphIssues.length).toBeGreaterThan(0);
    expect(mainIssues.some((issue) => issue.message.includes('flow_b'))).toBe(true);
    expect(mainIssues.some((issue) => issue.message.includes('npc.t_npc') || issue.message.includes('npc_el'))).toBe(true);
    expect(subgraphIssues.some((issue) => issue.message.includes('npc.t_npc') || issue.message.includes('npc_el'))).toBe(true);
    expect(subgraphIssues.some((issue) => issue.message.includes('flow_b.t_b'))).toBe(false);

    const overlap = mainIssues.filter((issue) => subgraphIssues.includes(issue));
    const mainGraphOnly = mainIssues.filter((issue) => issue.target?.kind === 'graph' || issue.target?.kind === 'state' || issue.target?.kind === 'transition');
    const subgraphOnly = subgraphIssues.filter((issue) => issue.target?.kind === 'graph' || issue.target?.kind === 'state' || issue.target?.kind === 'transition');
    expect(mainGraphOnly.some((issue) => subgraphOnly.includes(issue))).toBe(false);

    expect(issueBelongsToActiveGraph(
      {
        severity: 'error',
        code: 'signal.id.empty',
        message: 'author signal id is required',
        path: 'signals[0].id',
      },
      'comp_b',
      'main',
      data,
    )).toBe(false);
  });
});
