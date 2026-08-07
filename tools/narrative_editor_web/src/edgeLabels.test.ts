import { describe, expect, it } from 'vitest';
import { abbreviateSignal, displayEdgeLabel, resolveStyledEdgeLabel, shouldRenderStyledEdgeLabel, styledEdgeLabelWidth, transitionEdgeLabel } from './edgeLabels';

describe('edgeLabels', () => {
  it('resolves projection trigger labels from edge props', () => {
    const label = 'board_read_done';
    expect(resolveStyledEdgeLabel({ label })).toBe(label);
    expect(resolveStyledEdgeLabel({ data: { label } })).toBe(label);
    expect(shouldRenderStyledEdgeLabel(label)).toBe(true);
  });

  it('resolves read and stateCommand labels from data fallback', () => {
    expect(resolveStyledEdgeLabel({ data: { label: 'npc_ringboy' } })).toBe('npc_ringboy');
    expect(resolveStyledEdgeLabel({ data: { label: 'flow.b' } })).toBe('flow.b');
  });

  it('abbreviates long transition signals when not selected', () => {
    const full = 'state:flow_dock_water_monkey:crate_minigame_done';
    expect(abbreviateSignal(full).length).toBeLessThan(full.length);
    expect(displayEdgeLabel(full, 'transition', false)).not.toBe(full);
    expect(displayEdgeLabel(full, 'transition', true)).toBe(full);
  });

  it('labels reactive transitions by trigger, never by the __draft__ placeholder', () => {
    // reactive* 的 signal 恒为占位；若标签仍取 signal，画布上「条件已填」与「真没接线」同形。
    expect(transitionEdgeLabel({ signal: '__draft__', trigger: 'reactive' })).toBe('条件');
    expect(transitionEdgeLabel({ signal: '__draft__', trigger: 'reactiveAll' })).toBe('条件·全部');
    expect(transitionEdgeLabel({ signal: '__draft__', trigger: 'reactiveAny' })).toBe('条件·任一');
    // 信号型迁移一字不改：真草稿仍要显示成草稿，别把未接线藏起来。
    expect(transitionEdgeLabel({ signal: '__draft__' })).toBe('__draft__');
    expect(transitionEdgeLabel({ signal: '__draft__', trigger: 'signal' })).toBe('__draft__');
    expect(abbreviateSignal(transitionEdgeLabel({ signal: '__draft__' }))).toBe('草稿');
    expect(transitionEdgeLabel({ signal: '崖墓任务_发布完成' })).toBe('崖墓任务_发布完成');
    expect(transitionEdgeLabel({})).toBe('');
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
