import { Container, Graphics, Sprite } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import { Hotspot } from '../entities/Hotspot';
import { Npc } from '../entities/Npc';
import { createPlaceholderBackground } from '../rendering/PlaceholderFactory';
import type {
  SceneData,
  SceneRuntimeState,
  Position,
  GameContext,
  SceneCameraConfig,
  NpcPersistentSnapshot,
} from '../data/types';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { resolvePathRelativeToAnimManifest } from '../core/assetPath';
import type { IGameSystem } from '../data/types';

/** applyDebugWorldSize 成功时的返回值，供深度系统与碰撞比例同步 */
export type ApplyDebugWorldSizeResult =
  | { ok: true; worldToPixelX: number; worldToPixelY: number }
  | { ok: false };

interface SceneMemory {
  inspectedHotspots: string[];
  pickedUpHotspots: string[];
  npcSnapshots: Record<string, NpcPersistentSnapshot>;
}

export class SceneManager implements IGameSystem {
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private renderer: Renderer;

  private currentScene: SceneData | null = null;
  private currentHotspots: Hotspot[] = [];
  private currentNpcs: Npc[] = [];
  private sceneContainerBg: Container | null = null;
  private sceneMemory: Map<string, SceneMemory> = new Map();

  private fadeOverlay: Graphics | null = null;
  private isSwitching: boolean = false;
  private animRafId: number = 0;

  private playerPositionSetter: ((x: number, y: number) => void) | null = null;
  private cameraSetter: ((boundsW: number, boundsH: number, snapX: number, snapY: number, cameraConfig?: SceneCameraConfig, worldScale?: number) => void) | null = null;
  private boundsOnlySetter: ((boundsW: number, boundsH: number) => void) | null = null;
  private audioApplier: ((bgm?: string, ambient?: string[]) => void) | null = null;
  private zoneSetter: ((zones: import('../data/types').ZoneDef[]) => void) | null = null;
  private interactionSetter: ((hotspots: Hotspot[], npcs: Npc[]) => void) | null = null;
  private depthLoader: ((sceneId: string, sceneData: SceneData, worldToPixelX: number, worldToPixelY: number) => Promise<void>) | null = null;
  private depthUnloader: (() => void) | null = null;

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

  setPlayerPositionSetter(fn: (x: number, y: number) => void): void {
    this.playerPositionSetter = fn;
  }

  setCameraSetter(fn: (boundsW: number, boundsH: number, snapX: number, snapY: number, cameraConfig?: SceneCameraConfig, worldScale?: number) => void): void {
    this.cameraSetter = fn;
  }

