import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { EventBridge, type EventBridgeDeps } from '../core/EventBridge';
import { InventoryManager } from './InventoryManager';
import type { ActionDef, GameContext, ItemDef } from '../data/types';

const STRINGS = {
  get: (_cat: string, key: string) => (key === 'useDisabled' ? '眼下用不成。' : key),
};

async function makeInventory(defs: ItemDef[]): Promise<{
  inv: InventoryManager;
  flags: FlagStore;
  bus: EventBus;
}> {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  const inv = new InventoryManager(bus, flags);
  inv.init({
    strings: STRINGS,
    assetManager: { loadJson: async () => defs },
  } as unknown as GameContext);
  await inv.loadDefs();
  return { inv, flags, bus };
}

describe('InventoryManager.resolveItemUse（查询层：点下去之前就得知道结果）', () => {
  it('没配 use 的物件返回 null——面板据此不画使用键', async () => {
    const { inv } = await makeInventory([
      { id: 'stone', name: '石头', type: 'consumable', description: '', maxStack: 9 },
    ]);
    inv.addItem('stone', 1);
    expect(inv.resolveItemUse('stone')).toBeNull();
  });

  it('consume 缺省按类型推定：consumable 扣、key 不扣', async () => {
    const { inv } = await makeInventory([
      {
        id: 'cake', name: '饼', type: 'consumable', description: '', maxStack: 5,
        use: { label: '吃掉' },
      },
      {
        id: 'relic', name: '信物', type: 'key', description: '', maxStack: 1,
        use: { label: '摩挲' },
      },
    ]);
    inv.addItem('cake', 1);
    inv.addItem('relic', 1);
    expect(inv.resolveItemUse('cake')?.consume).toBe(true);
    expect(inv.resolveItemUse('relic')?.consume).toBe(false);
  });

  it('显式 consume 压过类型推定', async () => {
    const { inv } = await makeInventory([
      {
        id: 'lamp', name: '灯', type: 'consumable', description: '', maxStack: 1,
        use: { label: '点亮', consume: false },
      },
    ]);
    inv.addItem('lamp', 1);
    expect(inv.resolveItemUse('lamp')?.consume).toBe(false);
  });

  it('条件不满足 → enabled=false 且带上自定义理由（不跑任何 action）', async () => {
    const ran = vi.fn();
    const { inv, flags } = await makeInventory([
      {
        id: 'talis', name: '符', type: 'consumable', description: '', maxStack: 5,
        use: {
          label: '烧掉',
          conditions: [{ flag: 'is_night' } as never],
          disableHint: '天还亮着，烧了白烧。',
          actions: [{ type: 'setFlag', params: { key: 'burned', value: true } }],
        },
      },
    ]);
    inv.addItem('talis', 1);

    const blocked = inv.resolveItemUse('talis');
    expect(blocked?.enabled).toBe(false);
    expect(blocked?.disableReason).toBe('天还亮着，烧了白烧。');
    expect(ran).not.toHaveBeenCalled();
    // 查询是纯读：不许有副作用落到 flag 上
    expect(flags.get('burned')).toBeFalsy();

    flags.set('is_night', true);
    expect(inv.resolveItemUse('talis')?.enabled).toBe(true);
  });

  it('没写 disableHint 时退回 strings 默认理由', async () => {
    const { inv } = await makeInventory([
      {
        id: 'x', name: 'X', type: 'consumable', description: '', maxStack: 1,
        use: { label: '用', conditions: [{ flag: 'never' } as never] },
      },
    ]);
    inv.addItem('x', 1);
    expect(inv.resolveItemUse('x')?.disableReason).toBe('眼下用不成。');
  });

  it('要扣却一个都不剩 → enabled=false（面板开着时数量被剧情清零的补漏）', async () => {
    const { inv } = await makeInventory([
      {
        id: 'cake', name: '饼', type: 'consumable', description: '', maxStack: 5,
        use: { label: '吃掉' },
      },
    ]);
    inv.addItem('cake', 1);
    expect(inv.resolveItemUse('cake')?.enabled).toBe(true);
    inv.removeItem('cake', 1);
    expect(inv.resolveItemUse('cake')?.enabled).toBe(false);
  });
});

