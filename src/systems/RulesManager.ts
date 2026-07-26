import type { EventBus } from '../core/EventBus';
import type {
  RuleDef,
  RuleLayerDef,
  RuleLayerKey,
  RuleVerified,
  IGameSystem,
  GameContext,
  IRulesDataProvider,
} from '../data/types';
import type { AssetManager } from '../core/AssetManager';
import { TEXT_URLS } from '../core/projectPaths';
import {
  RULE_LAYER_ENTRY_STATE,
  RULE_LAYER_INITIAL_STATE,
  RULE_LAYER_KEYS,
  ruleLayerGraphId,
} from '../data/ruleGraphNaming';

/**
 * 规矩系统 —— **叙事状态的只读投影 + 定义表**。
 *
 * 它自己不存任何规矩状态：`serialize()` 恒返回 `{}`（与 PlaneReconciler 同型），
 * 也**不写任何 FlagStore 键**。全部答案来自层图 `<ruleId>__<layer>`：
 *
 * - **已离开初态** = 掌握了这一层（单调只增——知识学到了不会忘，且**支持越级授予**）
 * - `active`           = 现在信的是哪一版（可来回改——「验证状态会变」）
 *
 * 事件契约不变：仍然发 `rule:acquired` / `rule:layer` / `notification:show`，
 * 所以 AudioManager 与 NotificationUI 一行不用改。换的是后端，不是契约。
 *
 * 设计与迁移见 artifact/Design/规矩系统迁移-L0L3计划-2026-07-26.md。
 */

const LAYER_ORDER: RuleLayerKey[] = [...RULE_LAYER_KEYS];

type RuleDefRaw = Record<string, unknown>;

/** 一层的一个正文版本 = 层图的一个状态。 */
export interface RuleLayerVersionDef {
  id: string;
  label?: string;
  text?: string;
  verified?: RuleVerified;
  /** 这一版是「被推翻」的说法：规矩本上划掉，且 `mode:'usable'` 的条件不再放行。 */
  refuted?: boolean;
  /** 被它取代的旧说法（规矩本折叠展示，保留「我当初是这么以为的」）。 */
  supersededText?: string;
}

