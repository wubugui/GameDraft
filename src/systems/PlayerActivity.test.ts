import { describe, expect, it } from 'vitest';
import { PlayerActivity, type PlayerActivityEntry } from './PlayerActivity';

function makeBus() {
  const listeners = new Map<string, Set<(p?: unknown) => void>>();
  return {
    on: (e: string, cb: (p?: unknown) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(cb);
    },
    off: (e: string, cb: (p?: unknown) => void) => listeners.get(e)?.delete(cb),
    emit: (e: string, p?: unknown) => listeners.get(e)?.forEach((cb) => cb(p)),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function make() {
  const bus = makeBus();
  const st = { held: null as { label: string; burning: boolean } | null, posture: null as string | null };
  const pa = new PlayerActivity({
    eventBus: bus,
    playerPos: () => ({ x: 10, y: 20 }),
    itemInfo: (id) => ({ leifu: { name: '雷符', useLabel: '掐诀，掷出去' }, juzi: { name: '橘子', useLabel: null } } as Record<string, { name: string; useLabel: string | null }>)[id] ?? null,
    entityName: (id) => ({ dog: '土狗', well: '水井' } as Record<string, string>)[id] ?? null,
    held: () => st.held,
    posture: () => st.posture,
  });
  const got: PlayerActivityEntry[] = [];
  pa.onActivity((e) => got.push(e));
  return { bus, st, pa, got };
}

describe('PlayerActivity（玩家状态串）', () => {
  it('用道具：道具表里的名字 + "用"的说法；没写说法的说"用了"', () => {
    const { bus, got } = make();
    bus.emit('item:use', { itemId: 'leifu' });
    bus.emit('item:use', { itemId: 'juzi' });
    expect(got.map((g) => g.text)).toEqual(['拿出「雷符」掐诀，掷出去', '拿出「橘子」用了']);
    expect(got[0]).toMatchObject({ gist: '雷符', at: { x: 10, y: 20 }, source: 'item:use' });
  });

  it('身体动词：冲着谁就带上谁的名字；姿态进出各一句', () => {
    const { bus, got } = make();
    bus.emit('player:act', { verb: 'kick', targetId: 'dog' });
    bus.emit('player:act', { verb: 'jump' });
    bus.emit('player:posture', { from: null, to: 'crouch' });
    bus.emit('player:posture', { from: 'crouch', to: null });
    expect(got.map((g) => g.text)).toEqual(['冲土狗抬脚踢', '原地蹦了一下', '蹲下去了', '站起来了']);
    expect(got[0].target).toBe('dog');
  });

  it('找人说话 / 碰热点（按热点类型的说法）/ 点火 / 买 / 扔', () => {
    const { bus, got } = make();
    bus.emit('npc:interact', { npc: { def: { id: 'dog' } } });
    bus.emit('hotspot:interact', { hotspotId: 'well', type: 'inspect' });
    bus.emit('burn:igniteRequested', { targetId: 'well' });
    bus.emit('shop:purchase', { itemId: 'juzi', price: 1 });
    bus.emit('inventory:discard', { itemId: 'juzi' });
    expect(got.map((g) => g.text)).toEqual(['找土狗说话', '凑过去看水井', '拿火去点水井', '买了「橘子」', '把「橘子」扔了']);
  });

  it('手上换东西：拿起 / 点着 / 收起各一句；此刻的样子（姿态、手上）随时读得到', () => {
    const { bus, st, pa, got } = make();
    st.held = { label: '松明（占位图标）', burning: false };
    bus.emit('heldProp:changed', {});
    st.held = { label: '松明（占位图标）', burning: true };
    bus.emit('heldProp:changed', {});
    st.posture = 'crouch';
    expect(pa.now()).toEqual({ posture: '蹲下去了', holding: '提着点燃的松明', heldName: '松明' });
    st.held = null;
    bus.emit('heldProp:changed', {});
    expect(got.map((g) => g.text)).toEqual(['手上拿着松明', '手上提着点燃的松明', '把手上的东西收起来了']);
  });

  it('没人订阅时连句子都不拼；destroy 摘掉全部监听', () => {
    const bus = makeBus();
    let asked = 0;
    const pa = new PlayerActivity({
      eventBus: bus, playerPos: () => ({ x: 0, y: 0 }),
      itemInfo: () => { asked++; return null; },
      entityName: () => null, held: () => null, posture: () => null,
    });
    bus.emit('item:use', { itemId: 'x' });
    expect(asked).toBe(0);
    expect(bus.count()).toBeGreaterThan(0);
    pa.destroy();
    expect(bus.count()).toBe(0);
  });
});
