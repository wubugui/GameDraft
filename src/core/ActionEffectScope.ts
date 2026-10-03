/** Temporary action effects belong to one execution, never to an action type or save. */
export type ActionEffectEnd = 'done' | 'released' | 'interrupted' | 'error';

export interface ActionEffect {
  /** Optional name within this scope, for replacement / early release. */
  key?: string;
  cleanup(reason: ActionEffectEnd): void;
}

export class ActionEffectScope {
  private readonly effects = new Set<ActionEffect>();
  private readonly named = new Map<string, ActionEffect>();
  private end: ActionEffectEnd | null = null;

  constructor(private readonly onClose?: () => void) {}

  get closed(): boolean { return this.end !== null; }

  /** Late async acquisitions are released immediately after their owner has ended. */
  add(effect: ActionEffect): () => void {
    if (this.end) {
      this.clean(effect, this.end);
      return () => {};
    }
    if (effect.key) this.release(effect.key);
    // Replacing an effect may synchronously end its owner during cleanup.
    if (this.end) {
      this.clean(effect, this.end);
      return () => {};
    }
    this.effects.add(effect);
    if (effect.key) this.named.set(effect.key, effect);
    return () => this.remove(effect, 'released');
  }

  release(key: string): void {
    const effect = this.named.get(key);
    if (effect) this.remove(effect, 'released');
  }

  close(reason: ActionEffectEnd = 'done'): void {
    if (this.end) return;
    this.end = reason;
    for (const effect of [...this.effects].reverse()) this.remove(effect, reason);
    this.onClose?.();
  }

  private remove(effect: ActionEffect, reason: ActionEffectEnd): void {
    if (!this.effects.delete(effect)) return;
    if (effect.key && this.named.get(effect.key) === effect) this.named.delete(effect.key);
    this.clean(effect, reason);
  }

  private clean(effect: ActionEffect, reason: ActionEffectEnd): void {
    try { effect.cleanup(reason); }
    catch (error) { console.warn('ActionEffectScope: cleanup failed', effect.key, error); }
  }
}
