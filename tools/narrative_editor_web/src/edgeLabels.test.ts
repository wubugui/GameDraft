import { describe, expect, it } from 'vitest';
import { abbreviateSignal, displayEdgeLabel, resolveStyledEdgeLabel, shouldRenderStyledEdgeLabel, styledEdgeLabelWidth } from './edgeLabels';

describe('edgeLabels', () => {
  it('resolves projection trigger labels from edge props', () => {
    const label = 'external:dialogue:dock_board:board_read_done';
    expect(resolveStyledEdgeLabel({ label })).toBe(label);
    expect(resolveStyledEdgeLabel({ data: { label } })).toBe(label);
    expect(shouldRenderStyledEdgeLabel(label)).toBe(true);
  });

  it('resolves read and stateCommand labels from data fallback', () => {
    expect(resolveStyledEdgeLabel({ data: { label: 'npc_ringboy' } })).toBe('npc_ringboy');
    expect(resolveStyledEdgeLabel({ data: { label: 'flow.b' } })).toBe('flow.b');
  });

  it('abbreviates long transition signals when not selected', () => {
    const full = 'external:dialogue:rolling_ring_boy:ring_taken';
    expect(abbreviateSignal(full).length).toBeLessThan(full.length);
    expect(displayEdgeLabel(full, 'transition', false)).not.toBe(full);
    expect(displayEdgeLabel(full, 'transition', true)).toBe(full);
  });

  it('hides empty labels and uses wider canvas for projection edges', () => {
    expect(resolveStyledEdgeLabel({ label: '   ' })).toBeUndefined();
    expect(shouldRenderStyledEdgeLabel(undefined)).toBe(false);
    expect(styledEdgeLabelWidth('transition')).toBe(220);
    expect(styledEdgeLabelWidth('transition', true)).toBe(160);
    expect(styledEdgeLabelWidth('trigger')).toBe(280);
    expect(styledEdgeLabelWidth('read')).toBe(280);
    expect(styledEdgeLabelWidth('stateCommand')).toBe(280);
  });
});
