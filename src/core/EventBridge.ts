import type { EventBus } from './EventBus';
import type { ActionExecutor } from './ActionExecutor';
import type { GameStateController } from './GameStateController';
import type { DialogueManager } from '../systems/DialogueManager';
import type { GraphDialogueManager } from '../systems/GraphDialogueManager';
import type { EncounterManager } from '../systems/EncounterManager';
import type { SceneManager } from '../systems/SceneManager';
import type { ActionDef } from '../data/types';
import { GameState } from '../data/types';

export interface EventBridgeDeps {
  dialogueManager: DialogueManager;
  graphDialogueManager: GraphDialogueManager;
  encounterManager: EncounterManager;
  stateController: GameStateController;
  actionExecutor: ActionExecutor;
  sceneManager: SceneManager;
  mapUI: { setCurrentScene(sceneId: string): void };
  menuUI: { close(): void; openMainMenu(): void };
  inspectBox: { show(text: string): Promise<void> };
}

export class EventBridge {
  private eventBus: EventBus;
  private deps: EventBridgeDeps;
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];

  constructor(eventBus: EventBus, deps: EventBridgeDeps) {
    this.eventBus = eventBus;
    this.deps = deps;
  }

  init(): void {
    const { dialogueManager, graphDialogueManager, encounterManager, stateController,
            actionExecutor, sceneManager, mapUI, menuUI, inspectBox } = this.deps;

    this.listen('dialogue:advance', () => {
      const run = graphDialogueManager.isActive
        ? graphDialogueManager.advance()
        : dialogueManager.advance();
      void run.catch((e) => console.warn('Dialogue advance failed', e));
    });
    this.listen('dialogue:advanceEnd', () => {
      if (graphDialogueManager.isActive) graphDialogueManager.endDialogue();
      else dialogueManager.endDialogue();
    });
    this.listen('dialogue:choiceSelected', (p: { index: number }) => {
      const run = graphDialogueManager.isActive
        ? graphDialogueManager.chooseOption(p.index)
        : dialogueManager.chooseOption(p.index);
      void run.catch((e) => console.warn('Dialogue chooseOption failed', e));
    });
    this.listen('dialogue:end', () => stateController.setState(GameState.Exploring));

    this.listen('encounter:narrativeDone', () => encounterManager.generateOptions());
    this.listen('encounter:choiceSelected', (p: { index: number }) => encounterManager.chooseOption(p.index));
    this.listen('encounter:resultDone', () => encounterManager.endEncounter());
    this.listen('encounter:end', () => stateController.setState(GameState.Exploring));

    this.listen('shop:purchase', (p: { itemId: string; price: number }) => {
      actionExecutor.execute({ type: 'shopPurchase', params: { itemId: p.itemId, price: p.price } });
    });
    this.listen('inventory:discard', (p: { itemId: string }) => {
      actionExecutor.execute({ type: 'inventoryDiscard', params: { itemId: p.itemId } });
    });
    this.listen('shop:closed', () => stateController.setState(GameState.Exploring));

    this.listen('map:travel', (p: { sceneId: string }) => {
      stateController.setState(GameState.Cutscene);
      sceneManager.switchScene(p.sceneId)
        .then(() => stateController.setState(GameState.Exploring))
        .catch((e) => {
          console.warn('EventBridge: map:travel switchScene failed', e);
          stateController.setState(GameState.Exploring);
        });
    });

    this.listen('menu:newGame', () => { menuUI.close(); stateController.setState(GameState.Exploring); });
    this.listen('menu:returnToMain', () => { stateController.setState(GameState.MainMenu); menuUI.openMainMenu(); });

    this.listen('scene:enter', (p: { sceneId: string }) => mapUI.setCurrentScene(p.sceneId));

    this.listen('ruleUse:apply', async (p: { ruleId: string; actions: ActionDef[]; resultText?: string }) => {
      try {
        await actionExecutor.executeBatchAwait(p.actions);
      } catch (e) {
        console.warn('EventBridge: ruleUse:apply actions failed', e);
      }
      actionExecutor.execute({ type: 'setFlag', params: { key: `rule_used_${p.ruleId}`, value: true } });
      if (p.resultText) {
        stateController.setState(GameState.UIOverlay);
        await inspectBox.show(p.resultText);
        stateController.setState(GameState.Exploring);
      }
    });
  }

  private listen(event: string, fn: (...args: any[]) => void): void {
    this.eventBus.on(event, fn);
    this.boundCallbacks.push({ event, fn });
  }

  destroy(): void {
    for (const { event, fn } of this.boundCallbacks) this.eventBus.off(event, fn);
    this.boundCallbacks = [];
  }
}
