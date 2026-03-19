import { Container, Graphics, Sprite } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import { Hotspot } from '../entities/Hotspot';
import { Npc } from '../entities/Npc';
import { createPlaceholderBackground } from '../rendering/PlaceholderFactory';
import type { SceneData, SceneRuntimeState, Position, GameContext, AnimationSetDef } from '../data/types';
import type { IGameSystem } from '../data/types';

const SCENE_BOUNDARY_MARGIN = 40;

function sceneBoundaryCollisions(width: number, height: number): { x: number; y: number; width: number; height: number }[] {
  const m = SCENE_BOUNDARY_MARGIN;
  return [
    { x: 0, y: 0, width, height: m },
    { x: 0, y: 0, width: m, height },
    { x: width - m, y: 0, width: m, height },
    { x: 0, y: height - m, width, height: m },
  ];
}

interface SceneMemory {
  inspectedHotspots: string[];
  pickedUpHotspots: string[];
}

export class SceneManager implements IGameSystem {
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private renderer: Renderer;

  private currentScene: SceneData | null = null;
  private currentHotspots: Hotspot[] = [];
  private currentNpcs: Npc[] = [];
  private sceneContainerBg: Container | null = null;
  private sceneContainerFg: Container | null = null;
  private sceneMemory: Map<string, SceneMemory> = new Map();

  private fadeOverlay: Graphics | null = null;
  private isSwitching: boolean = false;

  private collisionSetter: ((collisions: { x: number; y: number; width: number; height: number }[]) => void) | null = null;
  private playerPositionSetter: ((x: number, y: number) => void) | null = null;
  private cameraSetter: ((w: number, h: number, x: number, y: number) => void) | null = null;
  private audioApplier: ((bgm?: string, ambient?: string[]) => void) | null = null;
  private zoneSetter: ((zones: import('../data/types').ZoneDef[]) => void) | null = null;
  private interactionSetter: ((hotspots: Hotspot[], npcs: Npc[]) => void) | null = null;

  private onHotspotPickup: (payload: { hotspotId: string }) => void;
  private onHotspotInspected: (payload: { hotspotId: string }) => void;

  constructor(
    assetManager: AssetManager,
    eventBus: EventBus,
    renderer: Renderer,
  ) {
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.renderer = renderer;

    this.onHotspotPickup = (payload) => this.markHotspotPickedUp(payload.hotspotId);
    this.onHotspotInspected = (payload) => this.markHotspotInspected(payload.hotspotId);
  }

