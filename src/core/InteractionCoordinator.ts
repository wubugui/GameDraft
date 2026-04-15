import type { EventBus } from './EventBus';
import type { ActionExecutor } from './ActionExecutor';
import type { GameStateController } from './GameStateController';
import type { SceneManager } from '../systems/SceneManager';
import type { DialogueManager } from '../systems/DialogueManager';
import type { GraphDialogueManager } from '../systems/GraphDialogueManager';
import type { Hotspot } from '../entities/Hotspot';
import type { Npc } from '../entities/Npc';
import type {
  HotspotDef,
  InspectData,
  InspectDataGraphMode,
  PickupData,
  TransitionData,
  EncounterTriggerData,
} from '../data/types';
import { GameState } from '../data/types';

export interface InteractionDeps {
  stateController: GameStateController;
  sceneManager: SceneManager;
  dialogueManager: DialogueManager;
  graphDialogueManager: GraphDialogueManager;
  actionExecutor: ActionExecutor;
  inspectBox: { show(text: string): Promise<void>; readonly isOpen: boolean; close(): void };
  eventBus: EventBus;
  getPlayerWorldPos: () => { x: number; y: number };
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
        this.handleEncounterTrigger(hotspot, def.data as EncounterTriggerData);
        break;
    }
  }

  private async handleNpc(npc: Npc): Promise<void> {
    const { stateController, dialogueManager, graphDialogueManager, eventBus, getPlayerWorldPos } = this.deps;
    if (stateController.currentState !== GameState.Exploring) return;
    if (dialogueManager.isActive || graphDialogueManager.isActive) return;

    const graphId = npc.def.dialogueGraphId?.trim();
    if (!graphId) return;

    this.deps.preparePlayerForNpcDialogue(npc);
    const pos = getPlayerWorldPos();
    npc.pausePatrolAndFaceForDialogue(pos.x, pos.y);

    const rawZ = npc.def.dialogueCameraZoom;
    const targetZoom =
      rawZ !== undefined && Number.isFinite(rawZ) && rawZ > 0 ? rawZ : 1;

    let dialogueCleanupDone = false;
    const cleanupDialogueZoomAndNpc = () => {
      if (dialogueCleanupDone) return;
      dialogueCleanupDone = true;
      npc.onDialogueEnd();
      eventBus.off('dialogue:end', onDialogueEnd);
      this.deps.fadingRestoreSceneCameraZoom(NPC_DIALOGUE_CAMERA_ZOOM_MS);
    };

    const onDialogueEnd = () => {
      cleanupDialogueZoomAndNpc();
    };
    eventBus.on('dialogue:end', onDialogueEnd);

    this.deps.fadingDialogueCameraZoom(targetZoom, NPC_DIALOGUE_CAMERA_ZOOM_MS);

    stateController.setState(GameState.Dialogue);
    try {
      await graphDialogueManager.startDialogueGraph({
        graphId,
        entry: npc.def.dialogueGraphEntry?.trim() || undefined,
        npcName: npc.def.name,
        npcId: npc.def.id,
      });
      if (!graphDialogueManager.isActive) {
        cleanupDialogueZoomAndNpc();
        stateController.setState(GameState.Exploring);
      }
    } catch (e) {
      cleanupDialogueZoomAndNpc();
      console.warn('InteractionCoordinator: startDialogue failed', e);
      stateController.setState(GameState.Exploring);
    }
  }

  private async handleInspect(hotspot: Hotspot, data: InspectData): Promise<void> {
    const graphId = 'graphId' in data && typeof data.graphId === 'string' ? data.graphId.trim() : '';
    if (graphId) {
      await this.handleInspectGraph(hotspot, data as InspectDataGraphMode, graphId);
      return;
    }

    const { stateController, inspectBox, eventBus, actionExecutor } = this.deps;
    const text = 'text' in data && typeof data.text === 'string' ? data.text : '';
    stateController.setState(GameState.UIOverlay);
    await inspectBox.show(text);
    eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
    if (data.actions) {
      try {
        await actionExecutor.executeBatchSequential(data.actions);
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
    const onDialogueEnd = () => {
      if (cleanupDone) return;
      cleanupDone = true;
      eventBus.off('dialogue:end', onDialogueEnd);
      eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
      void (async () => {
        if (data.actions?.length) {
          try {
            await actionExecutor.executeBatchSequential(data.actions);
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
        preferGraphMetaTitle: true,
      });
      if (!graphDialogueManager.isActive) {
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
    await actionExecutor.executeAwait({ type: 'setFlag', params: { key: `picked_up_${hotspot.def.id}`, value: true } });
    eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
  }

  private handleEncounterTrigger(hotspot: Hotspot, data: EncounterTriggerData): void {
    this.deps.actionExecutor.execute({ type: 'startEncounter', params: { id: data.encounterId } });
    this.deps.eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
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
