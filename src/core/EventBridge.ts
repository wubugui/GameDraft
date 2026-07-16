import type { EventBus } from './EventBus';
import type { ActionExecutor } from './ActionExecutor';
import type { GameStateController } from './GameStateController';
import type { DialogueManager } from '../systems/DialogueManager';
import type { GraphDialogueManager } from '../systems/GraphDialogueManager';
import type { EncounterManager } from '../systems/EncounterManager';
import type { ActionDef, DialogueEndPayload } from '../data/types';
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
  /** travel 槽第二道闸（第一道在 map 面板 openGuard）：返回 false 拒绝快速旅行并自行提示 */
  guardMapTravel: () => boolean;
}

export class EventBridge {
  private eventBus: EventBus;
  private deps: EventBridgeDeps;
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];
  /** 本次页面生命周期内是否已开过局（首次「新游戏」或从游戏内返回主菜单都算）。
   *  开过局后内存里全是旧局状态，「新游戏」必须整页重启才能零残留（R20）。 */
  private hasStartedSession = false;

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
      // ui:confirm/ui:cancel 映射约定（B4）：对话/遭遇选项点选=确认音（此处发）；
      // Esc 关面板=取消音（GameStateController 发）；打开面板不算确认，不发。
      this.eventBus.emit('ui:confirm', {});
      const run = dialogueManager.isActive
        ? dialogueManager.chooseOption(p.index)
        : graphDialogueManager.chooseOption(p.index);
      void run.catch((e) => console.warn('Dialogue chooseOption failed', e));
    });
    this.listen('dialogue:end', (p?: DialogueEndPayload) => {
      /** 状态恢复只认**最外层**对话结束（R5/R6 根因收敛）：
       *  - 嵌套 playScriptedDialogue 结束时任一管理器仍 active → 不恢复；
       *  - 图对话 deferred 链式接续（willContinue）→ 下一张图即将开播，不恢复——
       *    链条全部接续失败时 GraphDialogueManager 会补发一次 willContinue=false 的最终 end。 */
      if (dialogueManager.isActive || graphDialogueManager.isActive) return;
      if (p?.willContinue === true) return;
      stateController.setState(GameState.Exploring);
    });

    this.listen('encounter:narrativeDone', () => encounterManager.generateOptions());
    this.listen('encounter:choiceSelected', (p: { index: number }) => {
      // 同 dialogue:choiceSelected：选项点选=ui:confirm（B4 映射约定）
      this.eventBus.emit('ui:confirm', {});
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
      // 保留手工恢复（特殊时序，不可换成 closePanel('map')）：MapUI 在自己的 pointerdown 里
      // 已同步 close() 拆掉 UI（closePanel 对已关面板是幂等 no-op，不会弹栈）。恢复必须发生在
      // guard 与 switchScene **之前**：guard 拒绝时若不先弹栈，玩家会滞留在无面板的 UIOverlay
      // （地图已自关、Esc 找不到面板、其它面板禁开——不可恢复软锁）；而 switchScene 之后再恢复，
      // 会按“进入时的 prev=UIOverlay”恢复，快速旅行后同样卡住。map:travel 仅由 MapUI 发出
      // （全库唯一发射点），故 UIOverlay 态即意味着栈顶是打开地图时压的那层，弹栈安全。
      if (stateController.currentState === GameState.UIOverlay) {
        stateController.restorePreviousState();
      }
      // travel 槽第二道闸：面板 openGuard 后位面可能已切换（面板开着时叙事点名），
      // 或事件来自竞态路径——此处兜底拒绝（状态已在上方恢复，此处仅取消旅行）。
      if (!this.deps.guardMapTravel()) return;
      try {
        await actionExecutor.executeAwait({
          type: 'switchScene',
          params: { targetScene: p.sceneId },
        });
      } catch (e) {
        console.warn('EventBridge: map:travel switchScene action failed', e);
      }
    });

    this.listen('menu:newGame', () => {
      if (this.hasStartedSession) {
        // R20：开过局后 flag/背包/任务/叙事全是旧局残留，原地重置无法证明完备
        // （需全系统 destroy→init→内容重播种）。整页重启走与首次启动完全相同的引导路径，零残留。
        this.restartPageForNewGame();
        return;
      }
      // 首次开局：世界已在启动引导中就绪且从未被玩过，直接放行（与旧行为一致）
      this.hasStartedSession = true;
      menuUI.close();
      stateController.setState(GameState.Exploring);
    });
    this.listen('menu:returnToMain', () => {
      // 能从游戏内回主菜单，说明本页已开过局：之后再点「新游戏」必须整页重启
      this.hasStartedSession = true;
      stateController.setState(GameState.MainMenu);
      menuUI.openMainMenu();
    });
    // 保留手工恢复（特殊时序，不可换成 closePanel('menu')）：暂停菜单经 escapeFallback →
    // stateController.togglePanel('menu') 打开（η2a/η2b 收敛后有压栈），但「继续」按钮先自
    // close() 再发事件——closePanel 对已关面板幂等 no-op、不弹栈。此处 restorePreviousState
    // 弹掉 togglePanel 压的那层栈恢复状态，与 Esc 关闭暂停菜单的弹栈语义一致、栈保持平衡。
    this.listen('menu:resume', () => {
      if (stateController.currentState === GameState.UIOverlay) {
        stateController.restorePreviousState();
      }
    });

    this.listen('scene:enter', (p: { sceneId: string }) => mapUI.setCurrentScene(p.sceneId));

    this.listen('ruleUse:apply', async (p: { ruleId: string; actions: ActionDef[]; resultText?: string }) => {
      // R11：无论有无 resultText，状态恢复都在这一步完成——closePanel 统一关面板 + 弹栈
      // 恢复（RuleUseUI 不再自关）。此后有 resultText 才另起一段 UIOverlay 包裹展示。
      stateController.closePanel('ruleUse');
      try {
        await actionExecutor.executeBatchAwait(p.actions);
      } catch (e) {
        console.warn('EventBridge: ruleUse:apply actions failed', e);
      }
      await actionExecutor.executeAwait({ type: 'setFlag', params: { key: FlagKeys.ruleUsed(p.ruleId), value: true } });
      if (p.resultText) {
        stateController.setState(GameState.UIOverlay);
        await inspectBox.show(p.resultText);
        // 结算动作/展示期间可能已被对话、切场等推进到别的状态，仅在仍是 UIOverlay 时才复位
        if (stateController.currentState === GameState.UIOverlay) {
          stateController.setState(GameState.Exploring);
        }
      }
    });
  }

  /** R20：整页重启前净化一次性引导参数（过场直启/场景传送/各小游戏预览），
   *  否则 reload 会再次进这些调试入口而不是正常开局；`mode=dev` 是会话级模式，保留。 */
  private restartPageForNewGame(): void {
    try {
      const url = new URL(window.location.href);
      const oneShotParams = [
        'play_cutscene',
        'devScene',
        'dev_scene',
        'narrativeWarp',
        'narrative_warp',
        'waterPreview',
        'sugarWheelPreview',
        'paperCraftPreview',
      ];
      for (const key of oneShotParams) url.searchParams.delete(key);
      window.history.replaceState(null, '', url.toString());
    } catch (e) {
      console.warn('EventBridge: 新游戏重启前清理 URL 参数失败，按原 URL 重启', e);
    }
    window.location.reload();
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