  /** 仅更新相机边界（不 snap），供调试改 world 尺寸时用 */
  setBoundsOnlySetter(fn: (boundsW: number, boundsH: number) => void): void {
    this.boundsOnlySetter = fn;
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

  setDepthLoader(fn: (sceneId: string, sceneData: SceneData, worldToPixelX: number, worldToPixelY: number) => Promise<void>): void {
    this.depthLoader = fn;
  }

  setDepthUnloader(fn: () => void): void {
    this.depthUnloader = fn;
  }

  get currentSceneData() { return this.currentScene; }

  getNpcById(id: string): Npc | null {
    return this.currentNpcs.find(n => n.id === id) ?? null;
  }

  getCurrentNpcs(): readonly Npc[] {
    return this.currentNpcs;
  }

  getCurrentHotspots(): readonly Hotspot[] {
    return this.currentHotspots;
  }

  get switching(): boolean {
    return this.isSwitching;
  }

  /**
   * 合并当前场景内某 NPC 的持久快照（仅 `persistNpc*` Action 应调用）。
   * 不写场景 JSON；随 `sceneMemory` 进存档。
   */
  mergePersistentNpcState(npcId: string, patch: Partial<NpcPersistentSnapshot>): void {
    const sceneId = this.currentScene?.id;
    if (!sceneId) {
      console.warn('SceneManager.mergePersistentNpcState: 无当前场景');
      return;
    }
    const id = npcId.trim();
    if (!id) {
      console.warn('SceneManager.mergePersistentNpcState: 空 npcId');
      return;
    }
    let mem = this.sceneMemory.get(sceneId);
    if (!mem) {
      mem = { inspectedHotspots: [], pickedUpHotspots: [], npcSnapshots: {} };
      this.sceneMemory.set(sceneId, mem);
    } else if (!mem.npcSnapshots) {
      mem.npcSnapshots = {};
    }
    const prev = mem.npcSnapshots[id] ?? {};
    mem.npcSnapshots[id] = { ...prev, ...patch };
  }

  /** 再次进入场景时是否不应启动该 NPC 的巡逻 */
  isNpcPatrolPersistentlyDisabled(npcId: string): boolean {
    const sid = this.currentScene?.id;
    if (!sid) return false;
    const mem = this.sceneMemory.get(sid);
    return mem?.npcSnapshots?.[npcId]?.patrolDisabled === true;
  }

  /**
   * 调试：在内存中修改当前场景的 worldWidth / worldHeight（不写 JSON）。
   * 重算背景精灵缩放与相机边界；热点/NPC 世界坐标不变。
   */
  applyDebugWorldSize(width: number, height: number): ApplyDebugWorldSizeResult {
    const scene = this.currentScene;
    const bg = this.sceneContainerBg;
    if (!scene || !bg || !Number.isFinite(width) || !Number.isFinite(height)) return { ok: false };

    const minSz = 50;
    const maxSz = 10_000_000;
    const w = Math.max(minSz, Math.min(maxSz, width));
    const h = Math.max(minSz, Math.min(maxSz, height));

    const oldW = scene.worldWidth;
    const oldH = scene.worldHeight;
    if (oldW <= 0 || oldH <= 0) return { ok: false };

    scene.worldWidth = w;
    scene.worldHeight = h;

    let worldToPixelX = 1;
    let worldToPixelY = 1;

    let foundSprite = false;
    for (const child of bg.children) {
      if (child instanceof Sprite && child.texture?.width > 0 && child.texture?.height > 0) {
        foundSprite = true;
        child.scale.set(w / child.texture.width, h / child.texture.height);
      }
    }
    if (!foundSprite && oldW > 0 && oldH > 0) {
      bg.scale.x *= w / oldW;
      bg.scale.y *= h / oldH;
    }

    if (foundSprite) {
      const first = bg.children.find(
        (c): c is Sprite => c instanceof Sprite && c.texture?.width > 0 && c.texture?.height > 0,
      );
      if (first) {
        worldToPixelX = first.texture.width / w;
        worldToPixelY = first.texture.height / h;
      }
    }

    this.boundsOnlySetter?.(w, h);

    return { ok: true, worldToPixelX, worldToPixelY };
  }

  async loadScene(sceneId: string, spawnPointId?: string, cameraPosition?: { x: number; y: number }, fromSceneId?: string | null): Promise<void> {
    const sceneData = await this.assetManager.loadSceneData(sceneId);
    this.currentScene = sceneData;

    // 计算世界→像素的转换比例（用于碰撞检测）
    let worldToPixelX = 1;
    let worldToPixelY = 1;

    if (sceneData.backgrounds.length > 0) {
      this.sceneContainerBg = new Container();
      const layers = [...sceneData.backgrounds].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

      let firstTexWidth = 0;
      let firstTexHeight = 0;

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        try {
          const texture = await this.assetManager.loadTexture(layer.image);
          if (i === 0) {
            firstTexWidth = texture.width;
            firstTexHeight = texture.height;
            worldToPixelX = texture.width / sceneData.worldWidth;
            worldToPixelY = texture.height / sceneData.worldHeight;
          }
          const sprite = new Sprite(texture);
          sprite.x = layer.x ?? 0;
          sprite.y = layer.y ?? 0;
          sprite.scale.set(
            sceneData.worldWidth / texture.width,
            sceneData.worldHeight / texture.height,
          );
          this.sceneContainerBg.addChild(sprite);
        } catch (_e) {
          // 加载失败时跳过该层
        }
      }
    } else {
      this.sceneContainerBg = createPlaceholderBackground(
        this.renderer.app,
        sceneData.worldWidth,
        sceneData.worldHeight,
      );
    }
    this.renderer.backgroundLayer.addChild(this.sceneContainerBg);

    const memory = this.sceneMemory.get(sceneId);

    if (sceneData.hotspots) {
      for (const def of sceneData.hotspots) {
        if (memory?.pickedUpHotspots.includes(def.id)) continue;

        const hotspot = new Hotspot(def);
        this.currentHotspots.push(hotspot);
        this.renderer.entityLayer.addChild(hotspot.container);
        const di = def.displayImage;
        if (di?.image && di.worldWidth > 0 && di.worldHeight > 0) {
          try {
            const tex = await this.assetManager.loadTexture(di.image);
            hotspot.setDisplayTexture(tex, di.worldWidth, di.worldHeight);
          } catch (_e) {
            console.warn(`SceneManager: hotspot "${def.id}" displayImage failed`, di.image);
          }
        }
      }
    }

    if (sceneData.npcs) {
      for (const npcDef of sceneData.npcs) {
        const npc = new Npc(npcDef);
        if (npcDef.animFile) {
          try {
            const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(npcDef.animFile);
            const sheetPath = resolvePathRelativeToAnimManifest(npcDef.animFile, animRaw.spritesheet);
            const tex = await this.assetManager.loadTexture(sheetPath);
            const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height);
            npc.loadSprite(tex, animDef, npcDef.initialAnimState);
          } catch (_e) {
            // 加载失败时保留占位外观
          }
        }
        const snap = memory?.npcSnapshots?.[npcDef.id];
        if (snap) {
          if (
            typeof snap.x === 'number' &&
            Number.isFinite(snap.x) &&
            typeof snap.y === 'number' &&
            Number.isFinite(snap.y)
          ) {
            npc.x = snap.x;
            npc.y = snap.y;
          }
          if (typeof snap.enabled === 'boolean') {
            npc.setVisible(snap.enabled);
          }
          const anim = snap.animState?.trim();
          if (anim) {
            npc.playAnimation(anim);
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
    this.cameraSetter?.(sceneData.worldWidth, sceneData.worldHeight, posX, posY, sceneData.camera, sceneData.worldScale);

    this.audioApplier?.(sceneData.bgm, sceneData.ambientSounds);
    this.zoneSetter?.(sceneData.zones ?? []);

    if (this.depthLoader) {
      await this.depthLoader(sceneId, sceneData, worldToPixelX, worldToPixelY);
    }

    if (sceneData.filterId) {
      try {
        await this.renderer.loadAndSetWorldFilter(sceneData.filterId);
      } catch (_e) {
        this.renderer.clearWorldFilter();
      }
    } else {
      this.renderer.clearWorldFilter();
    }

    this.eventBus.emit('scene:enter', { sceneId, fromSceneId: fromSceneId ?? null, sceneName: sceneData.name });
    this.eventBus.emit('scene:ready');
  }

  unloadScene(): void {
    this.eventBus.emit('scene:beforeUnload');
    this.interactionSetter?.([], []);

    for (const hotspot of this.currentHotspots) {
      hotspot.destroy();
    }
    this.currentHotspots = [];

    for (const npc of this.currentNpcs) {
      const filters = npc.container.filters;
      if (filters && filters.length > 0) {
        for (const f of filters) {
          f.destroy();
        }
      }
      npc.container.filters = [];
      npc.destroy();
    }
    this.currentNpcs = [];

    if (this.sceneContainerBg) {
      this.renderer.backgroundLayer.removeChild(this.sceneContainerBg);
      this.sceneContainerBg.destroy({ children: true });
      this.sceneContainerBg = null;
    }

    this.depthUnloader?.();
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
    await this.loadScene(targetSceneId, spawnPointId, cameraPosition, fromSceneId);

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
      npcSnapshots: existing?.npcSnapshots ?? {},
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
    cancelAnimationFrame(this.animRafId);
    this.animRafId = 0;
    return new Promise(resolve => {
      const startTime = performance.now();
      target.alpha = from;

      const tick = () => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / durationMs, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) {
          this.animRafId = requestAnimationFrame(tick);
        } else {
          this.animRafId = 0;
          resolve();
        }
      };
      this.animRafId = requestAnimationFrame(tick);
    });
  }

  serialize(): object {
    const data: Record<
      string,
      { inspected: string[]; pickedUp: string[]; npcSnapshots: Record<string, NpcPersistentSnapshot> }
    > = {};
    this.sceneMemory.forEach((mem, sceneId) => {
      data[sceneId] = {
        inspected: mem.inspectedHotspots,
        pickedUp: mem.pickedUpHotspots,
        npcSnapshots: mem.npcSnapshots ?? {},
      };
    });
    return { currentSceneId: this.currentScene?.id ?? null, memory: data };
  }

  deserialize(data: {
    currentSceneId: string | null;
    memory: Record<
      string,
      {
        inspected: string[];
        pickedUp: string[];
        npcSnapshots?: Record<string, NpcPersistentSnapshot>;
      }
    >;
  }): void {
    this.sceneMemory.clear();
    for (const [sceneId, mem] of Object.entries(data.memory)) {
      this.sceneMemory.set(sceneId, {
        inspectedHotspots: mem.inspected,
        pickedUpHotspots: mem.pickedUp,
        npcSnapshots: mem.npcSnapshots ?? {},
      });
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.animRafId);
    this.animRafId = 0;
    this.eventBus.off('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.off('hotspot:inspected', this.onHotspotInspected);
    this.unloadScene();
    this.removeFadeOverlay();
    this.sceneMemory.clear();
    this.playerPositionSetter = null;
    this.cameraSetter = null;
    this.boundsOnlySetter = null;
    this.audioApplier = null;
    this.zoneSetter = null;
    this.interactionSetter = null;
    this.depthLoader = null;
    this.depthUnloader = null;
  }
}