  init(_ctx: GameContext): void {
    this.eventBus.on('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.on('hotspot:inspected', this.onHotspotInspected);
  }

  update(_dt: number): void {}

  setCollisionSetter(fn: (collisions: { x: number; y: number; width: number; height: number }[]) => void): void {
    this.collisionSetter = fn;
  }

  setPlayerPositionSetter(fn: (x: number, y: number) => void): void {
    this.playerPositionSetter = fn;
  }

  setCameraSetter(fn: (boundsW: number, boundsH: number, snapX: number, snapY: number) => void): void {
    this.cameraSetter = fn;
  }

  setAudioApplier(fn: (bgm?: string, ambient?: string[]) => void): void {
    this.audioApplier = fn;
  }

  setZoneSetter(fn: (zones: import('../data/types').ZoneDef[]) => void): void {
    this.zoneSetter = fn;
  }

  setInteractionSetter(fn: (hotspots: Hotspot[], npcs: Npc[]) => void): void {
    this.interactionSetter = fn;
  }

  get currentSceneData() { return this.currentScene; }

  getNpcById(id: string): Npc | null {
    return this.currentNpcs.find(n => n.id === id) ?? null;
  }

  getCurrentNpcs(): readonly Npc[] {
    return this.currentNpcs;
  }

  get switching(): boolean {
    return this.isSwitching;
  }

  async loadScene(sceneId: string, spawnPointId?: string, cameraPosition?: { x: number; y: number }): Promise<void> {
    const sceneData = await this.assetManager.loadSceneData(sceneId);
    this.currentScene = sceneData;

    if (sceneData.backgrounds.length > 0) {
      this.sceneContainerBg = new Container();
      const scale = sceneData.backgroundScale ?? 1;
      const layers = [...sceneData.backgrounds].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      for (const layer of layers) {
        try {
          const texture = await this.assetManager.loadTexture(layer.image);
          const sprite = new Sprite(texture);
          sprite.x = layer.x ?? 0;
          sprite.y = layer.y ?? 0;
          sprite.scale.set(scale);
          this.sceneContainerBg.addChild(sprite);
        } catch (_e) {
          // 加载失败时跳过该层
        }
      }
    } else {
      this.sceneContainerBg = createPlaceholderBackground(
        this.renderer.app,
        sceneData.width,
        sceneData.height,
        sceneData.collisions,
      );
    }
    this.renderer.backgroundLayer.addChild(this.sceneContainerBg);

    if (sceneData.foregrounds && sceneData.foregrounds.length > 0) {
      this.sceneContainerFg = new Container();
      const fgLayers = [...sceneData.foregrounds].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      for (const layer of fgLayers) {
        try {
          const texture = await this.assetManager.loadTexture(layer.image);
          const sprite = new Sprite(texture);
          sprite.x = layer.x ?? 0;
          sprite.y = layer.y ?? 0;
          sprite.scale.set(
            sceneData.width / texture.width,
            sceneData.height / texture.height,
          );
          this.sceneContainerFg.addChild(sprite);
        } catch (_e) {
          // 加载失败时跳过该层
        }
      }
      this.renderer.foregroundLayer.addChild(this.sceneContainerFg);
    } else {
      this.sceneContainerFg = null;
    }

    const boundary = sceneBoundaryCollisions(sceneData.width, sceneData.height);
    this.collisionSetter?.([...boundary, ...sceneData.collisions]);

    const memory = this.sceneMemory.get(sceneId);

    if (sceneData.hotspots) {
      for (const def of sceneData.hotspots) {
        if (memory?.pickedUpHotspots.includes(def.id)) continue;

        const hotspot = new Hotspot(def);
        this.currentHotspots.push(hotspot);
        this.renderer.entityLayer.addChild(hotspot.container);
      }
    }

    if (sceneData.npcs) {
      for (const npcDef of sceneData.npcs) {
        const npc = new Npc(npcDef);
        if (npcDef.animFile) {
          try {
            const animDef = await this.assetManager.loadJson<AnimationSetDef>(npcDef.animFile);
            const tex = await this.assetManager.loadTexture(animDef.spritesheet);
            npc.loadSprite(tex, animDef);
          } catch (_e) {
            // 加载失败时保留占位外观
          }
        }
        this.currentNpcs.push(npc);
        this.renderer.entityLayer.addChild(npc.container);
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);

    let spawn: Position = sceneData.spawnPoint;
    if (spawnPointId && sceneData.spawnPoints?.[spawnPointId]) {
      spawn = sceneData.spawnPoints[spawnPointId];
    }
    const posX = cameraPosition?.x ?? spawn.x;
    const posY = cameraPosition?.y ?? spawn.y;
    this.playerPositionSetter?.(posX, posY);
    this.cameraSetter?.(sceneData.width, sceneData.height, posX, posY);

    this.audioApplier?.(sceneData.bgm, sceneData.ambientSounds);
    this.zoneSetter?.(sceneData.zones ?? []);

    this.eventBus.emit('scene:enter', { sceneId, fromSceneId: null, sceneName: sceneData.name });
    this.eventBus.emit('scene:ready');
  }

  unloadScene(): void {
    this.interactionSetter?.([], []);

    for (const hotspot of this.currentHotspots) {
      hotspot.destroy();
    }
    this.currentHotspots = [];

    for (const npc of this.currentNpcs) {
      npc.destroy();
    }
    this.currentNpcs = [];

    if (this.sceneContainerBg) {
      this.renderer.backgroundLayer.removeChild(this.sceneContainerBg);
      this.sceneContainerBg.destroy({ children: true });
      this.sceneContainerBg = null;
    }

    if (this.sceneContainerFg) {
      this.renderer.foregroundLayer.removeChild(this.sceneContainerFg);
      this.sceneContainerFg.destroy({ children: true });
      this.sceneContainerFg = null;
    }

    this.collisionSetter?.([]);
    this.zoneSetter?.([]);
    this.currentScene = null;
  }

  async switchScene(targetSceneId: string, spawnPointId?: string, cameraPosition?: { x: number; y: number }): Promise<void> {
    if (this.isSwitching) return;
    this.isSwitching = true;

    this.saveCurrentSceneMemory();

    await this.fadeOut(300);

    const fromSceneId = this.currentScene?.id ?? null;
    this.unloadScene();
    await this.loadScene(targetSceneId, spawnPointId, cameraPosition);

    if (fromSceneId) {
      this.eventBus.emit('scene:enter', { sceneId: targetSceneId, fromSceneId, sceneName: this.currentScene?.name ?? targetSceneId });
    }

    await this.fadeIn(300);

    this.isSwitching = false;
  }

  private saveCurrentSceneMemory(): void {
    if (!this.currentScene) return;

    const inspected: string[] = [];
    const pickedUp: string[] = [];

    for (const hotspot of this.currentHotspots) {
      if (!hotspot.active && hotspot.def.type === 'pickup') {
        pickedUp.push(hotspot.def.id);
      }
    }

    const existing = this.sceneMemory.get(this.currentScene.id);
    if (existing) {
      for (const id of existing.inspectedHotspots) {
        if (!inspected.includes(id)) inspected.push(id);
      }
      for (const id of existing.pickedUpHotspots) {
        if (!pickedUp.includes(id)) pickedUp.push(id);
      }
    }

    this.sceneMemory.set(this.currentScene.id, {
      inspectedHotspots: inspected,
      pickedUpHotspots: pickedUp,
    });
  }

  private markHotspotPickedUp(hotspotId: string): void {
    const hotspot = this.currentHotspots.find(h => h.def.id === hotspotId);
    if (hotspot) {
      hotspot.setInactive();
    }
  }

  private markHotspotInspected(hotspotId: string): void {
    if (!this.currentScene) return;
    const mem = this.sceneMemory.get(this.currentScene.id);
    if (mem && !mem.inspectedHotspots.includes(hotspotId)) {
      mem.inspectedHotspots.push(hotspotId);
    }
  }

  private async fadeOut(durationMs: number): Promise<void> {
    this.ensureFadeOverlay();
    this.fadeOverlay!.alpha = 0;
    await this.animateAlpha(this.fadeOverlay!, 0, 1, durationMs);
  }

  private async fadeIn(durationMs: number): Promise<void> {
    this.ensureFadeOverlay();
    this.fadeOverlay!.alpha = 1;
    await this.animateAlpha(this.fadeOverlay!, 1, 0, durationMs);
    this.removeFadeOverlay();
  }

  private ensureFadeOverlay(): void {
    if (!this.fadeOverlay) {
      this.fadeOverlay = new Graphics();
      this.fadeOverlay.rect(0, 0, this.renderer.screenWidth + 200, this.renderer.screenHeight + 200);
      this.fadeOverlay.fill(0x000000);
      this.fadeOverlay.x = -100;
      this.fadeOverlay.y = -100;
      this.renderer.uiLayer.addChild(this.fadeOverlay);
    }
  }

  private removeFadeOverlay(): void {
    if (this.fadeOverlay) {
      if (this.fadeOverlay.parent) {
        this.fadeOverlay.parent.removeChild(this.fadeOverlay);
      }
      this.fadeOverlay.destroy();
      this.fadeOverlay = null;
    }
  }

  private animateAlpha(target: { alpha: number }, from: number, to: number, durationMs: number): Promise<void> {
    return new Promise(resolve => {
      const startTime = performance.now();
      target.alpha = from;

      const tick = () => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / durationMs, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  serialize(): object {
    const data: Record<string, { inspected: string[]; pickedUp: string[] }> = {};
    this.sceneMemory.forEach((mem, sceneId) => {
      data[sceneId] = {
        inspected: mem.inspectedHotspots,
        pickedUp: mem.pickedUpHotspots,
      };
    });
    return { currentSceneId: this.currentScene?.id ?? null, memory: data };
  }

  deserialize(data: { currentSceneId: string | null; memory: Record<string, { inspected: string[]; pickedUp: string[] }> }): void {
    this.sceneMemory.clear();
    for (const [sceneId, mem] of Object.entries(data.memory)) {
      this.sceneMemory.set(sceneId, {
        inspectedHotspots: mem.inspected,
        pickedUpHotspots: mem.pickedUp,
      });
    }
  }

  destroy(): void {
    this.eventBus.off('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.off('hotspot:inspected', this.onHotspotInspected);
    this.unloadScene();
    this.removeFadeOverlay();
    this.sceneMemory.clear();
    this.collisionSetter = null;
    this.playerPositionSetter = null;
    this.cameraSetter = null;
    this.audioApplier = null;
    this.zoneSetter = null;
    this.interactionSetter = null;
  }
}
