import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type {
  RuleDef,
  RuleLayerDef,
  RuleFragmentDef,
  RuleLayerKey,
  IGameSystem,
  GameContext,
  IRulesDataProvider,
} from '../data/types';
import type { AssetManager } from '../core/AssetManager';

const LAYER_ORDER: RuleLayerKey[] = ['xiang', 'li', 'shu'];

type RuleDefRaw = Record<string, unknown>;
type FragmentRaw = Record<string, unknown>;

function normalizeRuleDef(raw: RuleDefRaw): RuleDef | null {
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  const layersUnknown = raw.layers;
  if (
    layersUnknown &&
    typeof layersUnknown === 'object' &&
    layersUnknown !== null &&
    Object.keys(layersUnknown as object).length > 0
  ) {
    const def = raw as unknown as RuleDef;
    // 若旧数据有 rule 级 verified 但各层均未设 verified，则下推到所有已定义层
    const ruleVerified = (raw.verified as RuleDef['verified']) ?? undefined;
    if (ruleVerified) {
      const newLayers: Partial<Record<RuleLayerKey, RuleLayerDef>> = {};
      for (const lk of ['xiang', 'li', 'shu'] as RuleLayerKey[]) {
        const l = def.layers[lk];
        if (l) newLayers[lk] = l.verified ? l : { ...l, verified: ruleVerified };
      }
      return { ...def, layers: newLayers };
    }
    return def;
  }
  const legacyVerified = (raw.verified as RuleDef['verified']) ?? 'unverified';
  return {
    id,
    name: String(raw.name ?? id),
    incompleteName:
      raw.incompleteName !== undefined && raw.incompleteName !== null
        ? String(raw.incompleteName)
        : undefined,
    category: (raw.category as RuleDef['category']) ?? 'ward',
    layers: {
      xiang: {
        text: String(raw.description ?? raw.name ?? ''),
        verified: legacyVerified,
      },
    },
  };
}

function normalizeFragmentDef(raw: FragmentRaw): RuleFragmentDef | null {
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  const ruleId = String(raw.ruleId ?? '').trim();
  if (!ruleId) return null;
  const layerRaw = raw.layer ?? 'xiang';
  const layer: RuleLayerKey = ['xiang', 'li', 'shu'].includes(String(layerRaw))
    ? (String(layerRaw) as RuleLayerKey)
    : 'xiang';
  return {
    id,
    text: String(raw.text ?? ''),
    ruleId,
    layer,
    source: String(raw.source ?? ''),
  };
}

