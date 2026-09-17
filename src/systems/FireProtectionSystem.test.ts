import { describe, expect, it } from 'vitest';
import { FireProtectionSystem, type ProtectionFireSource } from './FireProtectionSystem';

describe('指定火光保护', () => {
  function make() {
    const system = new FireProtectionSystem();
    const state = { x: 0, running: true, sources: [] as ProtectionFireSource[] };
    system.connect({ canUpdate: () => state.running, playerPosition: () => ({ x: state.x, y: 0 }), sources: () => state.sources });
    const source = { id: 'torch', x: 0, y: 0, radius: 10, active: true, burning: true };
    state.sources.push(source);
    return { system, state, source };
  }

  it('必须真实点燃，短暂闪灭稳定；持续熄灭、离开范围或摘掉立即/按时失效', () => {
    const h = make(); h.source.burning = false; h.system.update(0.01);
    expect(h.system.protected).toBe(false);
    h.source.burning = true; h.system.update(0.01);
    expect(h.system.protected).toBe(true);
    h.source.burning = false; h.system.update(0.05);
    expect(h.system.protected).toBe(true);
    h.system.update(0.11); expect(h.system.protected).toBe(false);
    h.source.burning = true; h.system.update(0.01); h.state.x = 11; h.system.update(0.01);
    expect(h.system.protected).toBe(false);
    h.state.x = 0; h.system.update(0.01); h.state.sources = []; h.system.update(0.01);
    expect(h.system.protected).toBe(false);
  });

  it('暂停不耗缓冲；读档不带上旧场景的火光；坏坐标不成为保护火', () => {
    const h = make(); h.system.update(0.01); h.source.burning = false;
    h.state.running = false; h.system.update(100); expect(h.system.protected).toBe(true);
    h.system.deserialize({}); expect(h.system.protected).toBe(false);
    h.state.running = true; h.system.update(0.01); expect(h.system.protected).toBe(false);
    h.source.burning = true; h.source.x = NaN; h.system.update(0.01); expect(h.system.protected).toBe(false);
  });

  it('任意一个有效火源足够保护；禁用无缓冲，0 秒缓冲可编排', () => {
    const h = make(); h.system.configure({ lossGraceSeconds: 0 });
    h.state.sources.unshift({ ...h.source, id: 'other', burning: false });
    h.system.update(1); expect(h.system.protected).toBe(true);
    h.source.burning = false; h.system.update(0.01); expect(h.system.protected).toBe(false);
    h.source.burning = true; h.system.update(0.01);
    h.source.active = false; h.system.update(0.01); expect(h.system.protected).toBe(false);
  });
});
