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
  HotspotDisplayImage,
  SceneEntityRuntimeOverrides,
  SceneEntityRuntimeValue,
  NpcRuntimeOverride,
  HotspotRuntimeOverride,
  ZoneDef,
  CutsceneBindableEntityDef,
  HotspotDef,
  NpcDef,
} from '../data/types';
import { isCutsceneOnlyEntity, isEntityBoundToCutscene } from '../data/types';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { resolvePathRelativeToAnimManifest } from '../core/assetPath';
import type { IGameSystem } from '../data/types';
import {
  applyHotspotRuntimeOverride,
  applyNpcRuntimeOverride,
  coerceRuntimeFieldValue,
  type SceneEntityKind,
} from '../data/EntityRuntimeFieldSchema';

/** applyDebugWorldSize 成功时的返回值，供深度系统与碰撞比例同步 */
export type ApplyDebugWorldSizeResult =
  | { ok: true; worldToPixelX: number; worldToPixelY: number }
  | { ok: false };

interface SceneMemory {
  inspectedHotspots: string[];
  pickedUpHotspots: string[];
  entityOverrides: SceneEntityRuntimeOverrides;
}

interface CutsceneStaging {
  cutsceneId: string;
  sceneId: string;
  memory: SceneMemory;
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
  private cutsceneStaging: CutsceneStaging | null = null;

  /** 当前游戏会话内禁用的 standard zone id（按 sceneId 分桶，不写档）；depth_floor 不可在此关闭 */
  private zoneSessionDisabled: Map<string, Set<string>> = new Map();

  private fadeOverlay: Graphics | null = null;
  private isSwitching: boolean = false;
  /** 切场景请求串行队列，避免并发 switch 静默丢弃或交错 isSwitching */
  private sceneSwitchTail: Promise<void> = Promise.resolve();
  private animRafId: number = 0;

  /** 当前播放或过场预览绑定的 cutscene id；用于筛选 cutsceneOnly 实体。 */
  private activeCutsceneBindingId: string | null = null;

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

  /**
   * 未播放过场时为 null；由 Game 在 cutscene:start / cutscene:end 调用。
   */
  setActiveCutsceneBindingId(id: string | null): void {
    const t = id?.trim() || null;
    this.activeCutsceneBindingId = t;
  }

  getActiveCutsceneBindingId(): string | null {
    return this.activeCutsceneBindingId;
  }

  /** 根据 cutsceneOnly/shared/普通实体语义刷新当前已加载实体显隐。 */
  private refreshCutsceneBoundEntityVisibility(): void {
    const active = this.activeCutsceneBindingId?.trim() || null;
    const sceneId = this.currentScene?.id ?? '';

    for (const h of this.currentHotspots) {
      if (isCutsceneOnlyEntity(h.def)) {
        h.setEnabled(isEntityBoundToCutscene(h.def, active));
      } else {
        const snap = sceneId ? this.getEntityRuntimeOverrideForDef(sceneId, 'hotspot', h.def.id, h.def) : undefined;
        if (typeof snap?.enabled === 'boolean') h.setEnabled(snap.enabled);
      }
    }

    for (const n of this.currentNpcs) {
      if (isCutsceneOnlyEntity(n.def)) {
        n.setVisible(isEntityBoundToCutscene(n.def, active));
      } else {
        const snap = sceneId ? this.getEntityRuntimeOverrideForDef(sceneId, 'npc', n.def.id, n.def) : undefined;
        if (snap && typeof snap.enabled === 'boolean') {
          n.setVisible(snap.enabled);
        } else {
          n.setVisible(true);
        }
      }
    }
  }

  /**
   * InteractionSystem 中与过场绑定、sceneMemory.enabled 一致的基础显隐（不含触发条件图层）。
   */
  getHotspotBaseEnabledForInteraction(hotspot: Hotspot): boolean {
    const active = this.activeCutsceneBindingId?.trim() || null;
    const sceneId = this.currentScene?.id ?? '';
    if (isCutsceneOnlyEntity(hotspot.def)) {
      return isEntityBoundToCutscene(hotspot.def, active);
    }
    const snap = sceneId
      ? this.getEntityRuntimeOverrideForDef(sceneId, 'hotspot', hotspot.def.id, hotspot.def)
      : undefined;
    if (typeof snap?.enabled === 'boolean') return snap.enabled;
    return true;
  }

