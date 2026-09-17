import { describe, expect, it, vi } from 'vitest';
import type { GameContext } from '../data/types';
import type { HealthDepletion } from '../data/survival';
import { RetrySystem } from './RetrySystem';

const cause: HealthDepletion = { amount: 150, kind: 'yin', sourceId: 'ghost', deathNoteId: 'weak_yang',
  result: { requested: 150, afterProtection: 150, applied: 100, depleted: true, protectionIds: [] } };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const system = new RetrySystem();
  system.init({} as GameContext);
  const state = { safe: true, dead: false, flags: {} as Record<string, boolean>, health: 100, money: 50 };
  let resolveChoice: ((index: number | null) => void) | null = null;
  const capture = vi.fn(() => JSON.stringify({ version: 1, systems: {
    retrySystem: system.serialize(), flagStore: { ...state.flags }, health: state.health, money: state.money,
  } }));
  const load = vi.fn(async (raw: string) => {
    const saved = JSON.parse(raw).systems;
    system.deserialize(saved.retrySystem);
    state.flags = saved.flagStore; state.health = saved.health; state.money = saved.money; state.dead = false;
    return true;
  });
  const choose = vi.fn((_title: string, _options: { text: string }[]) => new Promise<number | null>((resolve) => { resolveChoice = resolve; }));
  const enterDeath = vi.fn();
  const menu = vi.fn();
  const showNote = vi.fn(async (id: string) => { state.flags[`sysnote_${id}`] = true; });
  system.connect({ canCapture: () => state.safe, capture, load, isDepleted: () => state.dead,
    enterDeath, closeChoice: () => resolveChoice?.(null), choose, showNote,
    returnToMenu: menu, shownNoteFlags: () => state.flags });
  return { system, state, capture, load, choose, enterDeath, menu, showNote, pick: (index: number | null) => resolveChoice?.(index) };
}

describe('死亡与安全点恢复', () => {
  it('请求不等待持锁 action；仅在安全探索窗口捕获，无递归载荷增长', () => {
    const h = setup();
    h.state.safe = false;
    h.system.requestCheckpoint('ridge', '跑马梁入口');
    h.system.update(0);
    expect(h.capture).not.toHaveBeenCalled();
    h.state.safe = true;
    h.system.update(0);
    const first = h.system.serialize() as { checkpoint: { payload: string } };
    expect(JSON.parse(first.checkpoint.payload).systems.retrySystem).toBeUndefined();
    h.system.requestCheckpoint('ridge2'); h.system.update(0);
    const second = h.system.serialize() as typeof first;
    expect(second.checkpoint.payload.length).toBe(first.checkpoint.payload.length);
  });

  it('死亡只开一次；重试恢复背包数值和站位所在的整份存档，已读提示保留', async () => {
    const h = setup(); h.system.update(0);
    h.state.health = 0; h.state.money = 0; h.state.dead = true;
    h.system.deplete(cause); h.system.deplete(cause);
    await flush();
    expect(h.choose).toHaveBeenCalledTimes(1);
    h.pick(0); await flush();
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.state.health).toBe(100); expect(h.state.money).toBe(50);
    expect(h.state.flags.sysnote_weak_yang).toBe(true);
    expect(h.state.dead).toBe(false);
    expect((h.system.snapshot() as { checkpoint: unknown }).checkpoint).not.toBeNull();
  });

  it('死亡选择中另行读档会作废旧选项，旧协程不能再覆盖新时间线', async () => {
    const h = setup(); h.system.update(0);
    h.system.deplete(cause); await flush();
    h.system.deserialize({}); h.pick(0); await flush();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.menu).not.toHaveBeenCalled();
  });

  it('恢复失败并回滚为死亡时重新提供入口，不解锁为零血探索', async () => {
    const h = setup(); h.system.update(0); h.state.dead = true;
    h.load.mockImplementation(async () => { h.system.deserialize(h.system.serialize()); return false; });
    h.system.deplete(cause); await flush(); h.pick(0); await flush();
    expect(h.choose).toHaveBeenCalledTimes(2);
    expect(h.choose.mock.calls[1][0]).toContain('重试未成功');
    expect(h.enterDeath).toHaveBeenCalledTimes(2);
    h.pick(1); await flush(); expect(h.menu).toHaveBeenCalledTimes(1);
  });

  it('坏检查点和旧档安全回落，下一次探索重新拍初始快照', () => {
    const h = setup();
    h.system.deserialize({ checkpoint: { id: 'broken', payload: '{' } });
    h.system.update(0);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });
});
