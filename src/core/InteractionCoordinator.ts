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
}

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
    const { stateController, dialogueManager } = this.deps;
    if (stateController.currentState !== GameState.Exploring) return;
    if (dialogueManager.isActive) return;

    const inkPath = npc.def.dialogueFile?.trim();
    if (!inkPath) return;

    stateController.setState(GameState.Dialogue);
    await dialogueManager.startDialogue(inkPath, npc.def.name, npc.def.dialogueKnot);
  }

  private async handleInspect(hotspot: Hotspot, data: InspectData): Promise<void> {
    const { stateController, inspectBox, eventBus, actionExecutor } = this.deps;
    stateController.setState(GameState.UIOverlay);
    await inspectBox.show(data.text);
    eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
    if (data.actions) actionExecutor.executeBatch(data.actions);
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
