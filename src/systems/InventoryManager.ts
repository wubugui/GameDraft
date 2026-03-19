import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ItemDef, IGameSystem, GameContext, IInventoryDataProvider } from '../data/types';
import { resolveAssetPath } from '../core/assetPath';

const MAX_SLOTS = 12;

export class InventoryManager implements IGameSystem, IInventoryDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private itemDefs: Map<string, ItemDef> = new Map();
  private slots: Map<string, number> = new Map();
  private coins: number = 0;
  private loaded: boolean = false;
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
  }
  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/items.json'));
      const defs: ItemDef[] = await resp.json();
      for (const def of defs) {
        this.itemDefs.set(def.id, def);
      }
      this.loaded = true;
    } catch {
      console.warn('InventoryManager: items.json not found, running without item definitions');
      this.loaded = true;
    }
  }

  getItemDef(id: string): ItemDef | undefined {
    return this.itemDefs.get(id);
  }

  private getUsedSlots(): number {
    return this.slots.size;
  }

  addItem(id: string, count: number = 1): boolean {
    const existing = this.slots.get(id) ?? 0;
    const def = this.itemDefs.get(id);
    const maxStack = def?.maxStack ?? 99;

    if (existing === 0 && this.getUsedSlots() >= MAX_SLOTS) {
      this.eventBus.emit('notification:show', { text: this.strings.get('notifications', 'inventoryFull'), type: 'warning' });
      return false;
    }

    const newCount = Math.min(existing + count, maxStack);
    this.slots.set(id, newCount);
    this.syncItemFlags(id);
    this.eventBus.emit('item:acquired', {
      itemId: id,
      itemName: def?.name ?? id,
      count: newCount - existing,
    });
    return true;
  }

  removeItem(id: string, count: number = 1): boolean {
    const existing = this.slots.get(id) ?? 0;
    if (existing < count) return false;

    const newCount = existing - count;
    if (newCount <= 0) {
      this.slots.delete(id);
    } else {
      this.slots.set(id, newCount);
    }
    this.syncItemFlags(id);
    this.eventBus.emit('item:consumed', { itemId: id, count });
    return true;
  }

  hasItem(id: string, count: number = 1): boolean {
    return (this.slots.get(id) ?? 0) >= count;
  }

  getItemCount(id: string): number {
    return this.slots.get(id) ?? 0;
  }

  getAllItems(): { id: string; count: number; def?: ItemDef }[] {
    const result: { id: string; count: number; def?: ItemDef }[] = [];
    this.slots.forEach((count, id) => {
      result.push({ id, count, def: this.itemDefs.get(id) });
    });
    return result;
  }

  getCoins(): number {
    return this.coins;
  }

  addCoins(amount: number): void {
    this.coins += amount;
    this.flagStore.set('coins', this.coins);
    this.eventBus.emit('currency:changed', { amount, newTotal: this.coins });
  }

  removeCoins(amount: number): boolean {
    if (this.coins < amount) return false;
    this.coins -= amount;
    this.flagStore.set('coins', this.coins);
    this.eventBus.emit('currency:changed', { amount: -amount, newTotal: this.coins });
    return true;
  }

  getItemDescription(id: string): string {
    const def = this.itemDefs.get(id);
    if (!def) return '';

    if (def.dynamicDescriptions) {
      for (const dd of def.dynamicDescriptions) {
        if (this.flagStore.checkConditions(dd.conditions)) {
          return dd.text;
        }
      }
    }
    return def.description;
  }

  canDiscard(id: string): boolean {
    const def = this.itemDefs.get(id);
    return def?.type === 'consumable';
  }

  discardItem(id: string): void {
    if (!this.canDiscard(id)) return;
    this.slots.delete(id);
    this.syncItemFlags(id);
  }

  private syncItemFlags(id: string): void {
    const count = this.slots.get(id) ?? 0;
    this.flagStore.set(`has_item_${id}`, count > 0);
    this.flagStore.set(`item_count_${id}`, count);
  }

  serialize(): object {
    const items: Record<string, number> = {};
    this.slots.forEach((count, id) => { items[id] = count; });
    return { items, coins: this.coins };
  }

  deserialize(data: { items: Record<string, number>; coins: number }): void {
    this.slots.clear();
    for (const [id, count] of Object.entries(data.items)) {
      this.slots.set(id, count);
      this.syncItemFlags(id);
    }
    this.coins = data.coins ?? 0;
    this.flagStore.set('coins', this.coins);
  }

  destroy(): void {
    this.slots.clear();
    this.itemDefs.clear();
    this.coins = 0;
  }
}
