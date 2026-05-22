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
    transitions: [{ id: 't_main', from: 'a', to: 'b', signal: 'x' }],
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
        transitions: [{ id: 't_inner', from: 's1', to: 's2', signal: 'state:flow:x' }],
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
        label: 'state:flow:x',
        compositionId: 'c',
      },
    ],
  },
  canvasMode: 'wiring' as const,
  showTrigger: true,
  showRead: false,
  showCommand: false,
};

function nodeSnapshot(nodes: ReturnType<typeof buildCanvasNodes>) {
  return nodes
    .map((n) => `${n.id}|${n.type}|${n.parentId ?? ''}`)
    .sort()
    .join('\n');
}

function edgeSnapshot(edges: ReturnType<typeof buildCanvasEdges>) {
  return edges
    .map((e) => `${e.id}|${e.type}|${e.source}|${e.target}`)
    .sort()
    .join('\n');
}

describe('buildCanvasModel main graph contract', () => {
  it('edit mode collapsed includes graph anchor, main states, element wrapper, main transition edges', () => {
    const input = { ...baseInput, canvasMode: 'edit' as const, expandedElementIds: [] as string[] };
    const nodes = buildCanvasNodes(input);
    const edges = buildCanvasEdges(input);

    expect(nodes.some((n) => n.id === 'graph:flow')).toBe(true);
    expect(nodes.some((n) => n.id === 'state:a')).toBe(true);
    expect(nodes.some((n) => n.id === 'state:b')).toBe(true);
    expect(nodes.some((n) => n.id === 'element:wrap')).toBe(true);
    expect(nodes.some((n) => n.id.startsWith('subgraph:'))).toBe(false);
    expect(nodes.some((n) => n.id.startsWith('transition-anchor:'))).toBe(false);
    expect(nodes.some((n) => n.id.startsWith('projection'))).toBe(false);

    const mainTransition = edges.find((e) => e.id === 'transition:t_main');
    expect(mainTransition?.source).toBe('state:a');
    expect(mainTransition?.target).toBe('state:b');
    expect(edges.some((e) => e.type === 'projection')).toBe(false);
  });

  it('edit mode expanded includes inline subgraph states and inner transition edges', () => {
    const input = { ...baseInput, canvasMode: 'edit' as const, expandedElementIds: ['wrap'] };
    const nodes = buildCanvasNodes(input);
    const edges = buildCanvasEdges(input);

    expect(nodes.find((n) => n.id === 'element:wrap')?.type).toBe('subgraphGroup');
    expect(nodes.some((n) => n.id === 'subgraph:wrap:state:s1')).toBe(true);
    expect(nodes.some((n) => n.id === 'subgraph:wrap:state:s2')).toBe(true);

    const inner = edges.find((e) => e.id === 'subgraph:wrap:transition:t_inner');
    expect(inner?.source).toBe('subgraph:wrap:state:s1');
    expect(inner?.target).toBe('subgraph:wrap:state:s2');
  });

  it('wiring mode collapsed exposes main anchor and remaps projection to element', () => {
    const input = { ...baseInput, canvasMode: 'wiring' as const, expandedElementIds: [] as string[] };
    const nodes = buildCanvasNodes(input);
    const edges = buildCanvasEdges(input);

    expect(nodes.some((n) => n.id === 'transition-anchor:flow:t_main')).toBe(true);
    expect(nodes.some((n) => n.id === 'transition-anchor:npc:t_inner')).toBe(false);

    const trigger = edges.find((e) => e.id === 'projection:tr1');
    expect(trigger?.target).toBe('element:wrap');
    expect(trigger?.source).toBe('element:dialogue');
  });

  it('wiring mode expanded keeps inner transition anchor inside group', () => {
    const input = { ...baseInput, canvasMode: 'wiring' as const, expandedElementIds: ['wrap'] };
    const nodes = buildCanvasNodes(input);
    const edges = buildCanvasEdges(input);

    const anchor = nodes.find((n) => n.id === 'transition-anchor:npc:t_inner');
    expect(anchor?.parentId).toBe('element:wrap');

    const trigger = edges.find((e) => e.id === 'projection:tr1');
    expect(trigger?.target).toBe('transition-anchor:npc:t_inner');
  });

  it('debug mode shows projection like wiring', () => {
    const wiringEdges = buildCanvasEdges({ ...baseInput, canvasMode: 'wiring', expandedElementIds: [] });
    const debugEdges = buildCanvasEdges({ ...baseInput, canvasMode: 'debug', expandedElementIds: [] });
    expect(edgeSnapshot(debugEdges)).toBe(edgeSnapshot(wiringEdges));
  });

  it('read and command projection layers respect show flags', () => {
    const projection = {
      ...emptyProjection,
      readEdges: [{
        id: 'rd1',
        kind: 'read' as const,
        source: 'element:wrap',
        target: 'state:a',
        label: 'read',
        compositionId: 'c',
      }],
      stateCommandEdges: [{
        id: 'cmd1',
        kind: 'stateCommand' as const,
        source: 'external:debug',
        target: 'state:b',
        label: 'cmd',
        compositionId: 'c',
      }],
    };
    const none = buildCanvasEdges({
      ...baseInput,
      projection,
      canvasMode: 'wiring',
      showTrigger: false,
      showRead: false,
      showCommand: false,
      expandedElementIds: [],
    });
    expect(none.some((e) => e.type === 'projection')).toBe(false);

    const readOnly = buildCanvasEdges({
      ...baseInput,
      projection,
      canvasMode: 'wiring',
      showTrigger: false,
      showRead: true,
      showCommand: false,
      expandedElementIds: [],
    });
    expect(readOnly.filter((e) => e.type === 'projection')).toHaveLength(1);
    expect(readOnly.find((e) => e.id === 'projection:rd1')).toBeTruthy();

    const all = buildCanvasEdges({
      ...baseInput,
      projection,
      canvasMode: 'wiring',
      showTrigger: false,
      showRead: true,
      showCommand: true,
      expandedElementIds: [],
    });
    expect(all.filter((e) => e.type === 'projection')).toHaveLength(2);
  });
});

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

