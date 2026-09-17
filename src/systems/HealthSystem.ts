import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { ActionDef, IGameSystem, GameContext } from '../data/types';
import { protectionHealthBonus, resolveHealthDamage } from '../data/survival';
import type { HealthBounds, HealthDamage, HealthDamageResult, HealthDepletion, HealthProtection, TimedHealthProtection } from '../data/survival';

export interface HealthConfig {
  /** 血量上限（默认满血起步） */
  maxHealth: number;
  /** 血量降到此值（含）即耗尽；只有明确获准时走剧情系绳 */
  deathThreshold: number;
  /** 系绳拽回后恢复到的血量 */
  restoreFloor: number;
  /** 死亡系绳触发的信号 cue id（阿秀冷信号：香粉味+小调） */
  tetherCueId: string;
  /**
   * 外部接管系绳的抑制 flag 键：该 flag 为 true 时跳过内置系绳演出与自动回血，
   * HP 交由内容侧脚本（healPlayer）救场。内容键名走配置而非硬编码（律4，与 tetherCueId
   * 同模式）；默认保持既有键，game_config.health 可覆盖。
   */
  tetherSuppressFlagKey: string;
}

const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  maxHealth: 100,
  deathThreshold: 0,
  restoreFloor: 60,
  tetherCueId: 'signal_death_tether',
  tetherSuppressFlagKey: 'forest.tether_suppressed',
};

/**
 * 死亡系绳 / 系统级血量（见 docs/玩法功能需求清单.md §G.5）。
 *
 * 普通伤害耗尽会死亡；只有内容条件明确允许时，才由死亡系绳接管。
 * 编排 setHealth 仍只置数（既有演出语义），普通玩法一律 applyDamage。
 * 防护来源由组装层提供，不持有背包／鬼物／UI 实例。临时上下限不修改永久能力。
 *
 * §1 合规：状态进 FlagStore（`player_health`/`player_max_health`），只经 EventBus
 * （`player:healthChanged`）+ ActionExecutor（跑系绳 cue），不持有其它系统引用。
 */
export class HealthSystem implements IGameSystem {
  private readonly eventBus: EventBus;
  private readonly flagStore: FlagStore;
  private readonly actionExecutor: ActionExecutor;

