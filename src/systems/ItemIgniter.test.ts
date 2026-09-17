import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { InventoryManager } from './InventoryManager';
import type { GameContext, ItemDef } from '../data/types';

const STRINGS = { get: (_cat: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) };

const DEFS: ItemDef[] = [
  { id: 'huorong', name: '火镰火绒', type: 'consumable', description: '', maxStack: 20, igniter: { uses: 1, seconds: 2.5, windLimit: 3 } },
  { id: 'huozhezi', name: '火折子', type: 'consumable', description: '', maxStack: 10, igniter: { uses: 3, seconds: 1, windLimit: 6 } },
  { id: 'stone', name: '石头', type: 'consumable', description: '', maxStack: 9 },
  {
    id: 'weird', name: '怪火种', type: 'consumable', description: '', maxStack: 9,
    igniter: { seconds: 1, windLimit: 1 }, use: { label: '吃掉' },
  },
];

async function make(): Promise<{ inv: InventoryManager; bus: EventBus }> {
  const bus = new EventBus();
  const inv = new InventoryManager(bus, new FlagStore(bus));
  inv.init({ strings: STRINGS, assetManager: { loadJson: async () => DEFS } } as unknown as GameContext);
  await inv.loadDefs();
  return { inv, bus };
}

describe('火种：当前火种、点一次用掉一次、入档', () => {
  it('火种的用法是「设为火种」（setActiveIgniter 动作、不扣）；设过的置灰；写了 use 的按 use 走；不是火种的不给', async () => {
    const { inv } = await make();
    inv.addItem('huorong', 2);
    const use = inv.resolveItemUse('huorong')!;
    expect(use.label).toBe('setIgniter');
    expect(use.enabled).toBe(true);
    expect(use.consume).toBe(false);
    expect(use.actions).toEqual([{ type: 'setActiveIgniter', params: { item: 'huorong' } }]);
    expect(inv.setActiveIgniter('huorong')).toBe(true);
    const again = inv.resolveItemUse('huorong')!;
    expect(again.enabled).toBe(false);
    expect(again.disableReason).toBe('igniterCurrent');
    expect(inv.resolveItemUse('weird')!.label).toBe('吃掉');
    expect(inv.resolveItemUse('stone')).toBeNull();
    expect(inv.setActiveIgniter('stone')).toBe(false);
    expect(inv.getActiveIgniter()!.itemId).toBe('huorong');
  });

  it('没设 ⇒ null，不自动挑；一份一次的点一次扣一件；用完了还是当前火种、available 0、再扣返回 null', async () => {
    const { inv } = await make();
    inv.addItem('huorong', 2);
    expect(inv.getActiveIgniter()).toBeNull();
    expect(inv.consumeIgniterUse()).toBeNull();
    expect(inv.getItemCount('huorong')).toBe(2);
    inv.setActiveIgniter('huorong');
    expect(inv.getActiveIgniter()!.available).toBe(2);
    expect(inv.consumeIgniterUse()!.seconds).toBe(2.5);
    expect(inv.getItemCount('huorong')).toBe(1);
    inv.consumeIgniterUse();
    expect(inv.getItemCount('huorong')).toBe(0);
    const st = inv.getActiveIgniter()!;
    expect(st.itemId).toBe('huorong');
    expect(st.available).toBe(0);
    expect(inv.consumeIgniterUse()).toBeNull();
  });

  it('一支点三次：头一次拆一支（扣一件、剩两次），后两次不扣件；换火种再换回来接着用拆开的那支', async () => {
    const { inv } = await make();
    inv.addItem('huozhezi', 2);
    inv.addItem('huorong', 1);
    inv.setActiveIgniter('huozhezi');
    expect(inv.getActiveIgniter()!.available).toBe(6);
    inv.consumeIgniterUse();
    expect(inv.getItemCount('huozhezi')).toBe(1);
    expect(inv.igniterInfoOf('huozhezi')).toEqual({ current: true, uses: 3, openedLeft: 2 });
    expect(inv.getActiveIgniter()!.available).toBe(5);
    inv.setActiveIgniter('huorong');
    expect(inv.igniterInfoOf('huozhezi')).toEqual({ current: false, uses: 3, openedLeft: 2 });
    inv.setActiveIgniter('huozhezi');
    inv.consumeIgniterUse();
    inv.consumeIgniterUse();
    expect(inv.getItemCount('huozhezi')).toBe(1);
    expect(inv.igniterInfoOf('huozhezi')!.openedLeft).toBe(0);
    inv.consumeIgniterUse();
    expect(inv.getItemCount('huozhezi')).toBe(0);
    expect(inv.igniterInfoOf('huozhezi')!.openedLeft).toBe(2);
    expect(inv.igniterInfoOf('stone')).toBeNull();
  });

  it('当前火种与拆开的剩余次数入档、读档回来一样；老档没有这块 ⇒ 没设', async () => {
    const { inv } = await make();
    inv.addItem('huozhezi', 1);
    inv.setActiveIgniter('huozhezi');
    inv.consumeIgniterUse();
    const saved = JSON.parse(JSON.stringify(inv.serialize()));
    expect(saved.igniter).toEqual({ active: 'huozhezi', opened: { huozhezi: 2 } });
    const { inv: b } = await make();
    b.deserialize(saved);
    expect(b.getActiveIgniter()).toMatchObject({ itemId: 'huozhezi', openedLeft: 2, available: 2 });
    const { inv: c } = await make();
    c.setActiveIgniter('huorong');
    c.deserialize({ items: {}, coins: 0 });
    expect(c.getActiveIgniter()).toBeNull();
    const { inv: d } = await make();
    expect((d.serialize() as { igniter?: unknown }).igniter).toBeUndefined();
  });
});
