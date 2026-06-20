import type { EventBus } from './EventBus';
import type { ActionExecutor } from './ActionExecutor';
import type { GameStateController } from './GameStateController';
import type { DialogueManager } from '../systems/DialogueManager';
import type { GraphDialogueManager } from '../systems/GraphDialogueManager';
import type { EncounterManager } from '../systems/EncounterManager';
import type { ActionDef } from '../data/types';
import { GameState } from '../data/types';
import { FlagKeys } from './FlagKeys';

export interface EventBridgeDeps {
  dialogueManager: DialogueManager;
  graphDialogueManager: GraphDialogueManager;
  encounterManager: EncounterManager;
  stateController: GameStateController;
  actionExecutor: ActionExecutor;
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
            actionExecutor, mapUI, menuUI, inspectBox } = this.deps;

    // runActions 内嵌 `playScriptedDialogue` 时图对话与 DialogueManager 同时 active；
    // 点击继续必须推进 DialogueManager，否则脚本台词永远卡在第一句。
    this.listen('dialogue:advance', () => {
      const run = dialogueManager.isActive
        ? dialogueManager.advance()
        : graphDialogueManager.advance();
      void run.catch((e) => console.warn('Dialogue advance failed', e));
    });
    this.listen('dialogue:advanceEnd', () => {
      if (dialogueManager.isActive) dialogueManager.endDialogue();
      else if (graphDialogueManager.isActive) graphDialogueManager.endDialogue();
    });
    this.listen('dialogue:choiceSelected', (p: { index: number }) => {
      const run = dialogueManager.isActive
        ? dialogueManager.chooseOption(p.index)
        : graphDialogueManager.chooseOption(p.index);
      void run.catch((e) => console.warn('Dialogue chooseOption failed', e));
    });
    this.listen('dialogue:end', () => {
      if (!graphDialogueManager.isActive) stateController.setState(GameState.Exploring);
    });

    this.listen('encounter:narrativeDone', () => encounterManager.generateOptions());
    this.listen('encounter:choiceSelected', (p: { index: number }) => {
      void encounterManager.chooseOption(p.index).catch((e) => {
        console.warn('EventBridge: encounter chooseOption failed', e);
      });
    });
    this.listen('encounter:resultDone', () => encounterManager.endEncounter());
    this.listen('encounter:end', () => stateController.setState(GameState.Exploring));

    this.listen('shop:purchase', async (p: { itemId: string; price: number }) => {
      try {
        await actionExecutor.executeAwait({ type: 'shopPurchase', params: { itemId: p.itemId, price: p.price } });
      } catch (e) {
        console.warn('EventBridge: shopPurchase failed', e);
      }
    });
    this.listen('inventory:discard', async (p: { itemId: string }) => {
      try {
        await actionExecutor.executeAwait({ type: 'inventoryDiscard', params: { itemId: p.itemId } });
      } catch (e) {
        console.warn('EventBridge: inventoryDiscard failed', e);
      }
    });
    this.listen('shop:closed', () => stateController.setState(GameState.Exploring));

    this.listen('map:travel', async (p: { sceneId: string }) => {
      // 地图面板点选传送：MapUI.close() 只拆 UI、不恢复状态机，state 仍停在 UIOverlay
      // 且 overlayReturnStack 仍压着 [Exploring]。先退回覆盖层状态（回到 Exploring）再切场景，
      // 否则 switchScene 完成后会按“进入时的 prev=UIOverlay”恢复，导致快速旅行后卡在 UIOverlay。
      if (stateController.currentState === GameState.UIOverlay) {
        stateController.restorePreviousState();
      }
      try {
        await actionExecutor.executeAwait({
          type: 'switchScene',
          params: { targetScene: p.sceneId },
        });
      } catch (e) {
        console.warn('EventBridge: map:travel switchScene action failed', e);
      }
    });

    this.listen('menu:newGame', () => { menuUI.close(); stateController.setState(GameState.Exploring); });
    this.listen('menu:returnToMain', () => { stateController.setState(GameState.MainMenu); menuUI.openMainMenu(); });
    // 暂停菜单「继续」：MenuUI.close() 只关 UI，不动状态机。此处把游戏状态从 UIOverlay 恢复，
    // 否则点「继续」后会卡在 UIOverlay（玩家冻结、Esc 也无效）。与 Esc 关闭暂停菜单的恢复语义一致。
    this.listen('menu:resume', () => {
      if (stateController.currentState === GameState.UIOverlay) {
        stateController.restorePreviousState();
      }
    });

    this.listen('scene:enter', (p: { sceneId: string }) => mapUI.setCurrentScene(p.sceneId));

    this.listen('ruleUse:apply', async (p: { ruleId: string; actions: ActionDef[]; resultText?: string }) => {
      try {
        await actionExecutor.executeBatchAwait(p.actions);
      } catch (e) {
        console.warn('EventBridge: ruleUse:apply actions failed', e);
      }
      await actionExecutor.executeAwait({ type: 'setFlag', params: { key: FlagKeys.ruleUsed(p.ruleId), value: true } });
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
