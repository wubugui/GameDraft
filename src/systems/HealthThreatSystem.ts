import type { GameContext, IGameSystem } from '../data/types';
import type { HealthDamage, HealthThreatDef } from '../data/survival';

export interface HealthThreatSource {
  def: HealthThreatDef;
  position(): { x: number; y: number } | null;
  active(): boolean;
}
export type HealthThreatState = 'outside' | 'repelled' | 'boundary' | 'attacking';
export interface HealthThreatDeps {
  canUpdate(): boolean;
  isPresentation?(): boolean;
  isNight(): boolean;
  playerPosition(): { x: number; y: number };
  hasFireProtection(): boolean;
  damage(value: HealthDamage): void;
  /** 三把火显隐请求是派生表现，不写叙事 flag。 */
  setYinSources(ids: readonly string[]): void;
  signal(id: string, sourceId: string): void;
  playSound?(id: string, position: { x: number; y: number }, volume: number): void;
}

/** 距离伤害与侵入/退避事件。没有火不构成伤害源；只有附近激活的实体才结算。 */
export class HealthThreatSystem implements IGameSystem {
  private sources: HealthThreatSource[] = [];
  private states = new Map<string, HealthThreatState>();
  private generation = 0;
  private deps: HealthThreatDeps | null = null;
  private yinSources: string[] = [];
  private soundClocks = new Map<string, number>();
  private playerPrevious: { x: number; y: number } | null = null;
  private heading = { x: 1, y: 0 };
  private readings: { id: string; state: HealthThreatState; distance: number | null; attackPerSecond: number }[] = [];

  connect(deps: HealthThreatDeps): void { this.deps = deps; }
  init(_ctx: GameContext): void { this.clear(); }
  setSources(sources: HealthThreatSource[]): void {
    this.clear();
    const ids = new Set<string>();
    this.sources = sources.filter(({ def }) => {
      if (!validThreat(def) || ids.has(def.id)) { console.warn('HealthThreatSystem: invalid or duplicate threat', def.id); return false; }
      ids.add(def.id); return true;
    });
  }

  update(dt: number): void {
    const d = this.deps;
    if (!d || !d.canUpdate() || !Number.isFinite(dt) || dt <= 0) return;
    const gen = this.generation;
    const player = d.playerPosition();
    const dx = player.x - (this.playerPrevious?.x ?? player.x), dy = player.y - (this.playerPrevious?.y ?? player.y);
    const moved = Math.hypot(dx, dy);
    if (moved > .01) this.heading = { x: dx / moved, y: dy / moved };
    this.playerPrevious = { ...player };
    const night = d.isNight(), protectedByFire = d.hasFireProtection();
    const yinSources: string[] = [];
    this.readings = [];
    for (const source of this.sources) {
      if (gen !== this.generation || !d.canUpdate()) break;
      const def = source.def;
      const position = source.position();
      const distance = position ? Math.hypot(player.x - position.x, player.y - position.y) : Infinity;
      if (d.isPresentation?.() && def.duringPresentation !== true) {
        const state = this.states.get(def.id) ?? 'outside';
        if (def.kind === 'yin' && (state === 'attacking' || state === 'boundary')) yinSources.push(def.id);
        this.readings.push({ id: def.id, state, distance: Number.isFinite(distance) ? distance : null, attackPerSecond: 0 });
        continue;
      }
      const enabled = source.active() && (def.nightOnly === false || night);
      let state: HealthThreatState = 'outside';
      let attack = 0;
      if (enabled && distance <= def.boundaryRadius) {
        if (protectedByFire && def.fireResponse !== 'ignore') {
          state = 'repelled';
        } else {
          state = distance <= def.damageRadius ? 'attacking' : 'boundary';
          if (def.kind === 'yin') yinSources.push(def.id);
          if (state === 'attacking') {
            attack = def.nearRadius !== undefined && distance <= def.nearRadius
              ? def.nearAttackPerSecond ?? def.attackPerSecond : def.attackPerSecond;
            if (attack > 0) d.damage({ amount: attack * dt, kind: def.kind, sourceId: def.id, deathNoteId: def.deathNoteId });
          }
        }
      }
      if (gen !== this.generation) return;
      const previous = this.states.get(def.id) ?? 'outside';
      this.states.set(def.id, state);
      this.readings.push({ id: def.id, state, distance: Number.isFinite(distance) ? distance : null, attackPerSecond: attack });
      const wasInside = previous === 'attacking' || previous === 'boundary';
      const inside = state === 'attacking' || state === 'boundary';
      if (!inside) this.soundClocks.delete(def.id);
      else if (def.presenceSfx && d.canUpdate()) {
        const remaining = Math.max(0, (this.soundClocks.get(def.id) ?? 0) - dt);
        this.soundClocks.set(def.id, remaining);
        if (remaining === 0 && (!def.soundOnlyMoving || moved > .01)) {
          const behind = def.soundBehindPlayer;
          const at = behind === undefined ? position! : { x: player.x - this.heading.x * behind, y: player.y - this.heading.y * behind };
          d.playSound?.(def.presenceSfx, at, def.soundVolume ?? 1);
          this.soundClocks.set(def.id, def.soundInterval ?? .7);
        }
      }
      const signal = inside && !wasInside ? def.enteredSignal
        : wasInside && state === 'repelled' ? def.repelledSignal
          : wasInside && state === 'outside' ? def.leftSignal : undefined;
      if (signal && d.canUpdate()) d.signal(signal, def.id);
    }
    if (gen !== this.generation) return;
    if (yinSources.join('\0') !== this.yinSources.join('\0')) {
      this.yinSources = yinSources;
      d.setYinSources(yinSources);
    }
  }