  /** 与 {@link getHotspotBaseEnabledForInteraction} 对偶，用于 NPC container.visible 基底。 */
  getNpcBaseVisibleForInteraction(npc: Npc): boolean {
    const active = this.activeCutsceneBindingId?.trim() || null;
    const sceneId = this.currentScene?.id ?? '';
    if (isCutsceneOnlyEntity(npc.def)) {
      return isEntityBoundToCutscene(npc.def, active);
    }
    const snap = sceneId
      ? this.getEntityRuntimeOverrideForDef(sceneId, 'npc', npc.def.id, npc.def)
      : undefined;
    if (snap && typeof snap.enabled === 'boolean') return snap.enabled;
    return true;
  }

  /** 供 Action：会话级开关 standard zone（不写档）。`enabled === false` 时从 ZoneSystem Unregister 该 id。 */
  setZoneEnabledSession(sceneId: string, zoneId: string, enabled: boolean): void {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    if (!sid || !zid) {
      console.warn('setZoneEnabledSession: sceneId 与 zoneId 不能为空');
      return;
    }
    if (this.resolveZoneKind(sid, zid) === 'depth_floor') {
      console.warn(`setZoneEnabledSession: zone "${zid}" 为 depth_floor，忽略`);
      return;
    }
    if (enabled) {
      const s = this.zoneSessionDisabled.get(sid);
      s?.delete(zid);
      if (s && s.size === 0) this.zoneSessionDisabled.delete(sid);
    } else {
      let bucket = this.zoneSessionDisabled.get(sid);
      if (!bucket) {
        bucket = new Set();
        this.zoneSessionDisabled.set(sid, bucket);
      }
      bucket.add(zid);
    }
    this.refreshZonesAfterRuntimeChange(sid);
  }

  /**
   * 供 Action：将 standard zone 的启用状态写入 sceneMemory（随存档）。
   * `enabled === true` 时移除该 zone 的存档覆盖；`false` 时写入 enabled false。
   */
  mergePersistentZoneEnabled(sceneId: string, zoneId: string, enabled: boolean): void {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    if (!sid || !zid) {
      console.warn('mergePersistentZoneEnabled: sceneId 与 zoneId 不能为空');
      return;
    }
    if (this.resolveZoneKind(sid, zid) === 'depth_floor') {
      console.warn(`mergePersistentZoneEnabled: zone "${zid}" 为 depth_floor，忽略`);
      return;
    }
    const mem = this.getWritableMemory(sid);
    if (!mem) {
      console.warn(`mergePersistentZoneEnabled: 无法写入 sceneMemory (${sid})`);
      return;
    }
    if (!mem.entityOverrides.zones) mem.entityOverrides.zones = {};
    if (enabled) {
      delete mem.entityOverrides.zones[zid];
    } else {
      mem.entityOverrides.zones[zid] = { enabled: false };
    }
    this.refreshZonesAfterRuntimeChange(sid);
  }

  private resolveZoneKind(sceneId: string, zoneId: string): 'standard' | 'depth_floor' | undefined {
    const z = this.findZoneDefInScene(sceneId, zoneId);
    if (!z) return undefined;
    return z.zoneKind === 'depth_floor' ? 'depth_floor' : 'standard';
  }

  private findZoneDefInScene(sceneId: string, zoneId: string): ZoneDef | undefined {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    if (!sid || !zid) return undefined;
    const sc = this.currentScene?.id === sid ? this.currentScene : null;
    return sc?.zones?.find((z) => z.id.trim() === zid);
  }

  private getMergedZoneOverride(sceneId: string, zoneId: string): { enabled?: boolean } | undefined {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    const committed = this.getCommittedMemory(sid)?.entityOverrides?.zones?.[zid];
    const staging =
      this.cutsceneStaging?.sceneId === sid
        ? this.cutsceneStaging.memory.entityOverrides?.zones?.[zid]
        : undefined;
    if (!committed && !staging) return undefined;
    return { ...(committed as object | undefined), ...(staging as object | undefined) } as {
      enabled?: boolean;
    };
  }

  private computeEffectiveZones(sceneId: string, raw: ZoneDef[] | undefined): ZoneDef[] {
    const list = raw ?? [];
    return list.filter((z) => this.shouldRegisterZoneWithZoneSystem(sceneId, z));
  }

