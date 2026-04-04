import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { RuleDef, RuleFragmentDef, IGameSystem, GameContext, IRulesDataProvider } from '../data/types';
import type { AssetManager } from '../core/AssetManager';

export class RulesManager implements IGameSystem, IRulesDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private ruleDefs: Map<string, RuleDef> = new Map();
  private fragmentDefs: Map<string, RuleFragmentDef> = new Map();
  private categoryNames: Record<string, string> = {};
  private verifiedLabels: Record<string, string> = {};

  private acquiredRules: Set<string> = new Set();
  private acquiredFragments: Set<string> = new Set();

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
  }
  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{
        rules: RuleDef[];
        fragments: RuleFragmentDef[];
        categories?: Record<string, string>;
        verifiedLabels?: Record<string, string>;
      }>('/assets/data/rules.json');
      for (const r of data.rules) {
        this.ruleDefs.set(r.id, r);
      }
      for (const f of data.fragments) {
        this.fragmentDefs.set(f.id, f);
      }
      if (data.categories) this.categoryNames = data.categories;
      if (data.verifiedLabels) this.verifiedLabels = data.verifiedLabels;
    } catch {
      console.warn('RulesManager: rules.json not found, running without rule definitions');
    }
  }

  giveRule(ruleId: string): void {
    if (this.acquiredRules.has(ruleId)) return;

    this.acquiredRules.add(ruleId);
    this.flagStore.set(`rule_${ruleId}_acquired`, true);

    const def = this.ruleDefs.get(ruleId);
    this.eventBus.emit('rule:acquired', { ruleId, name: def?.name ?? ruleId });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'ruleAcquired', { name: def?.name ?? ruleId }),
      type: 'rule',
    });
  }

  giveFragment(fragmentId: string): void {
    if (this.acquiredFragments.has(fragmentId)) return;

    this.acquiredFragments.add(fragmentId);
    const fragDef = this.fragmentDefs.get(fragmentId);
    if (!fragDef) {
      console.warn(`RulesManager: unknown fragment "${fragmentId}"`);
      return;
    }

    this.flagStore.set(`fragment_${fragmentId}_acquired`, true);
    this.syncRuleDiscoveryFlags(fragDef.ruleId);
    this.eventBus.emit('rule:fragment', { fragmentId, ruleId: fragDef.ruleId });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'fragmentAcquired'),
      type: 'rule',
    });

    this.tryAutoSynthesize(fragDef.ruleId);
  }

  private syncRuleDiscoveryFlags(ruleId: string): void {
    const ruleDef = this.ruleDefs.get(ruleId);
    const total = ruleDef?.fragmentCount ?? 0;
    let collected = 0;
    this.fragmentDefs.forEach((frag) => {
      if (frag.ruleId === ruleId && this.acquiredFragments.has(frag.id)) collected++;
    });
    this.flagStore.set(`rule_${ruleId}_discovered`, true);
    this.flagStore.set(`rule_${ruleId}_fragments_collected`, collected);
    this.flagStore.set(`rule_${ruleId}_fragments_total`, total);
  }

  private tryAutoSynthesize(ruleId: string): void {
    const ruleDef = this.ruleDefs.get(ruleId);
    if (!ruleDef || !ruleDef.fragmentCount) return;
    if (this.acquiredRules.has(ruleId)) return;

    let collected = 0;
    this.fragmentDefs.forEach((frag) => {
      if (frag.ruleId === ruleId && this.acquiredFragments.has(frag.id)) {
        collected++;
      }
    });

    if (collected >= ruleDef.fragmentCount) {
      this.giveRule(ruleId);
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'fragmentSynthesized', { name: ruleDef.name }),
        type: 'rule',
      });
    }
  }

  hasRule(ruleId: string): boolean {
    return this.acquiredRules.has(ruleId);
  }

  hasFragment(fragmentId: string): boolean {
    return this.acquiredFragments.has(fragmentId);
  }

  getRuleDef(ruleId: string): RuleDef | undefined {
    return this.ruleDefs.get(ruleId);
  }

  getCategoryName(key: string): string {
    return this.categoryNames[key] ?? key;
  }

  getVerifiedLabel(key: string): string {
    return this.verifiedLabels[key] ?? key;
  }

  isDiscovered(ruleId: string): boolean {
    if (this.acquiredRules.has(ruleId)) return false;
    let hasFragment = false;
    this.acquiredFragments.forEach((fragId) => {
      const frag = this.fragmentDefs.get(fragId);
      if (frag && frag.ruleId === ruleId) hasFragment = true;
    });
    return hasFragment;
  }

  getDiscoveredRules(): { def: RuleDef; collected: number; total: number }[] {
    const result: { def: RuleDef; collected: number; total: number }[] = [];
    this.ruleDefs.forEach((def) => {
      if (this.acquiredRules.has(def.id)) return;
      const progress = this.getFragmentProgress(def.id);
      if (progress.collected > 0) {
        result.push({ def, collected: progress.collected, total: progress.total });
      }
    });
    return result;
  }

  getAcquiredRules(): { def: RuleDef; acquired: boolean }[] {
    const result: { def: RuleDef; acquired: boolean }[] = [];
    this.ruleDefs.forEach((def) => {
      if (this.acquiredRules.has(def.id)) {
        result.push({ def, acquired: true });
      }
    });
    return result;
  }

  getFragmentProgress(ruleId: string): { collected: number; total: number; fragments: RuleFragmentDef[] } {
    const ruleDef = this.ruleDefs.get(ruleId);
    const total = ruleDef?.fragmentCount ?? 0;
    const fragments: RuleFragmentDef[] = [];
    let collected = 0;

    this.fragmentDefs.forEach((frag) => {
      if (frag.ruleId === ruleId) {
        fragments.push(frag);
        if (this.acquiredFragments.has(frag.id)) collected++;
      }
    });

    return { collected, total, fragments };
  }

  getPendingFragments(): RuleFragmentDef[] {
    const result: RuleFragmentDef[] = [];
    this.acquiredFragments.forEach((fragId) => {
      const frag = this.fragmentDefs.get(fragId);
      if (frag && !this.acquiredRules.has(frag.ruleId)) {
        result.push(frag);
      }
    });
    return result;
  }

  serialize(): object {
    return {
      acquiredRules: Array.from(this.acquiredRules),
      acquiredFragments: Array.from(this.acquiredFragments),
    };
  }

  deserialize(data: { acquiredRules: string[]; acquiredFragments: string[] }): void {
    this.acquiredRules = new Set(data.acquiredRules ?? []);
    this.acquiredFragments = new Set(data.acquiredFragments ?? []);
    this.acquiredRules.forEach((id) => {
      this.flagStore.set(`rule_${id}_acquired`, true);
    });
    this.acquiredFragments.forEach((id) => {
      this.flagStore.set(`fragment_${id}_acquired`, true);
    });
    const ruleIdsWithFragments = new Set<string>();
    this.acquiredFragments.forEach((fragId) => {
      const frag = this.fragmentDefs.get(fragId);
      if (frag) ruleIdsWithFragments.add(frag.ruleId);
    });
    ruleIdsWithFragments.forEach((ruleId) => this.syncRuleDiscoveryFlags(ruleId));
  }

  destroy(): void {
    this.acquiredRules.clear();
    this.acquiredFragments.clear();
    this.ruleDefs.clear();
    this.fragmentDefs.clear();
  }
}
