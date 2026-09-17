import type { GameContext, IGameSystem } from '../data/types';
import type { FireProtectionConfig } from '../data/survival';

export interface ProtectionFireSource {
  id: string;
  active: boolean;
  burning: boolean;
  x: number;
  y: number;
  radius: number;
}
export interface FireProtectionDeps {
  canUpdate(): boolean;
  playerPosition(): { x: number; y: number };
  sources(): ProtectionFireSource[];
  changed?(protectedByFire: boolean): void;
}

/** 有效火源的稳定读数；只有真实点燃过的来源才有熄灭缓冲。 */
export class FireProtectionSystem implements IGameSystem {
  private deps: FireProtectionDeps | null = null;
  private grace = 0.15;
  private remaining = new Map<string, number>();
  private protectedSources: string[] = [];
  configure(config?: FireProtectionConfig): void {
    this.grace = Number.isFinite(config?.lossGraceSeconds) ? Math.max(0, Math.min(10, config!.lossGraceSeconds!)) : 0.15;
  }
  connect(deps: FireProtectionDeps): void { this.deps = deps; }
  init(_ctx: GameContext): void { this.clear(); }
  get protected(): boolean { return this.protectedSources.length > 0; }
  update(dt: number): void {
    const d = this.deps;
    if (!d || !d.canUpdate() || !Number.isFinite(dt) || dt <= 0) return;
    this.sample(dt);
  }
  /** 场景就绪时先重建派生读数，避免首帧用上一场景的火光判定。 */
  refresh(): void { this.sample(0); this.deps?.changed?.(this.protected); }
  private sample(dt: number): void {
    const d = this.deps;
    if (!d) return;
    const before = this.protected;
    const p = d.playerPosition();
    const next = new Map<string, number>();
    const sources: string[] = [];
    for (const s of d.sources()) {
      if (!s.id || next.has(s.id) || !s.active || !Number.isFinite(s.radius) || s.radius < 0) continue;
      if (![p.x, p.y, s.x, s.y].every(Number.isFinite)) continue;
      // 离开范围就不再受保护；不把半径外的明火记作身上的余温。
      if (Math.hypot(p.x - s.x, p.y - s.y) > s.radius) continue;
      const remaining = s.burning ? this.grace : Math.max(0, (this.remaining.get(s.id) ?? 0) - dt);
      next.set(s.id, remaining);
      if (s.burning || remaining > 0) sources.push(s.id);
    }
    this.remaining = next;
    this.protectedSources = sources;
    if (before !== this.protected) d.changed?.(this.protected);
  }
  clear(): void {
    this.remaining.clear(); this.protectedSources = [];
    this.deps?.changed?.(false);
  }
  serialize(): object { return {}; }
  deserialize(_data: object): void { this.clear(); }
  snapshot(): object { return { protected: this.protected, sources: [...this.protectedSources] }; }
  destroy(): void { this.deps = null; this.clear(); }
}
