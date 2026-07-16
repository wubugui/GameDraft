import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { ActionDef, IGameSystem, GameContext } from '../data/types';

export interface HealthConfig {
  /** 血量上限（默认满血起步） */
  maxHealth: number;
  /** 血量降到此值（含）即触发死亡系绳，玩家不真死 */
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
 * 主角**永不真死**：血量将归零那一刻被拦截——血拽回恢复底，同时触发阿秀冷信号
 * （香粉味+小调，来自他贪财捡的旧帕子包/空香粉盒）。机制即主题：那不是温情守护，
 * 是阿秀死时那口盲目的「不撒手」念气，只认物不认人、无意识、无倾向，只是不让他撒手。
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
  private maxHealth = DEFAULT_HEALTH_CONFIG.maxHealth;
  /** 系绳演出期间为 true：连续致死 damage 只拽一次，避免重入 */
  private tethering = false;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
  }

  /** 可选：用 game_config.health 覆盖默认配置（Game 在 init 前调用）。 */
  configure(partial: Partial<HealthConfig> | undefined | null): void {
    if (!partial) return;
    this.config = { ...this.config, ...partial };
  }

  init(_ctx: GameContext): void {
    this.maxHealth = this.config.maxHealth;
    this.currentHealth = this.maxHealth;
    this.syncFlags();
    this.emitChanged();
  }

  update(_dt: number): void {}

  /** 当前血量。 */
  getHealth(): number {
    return this.currentHealth;
  }

  getMaxHealth(): number {
    return this.maxHealth;
  }

  /**
   * 扣血。若一次扣血会使血量 ≤ deathThreshold，**不真死**——触发死亡系绳：
   * 血先触底、跑阿秀冷信号、再拽回恢复底，并发叙事信号 `death_tether`。
   */
  async damage(amount: number): Promise<void> {
    const amt = Math.max(0, amount);
    if (amt === 0) return;
    const next = this.currentHealth - amt;
    if (next <= this.config.deathThreshold) {
      await this.triggerDeathTether();
      return;
    }
    this.currentHealth = next;
    this.syncFlags();
    this.emitChanged();
  }

  /** 回血（不超过上限）。 */
  heal(amount: number): void {
    const amt = Math.max(0, amount);
    if (amt === 0) return;
    this.currentHealth = Math.min(this.maxHealth, this.currentHealth + amt);
    this.syncFlags();
    this.emitChanged();
  }

  /**
   * 编排层直接置数（离死之距原始值）。clamp 到 [0, maxHealth]、同步 flag、广播变更
   * （三把阳火即时反应）。**不触发死亡系绳**——系绳留给 `damage()` 的玩法扣血路径。
   * reset/set/inc/dec 四个 action 都经此落地。
   */
  setHealth(value: number): void {
    const v = Number.isFinite(value) ? value : this.currentHealth;
    this.currentHealth = Math.max(0, Math.min(this.maxHealth, v));
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
    return this.triggerDeathTether();
  }

  private async triggerDeathTether(): Promise<void> {
    if (this.tethering) return;
    this.tethering = true;

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

    this.currentHealth = Math.max(1, Math.min(this.maxHealth, this.config.restoreFloor));
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
    return { currentHealth: this.currentHealth, maxHealth: this.maxHealth };
  }

  deserialize(data: object): void {
    const d = data as { currentHealth?: number; maxHealth?: number };
    if (typeof d.maxHealth === 'number') this.maxHealth = d.maxHealth;
    if (typeof d.currentHealth === 'number') this.currentHealth = d.currentHealth;
    this.syncFlags();
    this.emitChanged();
  }

  destroy(): void {}
}
