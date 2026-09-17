import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type {
  ActiveIgniterStatus, Condition, ConditionExpr, ItemDef, IGameSystem, GameContext, IInventoryDataProvider, ResolvedItemUse,
} from '../data/types';
import type { AssetManager } from '../core/AssetManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';

const MAX_SLOTS = 12;

/** 火种一份能点几次（缺省 / 非法 = 1） */
function igniterUses(def: ItemDef): number {
  const n = def.igniter?.uses;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export class InventoryManager implements IGameSystem, IInventoryDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private itemDefs: Map<string, ItemDef> = new Map();
  private slots: Map<string, number> = new Map();
  private coins: number = 0;
  private loaded: boolean = false;
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  /** 当前火种（物品 id；null = 没设）。玩家在背包里主动设，**不自动挑**（制作人 2026-09-15） */
  private activeIgniter: string | null = null;
  /** 每种火种拆开那一份还剩几次（火折子一支点三次：点了一次，剩两次记在这；换火种再换回来接着用） */
  private igniterOpened: Map<string, number> = new Map();

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<ItemDef[]>(TEXT_URLS.items);
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

  /**
   * @param opts.bypassSlotLimit 关键给予（giveItem critical=true）绕过槽上限：
   * 剧情必得道具的给予分支往往按 flag 推进且不可再入，满包丢弃即永久丢失——
   * 宁可临时超槽（UI 网格按需增行）也不能丢。maxStack 上限仍生效。
   */
  addItem(id: string, count: number = 1, opts?: { bypassSlotLimit?: boolean }): boolean {
    const existing = this.slots.get(id) ?? 0;
    const def = this.itemDefs.get(id);
    const maxStack = def?.maxStack ?? 99;

    if (existing === 0 && this.getUsedSlots() >= MAX_SLOTS && !opts?.bypassSlotLimit) {
      this.eventBus.emit('inventory:full', { itemId: id });
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
    /** B7：非有限金额拒绝写入——NaN 一旦混进 coins 会随存档扩散（`NaN < x` 恒 false 等） */
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      console.warn(`InventoryManager.addCoins: 非法金额 ${String(amount)}，已拒绝`);
      return;
    }
    this.coins += amount;
    this.flagStore.set('coins', this.coins);
    this.eventBus.emit('currency:changed', { amount, newTotal: this.coins });
  }

  removeCoins(amount: number): boolean {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      console.warn(`InventoryManager.removeCoins: 非法金额 ${String(amount)}，已拒绝`);
      return false;
    }
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
        const ctx = this.conditionCtxFactory?.();
        const ok = ctx
          ? evaluateConditionExprList(dd.conditions, ctx)
          : this.flagStore.checkConditions(dd.conditions as Condition[]);
        if (ok) {
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

  /**
   * 把 `ItemDef.use` 求成"点下去之前就知道结果"的查询产物（与遭遇选项的 ResolvedOption 同构）。
   *
   * **只读声明式那一半**（conditions / consume / 持有量），一条 action 都不跑——UI 的按钮
   * 灰态与理由全靠它，跑一遍再看结果就成了"点了才发现没反应"。
   */
  resolveItemUse(id: string): ResolvedItemUse | null {
    const def = this.itemDefs.get(id);
    if (def && !def.use && def.igniter) return this.resolveIgniterUse(def);
    const use = def?.use;
    if (!def || !use) return null;

    // 缺省按类型推定：关键道具不因使用而消失（玩法清单 F1b），消耗品扣一个。
    // 推定只在这里做一次，下游（UI、EventBridge）读 ResolvedItemUse.consume 不再各自推。
    const consume = use.consume ?? def.type === 'consumable';

    let enabled = true;
    let disableReason: string | undefined;

    // 要扣却不够：本该被面板"包里有才画得出这一格"挡住，但存档/剧情可能在面板开着时
    // 把数量清零，这里补一道——不变量「失败不得伪装成功」。
    if (consume && (this.slots.get(id) ?? 0) < 1) {
      enabled = false;
      disableReason = this.strings.get('inventory', 'useDisabled');
    } else if (use.conditions?.length) {
      const ctx = this.conditionCtxFactory?.();
      const ok = ctx
        ? evaluateConditionExprList(use.conditions, ctx)
        : this.flagStore.checkConditions(use.conditions as Condition[]);
      if (!ok) {
        enabled = false;
        disableReason = use.disableHint || this.strings.get('inventory', 'useDisabled');
      }
    }

    return {
      itemId: id,
      label: use.label,
      enabled,
      disableReason,
      consume,
      actions: use.actions ?? [],
      resultText: use.resultText,
    };
  }

  // ---------------------------------------------------------------- 火种

  /** 火种的用法：「设为火种」；已经是当前火种 ⇒ 置灰 + 理由 */
  private resolveIgniterUse(def: ItemDef): ResolvedItemUse {
    const current = this.activeIgniter === def.id;
    return {
      itemId: def.id,
      label: this.strings.get('inventory', 'setIgniter'),
      enabled: !current,
      disableReason: current ? this.strings.get('inventory', 'igniterCurrent') : undefined,
      consume: false,
      actions: [{ type: 'setActiveIgniter', params: { item: def.id } }],
    };
  }

  /** 设当前火种（`setActiveIgniter` 动作）。不是火种 ⇒ false，不动 */
  setActiveIgniter(id: string): boolean {
    const def = this.itemDefs.get(id.trim());
    if (!def?.igniter) {
      console.warn(`setActiveIgniter: 物品「${id}」不是火种（items.json 里没写 igniter）`);
      return false;
    }
    this.activeIgniter = def.id;
    this.eventBus.emit('inventory:igniterChanged', { itemId: def.id });
    return true;
  }

  /** 当前火种此刻的样子；没设 ⇒ null（设了但用完了照样返回，`available` 为 0） */
  getActiveIgniter(): ActiveIgniterStatus | null {
    const id = this.activeIgniter;
    const def = id ? this.itemDefs.get(id) : undefined;
    if (!id || !def?.igniter) return null;
    const uses = igniterUses(def);
    const openedLeft = this.igniterOpened.get(id) ?? 0;
    return {
      itemId: id,
      name: def.name,
      seconds: def.igniter.seconds,
      windLimit: def.igniter.windLimit,
      uses,
      openedLeft,
      available: openedLeft + (this.slots.get(id) ?? 0) * uses,
    };
  }

  /**
   * 点一次火用掉当前火种的一次：拆开的那份还有就扣它；没有就从包里拆一份（扣一件）。
   * 用不了（没设 / 用完了）⇒ null，什么都不动。点没点着都在开始点那一刻扣（制作人："点火失败，就直接消耗了"）。
   */
  consumeIgniterUse(): ActiveIgniterStatus | null {
    const st = this.getActiveIgniter();
    if (!st || st.available <= 0) return null;
    if (st.openedLeft > 0) {
      this.setOpened(st.itemId, st.openedLeft - 1);
    } else {
      if (!this.removeItem(st.itemId, 1)) return null;
      this.setOpened(st.itemId, st.uses - 1);
    }
    this.eventBus.emit('inventory:igniterChanged', { itemId: st.itemId });
    return st;
  }

  igniterInfoOf(id: string): { current: boolean; uses: number; openedLeft: number } | null {
    const def = this.itemDefs.get(id);
    if (!def?.igniter) return null;
    return { current: this.activeIgniter === id, uses: igniterUses(def), openedLeft: this.igniterOpened.get(id) ?? 0 };
  }

  private setOpened(id: string, n: number): void {
    if (n > 0) this.igniterOpened.set(id, n);
    else this.igniterOpened.delete(id);
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
    const out: { items: Record<string, number>; coins: number; igniter?: { active: string | null; opened: Record<string, number> } } = {
      items, coins: this.coins,
    };
    if (this.activeIgniter || this.igniterOpened.size > 0) {
      out.igniter = { active: this.activeIgniter, opened: Object.fromEntries(this.igniterOpened) };
    }
    return out;
  }

  deserialize(data: {
    items: Record<string, number>; coins: number; igniter?: { active?: unknown; opened?: unknown };
  }): void {
    this.activeIgniter = typeof data.igniter?.active === 'string' && data.igniter.active ? data.igniter.active : null;
    this.igniterOpened.clear();
    const opened = data.igniter?.opened;
    if (opened && typeof opened === 'object' && !Array.isArray(opened)) {
      for (const [id, n] of Object.entries(opened as Record<string, unknown>)) {
        if (typeof n === 'number' && Number.isFinite(n) && n >= 1) this.igniterOpened.set(id, Math.floor(n));
      }
    }
    this.slots.clear();
    for (const [id, count] of Object.entries(data.items)) {
      this.slots.set(id, count);
      this.syncItemFlags(id);
    }
    this.coins = data.coins ?? 0;
    this.flagStore.set('coins', this.coins);
    // 读档后刷新 HUD 铜钱显示。amount=0 表示非增减、仅对账——音效消费者按 amount 正负播币声，
    // 0 不会触发；restored=true 供其它副作用消费者识别忽略。
    this.eventBus.emit('currency:changed', { amount: 0, newTotal: this.coins, restored: true });
  }

  destroy(): void {
    this.activeIgniter = null;
    this.igniterOpened.clear();
    this.slots.clear();
    this.itemDefs.clear();
    this.coins = 0;
  }
}
