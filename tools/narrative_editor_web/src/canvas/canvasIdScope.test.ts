import { describe, expect, it } from 'vitest';
import { createInlineSubgraphScope, createLocalGraphScope } from './canvasIdScope';

describe('canvasIdScope', () => {
  it('local scope round-trips state and transition ids', () => {
    const scope = createLocalGraphScope('flow');
    expect(scope.stateNodeId('a')).toBe('state:a');
    expect(scope.transitionEdgeId('t1')).toBe('transition:t1');
    expect(scope.transitionAnchorNodeId('t1')).toBe('transition-anchor:flow:t1');
    expect(scope.parseStateNode('state:a')).toEqual({ stateId: 'a' });
    expect(scope.parseTransitionEdge('transition:t1')).toEqual({ transitionId: 't1' });
  });

  it('inline scope round-trips subgraph-prefixed ids', () => {
    const scope = createInlineSubgraphScope('wrap', 'npc');
    expect(scope.stateNodeId('s1')).toBe('subgraph:wrap:state:s1');
    expect(scope.transitionEdgeId('t1')).toBe('subgraph:wrap:transition:t1');
    expect(scope.parseStateNode('subgraph:wrap:state:s1')).toEqual({ stateId: 's1' });
    expect(scope.parseTransitionEdge('subgraph:wrap:transition:t1')).toEqual({ transitionId: 't1' });
  });
});
