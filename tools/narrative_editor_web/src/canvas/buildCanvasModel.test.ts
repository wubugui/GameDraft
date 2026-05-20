import { describe, expect, it } from 'vitest';
import { buildCanvasEdges, buildCanvasNodes } from './buildCanvasModel';
import type { NarrativeCompositionDef, ProjectionResult } from '../types';

const emptyProjection: ProjectionResult = {
  triggerEdges: [],
  readEdges: [],
  stateCommandEdges: [],
  warnings: [],
};

const comp: NarrativeCompositionDef = {
  id: 'c',
  mainGraph: {
    id: 'flow',
    ownerType: 'flow',
    initialState: 'a',
    states: { a: { id: 'a' }, b: { id: 'b' } },
    transitions: [{ id: 't_main', from: 'a', to: 'b', signal: 'external:x' }],
  },
  elements: [
    {
      id: 'wrap',
      kind: 'wrapperGraph',
      x: 100,
      y: 200,
      graph: {
        id: 'npc',
        ownerType: 'npc',
        initialState: 's1',
        states: { s1: { id: 's1' }, s2: { id: 's2' } },
        transitions: [{ id: 't_inner', from: 's1', to: 's2', signal: 'external:state:flow:x' }],
      },
    },
  ],
};

const baseInput = {
  comp,
  graph: comp.mainGraph,
  graphRef: 'main' as const,
  activeStates: {},
  projection: {
    ...emptyProjection,
    triggerEdges: [
      {
        id: 'tr1',
        kind: 'trigger' as const,
        source: 'element:dialogue',
        target: 'transition-anchor:npc:t_inner',
        label: 'external:state:flow:x',
        compositionId: 'c',
      },
    ],
  },
  canvasMode: 'wiring' as const,
  showTrigger: true,
  showRead: false,
  showCommand: false,
};

describe('buildCanvasModel subgraph grouping', () => {
  it('does not emit inline subgraph nodes when collapsed', () => {
    const nodes = buildCanvasNodes({ ...baseInput, expandedElementIds: [] });
    expect(nodes.some((n) => n.id.startsWith('subgraph:'))).toBe(false);
    expect(nodes.some((n) => n.id === 'transition-anchor:npc:t_inner')).toBe(false);
  });

  it('remaps projection target to element when wrapper collapsed', () => {
    const edges = buildCanvasEdges({ ...baseInput, expandedElementIds: [] });
    const trigger = edges.find((e) => e.id === 'projection:tr1');
    expect(trigger?.target).toBe('element:wrap');
  });

  it('emits parent group and child states when expanded', () => {
    const nodes = buildCanvasNodes({ ...baseInput, expandedElementIds: ['wrap'] });
    const parent = nodes.find((n) => n.id === 'element:wrap');
    const child = nodes.find((n) => n.id === 'subgraph:wrap:state:s1');
    expect(parent?.type).toBe('subgraphGroup');
    expect(child?.parentId).toBe('element:wrap');
    expect(child?.extent).toBe('parent');
    expect(child?.expandParent).toBe(true);
  });

  it('keeps inner transition anchor inside expanded group', () => {
    const nodes = buildCanvasNodes({ ...baseInput, expandedElementIds: ['wrap'] });
    const anchor = nodes.find((n) => n.id === 'transition-anchor:npc:t_inner');
    expect(anchor?.parentId).toBe('element:wrap');
  });
});