  private shouldRegisterZoneWithZoneSystem(sceneId: string, z: ZoneDef): boolean {
    if (z.zoneKind === 'depth_floor') return true;
    const sid = sceneId.trim();
    const zid = z.id.trim();
    if (!zid) return false;
    if (this.zoneSessionDisabled.get(sid)?.has(zid)) return false;
    const snap = this.getMergedZoneOverride(sid, zid);
    if (snap?.enabled === false) return false;
    return true;
  }

  private refreshZonesAfterRuntimeChange(sceneId: string): void {
    const sid = sceneId.trim();
    if (!this.zoneSetter || this.currentScene?.id !== sid) return;
    this.zoneSetter(this.computeEffectiveZones(sid, this.currentScene.zones));
  }

  get switching(): boolean {
    return this.isSwitching;
  }

  private emptyEntityOverrides(): SceneEntityRuntimeOverrides {
    return { npcs: {}, hotspots: {}, zones: {} };
  }

  private createEmptyMemory(): SceneMemory {
    return {
      inspectedHotspots: [],
      pickedUpHotspots: [],
      entityOverrides: this.emptyEntityOverrides(),
    };
  }

  private normalizeMemory(mem: SceneMemory): SceneMemory {
    if (!mem.entityOverrides) mem.entityOverrides = this.emptyEntityOverrides();
    if (!mem.entityOverrides.npcs) mem.entityOverrides.npcs = {};
    if (!mem.entityOverrides.hotspots) mem.entityOverrides.hotspots = {};
    if (!mem.entityOverrides.zones) mem.entityOverrides.zones = {};
    if (!mem.inspectedHotspots) mem.inspectedHotspots = [];
    if (!mem.pickedUpHotspots) mem.pickedUpHotspots = [];
    return mem;
  }

  private ensureSceneMemory(sceneId: string): SceneMemory {
    let mem = this.sceneMemory.get(sceneId);
    if (!mem) {
      mem = this.createEmptyMemory();
      this.sceneMemory.set(sceneId, mem);
    }
    return this.normalizeMemory(mem);
  }

  beginCutsceneStaging(cutsceneId: string, sceneId: string): void {
    const cid = cutsceneId.trim();
    const sid = sceneId.trim();
    if (!cid || !sid) {
      console.warn('SceneManager.beginCutsceneStaging: cutsceneId/sceneId 不能为空');
      return;
    }
    this.cutsceneStaging = {
      cutsceneId: cid,
      sceneId: sid,
      memory: this.createEmptyMemory(),
    };
    this.setActiveCutsceneBindingId(cid);
  }

  endCutsceneStaging(): void {
    this.cutsceneStaging = null;
    this.setActiveCutsceneBindingId(null);
  }

  async enterCutsceneInstancesForCurrent(cutsceneId: string): Promise<void> {
    const scene = this.currentScene;
    if (!scene) return;
    const sceneId = scene.id;

    const allDefs: { kind: 'hotspot'; def: HotspotDef }[] | { kind: 'npc'; def: NpcDef }[] = [];
    if (scene.hotspots) {
      for (const def of scene.hotspots) {
        if (!isEntityBoundToCutscene(def, cutsceneId)) continue;
        // destroy existing outer instance
        const idx = this.currentHotspots.findIndex(h => h.def.id === def.id);
        if (idx >= 0) {
          const h = this.currentHotspots[idx];
          this.renderer.entityLayer.removeChild(h.container);
          h.destroy();
          this.currentHotspots.splice(idx, 1);
        }
        // re-instantiate with cutscene context
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'cutscene');
        const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
        this.currentHotspots.push(hotspot);
      }
    }
    if (scene.npcs) {
      for (const npcDef of scene.npcs) {
        if (!isEntityBoundToCutscene(npcDef, cutsceneId)) continue;
        // destroy existing outer instance
        const idx = this.currentNpcs.findIndex(n => n.def.id === npcDef.id);
        if (idx >= 0) {
          const n = this.currentNpcs[idx];
          const filters = n.container.filters;
          if (filters && filters.length > 0) {
            for (const f of filters) f.destroy();
          }
          n.container.filters = [];
          this.renderer.entityLayer.removeChild(n.container);
          n.destroy();
          this.currentNpcs.splice(idx, 1);
        }
        // re-instantiate with cutscene context
        const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'cutscene') as NpcRuntimeOverride | undefined;
        const npc = await this.instantiateNpc(npcDef, snap);
        this.currentNpcs.push(npc);
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
  }

