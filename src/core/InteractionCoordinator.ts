import type { EventBus } from './EventBus';
import type { ActionExecutor } from './ActionExecutor';
import type { GameStateController } from './GameStateController';
import type { SceneManager } from '../systems/SceneManager';
import type { DialogueManager } from '../systems/DialogueManager';
import type { Hotspot } from '../entities/Hotspot';
import type { Npc } from '../entities/Npc';
import type { HotspotDef, InspectData, PickupData, TransitionData, EncounterTriggerData } from '../data/types';
import { GameState } from '../data/types';

export interface InteractionDeps {
  stateController: GameStateController;
  sceneManager: SceneManager;
  dialogueManager: DialogueManager;
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

  constructor(eventBus: EventBus, deps: InteractionDeps) {
    this.eventBus = eventBus;
    this.deps = deps;
  }

  init(): void {
    this.listen('hotspot:triggered', (payload: { hotspot: Hotspot; def: HotspotDef }) => {
      this.handleHotspot(payload.hotspot, payload.def);
    });
    this.listen('npc:interact', (payload: { npc: Npc }) => {
      this.handleNpc(payload.npc);
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
        this.handlePickup(hotspot, def.data as PickupData);
        break;
      case 'transition':
        this.handleTransition(def.data as TransitionData);
        break;
      case 'encounter':
        this.handleEncounterTrigger(hotspot, def.data as EncounterTriggerData);
        break;
    }
  }

  private async handleNpc(npc: Npc): Promise<void> {
    const { stateController, dialogueManager, eventBus, getPlayerWorldPos } = this.deps;
    if (stateController.currentState !== GameState.Exploring) return;
    if (dialogueManager.isActive) return;

    const inkPath = npc.def.dialogueFile?.trim();
    if (!inkPath) return;

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
      await dialogueManager.startDialogue(inkPath, npc.def.name, npc.def.dialogueKnot);
    } catch (e) {
      cleanupDialogueZoomAndNpc();
      console.warn('InteractionCoordinator: startDialogue failed', e);
      stateController.setState(GameState.Exploring);
    }
  }

  private async handleInspect(hotspot: Hotspot, data: InspectData): Promise<void> {
    const { stateController, inspectBox, eventBus, actionExecutor } = this.deps;
    stateController.setState(GameState.UIOverlay);
    await inspectBox.show(data.text);
    eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
    if (data.actions) await actionExecutor.executeBatchSequential(data.actions);
    if (stateController.currentState === GameState.UIOverlay) {
      stateController.setState(GameState.Exploring);
    }
  }

  private handlePickup(hotspot: Hotspot, data: PickupData): void {
    const { actionExecutor, eventBus } = this.deps;
    actionExecutor.execute({
      type: 'pickup',
      params: { itemId: data.itemId, itemName: data.itemName, count: data.count, isCurrency: data.isCurrency },
    });
    actionExecutor.execute({ type: 'setFlag', params: { key: `picked_up_${hotspot.def.id}`, value: true } });
    eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
  }

  private handleEncounterTrigger(hotspot: Hotspot, data: EncounterTriggerData): void {
    this.deps.actionExecutor.execute({ type: 'startEncounter', params: { id: data.encounterId } });
    this.deps.eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
  }

  private handleTransition(data: TransitionData): void {
    this.deps.actionExecutor.execute({
      type: 'switchScene',
      params: { targetScene: data.targetScene, targetSpawnPoint: data.targetSpawnPoint },
    });
  }

  destroy(): void {
    for (const { event, fn } of this.boundCallbacks) this.eventBus.off(event, fn);
    this.boundCallbacks = [];
  }
}
