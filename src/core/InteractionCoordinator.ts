import type { EventBus } from './EventBus';
import type { ActionExecutor } from './ActionExecutor';
import type { GameStateController } from './GameStateController';
import type { SceneManager } from '../systems/SceneManager';
import type { DialogueManager } from '../systems/DialogueManager';
import type { GraphDialogueManager } from '../systems/GraphDialogueManager';
import type { Hotspot } from '../entities/Hotspot';
import type { Npc } from '../entities/Npc';
import type {
  DialogueEndPayload,
  HotspotDef,
  InspectData,
  InspectDataGraphMode,
  PickupData,
  TransitionData,
  EncounterTriggerData,
} from '../data/types';
import { GameState } from '../data/types';
import { inspectDataHasInteractablePayload } from '../utils/hotspotInteraction';
import { FlagKeys } from './FlagKeys';

export interface InteractionDeps {
  stateController: GameStateController;
  sceneManager: SceneManager;
  dialogueManager: DialogueManager;
  graphDialogueManager: GraphDialogueManager;
  actionExecutor: ActionExecutor;
  inspectBox: { show(text: string): Promise<void>; readonly isOpen: boolean; close(): void };
  eventBus: EventBus;
  getPlayerWorldPos: () => { x: number; y: number };
  getCameraZoom: () => number;
  /** 与 NPC 对话开始前：玩家切站立并朝向该 NPC（世界向量，不改动画数据） */
  preparePlayerForNpcDialogue: (npc: Npc) => void;
  /** 与 Action `fadingZoom` 同源：NPC 对话开场拉近 */
  fadingDialogueCameraZoom: (targetZoom: number, durationMs: number) => void;
  /** 与 Action `fadingRestoreSceneCameraZoom` 同源：对话结束恢复场景 zoom */
  fadingRestoreSceneCameraZoom: (durationMs: number) => void;
}

const NPC_DIALOGUE_CAMERA_ZOOM_MS = 550;

