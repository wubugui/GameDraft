import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { EncounterDef, IGameSystem, GameContext, ResolvedOption } from '../data/types';

export class EncounterManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;

  private encounterDefs: Map<string, EncounterDef> = new Map();
  private currentEncounter: EncounterDef | null = null;
  private currentOptions: ResolvedOption[] = [];
  private active: boolean = false;

  private ruleNameResolver: ((ruleId: string) => { name: string; incompleteName?: string } | undefined) | null = null;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
  }

  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
  }
  update(_dt: number): void {}

  setRuleNameResolver(fn: (ruleId: string) => { name: string; incompleteName?: string } | undefined): void {
    this.ruleNameResolver = fn;
  }

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<EncounterDef[]>('/assets/data/encounters.json');
      for (const def of defs) {
        this.encounterDefs.set(def.id, def);
      }
    } catch {
      console.warn('EncounterManager: encounters.json not found');
    }
  }

  startEncounter(encounterId: string): void {
    const def = this.encounterDefs.get(encounterId);
    if (!def) {
      console.warn(`EncounterManager: unknown encounter "${encounterId}"`);
      return;
    }

    this.currentEncounter = def;
    this.active = true;

    this.eventBus.emit('encounter:start', { encounterId });

    this.eventBus.emit('encounter:narrative', { text: def.narrative });
  }

  generateOptions(): void {
    if (!this.currentEncounter) return;

    this.currentOptions = [];
    let idx = 0;

    for (const opt of this.currentEncounter.options) {
      if (opt.requiredRuleId) {
        const ruleId = opt.requiredRuleId;
        const ruleAcquired = this.flagStore.get(`rule_${ruleId}_acquired`) === true;
        const ruleDiscovered = this.flagStore.get(`rule_${ruleId}_discovered`) === true;

        if (ruleAcquired) {
          // rule acquired -- show normally
        } else if (ruleDiscovered) {
          const ruleInfo = this.ruleNameResolver?.(ruleId);
          const collected = (this.flagStore.get(`rule_${ruleId}_fragments_collected`) as number) ?? 0;
          const total = (this.flagStore.get(`rule_${ruleId}_fragments_total`) as number) ?? 0;
          const displayName = ruleInfo?.incompleteName ?? this.strings.get('encounter', 'unknownRule');
          this.currentOptions.push({
            index: idx++,
            text: `${displayName} (${collected}/${total})`,
            type: opt.type,
            enabled: false,
            disableReason: this.strings.get('encounter', 'fragmentInsufficient', { collected, total }),
            consumeItems: opt.consumeItems,
            resultActions: opt.resultActions,
            resultText: opt.resultText,
          });
          continue;
        } else {
          continue;
        }
      }

      if (opt.conditions.length > 0 && !this.flagStore.checkConditions(opt.conditions)) {
        continue;
      }

      let enabled = true;
      let disableReason: string | undefined;

      if (opt.consumeItems) {
        for (const req of opt.consumeItems) {
          const count = (this.flagStore.get(`item_count_${req.id}`) as number) ?? 0;
          if (count < req.count) {
            enabled = false;
            disableReason = this.strings.get('encounter', 'itemInsufficient');
            break;
          }
        }
      }

      this.currentOptions.push({
        index: idx++,
        text: opt.text,
        type: opt.type,
        enabled,
        disableReason,
        consumeItems: opt.consumeItems,
        resultActions: opt.resultActions,
        resultText: opt.resultText,
      });
    }

    this.eventBus.emit('encounter:options', { options: this.currentOptions });
  }

  chooseOption(index: number): void {
    const opt = this.currentOptions[index];
    if (!opt || !opt.enabled) return;

    if (opt.consumeItems) {
      for (const req of opt.consumeItems) {
        this.actionExecutor.execute({
          type: 'removeItem',
          params: { id: req.id, count: req.count },
        });
      }
    }

    if (opt.resultActions.length > 0) {
      void this.actionExecutor.executeBatchAwait(opt.resultActions).catch((e) => {
        console.warn('EncounterManager: resultActions failed', e);
      });
    }

    if (opt.resultText) {
      this.eventBus.emit('encounter:result', { text: opt.resultText });
    } else {
      this.endEncounter();
    }
  }

  endEncounter(): void {
    if (!this.active) return;
    this.active = false;
    this.currentEncounter = null;
    this.currentOptions = [];
    this.eventBus.emit('encounter:end', {});
  }

  get isActive(): boolean {
    return this.active;
  }

  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {}

  destroy(): void {
    this.currentEncounter = null;
    this.currentOptions = [];
    this.active = false;
    this.encounterDefs.clear();
  }
}