  async exitCutsceneInstancesForCurrent(cutsceneId: string): Promise<void> {
    const scene = this.currentScene;
    if (!scene) return;
    const sceneId = scene.id;
    const committedMemory = this.getCommittedMemory(sceneId);

    if (scene.hotspots) {
      for (const def of scene.hotspots) {
        if (!isEntityBoundToCutscene(def, cutsceneId)) continue;
        // destroy cutscene instance
        const idx = this.currentHotspots.findIndex(h => h.def.id === def.id);
        if (idx >= 0) {
          const h = this.currentHotspots[idx];
          this.renderer.entityLayer.removeChild(h.container);
          h.destroy();
          this.currentHotspots.splice(idx, 1);
        }
        // B-type (cutsceneOnly:false): rebuild outer instance
        if (!isCutsceneOnlyEntity(def)) {
          if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
          if (ovr?.enabled === false) continue;
          const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
          this.currentHotspots.push(hotspot);
        }
      }
    }
    if (scene.npcs) {
      for (const npcDef of scene.npcs) {
        if (!isEntityBoundToCutscene(npcDef, cutsceneId)) continue;
        // destroy cutscene instance
        const idx = this.currentNpcs.findIndex(n => n.def.id === npcDef.id);
        if (idx >= 0) {
          const n = this.currentNpcs[idx];
          const filters = n.container.filters;
          if (filters && filters.length > 0) {
            for (const f of filters) f.destroy();
          }
          n.container.filters = [];
          this.renderer.entityLayer.removeChild(n.container);
          n.destroy();
          this.currentNpcs.splice(idx, 1);
        }
        // B-type (cutsceneOnly:false): rebuild outer instance
        if (!isCutsceneOnlyEntity(npcDef)) {
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
          const npc = await this.instantiateNpc(npcDef, snap);
          this.currentNpcs.push(npc);
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
  }

  isCutsceneStagingActive(): boolean {
    return this.cutsceneStaging !== null;
  }

  getActiveCutsceneStagingSceneId(): string | null {
    return this.cutsceneStaging?.sceneId ?? null;
  }

  getActiveCutsceneStagingId(): string | null {
    return this.cutsceneStaging?.cutsceneId ?? null;
  }

  private getCommittedMemory(sceneId: string): SceneMemory | undefined {
    const mem = this.sceneMemory.get(sceneId);
    return mem ? this.normalizeMemory(mem) : undefined;
  }

  private getWritableMemory(sceneId: string): SceneMemory | null {
    if (this.cutsceneStaging) {
      if (sceneId !== this.cutsceneStaging.sceneId) {
        console.warn(
          `SceneManager: 过场中忽略跨场景 sceneMemory 写入 "${sceneId}"（当前过场场景 "${this.cutsceneStaging.sceneId}"）`,
        );
        return null;
      }
      return this.normalizeMemory(this.cutsceneStaging.memory);
    }
    return this.ensureSceneMemory(sceneId);
  }

  private findEntityDef(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
  ): CutsceneBindableEntityDef | undefined {
    if (this.currentScene?.id !== sceneId) return undefined;
    return kind === 'npc'
      ? this.currentScene.npcs?.find(n => n.id === entityId)
      : this.currentScene.hotspots?.find(h => h.id === entityId);
  }

  private isCurrentCutsceneOnlyEntity(sceneId: string, kind: SceneEntityKind, entityId: string): boolean {
    const def = this.findEntityDef(sceneId, kind, entityId);
    return !!def && isCutsceneOnlyEntity(def);
  }

  private getEntityRuntimeOverrideForDef(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    def: CutsceneBindableEntityDef,
  ): NpcRuntimeOverride | HotspotRuntimeOverride | undefined {
    const committed = isCutsceneOnlyEntity(def)
      ? undefined
      : this.getCommittedMemory(sceneId)?.entityOverrides?.[kind === 'npc' ? 'npcs' : 'hotspots']?.[entityId];
    const staging = this.cutsceneStaging?.sceneId === sceneId
      ? this.cutsceneStaging.memory.entityOverrides?.[kind === 'npc' ? 'npcs' : 'hotspots']?.[entityId]
      : undefined;
    if (!committed && !staging) return undefined;
    return { ...(committed as object | undefined), ...(staging as object | undefined) } as NpcRuntimeOverride | HotspotRuntimeOverride;
  }

  private getRuntimeOverrideForContext(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    _def: CutsceneBindableEntityDef,
    context: 'outer' | 'cutscene',
  ): NpcRuntimeOverride | HotspotRuntimeOverride | undefined {
    const bucket = kind === 'npc' ? 'npcs' : 'hotspots';
    if (context === 'outer') {
      return this.getCommittedMemory(sceneId)?.entityOverrides?.[bucket]?.[entityId] as
        NpcRuntimeOverride | HotspotRuntimeOverride | undefined;
    }
    // cutscene context: only staging memory
    if (this.cutsceneStaging?.sceneId === sceneId) {
      return this.cutsceneStaging.memory.entityOverrides?.[bucket]?.[entityId] as
        NpcRuntimeOverride | HotspotRuntimeOverride | undefined;
    }
    return undefined;
  }

  /**
   * 记录某场景某热点展示图运行态（供非当前图 setHotspotDisplayImage 或进图时合并）。
   */
  mergeHotspotDisplayImageOverride(
    sceneId: string,
    hotspotId: string,
    di: HotspotDisplayImage,
  ): void {
    this.setEntityRuntimeField(sceneId, 'hotspot', hotspotId, 'displayImage', di);
  }

  setEntityRuntimeField(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    fieldName: string,
    rawValue: unknown,
  ): { ok: true; value: SceneEntityRuntimeValue } | { ok: false; error: string } {
    const sid = sceneId.trim();
    const id = entityId.trim();
    const field = fieldName.trim();
    if (!sid || !id || !field) {
      return { ok: false, error: 'setEntityRuntimeField: sceneId/entityId/fieldName 不能为空' };
    }
    const coerced = coerceRuntimeFieldValue(kind, field, rawValue);
    if (!coerced.ok) return coerced;
    if (!this.cutsceneStaging && this.isCurrentCutsceneOnlyEntity(sid, kind, id)) {
      return { ok: false, error: `setEntityRuntimeField: ${kind}.${id} 是仅过场实体，普通上下文不写 committed sceneMemory` };
    }
    const mem = this.getWritableMemory(sid);
    if (!mem) return { ok: false, error: `setEntityRuntimeField: 过场中忽略跨场景写入 ${sid}` };
    const bucket = kind === 'npc' ? mem.entityOverrides.npcs : mem.entityOverrides.hotspots;
    const prev = bucket[id] ?? {};
    bucket[id] = { ...prev, [field]: coerced.value };
    return { ok: true, value: coerced.value };
  }

  getEntityRuntimeOverride(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
  ): NpcRuntimeOverride | HotspotRuntimeOverride | undefined {
    const def = this.findEntityDef(sceneId, kind, entityId);
    if (def) return this.getEntityRuntimeOverrideForDef(sceneId, kind, entityId, def);
    const mem = this.getCommittedMemory(sceneId);
    const staging = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.memory : undefined;
    const committed = kind === 'npc' ? mem?.entityOverrides.npcs?.[entityId] : mem?.entityOverrides.hotspots?.[entityId];
    const staged = kind === 'npc' ? staging?.entityOverrides.npcs?.[entityId] : staging?.entityOverrides.hotspots?.[entityId];
    if (!committed && !staged) return undefined;
    return { ...(committed as object | undefined), ...(staged as object | undefined) } as NpcRuntimeOverride | HotspotRuntimeOverride;
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
    if (!this.cutsceneStaging && this.isCurrentCutsceneOnlyEntity(sceneId, 'npc', id)) {
      console.warn(`SceneManager.mergePersistentNpcState: "${id}" 是仅过场 NPC，普通上下文不写 committed sceneMemory`);
      return;
    }
    const mem = this.getWritableMemory(sceneId);
    if (!mem) return;
    const prev = mem.entityOverrides.npcs[id] ?? {};
    mem.entityOverrides.npcs[id] = { ...prev, ...patch };
  }

  /** 再次进入场景时是否不应启动该 NPC 的巡逻 */
  isNpcPatrolPersistentlyDisabled(npcId: string): boolean {
    const sid = this.currentScene?.id;
    if (!sid) return false;
    const mem = this.getCommittedMemory(sid);
    return mem?.entityOverrides?.npcs?.[npcId]?.patrolDisabled === true;
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

  /**
   * 第一层背景贴图在 X/Y 方向的「每世界单位像素数」（与 loadScene / applyDebugWorldSize 中 worldToPixel 一致）。
   * 无有效背景精灵时返回 null。
   */
  getBackgroundTexelsPerWorld(): { x: number; y: number } | null {
    const scene = this.currentScene;
    const bg = this.sceneContainerBg;
    if (!scene || !bg || scene.worldWidth <= 0 || scene.worldHeight <= 0) return null;
    const first = bg.children.find(
      (c): c is Sprite => c instanceof Sprite && c.texture?.width > 0 && c.texture?.height > 0,
    );
    if (!first) return null;
    return {
      x: first.texture.width / scene.worldWidth,
      y: first.texture.height / scene.worldHeight,
    };
  }

  private async instantiateHotspot(def: HotspotDef, overrides: HotspotRuntimeOverride | undefined): Promise<Hotspot> {
    const defToUse = applyHotspotRuntimeOverride(def, overrides as Record<string, SceneEntityRuntimeValue> | undefined);
    const hotspot = new Hotspot(defToUse);
    this.renderer.entityLayer.addChild(hotspot.container);
    const di = defToUse.displayImage;
    if (di?.image && di.worldWidth > 0 && di.worldHeight > 0) {
      try {
        const tex = await this.assetManager.loadTexture(di.image);
        hotspot.setDisplayTexture(tex, di.worldWidth, di.worldHeight);
      } catch (_e) {
        console.warn(`SceneManager: hotspot "${def.id}" displayImage failed`, di.image);
      }
    }
    return hotspot;
  }

  private async instantiateNpc(npcDef: NpcDef, overrides: NpcRuntimeOverride | undefined): Promise<Npc> {
    const defToUse = applyNpcRuntimeOverride(npcDef, overrides as Record<string, SceneEntityRuntimeValue> | undefined);
    const npc = new Npc(defToUse);
    if (defToUse.animFile) {
      try {
        const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(defToUse.animFile);
        const sheetPath = resolvePathRelativeToAnimManifest(defToUse.animFile, animRaw.spritesheet);
        const tex = await this.assetManager.loadTexture(sheetPath);
        const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height);
        npc.loadSprite(tex, animDef, defToUse.initialAnimState);
      } catch (_e) {
        // 加载失败时保留占位外观
      }
    }
    if (overrides) {
      const anim = (overrides as NpcRuntimeOverride).animState?.trim();
      if (anim) {
        npc.playAnimation(anim);
      }
    }
    this.renderer.entityLayer.addChild(npc.container);
    return npc;
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

    const committedMemory = this.getCommittedMemory(sceneId);
    const activeCutsceneId = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.cutsceneId : null;

    if (sceneData.hotspots) {
      for (const def of sceneData.hotspots) {
        const boundToActive = activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId);
        if (boundToActive) {
          // cutscene context: skip pickedUpHotspots filter, skip committed enabled filter
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'cutscene');
          const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
          this.currentHotspots.push(hotspot);
        } else {
          // outer context
          if (isCutsceneOnlyEntity(def)) continue;
          if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
          if (ovr?.enabled === false) continue;
          const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
          this.currentHotspots.push(hotspot);
        }
      }
    }

    if (sceneData.npcs) {
      for (const npcDef of sceneData.npcs) {
        const boundToActive = activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId);
        if (boundToActive) {
          // cutscene context
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'cutscene') as NpcRuntimeOverride | undefined;
          const npc = await this.instantiateNpc(npcDef, snap);
          this.currentNpcs.push(npc);
        } else {
          // outer context
          if (isCutsceneOnlyEntity(npcDef)) continue;
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
          const npc = await this.instantiateNpc(npcDef, snap);
          this.currentNpcs.push(npc);
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);

    this.applyPlayerSpawnAndCamera(sceneData, spawnPointId, cameraPosition);

    this.audioApplier?.(sceneData.bgm, sceneData.ambientSounds);
    this.zoneSetter?.(this.computeEffectiveZones(sceneId, sceneData.zones));

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

  /** 对 **已加载** 的 sceneData 应用 spawn / spawnPoints / cameraPosition（语义与 loadScene 末尾一致） */
  private applyPlayerSpawnAndCamera(
    sceneData: SceneData,
    spawnPointId?: string,
    cameraPosition?: { x: number; y: number },
  ): void {
    let spawn: Position = sceneData.spawnPoint;
    const spKey = spawnPointId?.trim();
    if (spKey && sceneData.spawnPoints?.[spKey]) {
      spawn = sceneData.spawnPoints[spKey];
    }
    const posX = cameraPosition?.x ?? spawn.x;
    const posY = cameraPosition?.y ?? spawn.y;
    this.playerPositionSetter?.(posX, posY);
    this.cameraSetter?.(sceneData.worldWidth, sceneData.worldHeight, posX, posY, sceneData.camera, sceneData.worldScale);
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
    const job = async (): Promise<void> => {
      const tid = targetSceneId.trim();
      if (!tid) {
        console.warn('SceneManager: switchScene 无效：targetScene 为空');
        return;
      }

      const curId = this.currentScene?.id?.trim() ?? '';
      if (curId === tid) {
        const wantSpawnOverride = !!(spawnPointId?.trim());
        const wantCamOverride = cameraPosition != null && (
          cameraPosition.x !== undefined || cameraPosition.y !== undefined
        );
        if (!wantSpawnOverride && !wantCamOverride) {
          return;
        }
        if (!this.currentScene) return;
        if (!this.cutsceneStaging) {
          this.saveCurrentSceneMemory();
        }
        this.applyPlayerSpawnAndCamera(this.currentScene, spawnPointId, cameraPosition);
        return;
      }

      this.isSwitching = true;
      try {
        this.saveCurrentSceneMemory();

        await this.fadeOut(300);

        const fromSceneId = this.currentScene?.id ?? null;
        this.unloadScene();
        await this.loadScene(tid, spawnPointId, cameraPosition, fromSceneId);

        await this.fadeIn(300);
      } finally {
        this.isSwitching = false;
      }
    };

    const p = this.sceneSwitchTail.then(job, job);
    this.sceneSwitchTail = p.catch((e) => {
      console.warn('SceneManager: switchScene failed', e);
    });
    await p;
  }


  private saveCurrentSceneMemory(): void {
    if (!this.currentScene) return;
    if (this.cutsceneStaging) return;

    const inspected: string[] = [];
    const pickedUp: string[] = [];

    for (const hotspot of this.currentHotspots) {
      if (!hotspot.active && hotspot.def.type === 'pickup') {
        pickedUp.push(hotspot.def.id);
      }
    }

    const existing = this.getCommittedMemory(this.currentScene.id);
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
      entityOverrides: existing?.entityOverrides ?? this.emptyEntityOverrides(),
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
    const mem = this.getWritableMemory(this.currentScene.id);
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
      {
        inspected: string[];
        pickedUp: string[];
        entityOverrides: SceneEntityRuntimeOverrides;
      }
    > = {};
    this.sceneMemory.forEach((mem, sceneId) => {
      data[sceneId] = {
        inspected: mem.inspectedHotspots,
        pickedUp: mem.pickedUpHotspots,
        entityOverrides: mem.entityOverrides ?? this.emptyEntityOverrides(),
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
        entityOverrides?: SceneEntityRuntimeOverrides;
        npcSnapshots?: Record<string, NpcPersistentSnapshot>;
        hotspotDisplayImageOverrides?: Record<string, HotspotDisplayImage>;
      }
    >;
  }): void {
    this.sceneMemory.clear();
    for (const [sceneId, mem] of Object.entries(data.memory)) {
      const base = mem.entityOverrides ?? this.emptyEntityOverrides();
      const entityOverrides: SceneEntityRuntimeOverrides = {
        npcs: { ...base.npcs },
        hotspots: { ...base.hotspots },
        zones: { ...(base.zones ?? {}) },
      };
      if (mem.npcSnapshots) {
        entityOverrides.npcs = { ...entityOverrides.npcs, ...mem.npcSnapshots };
      }
      if (mem.hotspotDisplayImageOverrides) {
        for (const [hotspotId, displayImage] of Object.entries(mem.hotspotDisplayImageOverrides)) {
          entityOverrides.hotspots[hotspotId] = {
            ...(entityOverrides.hotspots[hotspotId] ?? {}),
            displayImage,
          };
        }
      }
      this.sceneMemory.set(sceneId, {
        inspectedHotspots: mem.inspected,
        pickedUpHotspots: mem.pickedUp,
        entityOverrides,
      });
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.animRafId);
    this.animRafId = 0;
    this.zoneSessionDisabled.clear();
    this.eventBus.off('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.off('hotspot:inspected', this.onHotspotInspected);
    this.unloadScene();
    this.removeFadeOverlay();
    this.sceneMemory.clear();
    this.cutsceneStaging = null;
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
