/**
 * 呼吸联动(工作台 → 游戏):工作态每个 rev 只套一次、不套自己写的;探针第一次看到槽只记序号(刷新页面不重放上一次的操作);
 * 换了写者序号清零;太旧的槽不套;拆掉时撤回工作态;槽的形状闸门只放行认识的字段。
 */
import { describe, expect, it, vi } from 'vitest';

import { breathingDocShapeError } from './runtimeBreathingApiPlugin';
import { RuntimeBreathingSync, isBreathingDocStale, shouldApplyBreathingDoc, type BreathingSyncDoc, type RuntimeBreathingSyncDeps } from './runtimeBreathingSync';

function make() {
  const applyPreview = vi.fn<RuntimeBreathingSyncDeps['applyPreview']>();
  const probe = vi.fn<RuntimeBreathingSyncDeps['probe']>(() => true);
  const deps: RuntimeBreathingSyncDeps = {
    applyPreview, probe,
    getStatus: () => ({ sceneId: null, instances: [] }),
    log: () => {},
  };
  const s = new RuntimeBreathingSync(deps, 'game-1');
  return { s, applyPreview, probe };
}

const doc = (over: Partial<BreathingSyncDoc>): BreathingSyncDoc => ({ rev: 1, writer: 'wb', ...over });

describe('呼吸联动', () => {
  it('要不要套工作态:有内容、比见过的新、不是自己写的', () => {
    expect(shouldApplyBreathingDoc(doc({ rev: 2, breathing: {} }), 'game-1', 1)).toBe(true);
    expect(shouldApplyBreathingDoc(doc({ rev: 2, breathing: {} }), 'game-1', 2)).toBe(false);
    expect(shouldApplyBreathingDoc(doc({ rev: 3, writer: 'game-1', breathing: {} }), 'game-1', 1)).toBe(false);
    expect(shouldApplyBreathingDoc(doc({ rev: 3, probe: { seq: 1, action: 'gasp', target: 'a' } }), 'game-1', 1)).toBe(false);
    expect(isBreathingDocStale(5 * 60 * 1000 + 1)).toBe(true);
    expect(isBreathingDocStale(null)).toBe(false);
  });

  it('工作态每个 rev 只套一次;拆掉时撤回', () => {
    const h = make();
    const d = doc({ rev: 4, breathing: { a: {} } });
    h.s.handleDoc(d, 10);
    h.s.handleDoc(d, 20);
    expect(h.applyPreview).toHaveBeenCalledTimes(1);
    expect(h.applyPreview).toHaveBeenLastCalledWith({ a: {} });
    h.s.stop();
    expect(h.applyPreview).toHaveBeenLastCalledWith(null);
  });

  it('探针:第一次看到只记序号;之后序号涨一次做一次;换了写者从头数', () => {
    const h = make();
    h.s.handleDoc(doc({ rev: 1, probe: { seq: 5, action: 'gasp', target: 'a' } }), 10);
    expect(h.probe).not.toHaveBeenCalled();
    h.s.handleDoc(doc({ rev: 2, probe: { seq: 5, action: 'gasp', target: 'a' } }), 10);
    expect(h.probe).not.toHaveBeenCalled();
    h.s.handleDoc(doc({ rev: 3, probe: { seq: 6, action: 'fadeOut', target: 'a' } }), 10);
    expect(h.probe).toHaveBeenCalledWith('fadeOut', 'a');
    h.s.handleDoc(doc({ rev: 4, writer: 'wb2', probe: { seq: 1, action: 'show', target: 'a' } }), 10);
    expect(h.probe).toHaveBeenLastCalledWith('show', 'a');
  });

  it('太旧的槽不套', () => {
    const h = make();
    h.s.handleDoc(doc({ rev: 9, breathing: { a: {} } }), 6 * 60 * 1000);
    expect(h.applyPreview).not.toHaveBeenCalled();
  });

  it('形状闸门', () => {
    expect(breathingDocShapeError({ writer: 'w', breathing: { a: {} } })).toBeNull();
    expect(breathingDocShapeError({ breathing: {} })).toMatch(/writer/);
    expect(breathingDocShapeError({ writer: 'w', breathing: [] })).toMatch(/breathing/);
    expect(breathingDocShapeError({ writer: 'w', probe: { seq: 1, action: 'explode', target: 'a' } })).toMatch(/probe/);
    expect(breathingDocShapeError({ writer: 'w', probe: { seq: 1, action: 'gasp', target: 'a' } })).toBeNull();
  });
});
