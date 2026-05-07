import type { Hotspot } from '../entities/Hotspot';
import type { Npc } from '../entities/Npc';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { InputManager } from '../core/InputManager';
import type { Condition, ConditionExpr, IGameSystem, GameContext } from '../data/types';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { hotspotOffersPlayerInteraction } from '../utils/hotspotInteraction';

interface InteractableTarget {
  kind: 'hotspot' | 'npc';
  hotspot?: Hotspot;
  npc?: Npc;
}

export class InteractionSystem implements IGameSystem {
  private hotspots: Hotspot[] = [];
  private npcs: Npc[] = [];
  private nearestTarget: InteractableTarget | null = null;
  /** 已进入范围并触发过一次的 autoTrigger 热点，离开前不重复触发 */
  private autoTriggeredHotspot: Hotspot | null = null;
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private inputManager: InputManager;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private playerPosGetter: (() => { x: number; y: number }) | null = null;
  /** 与 SceneManager.refreshCutsceneBoundEntityVisibility 一致的基础显隐，不含触发条件图层 */
  private hotspotBaseEnabled: ((h: Hotspot) => boolean) | null = null;
  private npcBaseVisible: ((n: Npc) => boolean) | null = null;

  constructor(eventBus: EventBus, flagStore: FlagStore, inputManager: InputManager) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.inputManager = inputManager;
  }

  init(_ctx: GameContext): void {}
  serialize(): object {
    return {};
  }
  deserialize(_data: object): void {}

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  /**
   * 由 Game 注入，与过场/sceneMemory 基底一致；未注入时条件隐藏仍生效，基底按 true。
   */
  setEntityBaseVisibilityReaders(
    hotspotBase: ((h: Hotspot) => boolean) | null,
    npcBase: ((n: Npc) => boolean) | null,
  ): void {
    this.hotspotBaseEnabled = hotspotBase;
    this.npcBaseVisible = npcBase;
  }

  private evalConditionsList(conds: ConditionExpr[] | undefined): boolean {
    if (!conds?.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (ctx) return evaluateConditionExprList(conds, ctx);
    return this.flagStore.checkConditions(conds as Condition[]);
  }

  setPlayerPositionGetter(getter: () => { x: number; y: number }): void {
    this.playerPosGetter = getter;
  }

  setHotspots(hotspots: Hotspot[]): void {
    this.clearHotspots();
    this.hotspots = hotspots;
  }

  clearHotspots(): void {
    this.hotspots = [];
    this.clearNearestIfKind('hotspot');
    this.autoTriggeredHotspot = null;
  }

  setNpcs(npcs: Npc[]): void {
    this.clearNpcs();
    this.npcs = npcs;
  }

  clearNpcs(): void {
    this.npcs = [];
    this.clearNearestIfKind('npc');
  }

  private clearNearestIfKind(kind: 'hotspot' | 'npc'): void {
    if (this.nearestTarget?.kind === kind) {
      if (kind === 'hotspot') this.nearestTarget.hotspot?.hidePrompt();
      if (kind === 'npc') this.nearestTarget.npc?.hidePrompt();
      this.nearestTarget = null;
    }
  }

  private applyHotspotVisibilityAndBase(hotspot: Hotspot): void {
    const conds = hotspot.def.conditions;
    const condOk = this.evalConditionsList(conds);
    const base = this.hotspotBaseEnabled?.(hotspot) ?? true;
    const hideWhenFail = hotspot.def.conditionHidesEntity === true && !!conds?.length;
    if (hideWhenFail) {
      hotspot.setEnabled(base && condOk);
    } else {
      hotspot.setEnabled(base);
    }
  }

  private applyNpcVisibilityAndBase(npc: Npc): void {
    const conds = npc.def.conditions;
    const condOk = this.evalConditionsList(conds);
    const base = this.npcBaseVisible?.(npc) ?? true;
    const hideWhenFail = npc.def.conditionHidesEntity === true && !!conds?.length;
    if (hideWhenFail) {
      npc.setVisible(base && condOk);
    } else {
      npc.setVisible(base);
    }
  }

  update(_dt: number): void {
    if (!this.playerPosGetter) return;
    if (this.hotspots.length === 0 && this.npcs.length === 0) return;

    const pos = this.playerPosGetter();
    let closestTarget: InteractableTarget | null = null;
    let closestDist = Infinity;

    for (const hotspot of this.hotspots) {
      this.applyHotspotVisibilityAndBase(hotspot);
      if (!hotspot.active) continue;
      if (!hotspotOffersPlayerInteraction(hotspot.def)) continue;
      if (hotspot.def.conditions && hotspot.def.conditions.length > 0) {
        if (!this.evalConditionsList(hotspot.def.conditions)) continue;
      }

      const dx = pos.x - hotspot.centerX;
      const dy = pos.y - hotspot.centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= hotspot.def.interactionRange && dist < closestDist) {
        closestTarget = { kind: 'hotspot', hotspot };
        closestDist = dist;
      }
    }

    for (const npc of this.npcs) {
      this.applyNpcVisibilityAndBase(npc);
      if (!npc.container.visible) continue;
      if (npc.def.conditions && npc.def.conditions.length > 0) {
        if (!this.evalConditionsList(npc.def.conditions)) continue;
      }
      const dx = pos.x - npc.x;
      const dy = pos.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= npc.interactionRange && dist < closestDist) {
        closestTarget = { kind: 'npc', npc };
        closestDist = dist;
      }
    }

    if (!this.isSameTarget(this.nearestTarget, closestTarget)) {
      this.hideCurrentPrompt();
      this.nearestTarget = closestTarget;
      this.showCurrentPrompt();
    }

    if (closestTarget && this.inputManager.wasKeyJustPressed('KeyE')) {
      this.triggerTarget(closestTarget);
    } else if (closestTarget?.kind === 'hotspot' && closestTarget.hotspot?.def.autoTrigger) {
      const h = closestTarget.hotspot;
      if (this.autoTriggeredHotspot !== h) {
        this.autoTriggeredHotspot = h;
        this.triggerTarget(closestTarget);
      }
    } else {
      this.autoTriggeredHotspot = null;
    }
  }

  private isSameTarget(a: InteractableTarget | null, b: InteractableTarget | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'hotspot') return a.hotspot === b.hotspot;
    return a.npc === b.npc;
  }

  private hideCurrentPrompt(): void {
    if (!this.nearestTarget) return;
    if (this.nearestTarget.kind === 'hotspot') this.nearestTarget.hotspot?.hidePrompt();
    if (this.nearestTarget.kind === 'npc') this.nearestTarget.npc?.hidePrompt();
  }

  private showCurrentPrompt(): void {
    if (!this.nearestTarget) return;
    if (this.nearestTarget.kind === 'hotspot' && !this.nearestTarget.hotspot?.def.autoTrigger) {
      this.nearestTarget.hotspot?.showPrompt();
    }
    if (this.nearestTarget.kind === 'npc') {
      this.nearestTarget.npc?.showPrompt();
    }
  }

  private triggerTarget(target: InteractableTarget): void {
    if (target.kind === 'hotspot') {
      this.eventBus.emit('hotspot:triggered', { hotspot: target.hotspot!, def: target.hotspot!.def });
    } else if (target.kind === 'npc') {
      this.eventBus.emit('npc:interact', { npc: target.npc! });
    }
  }

  destroy(): void {
    this.clearHotspots();
    this.clearNpcs();
    this.nearestTarget = null;
    this.autoTriggeredHotspot = null;
    this.playerPosGetter = null;
    this.hotspotBaseEnabled = null;
    this.npcBaseVisible = null;
  }
}