/** 叙事状态读取面（由 Game 注入真实 NarrativeStateManager；测试可注 fake）。 */
export interface RuleNarrativeReader {
  getActiveState(graphId: string): string | undefined;
  hasReachedState(graphId: string, stateId: string): boolean;
}

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
      for (const lk of LAYER_ORDER) {
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

function normalizeVersions(raw: RuleDefRaw): Map<RuleLayerKey, RuleLayerVersionDef[]> {
  const out = new Map<RuleLayerKey, RuleLayerVersionDef[]>();
  const versions = raw.versions;
  if (!versions || typeof versions !== 'object') return out;
  for (const layer of LAYER_ORDER) {
    const rows = (versions as Record<string, unknown>)[layer];
    if (!Array.isArray(rows)) continue;
    const list: RuleLayerVersionDef[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const vid = String((row as { id?: unknown }).id ?? '').trim();
      if (!vid) continue;
      list.push({ ...(row as object), id: vid } as RuleLayerVersionDef);
    }
    if (list.length) out.set(layer, list);
  }
  return out;
}

export class RulesManager implements IGameSystem, IRulesDataProvider {
  private eventBus: EventBus;

  private ruleDefs: Map<string, RuleDef> = new Map();
  private versionDefs: Map<string, Map<RuleLayerKey, RuleLayerVersionDef[]>> = new Map();
  private categoryNames: Record<string, string> = {};
  private verifiedLabels: Record<string, string> = {};

  private narrative: RuleNarrativeReader | null = null;
  /** 上一帧的层解锁快照，用于把 narrative:stateChanged 差分成既有的 rule:* 事件。 */
  private lastKnownLayers: Map<string, Set<RuleLayerKey>> = new Map();
  private onNarrativeStateChanged = (): void => { this.reprojectAndEmit(); };

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = {
    get: (_c, k) => k,
  };
  private assetManager!: AssetManager;

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
    this.eventBus.on('narrative:stateChanged', this.onNarrativeStateChanged);
  }

  update(_dt: number): void {}

  /** 由 Game 装配期注入。未注入时全部查询恒 false（保守：还没接上就是什么都没掌握）。 */
  setNarrativeReader(reader: RuleNarrativeReader | null): void {
    this.narrative = reader;
    this.lastKnownLayers = this.snapshotAllLayers();
  }

  private static definedLayers(def: RuleDef): RuleLayerKey[] {
    return LAYER_ORDER.filter((k) => def.layers[k] != null);
  }

  // ------------------------------------------------------------------ //
  // 投影：全部读自层图
  // ------------------------------------------------------------------ //

  /**
   * 该层是否已掌握 = 层图**已经离开初态**（不是「reached 过入口版本」）。
   *
   * 为什么不能只看 reached('未验')：越级授予是本设计的招牌——⑤ 码头古籍可以先给「理」
   * 且直接给到「验成」，象要到 ⑨ 才补。那种情况下「未验」从没被 reached 过，
   * 只看它会把一个明明已经验成的层判成「没掌握」。
   *
   * 生成器不产任何回到初态的边，所以「离开初态」是单调的，与 reached 同样只增。
   * 两个条件取或，是为了兼容将来若有别的初态命名。
   */
  private layerKnown(ruleId: string, layer: RuleLayerKey): boolean {
    const def = this.ruleDefs.get(ruleId);
    if (!def?.layers?.[layer] || !this.narrative) return false;
    const gid = ruleLayerGraphId(ruleId, layer);
    if (this.narrative.hasReachedState(gid, RULE_LAYER_ENTRY_STATE)) return true;
    const active = this.narrative.getActiveState(gid);
    return active !== undefined && active !== RULE_LAYER_INITIAL_STATE;
  }

  /** 该层当前生效的版本；未掌握返回 undefined。 */
  private layerVersionId(ruleId: string, layer: RuleLayerKey): string | undefined {
    if (!this.layerKnown(ruleId, layer)) return undefined;
    return this.narrative?.getActiveState(ruleLayerGraphId(ruleId, layer));
  }

  private versionDef(ruleId: string, layer: RuleLayerKey, versionId: string): RuleLayerVersionDef | undefined {
    return this.versionDefs.get(ruleId)?.get(layer)?.find((v) => v.id === versionId);
  }

  /** 该层当前版本是否是「被推翻」的说法。 */
  private layerRefuted(ruleId: string, layer: RuleLayerKey): boolean {
    const vid = this.layerVersionId(ruleId, layer);
    if (!vid || vid === RULE_LAYER_ENTRY_STATE) return false;
    return this.versionDef(ruleId, layer, vid)?.refuted === true;
  }

  private hasRuleInternal(ruleId: string): boolean {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return false;
    const keys = RulesManager.definedLayers(def);
    if (keys.length === 0) return false;
    return keys.every((k) => this.layerKnown(ruleId, k));
  }

  private snapshotAllLayers(): Map<string, Set<RuleLayerKey>> {
    const out = new Map<string, Set<RuleLayerKey>>();
    this.ruleDefs.forEach((def, ruleId) => {
      const set = new Set<RuleLayerKey>();
      for (const L of RulesManager.definedLayers(def)) {
        if (this.layerKnown(ruleId, L)) set.add(L);
      }
      out.set(ruleId, set);
    });
    return out;
  }

  /**
   * 叙事状态变了 → 差分出「哪些层刚掌握」→ 发既有的 rule:layer / rule:acquired 事件。
   * 这是「换后端不换事件契约」的落点：AudioManager / NotificationUI 完全无感。
   */
  private reprojectAndEmit(): void {
    const now = this.snapshotAllLayers();
    now.forEach((layers, ruleId) => {
      const before = this.lastKnownLayers.get(ruleId) ?? new Set<RuleLayerKey>();
      const beforeFull = before.size > 0
        && RulesManager.definedLayers(this.ruleDefs.get(ruleId)!).every((k) => before.has(k));
      let gained = false;
      for (const L of LAYER_ORDER) {
        if (layers.has(L) && !before.has(L)) {
          gained = true;
          this.eventBus.emit('rule:layer', { ruleId, layer: L, source: 'grant' as const });
        }
      }
      if (gained && !beforeFull && this.hasRuleInternal(ruleId)) {
        this.emitRuleAcquired(ruleId);
      }
    });
    this.lastKnownLayers = now;
  }

  async loadDefs(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{
        rules: RuleDefRaw[];
        categories?: Record<string, string>;
        verifiedLabels?: Record<string, string>;
      }>(TEXT_URLS.rules);
      this.ruleDefs.clear();
      this.versionDefs.clear();
      for (const r of data.rules ?? []) {
        const norm = normalizeRuleDef(r);
        if (!norm) continue;
        this.ruleDefs.set(norm.id, norm);
        const versions = normalizeVersions(r);
        if (versions.size) this.versionDefs.set(norm.id, versions);
      }
      if (data.categories) this.categoryNames = data.categories;
      if (data.verifiedLabels) this.verifiedLabels = data.verifiedLabels;
      this.lastKnownLayers = this.snapshotAllLayers();
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

  // ------------------------------------------------------------------ //
  // 条件系统读取面（ConditionEvalContext.ruleState）
  // ------------------------------------------------------------------ //

  isLayerKnown(ruleId: string, layer: RuleLayerKey): boolean {
    return this.layerKnown(ruleId, layer);
  }

  isLayerUsable(ruleId: string, layer: RuleLayerKey): boolean {
    return this.layerKnown(ruleId, layer) && !this.layerRefuted(ruleId, layer);
  }

  isRuleDiscovered(ruleId: string): boolean {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return false;
    return RulesManager.definedLayers(def).some((L) => this.layerKnown(ruleId, L));
  }

  isRuleAcquired(ruleId: string): boolean {
    return this.hasRuleInternal(ruleId);
  }

  getLayerVersion(ruleId: string, layer: RuleLayerKey): string | undefined {
    return this.layerVersionId(ruleId, layer);
  }

  // ------------------------------------------------------------------ //
  // IRulesDataProvider（UI 读取面）
  // ------------------------------------------------------------------ //

  hasRule(ruleId: string): boolean {
    return this.hasRuleInternal(ruleId);
  }

  hasLayer(ruleId: string, layer: RuleLayerKey): boolean {
    return this.layerKnown(ruleId, layer);
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

  /** 听说过但还没完整掌握。 */
  isDiscovered(ruleId: string): boolean {
    if (this.hasRuleInternal(ruleId)) return false;
    return this.isRuleDiscovered(ruleId);
  }

  getDiscoveredRules(): { def: RuleDef; collected: number; total: number }[] {
    const result: { def: RuleDef; collected: number; total: number }[] = [];
    this.ruleDefs.forEach((def) => {
      if (this.hasRuleInternal(def.id) || !this.isDiscovered(def.id)) return;
      const depth = this.getRuleDepth(def.id);
      result.push({ def, collected: depth.unlocked, total: depth.total });
    });
    return result;
  }

  getAcquiredRules(): { def: RuleDef; acquired: boolean }[] {
    const result: { def: RuleDef; acquired: boolean }[] = [];
    this.ruleDefs.forEach((def) => {
      if (this.hasRuleInternal(def.id)) result.push({ def, acquired: true });
    });
    return result;
  }

  getRuleDepth(ruleId: string): { unlocked: number; total: number } {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return { unlocked: 0, total: 0 };
    const keys = RulesManager.definedLayers(def);
    let u = 0;
    for (const k of keys) {
      if (this.layerKnown(ruleId, k)) u++;
    }
    return { unlocked: u, total: keys.length };
  }

  /**
   * 已解锁各层的**当前版本正文**（不是层定义里那段死文本）。
   * 版本没写 text 时回落到层定义正文——「细化」只换写了新说法的那些版本。
   */
  getUnlockedLayerTexts(ruleId: string): Partial<Record<RuleLayerKey, string>> {
    const def = this.ruleDefs.get(ruleId);
    if (!def) return {};
    const out: Partial<Record<RuleLayerKey, string>> = {};
    for (const L of RulesManager.definedLayers(def)) {
      if (!this.layerKnown(ruleId, L)) continue;
      const vid = this.layerVersionId(ruleId, L);
      const vtext = vid ? this.versionDef(ruleId, L, vid)?.text : undefined;
      const text = vtext ?? def.layers[L]?.text;
      if (text) out[L] = text;
    }
    return out;
  }

  /** 某层当前版本的验证态（供规矩本渲染标签）；版本没写就用层定义的。 */
  getLayerVerified(ruleId: string, layer: RuleLayerKey): RuleVerified | undefined {
    const def = this.ruleDefs.get(ruleId);
    if (!def?.layers?.[layer] || !this.layerKnown(ruleId, layer)) return undefined;
    const vid = this.layerVersionId(ruleId, layer);
    const vdef = vid ? this.versionDef(ruleId, layer, vid) : undefined;
    return vdef?.verified ?? def.layers[layer]?.verified;
  }

  /** 某层当前版本是否被推翻（规矩本画删除线用）。 */
  isLayerRefuted(ruleId: string, layer: RuleLayerKey): boolean {
    return this.layerRefuted(ruleId, layer);
  }

  /** 被取代的旧说法（规矩本折叠展示）。 */
  getLayerSupersededText(ruleId: string, layer: RuleLayerKey): string | undefined {
    const vid = this.layerVersionId(ruleId, layer);
    if (!vid) return undefined;
    return this.versionDef(ruleId, layer, vid)?.supersededText;
  }

  // ------------------------------------------------------------------ //
  // 生命周期
  // ------------------------------------------------------------------ //

  /** 规矩状态住在叙事存档里，这里没有第二份。 */
  serialize(): object {
    return {};
  }

  /** 读档后叙事状态已就位，只需重建投影基线（避免把恢复的层当成「刚学到」再弹一次通知）。 */
  deserialize(_data: unknown): void {
    this.lastKnownLayers = this.snapshotAllLayers();
  }

  destroy(): void {
    // 铁律 8：init 里订阅了就必须在这里退订，否则重 init 会双份监听、通知与音效翻倍。
    this.eventBus.off('narrative:stateChanged', this.onNarrativeStateChanged);
    this.narrative = null;
    this.lastKnownLayers.clear();
    this.ruleDefs.clear();
    this.versionDefs.clear();
  }
}