/** EventBridge 的 item:use 只用到这几件依赖，其余管理器在本用例里永远不会被碰到。 */
function makeBridge(overrides: {
  consumeItem: (id: string, n: number) => boolean;
  executeBatchAwait: (actions: ActionDef[]) => Promise<void>;
  showInspect?: (text: string) => Promise<void>;
}): { bus: EventBus; bridge: EventBridge; closed: string[]; states: string[] } {
  const bus = new EventBus();
  const closed: string[] = [];
  const states: string[] = [];
  const deps = {
    dialogueManager: {}, graphDialogueManager: {}, encounterManager: {},
    stateController: {
      get currentState() { return 'Exploring'; },
      closePanel: (name: string) => closed.push(name),
      setState: (s: string) => states.push(s),
      restorePreviousState: () => {},
    },
    actionExecutor: {
      executeBatchAwait: overrides.executeBatchAwait,
      executeAwait: async () => {},
    },
    mapUI: { setCurrentScene: () => {} },
    menuUI: { close: () => {}, openMainMenu: () => {} },
    inspectBox: { show: overrides.showInspect ?? (async () => {}) },
    guardMapTravel: () => true,
    consumeItem: overrides.consumeItem,
  } as unknown as EventBridgeDeps;
  const bridge = new EventBridge(bus, deps);
  bridge.init();
  return { bus, bridge, closed, states };
}

describe('EventBridge item:use（先扣后跑 / 扣不到就取消 / 防重入）', () => {
  it('先扣后跑：扣除发生在 actions 之前', async () => {
    const order: string[] = [];
    const { bus } = makeBridge({
      consumeItem: () => { order.push('consume'); return true; },
      executeBatchAwait: async () => { order.push('actions'); },
    });
    bus.emit('item:use', { itemId: 'cake', consume: true, actions: [{ type: 'noop' }] });
    await vi.waitFor(() => expect(order).toEqual(['consume', 'actions']));
  });

  it('扣不到就整件事取消：一条 action 都不跑，面板也不关', async () => {
    const run = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, closed } = makeBridge({
      consumeItem: () => false,
      executeBatchAwait: run,
    });
    bus.emit('item:use', { itemId: 'ghost', consume: true, actions: [{ type: 'noop' }] });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(closed).toEqual([]);
    warn.mockRestore();
  });

  it('consume=false 的用途不碰扣除通道', async () => {
    const consume = vi.fn(() => true);
    const run = vi.fn(async () => {});
    const { bus } = makeBridge({ consumeItem: consume, executeBatchAwait: run });
    bus.emit('item:use', { itemId: 'relic', consume: false, actions: [{ type: 'noop' }] });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(consume).not.toHaveBeenCalled();
  });

  it('在途锁：actions 还没跑完时再点一次，不会重复消耗也不会重复结算', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const consume = vi.fn(() => true);
    const run = vi.fn(async () => { await gate; });
    const { bus } = makeBridge({ consumeItem: consume, executeBatchAwait: run });

    bus.emit('item:use', { itemId: 'cake', consume: true, actions: [{ type: 'noop' }] });
    await Promise.resolve();
    bus.emit('item:use', { itemId: 'cake', consume: true, actions: [{ type: 'noop' }] });
    await Promise.resolve();

    expect(consume).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    // 锁在 finally 里放开。重试式重发＝"一直点到点得动"：锁没放开时 emit 是空转，
    // 放开后第一次就受理——既证明锁会放开，又不依赖对 await 层数的猜测。
    await vi.waitFor(() => {
      bus.emit('item:use', { itemId: 'cake', consume: true, actions: [{ type: 'noop' }] });
      expect(consume).toHaveBeenCalledTimes(2);
    });
  });

  it('actions 抛错不会把锁卡死，也不阻断 resultText 展示', async () => {
    const shown: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus } = makeBridge({
      consumeItem: () => true,
      executeBatchAwait: async () => { throw new Error('boom'); },
      showInspect: async (t) => { shown.push(t); },
    });
    bus.emit('item:use', {
      itemId: 'cake', consume: true, actions: [{ type: 'noop' }], resultText: '吃了。',
    });
    await vi.waitFor(() => expect(shown).toEqual(['吃了。']));

    // 锁已放开：第二次使用照常受理
    bus.emit('item:use', {
      itemId: 'cake', consume: true, actions: [{ type: 'noop' }], resultText: '又吃了。',
    });
    await vi.waitFor(() => expect(shown).toEqual(['吃了。', '又吃了。']));
    warn.mockRestore();
  });
});
