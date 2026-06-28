import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { IGameSystem, GameContext } from '../data/types';

/**
 * 气味系统（见《系统设计/气味系统设计文档》）。和三把火 / 离死之距（HealthSystem）同构：
 * 系统 own 当前主导气味（scent id + 强度 0–100），由编排层 action（setSmell / clearSmell）驱动，
 * 状态进 FlagStore（`current_smell` / `smell_intensity`），经 EventBus（`player:smellChanged`）
 * 广播给 HUD 的"气味烟"渲染。
 *
 * 设计语义：气味 = 关二狗对"气"世界的粗感知；香粉味是其中一个稀有冷读数（仍守冷框架，只在濒死投放）。
 * 本系统只管"当前什么味、多强"，**具体怎么画由 HUD 决定**（未知 scent id 不渲染）。
 *
 * §1 合规：状态进 FlagStore，只经 EventBus 通信，不持有其它系统引用。
 */
export class SmellSystem implements IGameSystem {
  private readonly eventBus: EventBus;
  private readonly flagStore: FlagStore;

  /** 当前主导气味 id（空串 = 无味）。具体气味词库（颜色/飘法）在 HUD。 */
  private scent: string = '';
  /** 强度 0–100。 */
  private intensity: number = 0;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  init(_ctx: GameContext): void {
    this.scent = '';
    this.intensity = 0;
    this.syncFlags();
    this.emitChanged();
  }

  update(_dt: number): void {}

  /** 设置当前主导气味：scent id + 强度 0–100（intensity 省略默认 60）。空 scent 视为清空。 */
  setSmell(scent: string, intensity?: number): void {
    this.scent = String(scent ?? '');
    if (!this.scent) {
      this.intensity = 0;
    } else {
      const n = Number(intensity);
      this.intensity = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 60;
    }
    this.syncFlags();
    this.emitChanged();
  }

  /** 清空气味（无味）。 */
  clearSmell(): void {
    this.scent = '';
    this.intensity = 0;
    this.syncFlags();
    this.emitChanged();
  }

  getScent(): string {
    return this.scent;
  }

  getIntensity(): number {
    return this.intensity;
  }

  private syncFlags(): void {
    this.flagStore.set('current_smell', this.scent);
    this.flagStore.set('smell_intensity', this.intensity);
  }

  private emitChanged(): void {
    this.eventBus.emit('player:smellChanged', { scent: this.scent, intensity: this.intensity });
  }

  serialize(): object {
    return { scent: this.scent, intensity: this.intensity };
  }

  deserialize(data: object): void {
    const d = data as { scent?: string; intensity?: number };
    if (typeof d.scent === 'string') this.scent = d.scent;
    if (typeof d.intensity === 'number') this.intensity = d.intensity;
    this.syncFlags();
    this.emitChanged();
  }

  destroy(): void {}
}