  clear(): void {
    this.generation++;
    this.sources = []; this.states.clear(); this.readings = []; this.yinSources = [];
    this.soundClocks.clear(); this.playerPrevious = null; this.heading = { x: 1, y: 0 };
    this.deps?.setYinSources([]);
  }
  serialize(): object { return {}; }
  deserialize(_data: object): void { this.clear(); }
  snapshot(): object { return { yinSources: [...this.yinSources], sources: this.readings.map((r) => ({ ...r })) }; }
  destroy(): void { this.deps = null; this.clear(); }
}

/** 内容校验同样约束这些关系，运行时仍拒绝坏数而非产生 NaN/负伤害。 */
export function validThreat(def: HealthThreatDef): boolean {
  if (typeof def?.id !== 'string' || !def.id.trim() || (def.kind !== 'yin' && def.kind !== 'fright')) return false;
  if (![def.boundaryRadius, def.damageRadius, def.attackPerSecond].every((v) => Number.isFinite(v) && v >= 0)) return false;
  if (def.boundaryRadius <= 0 || def.damageRadius > def.boundaryRadius) return false;
  if (def.nearRadius !== undefined && (!Number.isFinite(def.nearRadius) || def.nearRadius < 0 || def.nearRadius > def.damageRadius)) return false;
  if (def.nearAttackPerSecond !== undefined && (!Number.isFinite(def.nearAttackPerSecond) || def.nearAttackPerSecond < 0 || def.nearRadius === undefined)) return false;
  if (def.fireResponse !== undefined && def.fireResponse !== 'repelled' && def.fireResponse !== 'ignore') return false;
  if ([def.nightOnly, def.affectsWhenHidden, def.duringPresentation].some((v) => v !== undefined && typeof v !== 'boolean')) return false;
  if (def.presenceSfx !== undefined && typeof def.presenceSfx !== 'string') return false;
  if (def.soundOnlyMoving !== undefined && typeof def.soundOnlyMoving !== 'boolean') return false;
  if (def.soundInterval !== undefined && (!Number.isFinite(def.soundInterval) || def.soundInterval < .1)) return false;
  if (def.soundBehindPlayer !== undefined && (!Number.isFinite(def.soundBehindPlayer) || def.soundBehindPlayer < 0)) return false;
  if (def.soundVolume !== undefined && (!Number.isFinite(def.soundVolume) || def.soundVolume < 0 || def.soundVolume > 1)) return false;
  return true;
}