export class RulesManager implements IGameSystem, IRulesDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private ruleDefs: Map<string, RuleDef> = new Map();
  private fragmentDefs: Map<string, RuleFragmentDef> = new Map();
  private categoryNames: Record<string, string> = {};
  private verifiedLabels: Record<string, string> = {};

  private acquiredFragments: Set<string> = new Set();
  private grantedLayers: Map<string, Set<RuleLayerKey>> = new Map();

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = {
    get: (_c, k) => k,
  };
  private assetManager!: AssetManager;

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
  }
  update(_dt: number): void {}

  private static definedLayers(def: RuleDef): RuleLayerKey[] {
    return LAYER_ORDER.filter((k) => def.layers[k] != null);
  }

  private layerDoneFlagKey(ruleId: string, layer: RuleLayerKey): string {
    return `rule_${ruleId}_${layer}_done`;
  }

  private snapshotLayerDone(ruleId: string): Partial<Record<RuleLayerKey, boolean>> {
    const out: Partial<Record<RuleLayerKey, boolean>> = {};
    const def = this.ruleDefs.get(ruleId);
    if (!def) return out;
    for (const L of RulesManager.definedLayers(def)) {
      out[L] = this.hasLayerImpl(ruleId, L);
    }
    return out;
  }

  /** 层是否解锁：有碎片则须集齐；无碎片则仅 grant / giveRule 可解锁 */
  private hasLayerImpl(ruleId: string, layer: RuleLayerKey): boolean {
    const def = this.ruleDefs.get(ruleId);
    if (!def?.layers?.[layer]) return false;
    if (this.grantedLayers.get(ruleId)?.has(layer)) return true;
    const frags: RuleFragmentDef[] = [];
    this.fragmentDefs.forEach((f) => {
      if (f.ruleId === ruleId && f.layer === layer) frags.push(f);
    });
    if (frags.length === 0) return false;
    return frags.every((f) => this.acquiredFragments.has(f.id));
  }

  private hasRuleInternal(ruleId: string): boolean {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return false;
    const keys = RulesManager.definedLayers(def);
    if (keys.length === 0) return false;
    return keys.every((k) => this.hasLayerImpl(ruleId, k));
  }

  async loadDefs(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{
        rules: RuleDefRaw[];
        fragments: FragmentRaw[];
        categories?: Record<string, string>;
        verifiedLabels?: Record<string, string>;
      }>('/assets/data/rules.json');
      this.ruleDefs.clear();
      this.fragmentDefs.clear();
      for (const r of data.rules ?? []) {
        const norm = normalizeRuleDef(r);
        if (norm) this.ruleDefs.set(norm.id, norm);
      }
      for (const f of data.fragments ?? []) {
        const norm = normalizeFragmentDef(f);
        if (norm) this.fragmentDefs.set(norm.id, norm);
      }
      if (data.categories) this.categoryNames = data.categories;
      if (data.verifiedLabels) this.verifiedLabels = data.verifiedLabels;
    } catch {
      console.warn('RulesManager: rules.json not found, running without rule definitions');
    }
  }

  private emitRuleAcquired(ruleId: string): void {
    const def = this.ruleDefs.get(ruleId);
    this.eventBus.emit('rule:acquired', { ruleId, name: def?.name ?? ruleId });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'ruleAcquired', { name: def?.name ?? ruleId }),
      type: 'rule',
    });
  }

  giveRule(ruleId: string): void {
    if (this.hasRuleInternal(ruleId)) return;
    const def = this.ruleDefs.get(ruleId);
    if (!def) return;
    const keys = RulesManager.definedLayers(def);
    if (keys.length === 0) return;
    const set = this.grantedLayers.get(ruleId) ?? new Set<RuleLayerKey>();
    for (const L of keys) set.add(L);
    this.grantedLayers.set(ruleId, set);
    this.syncRuleFlags(ruleId);
    this.emitRuleAcquired(ruleId);
  }

  grantLayer(ruleId: string, layer: RuleLayerKey): void {
    const def = this.ruleDefs.get(ruleId);
    if (!def?.layers?.[layer]) return;
    if (this.hasLayerImpl(ruleId, layer)) return;
    const beforeFull = this.hasRuleInternal(ruleId);
    const set = this.grantedLayers.get(ruleId) ?? new Set<RuleLayerKey>();
    set.add(layer);
    this.grantedLayers.set(ruleId, set);
    this.syncRuleFlags(ruleId);
    this.eventBus.emit('rule:layer', { ruleId, layer, source: 'grant' as const });
    if (!beforeFull && this.hasRuleInternal(ruleId)) {
      this.emitRuleAcquired(ruleId);
    }
  }

  giveFragment(fragmentId: string): void {
    if (this.acquiredFragments.has(fragmentId)) return;

    const fragDef = this.fragmentDefs.get(fragmentId);
    if (!fragDef) {
      console.warn(`RulesManager: unknown fragment "${fragmentId}"`);
      return;
    }

    const ruleId = fragDef.ruleId;
    const beforeRuleFull = this.hasRuleInternal(ruleId);
    const beforeLayers = this.snapshotLayerDone(ruleId);

    this.acquiredFragments.add(fragmentId);
    this.flagStore.set(`fragment_${fragmentId}_acquired`, true);
    this.syncRuleFlags(ruleId);

    const afterLayers = this.snapshotLayerDone(ruleId);
    for (const L of LAYER_ORDER) {
      if (afterLayers[L] === true && beforeLayers[L] !== true) {
        this.eventBus.emit('rule:layer', { ruleId, layer: L, source: 'fragment' as const });
      }
    }

    this.eventBus.emit('rule:fragment', { fragmentId, ruleId });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'fragmentAcquired'),
      type: 'rule',
    });

    this.tryAutoSynthesize(ruleId, beforeRuleFull);
  }

  private syncRuleFlags(ruleId: string): void {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return;

    const frags: RuleFragmentDef[] = [];
    this.fragmentDefs.forEach((f) => {
      if (f.ruleId === ruleId) frags.push(f);
    });
    const collected = frags.filter((f) => this.acquiredFragments.has(f.id)).length;
    const total = frags.length;
    this.flagStore.set(`rule_${ruleId}_fragments_collected`, collected);
    this.flagStore.set(`rule_${ruleId}_fragments_total`, total);

    for (const layer of RulesManager.definedLayers(def)) {
      const done = this.hasLayerImpl(ruleId, layer);
      this.flagStore.set(this.layerDoneFlagKey(ruleId, layer), done);
    }

    const full = this.hasRuleInternal(ruleId);
    this.flagStore.set(`rule_${ruleId}_acquired`, full);

    const anyProg =
      collected > 0 || (this.grantedLayers.get(ruleId)?.size ?? 0) > 0;
    if (anyProg && !full) {
      this.flagStore.set(`rule_${ruleId}_discovered`, true);
    }
  }

  private resyncAllRuleFlags(): void {
    this.fragmentDefs.forEach((f) => {
      if (this.acquiredFragments.has(f.id)) {
        this.flagStore.set(`fragment_${f.id}_acquired`, true);
      }
    });
    this.ruleDefs.forEach((_def, ruleId) => {
      this.syncRuleFlags(ruleId);
    });
  }

  private tryAutoSynthesize(ruleId: string, beforeRuleFull: boolean): void {
    const prog = this.getFragmentProgress(ruleId);
    if (prog.total === 0) return;
    if (prog.collected < prog.total) return;

    const ruleDef = this.ruleDefs.get(ruleId);
    if (!ruleDef) return;

    if (!this.hasRuleInternal(ruleId)) {
      this.giveRule(ruleId);
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'fragmentSynthesized', { name: ruleDef.name }),
        type: 'rule',
      });
      return;
    }

    if (!beforeRuleFull) {
      this.emitRuleAcquired(ruleId);
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'fragmentSynthesized', { name: ruleDef.name }),
        type: 'rule',
      });
    }
  }

  hasRule(ruleId: string): boolean {
    return this.hasRuleInternal(ruleId);
  }

  hasLayer(ruleId: string, layer: RuleLayerKey): boolean {
    return this.hasLayerImpl(ruleId, layer);
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
    if (this.hasRuleInternal(ruleId)) return false;
    let fragHit = false;
    this.acquiredFragments.forEach((fragId) => {
      const frag = this.fragmentDefs.get(fragId);
      if (frag && frag.ruleId === ruleId) fragHit = true;
    });
    if (fragHit) return true;
    return (this.grantedLayers.get(ruleId)?.size ?? 0) > 0;
  }

  getDiscoveredRules(): { def: RuleDef; collected: number; total: number }[] {
    const result: { def: RuleDef; collected: number; total: number }[] = [];
    this.ruleDefs.forEach((def) => {
      if (this.hasRuleInternal(def.id)) return;
      if (!this.isDiscovered(def.id)) return;
      const progress = this.getFragmentProgress(def.id);
      result.push({ def, collected: progress.collected, total: progress.total });
    });
    return result;
  }

  getAcquiredRules(): { def: RuleDef; acquired: boolean }[] {
    const result: { def: RuleDef; acquired: boolean }[] = [];
    this.ruleDefs.forEach((def) => {
      if (this.hasRuleInternal(def.id)) {
        result.push({ def, acquired: true });
      }
    });
    return result;
  }

  getFragmentProgress(ruleId: string): { collected: number; total: number; fragments: RuleFragmentDef[] } {
    const fragments: RuleFragmentDef[] = [];
    let collected = 0;
    this.fragmentDefs.forEach((frag) => {
      if (frag.ruleId === ruleId) {
        fragments.push(frag);
        if (this.acquiredFragments.has(frag.id)) collected++;
      }
    });
    return { collected, total: fragments.length, fragments };
  }

  getRuleDepth(ruleId: string): { unlocked: number; total: number } {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return { unlocked: 0, total: 0 };
    const keys = RulesManager.definedLayers(def);
    let u = 0;
    for (const k of keys) {
      if (this.hasLayerImpl(ruleId, k)) u++;
    }
    return { unlocked: u, total: keys.length };
  }

  getUnlockedLayerTexts(ruleId: string): Partial<Record<RuleLayerKey, string>> {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return {};
    const out: Partial<Record<RuleLayerKey, string>> = {};
    for (const L of RulesManager.definedLayers(def)) {
      if (this.hasLayerImpl(ruleId, L)) {
        const t = def.layers[L]?.text;
        if (t) out[L] = t;
      }
    }
    return out;
  }

  getLayerFragmentProgress(
    ruleId: string,
  ): Partial<Record<RuleLayerKey, { collected: number; total: number; fragments: RuleFragmentDef[] }>> {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return {};
    const out: Partial<Record<RuleLayerKey, { collected: number; total: number; fragments: RuleFragmentDef[] }>> =
      {};
    for (const L of RulesManager.definedLayers(def)) {
      const fragments: RuleFragmentDef[] = [];
      this.fragmentDefs.forEach((f) => {
        if (f.ruleId === ruleId && f.layer === L) fragments.push(f);
      });
      let collected = 0;
      for (const f of fragments) {
        if (this.acquiredFragments.has(f.id)) collected++;
      }
      out[L] = { collected, total: fragments.length, fragments };
    }
    return out;
  }

  getPendingFragments(): RuleFragmentDef[] {
    const result: RuleFragmentDef[] = [];
    this.acquiredFragments.forEach((fragId) => {
      const frag = this.fragmentDefs.get(fragId);
      if (frag && !this.hasRuleInternal(frag.ruleId)) {
        result.push(frag);
      }
    });
    return result;
  }

  serialize(): object {
    const granted: Record<string, RuleLayerKey[]> = {};
    this.grantedLayers.forEach((set, rid) => {
      if (set.size > 0) granted[rid] = LAYER_ORDER.filter((k) => set.has(k));
    });
    return {
      acquiredFragments: Array.from(this.acquiredFragments),
      grantedLayers: granted,
    };
  }

  deserialize(data: {
    acquiredFragments?: string[];
    grantedLayers?: Record<string, RuleLayerKey[]>;
    acquiredRules?: string[];
  }): void {
    this.acquiredFragments = new Set(data.acquiredFragments ?? []);
    this.grantedLayers = new Map(
      Object.entries(data.grantedLayers ?? {}).map(([rid, ls]) => [
        rid,
        new Set((ls ?? []).filter((x): x is RuleLayerKey => ['xiang', 'li', 'shu'].includes(x))),
      ]),
    );

    for (const rid of data.acquiredRules ?? []) {
      const def = this.ruleDefs.get(rid);
      if (!def) continue;
      const set = this.grantedLayers.get(rid) ?? new Set<RuleLayerKey>();
      for (const L of RulesManager.definedLayers(def)) {
        set.add(L);
      }
      this.grantedLayers.set(rid, set);
    }

    this.resyncAllRuleFlags();
  }

  destroy(): void {
    this.acquiredFragments.clear();
    this.grantedLayers.clear();
    this.ruleDefs.clear();
    this.fragmentDefs.clear();
  }
}
