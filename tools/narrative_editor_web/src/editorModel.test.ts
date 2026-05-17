import { describe, expect, it } from 'vitest';
import {
  createTransition,
  normalizeFile,
  renameStateInGraph,
  simulateSignalImpact,
  validateNarrativeData,
} from './editorModel';
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
              transitions: [{ id: 'after', from: 'before', to: 'after', signal: 'stateEntered:flow:b' }],
            },
          },
        ],
      },
    ],
  };
}

describe('editorModel', () => {
  it('renames states and lifecycle signal references together', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const nextId = renameStateInGraph(data, flow, 'b', 'done');
    expect(nextId).toBe('done');
    expect(flow.transitions[0]!.to).toBe('done');
    const npc = data.compositions![0]!.elements![0]!.graph!;
    expect(npc.transitions[0]!.signal).toBe('stateEntered:flow:done');
  });

  it('renames cross-graph transition endpoints together', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const npc = data.compositions![0]!.elements![0]!.graph!;
    flow.transitions.push({
      id: 'enter_npc',
      from: 'b',
      to: { graphId: 'npc', stateId: 'before' },
      signal: 'external:system:test:enter',
    });
    const nextId = renameStateInGraph(data, npc, 'before', 'idle');
    expect(nextId).toBe('idle');
    expect(flow.transitions[1]!.to).toEqual({ graphId: 'npc', stateId: 'idle' });
  });

  it('creates transitions with a safe default signal', () => {
    const data = normalizeFile(sample());
    const flow = data.compositions![0]!.mainGraph;
    const t = createTransition(flow, 'b', 'a');
    expect(t.id).toBe('t_1');
    expect(t.signal).toBe('external:system:TODO:signal');
    expect(flow.transitions).toHaveLength(2);
  });

  it('simulates external and lifecycle cascade transitions', () => {
    const result = simulateSignalImpact(sample(), 'external:system:test:go');
    expect(result.activeStates).toMatchObject({ flow: 'b', npc: 'after' });
    expect(result.recentTransitions.map((t) => t.transitionId)).toEqual(['go', 'after']);
  });

  it('simulates a cross-graph transition without moving the source graph', () => {
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
    expect(result.activeStates.scenario).toBe('entry');
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

  it('validates scenario boundary transitions', () => {
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
    expect(codes).toContain('scenario.boundary.entry');
  });
});