  private config: HealthConfig = { ...DEFAULT_HEALTH_CONFIG };
  private currentHealth = DEFAULT_HEALTH_CONFIG.maxHealth;
  private baseMaxHealth = DEFAULT_HEALTH_CONFIG.maxHealth;
  private maxHealth = DEFAULT_HEALTH_CONFIG.maxHealth;
  /** 系绳演出期间为 true：连续致死 damage 只拽一次，避免重入 */
  private tethering = false;
  private depleted = false;
  private generation = 0;
  private bounds = new Map<string, HealthBounds>();
  private activeProtections = new Map<string, TimedHealthProtection>();
  private sceneId = '';
  private protectionProvider: () => readonly HealthProtection[] = () => [];
  private tetherAllowed: () => boolean = () => false;
  private depletionHandler: ((cause: HealthDepletion) => void | Promise<void>) | null = null;
  private lastDamage: (HealthDamage & { result: HealthDamageResult }) | null = null;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
  }

  /** 可选：用 game_config.health 覆盖默认配置（Game 在 init 前调用）。 */
  configure(partial: Partial<HealthConfig> | undefined | null): void {
    if (!partial) return;
    this.config = { ...this.config, ...partial };
    this.config.maxHealth = this.validMax(this.config.maxHealth);
    if (!Number.isFinite(this.config.deathThreshold) || this.config.deathThreshold < 0
      || this.config.deathThreshold >= this.config.maxHealth) this.config.deathThreshold = 0;
    if (!Number.isFinite(this.config.restoreFloor) || this.config.restoreFloor <= this.config.deathThreshold)
      this.config.restoreFloor = Math.max(this.config.deathThreshold + 1, DEFAULT_HEALTH_CONFIG.restoreFloor);
  }

  init(_ctx: GameContext): void {
    this.generation++;
    this.baseMaxHealth = this.validMax(this.config.maxHealth);
    this.maxHealth = this.baseMaxHealth;
    this.currentHealth = this.maxHealth;
    this.bounds.clear();
    this.activeProtections.clear();
    this.sceneId = '';
    this.depleted = false;
    this.tethering = false;
    this.lastDamage = null;
    this.syncFlags();
    this.emitChanged();
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0 || this.depleted || this.tethering) return;
    let changed = false;
    for (const [id, protection] of this.activeProtections) {
      protection.remainingSeconds -= dt;
      if (protection.remainingSeconds <= 0) { this.activeProtections.delete(id); changed = true; }
    }
    if (changed) this.refreshProtection();
  }

  /** 携带的被动来源与主动来源共用 id 去重规则。 */
  getProtections(): readonly HealthProtection[] {
    return [...this.protectionProvider(), ...this.activeProtections.values()];
  }

  applyProtection(protection: HealthProtection, seconds: number): boolean {
    if (!protection.id?.trim() || !Number.isFinite(seconds) || seconds <= 0) return false;
    if (protection.reduction !== undefined && (!Number.isFinite(protection.reduction) || protection.reduction < 0 || protection.reduction > 1)) return false;
    if (protection.maxHealthBonus !== undefined && (!Number.isFinite(protection.maxHealthBonus) || protection.maxHealthBonus < 0)) return false;
    this.activeProtections.set(protection.id, { ...protection, remainingSeconds: seconds });
    this.refreshProtection();
    return true;
  }

  removeProtection(id: string): void {
    this.activeProtections.delete(id);
    this.refreshProtection();
  }

  /** 当前血量。 */
  getHealth(): number {
    return this.currentHealth;
  }

  getMaxHealth(): number {
    return this.maxHealth;
  }

  getBaseMaxHealth(): number { return this.baseMaxHealth; }
  isDepleted(): boolean { return this.depleted; }

  setProtectionProvider(provider: () => readonly HealthProtection[]): void {
    this.protectionProvider = provider;
    this.refreshProtection();
  }

  setTetherAllowed(predicate: () => boolean): void { this.tetherAllowed = predicate; }
  setDepletionHandler(handler: ((cause: HealthDepletion) => void | Promise<void>) | null): void {
    this.depletionHandler = handler;
  }

  /** 成长保留当前值：增加上限不是隐含回血，补血由独立 action 表达。 */
  setBaseMaxHealth(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.baseMaxHealth = amount;
    this.refreshProtection();
  }

  refreshProtection(): void {
    const next = this.validMax(this.baseMaxHealth + protectionHealthBonus(this.getProtections()));
    const old = this.maxHealth;
    this.maxHealth = next;
    const current = this.clampCurrent(this.currentHealth);
    if (old === next && current === this.currentHealth) return;
    this.currentHealth = current;
    this.syncFlags();
    this.emitChanged();
  }

  /** 重叠限制取交集；冲突拒绝，不悄悄覆盖另一段教学的限制。 */
  setBounds(value: HealthBounds): boolean {
    if (!value.id?.trim() || (value.min === undefined && value.max === undefined)) return false;
    if (value.scope !== undefined && value.scope !== 'scene' && value.scope !== 'persistent') return false;
    for (const v of [value.min, value.max]) if (v !== undefined && (!Number.isFinite(v) || v < 0)) return false;
    const pending = new Map(this.bounds);
    pending.set(value.id, { ...value, scope: value.scope ?? 'scene' });
    let min = 0, max = Infinity;
    for (const b of pending.values()) { min = Math.max(min, b.min ?? 0); max = Math.min(max, b.max ?? Infinity); }
    if (min > max) return false;
    this.bounds = pending;
    this.setHealth(this.currentHealth);
    return true;
  }

  clearBounds(id: string): void { this.bounds.delete(id); }
  clearSceneBounds(): void {
    for (const [id, b] of this.bounds) if (b.scope !== 'persistent') this.bounds.delete(id);
  }

  /** 同场景读档保留教学限制；真正换场才释放 scene 句柄。 */
  enterScene(id: string): void {
    if (this.sceneId && this.sceneId !== id) this.clearSceneBounds();
    this.sceneId = id;
  }

  private validMax(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_HEALTH_CONFIG.maxHealth;
  }

  private clampCurrent(value: number): number {
    let min = 0, max = this.maxHealth;
    for (const b of this.bounds.values()) { min = Math.max(min, b.min ?? 0); max = Math.min(max, b.max ?? max); }
    // 脱下加上限的物品时，最低保护不能把当前值抬到真实最大值之外。
    return Math.max(Math.min(min, max), Math.min(max, value));
  }

  /**
   * 旧入口保留调用形状，统一交给普通伤害通道。只有获准时才触发死亡系绳。
   */
  async damage(amount: number): Promise<void> {
    await this.applyDamage({ amount, kind: 'yin', sourceId: 'legacy' });
  }

  async applyDamage(damage: HealthDamage): Promise<HealthDamageResult> {
    const result: HealthDamageResult = {
      requested: Number.isFinite(damage.amount) ? Math.max(0, damage.amount) : 0,
      afterProtection: 0, applied: 0, depleted: false, protectionIds: [],
    };
    if (this.depleted || this.tethering || result.requested <= 0) return result;
    this.refreshProtection();
    const resolved = resolveHealthDamage(damage, this.getProtections());
    result.afterProtection = resolved.amount;
    result.protectionIds = resolved.protectionIds;
    const before = this.currentHealth;
    this.currentHealth = this.clampCurrent(before - resolved.amount);
    result.applied = Math.max(0, before - this.currentHealth);
    // 正最低保护具有“不死”含义，即使作者配置了大于 0 的濒死阈值。
    const protectedFloor = [...this.bounds.values()].some((b) => (b.min ?? 0) > 0);
    result.depleted = !protectedFloor && this.currentHealth <= this.config.deathThreshold;
    this.lastDamage = { ...damage, result: { ...result, protectionIds: [...result.protectionIds] } };
    const gen = this.generation;
    if (result.depleted) this.depleted = true; // 先闸住重入，再发事件
    this.syncFlags();
    this.emitChanged();
    this.eventBus.emit('player:damaged', this.lastDamage);
    if (gen !== this.generation || !result.depleted) return result;
    if (this.tetherAllowed()) {
      await this.triggerDeathTether();
    } else {
      const cause: HealthDepletion = { ...damage, result };
      this.eventBus.emit('player:depleted', cause);
      if (gen === this.generation) await this.depletionHandler?.(cause);
    }
    return result;
  }

  /** 回血（不超过上限）。 */
  heal(amount: number): void {
    const amt = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    if (amt === 0) return;
    this.setHealth(this.currentHealth + amt);
  }

  /**
   * 编排层直接置数（离死之距原始值）。clamp 到 [0, maxHealth]、同步 flag、广播变更
   * （三把阳火即时反应）。**不触发死亡系绳**——系绳留给 `damage()` 的玩法扣血路径。
   * reset/set/inc/dec 四个 action 都经此落地。
   */
  setHealth(value: number): void {
    const v = Number.isFinite(value) ? value : this.currentHealth;
    this.currentHealth = this.clampCurrent(v);
    if (this.currentHealth > this.config.deathThreshold) this.depleted = false;
    this.syncFlags();
    this.emitChanged();
  }

  /**
   * 显式触发死亡系绳（濒死被拽回）。供编排层 `triggerDeathTether` action 用，
   * 替代旧的 `damagePlayer{9999}` 魔法数硬凑——意图即"该死那一拍、念气把人薅回"。
   * 重入由内部 `tethering` 守卫挡掉（守卫命中时返回已 resolve 的 Promise）。
   * 必须返回整段系绳流程的 Promise：动作批严格按序执行依赖 handler 返回真实异步，
   * 否则批内排在其后的音效/信号会在演出完成前提前执行（与 damage() 路径同约定）。
   */
  tether(): Promise<void> {
    if (!this.tetherAllowed()) {
      console.warn('triggerDeathTether: authored eligibility condition is not satisfied');
      return Promise.resolve();
    }
    return this.triggerDeathTether();
  }

  private async triggerDeathTether(): Promise<void> {
    if (this.tethering) return;
    const gen = this.generation;
    this.tethering = true;
    // 由剧情接管的濒死不是普通死亡态，不能被死亡输入闸锁住救场动作。
    this.depleted = false;

    // 不死：先把血压到 0（触底的那一拍），演出后拽回
    this.currentHealth = 0;
    this.syncFlags();
    this.emitChanged();

    // 外部接管口子：抑制 flag 为 true 时内容脚本已接手救场（如李天狗线），
    // 跳过阿秀信号与自动回血，HP 交由外部 healPlayer 恢复。键名见 config.tetherSuppressFlagKey。
    if (this.flagStore.get(this.config.tetherSuppressFlagKey) === true) {
      this.tethering = false;
      return;
    }

    try {
      const actions: ActionDef[] = [
        { type: 'playSignalCue', params: { id: this.config.tetherCueId } },
        {
          type: 'emitNarrativeSignal',
          params: { sourceType: 'system', sourceId: 'health', signal: 'death_tether' },
        },
      ];
      await this.actionExecutor.executeBatchAwait(actions);
    } catch (e) {
      console.warn('HealthSystem: death-tether actions failed', e);
    }

    if (gen !== this.generation) return;
    this.currentHealth = this.clampCurrent(Math.max(1, Math.min(this.maxHealth, this.config.restoreFloor)));
    this.depleted = false;
    this.syncFlags();
    this.emitChanged();
    this.tethering = false;
  }

  private syncFlags(): void {
    this.flagStore.set('player_health', this.currentHealth);
    this.flagStore.set('player_max_health', this.maxHealth);
  }

  private emitChanged(): void {
    this.eventBus.emit('player:healthChanged', {
      current: this.currentHealth,
      max: this.maxHealth,
    });
  }

  serialize(): object {
    return {
      currentHealth: this.currentHealth, maxHealth: this.maxHealth,
      baseMaxHealth: this.baseMaxHealth, depleted: this.depleted,
      bounds: [...this.bounds.values()].map((b) => ({ ...b })),
      activeProtections: [...this.activeProtections.values()].map((p) => ({ ...p })),
      sceneId: this.sceneId,
    };
  }

  deserialize(data: object): void {
    this.generation++;
    this.tethering = false;
    this.lastDamage = null;
    const d = (data ?? {}) as { currentHealth?: number; maxHealth?: number; baseMaxHealth?: number; depleted?: boolean; bounds?: HealthBounds[]; activeProtections?: TimedHealthProtection[]; sceneId?: string };
    this.sceneId = typeof d.sceneId === 'string' ? d.sceneId : '';
    this.baseMaxHealth = this.validMax(d.baseMaxHealth ?? d.maxHealth ?? this.config.maxHealth);
    this.activeProtections.clear();
    if (Array.isArray(d.activeProtections)) for (const p of d.activeProtections) {
      if (!p || typeof p.id !== 'string' || !p.id.trim() || !Number.isFinite(p.remainingSeconds) || p.remainingSeconds <= 0) continue;
      if (p.reduction !== undefined && (!Number.isFinite(p.reduction) || p.reduction < 0 || p.reduction > 1)) continue;
      if (p.maxHealthBonus !== undefined && (!Number.isFinite(p.maxHealthBonus) || p.maxHealthBonus < 0)) continue;
      if (p.kinds !== undefined && (!Array.isArray(p.kinds) || p.kinds.some((k) => k !== 'yin' && k !== 'fright'))) continue;
      if (p.threatIds !== undefined && (!Array.isArray(p.threatIds) || p.threatIds.some((id) => typeof id !== 'string'))) continue;
      this.activeProtections.set(p.id, { ...p });
    }
    this.maxHealth = this.baseMaxHealth + protectionHealthBonus(this.getProtections());
    this.bounds.clear();
    // 不经 setBounds 逐条广播：读档是一次原子恢复，不是重播教学。
    if (Array.isArray(d.bounds)) {
      let min = 0, max = Infinity;
      for (const b of d.bounds) {
        if (!b || typeof b.id !== 'string' || !b.id.trim() || this.bounds.has(b.id)) continue;
        if (b.scope !== undefined && b.scope !== 'scene' && b.scope !== 'persistent') continue;
        if (b.min === undefined && b.max === undefined) continue;
        if ([b.min, b.max].some((v) => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))) continue;
        const nextMin = Math.max(min, b.min ?? 0), nextMax = Math.min(max, b.max ?? Infinity);
        if (nextMin > nextMax) continue;
        min = nextMin; max = nextMax;
        this.bounds.set(b.id, { ...b, scope: b.scope ?? 'scene' });
      }
    }
    this.currentHealth = this.clampCurrent(Number.isFinite(d.currentHealth) ? d.currentHealth! : this.maxHealth);
    this.depleted = d.depleted === true && this.currentHealth <= this.config.deathThreshold;
    this.syncFlags();
    this.emitChanged();
  }

  snapshot(): object {
    return { ...this.serialize(), lastDamage: this.lastDamage, protections: this.getProtections().map((p) => ({ ...p })) };
  }

  destroy(): void {
    this.generation++;
    this.tethering = false;
    this.bounds.clear();
    this.activeProtections.clear();
    this.depletionHandler = null;
    this.protectionProvider = () => [];
    this.tetherAllowed = () => false;
  }
}