describe('buildCanvasModel real composition data', () => {
  const realComp: NarrativeCompositionDef = {
    id: 'flow_dock_water_monkey',
    mainGraph: {
      id: 'flow_dock_water_monkey',
      ownerType: 'flow',
      initialState: 'initial',
      states: { initial: { id: 'initial' } },
      transitions: [],
    },
    elements: [{
      id: 'wrapper_npc_ringboy',
      kind: 'wrapperGraph',
      label: '滚铁环小孩 Wrapper',
      ownerType: 'npc',
      ownerId: 'npc_ringboy',
      graph: {
        id: 'npc_ringboy',
        ownerType: 'npc',
        ownerId: 'npc_ringboy',
        initialState: 'before_event',
        states: {
          before_event: { id: 'before_event', meta: { editor: { x: 0, y: 0 } } },
          after_event: { id: 'after_event', meta: { editor: { x: 220, y: 0 } } },
          ring_taken: { id: 'ring_taken', meta: { editor: { x: 470, y: 0 } } },
        },
        transitions: [
          { id: 't_ringboy_after_event', from: 'before_event', to: 'after_event', signal: 'state:flow:done' },
          { id: 't_ring_taken', from: 'after_event', to: 'ring_taken', signal: 'ring_taken' },
        ],
      },
    }],
  };

  it('exclusive mode connects all inner transitions to state nodes', () => {
    const el = realComp.elements![0]!;
    const input = {
      comp: realComp,
      graph: el.graph!,
      graphRef: 'element:wrapper_npc_ringboy' as const,
      activeStates: {},
      projection: emptyProjection,
      canvasMode: 'edit' as const,
      showTrigger: false,
      showRead: false,
      showCommand: false,
      expandedElementIds: [] as string[],
    };
    const nodes = buildCanvasNodes(input);
    const edges = buildCanvasEdges(input);
    const nodeIds = new Set(nodes.map((n) => n.id));
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
      expect(edge.zIndex).toBe(25);
    }
  });

  it('inline expanded mode connects inner transitions with subgraph node ids', () => {
    const input = {
      comp: realComp,
      graph: realComp.mainGraph,
      graphRef: 'main' as const,
      activeStates: {},
      projection: emptyProjection,
      canvasMode: 'edit' as const,
      showTrigger: false,
      showRead: false,
      showCommand: false,
      expandedElementIds: ['wrapper_npc_ringboy'],
    };
    const nodes = buildCanvasNodes(input);
    const edges = buildCanvasEdges(input);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const inner = edges.find((e) => e.id === 'subgraph:wrapper_npc_ringboy:transition:t_ring_taken');
    expect(inner?.source).toBe('subgraph:wrapper_npc_ringboy:state:after_event');
    expect(inner?.target).toBe('subgraph:wrapper_npc_ringboy:state:ring_taken');
    expect(nodeIds.has(inner!.source)).toBe(true);
    expect(nodeIds.has(inner!.target)).toBe(true);
  });
});

describe('buildCanvasModel exclusive subgraph', () => {
  const exclusiveInput = {
    ...baseInput,
    graph: comp.elements![0]!.graph!,
    graphRef: 'element:wrap' as const,
    canvasMode: 'edit' as const,
    expandedElementIds: [] as string[],
  };

  it('renders transition edges with state endpoints in exclusive mode', () => {
    const edges = buildCanvasEdges(exclusiveInput);
    const inner = edges.find((e) => e.id === 'transition:t_inner');
    expect(inner?.source).toBe('state:s1');
    expect(inner?.target).toBe('state:s2');
  });

  it('exposes transition anchors in exclusive wiring mode', () => {
    const nodes = buildCanvasNodes({ ...exclusiveInput, canvasMode: 'wiring' });
    expect(nodes.some((n) => n.id === 'transition-anchor:npc:t_inner')).toBe(true);
    expect(nodes.some((n) => n.id.startsWith('subgraph:'))).toBe(false);
    expect(nodes.find((n) => n.id === 'element:wrap')).toBeUndefined();
  });

  it('shows scoped projection in exclusive wiring mode', () => {
    const edges = buildCanvasEdges({ ...exclusiveInput, canvasMode: 'wiring' });
    const trigger = edges.find((e) => e.id === 'projection:tr1');
    expect(trigger?.target).toBe('transition-anchor:npc:t_inner');
  });
});