export class InteractionCoordinator {
  private eventBus: EventBus;
  private deps: InteractionDeps;
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];
  /** 热区交互串行，避免拾取/inspect/过渡的 executeAwait 与异步链交错 */
  private hotspotChain: Promise<void> = Promise.resolve();

  constructor(eventBus: EventBus, deps: InteractionDeps) {
    this.eventBus = eventBus;
    this.deps = deps;
  }

  init(): void {
    this.listen('hotspot:triggered', (payload: { hotspot: Hotspot; def: HotspotDef }) => {
      const job = () => this.handleHotspot(payload.hotspot, payload.def);
      this.hotspotChain = this.hotspotChain.then(job, job).catch((e) => {
        console.warn('InteractionCoordinator: hotspot handling failed', e);
      });
    });
    this.listen('npc:interact', (payload: { npc: Npc }) => {
      void this.handleNpc(payload.npc).catch((e) => {
        console.warn('InteractionCoordinator: npc interact failed', e);
      });
    });
  }

  private listen(event: string, fn: (...args: any[]) => void): void {
    this.eventBus.on(event, fn);
    this.boundCallbacks.push({ event, fn });
  }

  private async handleHotspot(hotspot: Hotspot, def: HotspotDef): Promise<void> {
    const { stateController, sceneManager } = this.deps;
    if (stateController.currentState !== GameState.Exploring) return;
    if (sceneManager.switching) return;

    this.eventBus.emit('hotspot:interact', { hotspotId: def.id, type: def.type });

    switch (def.type) {
      case 'inspect':
        await this.handleInspect(hotspot, def.data as InspectData);
        break;
      case 'pickup':
        await this.handlePickup(hotspot, def.data as PickupData);
        break;
      case 'transition':
        await this.handleTransition(def.data as TransitionData);
        break;
      case 'encounter':
        await this.handleEncounterTrigger(hotspot, def.data as EncounterTriggerData);
        break;
    }
  }

  private async handleNpc(npc: Npc): Promise<void> {
    const {
      stateController,
      sceneManager,
      dialogueManager,
      graphDialogueManager,
      eventBus,
      getPlayerWorldPos,
      getCameraZoom,
    } = this.deps;
    if (stateController.currentState !== GameState.Exploring) return;
    if (dialogueManager.isActive || graphDialogueManager.isActive) return;

    const graphId = npc.def.dialogueGraphId?.trim();
    if (!graphId) return;

    this.deps.preparePlayerForNpcDialogue(npc);
    const pos = getPlayerWorldPos();
    npc.pausePatrolAndFaceForDialogue(pos.x, pos.y);

    const rawZ = npc.def.dialogueCameraZoom;
    const sceneZ = sceneManager.currentSceneData?.camera?.zoom;
    /** 场景 JSON 基线 zoom；缺省按 1。与「未配 dialogueCameraZoom 时候选为 1」一起做下限，避免仅广角场景时无法向 1 拉近。 */
    const sceneBaseline =
      sceneZ !== undefined && Number.isFinite(sceneZ) && sceneZ > 0 ? sceneZ : 1;
    /** 未配置 NPC 时仍为 1（经典对话画幅），勿改为 sceneBaseline，否则 scene.zoom<1 时开场无任何拉近。 */
    const candidate =
      rawZ !== undefined && Number.isFinite(rawZ) && rawZ > 0 ? rawZ : 1;
    const currentZoom = getCameraZoom();
    const targetZoom = Math.max(currentZoom, candidate, sceneBaseline);

    let dialogueCleanupDone = false;
    const cleanupDialogueZoomAndNpc = () => {
      if (dialogueCleanupDone) return;
      dialogueCleanupDone = true;
      npc.onDialogueEnd();
      eventBus.off('dialogue:end', onDialogueEnd);
      this.deps.fadingRestoreSceneCameraZoom(NPC_DIALOGUE_CAMERA_ZOOM_MS);
    };

    const onDialogueEnd = (p?: DialogueEndPayload) => {
      /** R5：只认本会话（图对话）自身的**最终**结束。嵌套 playScriptedDialogue 的 end
       *  （source='scripted'）与 deferred 链式接续的中间 end（willContinue）期间对话仍在进行，
       *  NPC 不得中途恢复巡逻走开、镜头不得提前复位。 */
      if (p?.source !== 'graph' || p.willContinue === true) return;
      cleanupDialogueZoomAndNpc();
    };
    eventBus.on('dialogue:end', onDialogueEnd);

    if (targetZoom !== currentZoom) {
      this.deps.fadingDialogueCameraZoom(targetZoom, NPC_DIALOGUE_CAMERA_ZOOM_MS);
    }

    stateController.setState(GameState.Dialogue);
    try {
      await graphDialogueManager.startDialogueGraph({
        graphId,
        entry: npc.def.dialogueGraphEntry?.trim() || undefined,
        npcName: npc.def.name,
        npcId: npc.def.id,
        ownerType: 'npc',
        ownerId: npc.def.id,
      });
      /** hasPendingChainContinuation：图同步完结但链式接续图正在启动（会话未终结），
       *  不得按启动失败处理；收尾与状态恢复交给最终 dialogue:end / EventBridge */
      if (!graphDialogueManager.isActive && !graphDialogueManager.hasPendingChainContinuation) {
        cleanupDialogueZoomAndNpc();
        stateController.setState(GameState.Exploring);
      }
    } catch (e) {
      cleanupDialogueZoomAndNpc();
      console.warn('InteractionCoordinator: startDialogue failed', e);
      stateController.setState(GameState.Exploring);
    }
  }

  async debugTriggerHotspotById(hotspotId: string): Promise<boolean> {
    const id = hotspotId.trim();
    if (!id) return false;
    const hotspot = this.deps.sceneManager.getCurrentHotspots().find((h) => h.def.id === id);
    if (!hotspot) return false;
    await this.handleHotspot(hotspot, hotspot.def);
    return true;
  }

  async debugInteractNpcById(npcId: string): Promise<boolean> {
    const id = npcId.trim();
    if (!id) return false;
    const npc = this.deps.sceneManager.getNpcById(id);
    if (!npc) return false;
    await this.handleNpc(npc);
    return true;
  }

  private async handleInspect(hotspot: Hotspot, data: InspectData): Promise<void> {
    if (!inspectDataHasInteractablePayload(data)) {
      return;
    }

    const graphId = 'graphId' in data && typeof data.graphId === 'string' ? data.graphId.trim() : '';
    if (graphId) {
      await this.handleInspectGraph(hotspot, data as InspectDataGraphMode, graphId);
      return;
    }

    const { stateController, inspectBox, eventBus, actionExecutor } = this.deps;
    const text = 'text' in data && typeof data.text === 'string' ? data.text : '';
    const trimmed = text.trim();
    if (trimmed) {
      stateController.setState(GameState.UIOverlay);
      await inspectBox.show(text);
    }
    eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
    if (data.actions) {
      try {
        await actionExecutor.executeBatchAwait(data.actions);
      } catch (e) {
        console.warn('InteractionCoordinator: inspect actions failed', e);
      }
    }
    if (stateController.currentState === GameState.UIOverlay) {
      stateController.setState(GameState.Exploring);
    }
  }

  /** Inspect 热区配置 `graphId` 时走图对话（与 NPC 共用 GraphDialogueManager，无镜头拉近） */
  private async handleInspectGraph(
    hotspot: Hotspot,
    data: InspectDataGraphMode,
    graphId: string,
  ): Promise<void> {
    const { stateController, graphDialogueManager, eventBus, actionExecutor } = this.deps;
    if (stateController.currentState !== GameState.Exploring) return;
    if (graphDialogueManager.isActive) return;

    let cleanupDone = false;
    const onDialogueEnd = (p?: DialogueEndPayload) => {
      /** R5：同 NPC 路径——嵌套脚本台词 / 链式接续的中间 end 不触发 inspect 收尾
       *  （提前跑 data.actions、强切 Exploring 会让剩余图对话在探索态播放） */
      if (p?.source !== 'graph' || p.willContinue === true) return;
      if (cleanupDone) return;
      cleanupDone = true;
      eventBus.off('dialogue:end', onDialogueEnd);
      eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
      void (async () => {
        if (data.actions?.length) {
          try {
            await actionExecutor.executeBatchAwait(data.actions);
          } catch (e) {
            console.warn('InteractionCoordinator: inspect graph actions failed', e);
          }
        }
        if (stateController.currentState === GameState.Dialogue) {
          stateController.setState(GameState.Exploring);
        }
      })();
    };

    eventBus.on('dialogue:end', onDialogueEnd);
    stateController.setState(GameState.Dialogue);
    try {
      await graphDialogueManager.startDialogueGraph({
        graphId,
        entry: data.entry?.trim() || undefined,
        npcName: '旁白',
        ownerType: 'hotspot',
        ownerId: hotspot.def.id,
        preferGraphMetaTitle: true,
      });
      /** 同 NPC 路径：链式接续中不得按启动失败提前收尾 */
      if (!graphDialogueManager.isActive && !graphDialogueManager.hasPendingChainContinuation) {
        if (!cleanupDone) {
          cleanupDone = true;
          eventBus.off('dialogue:end', onDialogueEnd);
        }
        stateController.setState(GameState.Exploring);
      }
    } catch (e) {
      if (!cleanupDone) {
        cleanupDone = true;
        eventBus.off('dialogue:end', onDialogueEnd);
      }
      console.warn('InteractionCoordinator: inspect graph failed', e);
      stateController.setState(GameState.Exploring);
    }
  }

  private async handlePickup(hotspot: Hotspot, data: PickupData): Promise<void> {
    const { actionExecutor, eventBus } = this.deps;
    await actionExecutor.executeAwait({
      type: 'pickup',
      params: { itemId: data.itemId, itemName: data.itemName, count: data.count, isCurrency: data.isCurrency },
    });
    await actionExecutor.executeAwait({ type: 'setFlag', params: { key: FlagKeys.hotspotPickedUp(hotspot.def.id), value: true } });
    eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
  }

  private async handleEncounterTrigger(
    hotspot: Hotspot,
    data: EncounterTriggerData,
  ): Promise<void> {
    const { actionExecutor, eventBus } = this.deps;
    /** B22：只有真正进入遭遇才消费热点（失活为会话级、不入档——世界系统批次已定的语义）。
     *  成败判据用 encounter:start 事件而非 currentState——startEncounter 传未知 id 时
     *  状态可能残留在 Encounter（R13），事件才是可靠信号。 */
    let encounterStarted = false;
    const onEncounterStart = () => { encounterStarted = true; };
    eventBus.on('encounter:start', onEncounterStart);
    try {
      await actionExecutor.executeAwait({
        type: 'startEncounter',
        params: { id: data.encounterId },
      });
    } catch (e) {
      console.warn('InteractionCoordinator: startEncounter failed', e);
    } finally {
      eventBus.off('encounter:start', onEncounterStart);
    }
    if (encounterStarted) {
      eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
    } else {
      console.warn(
        `InteractionCoordinator: 遭遇 ${data.encounterId} 未能启动，热点 ${hotspot.def.id} 保持可交互以便重试`,
      );
    }
  }

  private async handleTransition(data: TransitionData): Promise<void> {
    await this.deps.actionExecutor.executeAwait({
      type: 'switchScene',
      params: { targetScene: data.targetScene, targetSpawnPoint: data.targetSpawnPoint },
    });
  }

  destroy(): void {
    for (const { event, fn } of this.boundCallbacks) this.eventBus.off(event, fn);
    this.boundCallbacks = [];
    this.hotspotChain = Promise.resolve();
  }
}
