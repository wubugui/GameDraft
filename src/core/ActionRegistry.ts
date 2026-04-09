import type { ActionExecutor } from './ActionExecutor';
import type { RuleOfferRegistry } from './RuleOfferRegistry';
import type { EventBus } from './EventBus';
import type { StringsProvider } from './StringsProvider';
import type { GameStateController } from './GameStateController';
import type { InventoryManager } from '../systems/InventoryManager';
import type { RulesManager } from '../systems/RulesManager';
import type { QuestManager } from '../systems/QuestManager';
import type { EncounterManager } from '../systems/EncounterManager';
import type { AudioManager } from '../systems/AudioManager';
import type { DayManager } from '../systems/DayManager';
import type { ArchiveManager } from '../systems/ArchiveManager';
import type { CutsceneManager } from '../systems/CutsceneManager';
import type { SceneManager } from '../systems/SceneManager';
import type { EmoteBubbleManager } from '../systems/EmoteBubbleManager';
import type { ICutsceneActor, ZoneRuleSlot } from '../data/types';
import { GameState } from '../data/types';

export interface ActionRegistryDeps {
  ruleOfferRegistry: RuleOfferRegistry;
  inventoryManager: InventoryManager;
  rulesManager: RulesManager;
  questManager: QuestManager;
  encounterManager: EncounterManager;
  audioManager: AudioManager;
  dayManager: DayManager;
  archiveManager: ArchiveManager;
  cutsceneManager: CutsceneManager;
  sceneManager: SceneManager;
  emoteBubbleManager: EmoteBubbleManager;
  stateController: GameStateController;
  stringsProvider: StringsProvider;
  eventBus: EventBus;
  resolveActor: (id: string) => ICutsceneActor | null;
  pickupNotification: { show(name: string, count: number): void; forceCleanup(): void };
  inspectBox: { readonly isOpen: boolean; close(): void };
  shopUI: { openShop(shopId: string): void };
}

export function registerActionHandlers(executor: ActionExecutor, d: ActionRegistryDeps): void {
  executor.register('enableRuleOffers', (p, zctx) => {
    if (!zctx?.zoneId) {
      console.warn('enableRuleOffers: missing zone context (must run from ZoneSystem batch)');
      return;
    }
    const slots = p.slots as ZoneRuleSlot[] | undefined;
    if (!slots || !Array.isArray(slots)) return;
    d.ruleOfferRegistry.register(zctx.zoneId, slots);
  }, ['slots']);

  executor.register('disableRuleOffers', (_p, zctx) => {
    if (!zctx?.zoneId) {
      console.warn('disableRuleOffers: missing zone context (must run from ZoneSystem batch)');
      return;
    }
    d.ruleOfferRegistry.unregister(zctx.zoneId);
  }, []);

  executor.register('giveItem', (p) => d.inventoryManager.addItem(p.id as string, (p.count as number) ?? 1), ['id', 'count']);
  executor.register('removeItem', (p) => d.inventoryManager.removeItem(p.id as string, (p.count as number) ?? 1), ['id', 'count']);
  executor.register('giveCurrency', (p) => d.inventoryManager.addCoins(p.amount as number), ['amount']);
  executor.register('removeCurrency', (p) => d.inventoryManager.removeCoins(p.amount as number), ['amount']);
  executor.register('giveRule', (p) => d.rulesManager.giveRule(p.id as string), ['id']);
  executor.register('giveFragment', (p) => d.rulesManager.giveFragment(p.id as string), ['id']);
  executor.register('updateQuest', (p) => d.questManager.acceptQuest(p.id as string), ['id']);

  executor.register('startEncounter', (p) => {
    d.stateController.setState(GameState.Encounter);
    d.encounterManager.startEncounter(p.id as string);
  }, ['id']);

  executor.register('playBgm', (p) => d.audioManager.playBgm(p.id as string, (p.fadeMs as number) ?? 1000), ['id', 'fadeMs']);
  executor.register('stopBgm', (p) => d.audioManager.stopBgm((p.fadeMs as number) ?? 1000), ['fadeMs']);
  executor.register('playSfx', (p) => d.audioManager.playSfx(p.id as string), ['id']);
  executor.register('endDay', () => d.dayManager.endDay());

  executor.register('addDelayedEvent', (p) => {
    d.dayManager.addDelayedEvent(p.targetDay as number, p.actions as any[]);
  }, ['targetDay', 'actions']);

  executor.register('addArchiveEntry', (p) => {
    d.archiveManager.addEntry(p.bookType as 'character' | 'lore' | 'document' | 'book', p.entryId as string);
  }, ['bookType', 'entryId']);

  executor.register('startCutscene', (p) => {
    d.stateController.setState(GameState.Cutscene);
    d.cutsceneManager.startCutscene(p.id as string).then(() => {
      d.stateController.setState(GameState.Exploring);
    });
  }, ['id']);

  executor.register('showEmote', (p) => {
    const actor = d.resolveActor(p.target as string);
    if (actor) d.emoteBubbleManager.show(actor, p.emote as string, (p.duration as number) ?? 1500);
  }, ['target', 'emote', 'duration']);

  executor.register('openShop', (p) => {
    d.stateController.setState(GameState.UIOverlay);
    d.shopUI.openShop(p.shopId as string);
  }, ['shopId']);

  executor.register('pickup', (p) => {
    if (p.isCurrency as boolean | undefined) {
      d.inventoryManager.addCoins(p.count as number);
    } else {
      d.inventoryManager.addItem(p.itemId as string, p.count as number);
    }
    d.pickupNotification.show(p.itemName as string, p.count as number);
  }, ['itemId', 'itemName', 'count', 'isCurrency']);

  const prepareSceneSwitch = () => {
    d.pickupNotification.forceCleanup();
    if (d.inspectBox.isOpen) d.inspectBox.close();
  };

  executor.register('switchScene', (p) => {
    d.stateController.setState(GameState.Cutscene);
    prepareSceneSwitch();
    d.sceneManager.switchScene(p.targetScene as string, p.targetSpawnPoint as string | undefined).then(() => {
      d.stateController.setState(GameState.Exploring);
    });
  }, ['targetScene', 'targetSpawnPoint']);

  executor.register('changeScene', (p) => {
    d.stateController.setState(GameState.Cutscene);
    prepareSceneSwitch();
    const cam = typeof p.cameraX === 'number' && typeof p.cameraY === 'number'
      ? { x: p.cameraX as number, y: p.cameraY as number } : undefined;
    d.sceneManager.switchScene(p.targetScene as string, p.targetSpawnPoint as string | undefined, cam).then(() => {
      d.stateController.setState(GameState.Exploring);
    });
  }, ['targetScene', 'targetSpawnPoint', 'cameraX', 'cameraY']);

  executor.register('shopPurchase', (p) => {
    const itemId = p.itemId as string;
    const price = p.price as number;
    if (!d.inventoryManager.removeCoins(price)) {
      d.eventBus.emit('notification:show', {
        text: d.stringsProvider.get('notifications', 'currencyInsufficient'),
        type: 'warning',
      });
      return;
    }
    if (!d.inventoryManager.addItem(itemId, 1)) {
      d.inventoryManager.addCoins(price);
      return;
    }
    const def = d.inventoryManager.getItemDef(itemId);
    d.eventBus.emit('notification:show', {
      text: d.stringsProvider.get('notifications', 'shopPurchased', { name: def?.name ?? itemId }),
      type: 'info',
    });
  }, ['itemId', 'price']);

  executor.register('inventoryDiscard', (p) => d.inventoryManager.discardItem(p.itemId as string), ['itemId']);
}
