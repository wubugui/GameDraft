import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from '../engine2d';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { ActionExecutor } from '../core/ActionExecutor';
import { registerActionHandlers, type ActionRegistryDeps } from '../core/ActionRegistry';
import { InventoryManager } from '../systems/InventoryManager';
import { AudioManager } from '../systems/AudioManager';
import { PickupNotification } from './PickupNotification';
import { NotificationUI } from './NotificationUI';
import { UITheme } from './UITheme';
import { buildToastChip } from './components/UIToast';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import type { GameContext, ItemDef } from '../data/types';

vi.mock('./components/UIToast', () => ({
  buildToastChip: vi.fn(() => ({ container: new Container(), width: 200, height: 40 })),
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function harness() {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const bus = new EventBus();
  const audio = new AudioManager(bus);
  audio.init({ assetManager: { loadJson: vi.fn() } } as unknown as GameContext);
  const sounds: { key: string; at: number }[] = [];
  (audio as unknown as { playSystemSfx: (key: string) => void }).playSystemSfx =
    key => { sounds.push({ key, at: now }); };
  const flags = new FlagStore(bus);
  const inv = new InventoryManager(bus, flags);
  const strings = { get: (cat: string, key: string, vars?: Record<string, string | number>) =>
    cat === 'pickup' ? `获得了 ${vars?.name} x${vars?.count}` : key };
  inv.init({ strings, assetManager: { loadJson: async () => [
    { id: 'paper', name: '纸钱', maxStack: 5, type: 'consumable', description: '' },
  ] satisfies ItemDef[] } } as unknown as GameContext);
  await inv.loadDefs();
  const unsubscribe = vi.fn();
  const uiLayer = new Container();
  const renderer = { uiLayer, screenWidth: 1024, subscribeAfterResize: () => unsubscribe };
  const ui = new PickupNotification(renderer as unknown as Renderer, strings as StringsProvider, bus);
  const notifications = new NotificationUI(renderer as unknown as Renderer, bus);
  cleanups.push(() => { ui.destroy(); notifications.destroy(); inv.destroy(); audio.destroy(); uiLayer.destroy({ children: true }); });
  const executor = new ActionExecutor(bus, flags);
  registerActionHandlers(executor, {
    eventBus: bus, inventoryManager: inv, pickupNotification: ui, stringsProvider: strings,
    resolveDisplayText: (text: string) => text,
  } as unknown as ActionRegistryDeps);
  const notices: unknown[] = [];
  bus.on('notification:show', p => notices.push(p));
  const step = (ms = 400) => { now += ms; notifications.update(ms / 1000); };
  const flush = () => { for (let i = 0; i < 5; i++) step(); };
  const labels = () => {
    flush();
    return vi.mocked(buildToastChip).mock.calls.filter(([opts]) => opts.color === UITheme.colors.pickupText).map(([opts]) => opts.text);
  };
  const action = (type: string, params: Record<string, unknown>) => executor.executeAwait({ type, params });
  return { bus, inv, ui, notifications, renderer, unsubscribe, action, labels, notices, sounds, step, flush };
}

describe('物品获得回执（真实动作 → 背包事件 → UI）', () => {
  it('giveItem 自动提示，名称来自物品定义', async () => {
    const h = await harness();
    await h.action('giveItem', { id: 'paper', count: 2 });
    expect(h.inv.getItemCount('paper')).toBe(2);
    expect(h.labels()).toEqual(['获得了 纸钱 x2']);
  });

  it('拾取只提示一次，截到堆叠上限时显示实际入包量，满堆叠不提示', async () => {
    const h = await harness();
    h.inv.deserialize({ items: { paper: 4 }, coins: 0 });
    await h.action('pickup', { itemId: 'paper', itemName: '旧名字', count: 3 });
    await h.action('giveItem', { id: 'paper', count: 1 });
    expect(h.inv.getItemCount('paper')).toBe(5);
    expect(h.labels()).toEqual(['获得了 纸钱 x1']);
  });

  it('购买只出入袋回执，保留实际扣款', async () => {
    const h = await harness();
    h.inv.addCoins(10);
    await h.action('shopPurchase', { itemId: 'paper', price: 3 });
    expect(h.inv.getCoins()).toBe(7);
    expect(h.labels()).toEqual(['获得了 纸钱 x1']);
    expect(h.notices).toEqual([]);
  });

  it('普通给予、拾取、购买满包均不报成功，购买失败仍退款，critical 可获得', async () => {
    const h = await harness();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.inv.deserialize({ items: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`item${i}`, 1])), coins: 10 });
    await h.action('giveItem', { id: 'paper' });
    await h.action('pickup', { itemId: 'paper', itemName: '纸钱', count: 1 });
    await h.action('shopPurchase', { itemId: 'paper', price: 3 });
    expect(h.labels()).toEqual([]);
    expect(h.notices).toHaveLength(3);
    expect(h.inv.getCoins()).toBe(10);
    await h.action('giveItem', { id: 'paper', critical: true });
    expect(h.labels()).toEqual(['获得了 纸钱 x1']);
  });

  it('过场内收到物品先保留，结束后出现且不重复', async () => {
    const h = await harness();
    h.bus.emit('cutscene:start');
    await h.action('giveItem', { id: 'paper', count: 2 });
    expect(h.labels()).toEqual([]);
    h.bus.emit('cutscene:end');
    h.bus.emit('cutscene:end');
    expect(h.labels()).toEqual(['获得了 纸钱 x2']);
  });

  it('读档恢复物品不播报，铜钱拾取仍保留原提示', async () => {
    const h = await harness();
    h.inv.deserialize({ items: { paper: 2 }, coins: 10 });
    expect(h.labels()).toEqual([]);
    await h.action('pickup', { isCurrency: true, itemName: '铜钱', count: 3 });
    expect(h.inv.getCoins()).toBe(13);
    expect(h.labels()).toEqual(['获得了 铜钱 x3']);
  });

  it('销毁摘掉事件、清掉过场待提示；重建后只播一次', async () => {
    const h = await harness();
    h.bus.emit('cutscene:start');
    await h.action('giveItem', { id: 'paper' });
    h.ui.destroy();
    h.bus.emit('cutscene:end');
    await h.action('giveItem', { id: 'paper' });
    expect(h.labels()).toEqual([]);
    // 入袋适配器已不占独立布局监听；统一提示层仍活着。
    expect(h.unsubscribe).not.toHaveBeenCalled();
    const next = new PickupNotification(h.renderer as unknown as Renderer,
      { get: () => '新实例回执' } as unknown as StringsProvider, h.bus);
    cleanups.push(() => next.destroy());
    await h.action('giveItem', { id: 'paper' });
    expect(h.labels()).toEqual(['新实例回执']);
  });

  it('物品与普通提示在同一队列居中堆叠，不重叠；物品仍在 2 秒后移除', async () => {
    const h = await harness();
    h.bus.emit('notification:show', { text: '普通提示', type: 'info' });
    await h.action('giveItem', { id: 'paper', count: 1 });
    const list = h.renderer.uiLayer.children[0];
    h.step();
    expect(list.children).toHaveLength(1);
    h.step(399);
    expect(list.children).toHaveLength(1);
    h.step(1);
    expect(list.children).toHaveLength(2);
    const [normal, pickup] = list.children;
    expect(pickup.x).toBe((1024 - 200) / 2);
    expect(pickup.y).toBe(UITheme.topLanes.toast);
    expect(normal.y).toBeGreaterThanOrEqual(pickup.y + 40);
    h.renderer.screenWidth = 800;
    h.step(2000);
    expect(list.children).toEqual([normal]);
    expect(normal.x).toBe((800 - 200) / 2);
  });

  it('清理只移除物品提示，普通提示与其队列保留', async () => {
    const h = await harness();
    h.bus.emit('notification:show', { text: '普通提示', type: 'info' });
    await h.action('giveItem', { id: 'paper', count: 1 });
    h.step();
    h.step();
    const list = h.renderer.uiLayer.children[0];
    expect(list.children).toHaveLength(2);
    h.ui.forceCleanup();
    expect(list.children).toHaveLength(1);
    await h.action('giveItem', { id: 'paper', count: 1 });
    h.ui.destroy();
    h.step();
    expect(list.children).toHaveLength(1);
  });

  it('同批三条物品先无声入队，每条出现才响一次，间隔跟随提示队列', async () => {
    const h = await harness();
    await h.action('giveItem', { id: 'paper', count: 3 });
    await h.action('giveItem', { id: 'itemA', count: 1 });
    await h.action('giveItem', { id: 'itemB', count: 1 });
    expect(h.sounds).toEqual([]);
    h.step();
    expect(h.sounds).toEqual([{ key: 'itemAcquired', at: 1400 }]);
    h.step(399);
    expect(h.sounds).toHaveLength(1);
    h.step(1);
    h.step(400);
    expect(h.sounds).toEqual([
      { key: 'itemAcquired', at: 1400 },
      { key: 'itemAcquired', at: 1800 },
      { key: 'itemAcquired', at: 2200 },
    ]);
    h.step(2400);
    expect(h.sounds).toHaveLength(3);
  });

  it('过场中、零增加量与丢弃的待显示提示不响物品音', async () => {
    const h = await harness();
    h.bus.emit('cutscene:start');
    await h.action('giveItem', { id: 'paper', count: 5 });
    await h.action('giveItem', { id: 'paper', count: 1 });
    h.step();
    const itemSounds = () => h.sounds.filter(s => s.key === 'itemAcquired');
    expect(itemSounds()).toEqual([]);
    h.bus.emit('cutscene:end');
    expect(itemSounds()).toEqual([]);
    h.step();
    expect(itemSounds()).toHaveLength(1);
    await h.action('giveItem', { id: 'itemA', count: 1 });
    h.ui.destroy();
    h.step();
    expect(itemSounds()).toHaveLength(1);
  });

  it('铜钱拾取只响原来的 coinGain，不再叠物品音或通用提示音', async () => {
    const h = await harness();
    await h.action('pickup', { isCurrency: true, itemName: '铜钱', count: 3 });
    h.step();
    expect(h.sounds.map(s => s.key)).toEqual(['coinGain']);
  });
});
