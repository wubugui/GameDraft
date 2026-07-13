import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { AssetManager, AssetManifest, AssetRef } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import { Hotspot } from '../entities/Hotspot';
import { Npc } from '../entities/Npc';
import { createPlaceholderBackground } from '../rendering/PlaceholderFactory';
import type {
  ActionDef,
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
import { applyCharacterDefaults, type CharacterRegistry } from '../data/characterRegistry';
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
import type { ActivePlaneSnapshot } from './plane/types';

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

  /** 角色注册表（character_registry.json）：instantiateNpc 合并 name/animFile/portraitSlug 默认。由 Game 装配期注入。 */
  private characterRegistry: CharacterRegistry = {};
  setCharacterRegistry(reg: CharacterRegistry): void {
    this.characterRegistry = reg;
  }

  /** 当前游戏会话内禁用的 standard zone id（按 sceneId 分桶，不写档）；depth_floor 不可在此关闭 */
  private zoneSessionDisabled: Map<string, Set<string>> = new Map();

  /**
   * 会话级隐藏的实体 id（按 sceneId 分桶，不写档）。与实体实例上的 override 通道成对：
   * 桶保证过场重建 / 重进场景（同会话）时覆盖不丢，实例重建时从桶恢复。
   * 持久显隐仍走 sceneMemory.entityOverrides.enabled（persist* Action），语义不变。
   */
  private entitySessionOverrides: Map<string, { npcs: Set<string>; hotspots: Set<string> }> = new Map();

  /** 场景世代号：unloadScene 自增。跨 await 持有实体/场景引用的流程以此判废，防并发卸载竞态产生孤儿容器 */
  private sceneEpoch = 0;

  /** >0 表示正在执行场景根 onEnter 动作批（重入 switchScene 检测用） */
  private sceneEnterBatchDepth = 0;

  /** onEnter 批内发起的切换请求（fire-and-forget 登记，当前加载完成后 drain） */
  private pendingReentrantSwitch: {
    targetSceneId: string;
    spawnPointId?: string;
    cameraPosition?: { x: number; y: number };
  } | null = null;

  /** 切场景淡入淡出根节点（黑底 + 可选加载进度条） */
  private transitionOverlay: Container | null = null;
  private transitionBarFill: Graphics | null = null;
  private transitionBarW = 0;
  private transitionBarH = 8;
  private transitionDebugLabel: Text | null = null;
  private isSwitching: boolean = false;
  /** 切场景请求串行队列，避免并发 switch 静默丢弃或交错 isSwitching */
  private sceneSwitchTail: Promise<void> = Promise.resolve();
  private animRafId: number = 0;

  /** 当前播放或过场预览绑定的 cutscene id；用于筛选 cutsceneOnly 实体。 */
  private activeCutsceneBindingId: string | null = null;

  /** 由 Game 注入：当前激活位面快照（PlaneReconciler 派生）；未注入时按 normal/shared。 */
  private activePlaneGetter: (() => ActivePlaneSnapshot) | null = null;

  private playerPositionSetter: ((x: number, y: number) => void) | null = null;
  private cameraSetter: ((boundsW: number, boundsH: number, snapX: number, snapY: number, cameraConfig?: SceneCameraConfig, worldScale?: number) => void) | null = null;
  private boundsOnlySetter: ((boundsW: number, boundsH: number) => void) | null = null;
  private audioApplier: ((bgm?: string, ambient?: string[]) => void) | null = null;
  private audioManifestResolver: ((bgm?: string, ambient?: string[]) => AssetRef[]) | null = null;
  private zoneSetter: ((zones: import('../data/types').ZoneDef[]) => void) | null = null;
  private interactionSetter: ((hotspots: Hotspot[], npcs: Npc[]) => void) | null = null;
  /** 由 Game 注入：从深度系统摘除并销毁实体滤镜（Game 持有 SceneDepthSystem）。
   *  实体在过场重建 / 卸载时若不摘除，已 destroy 的滤镜仍留在每帧驱动列表里。 */
  private entityFilterReleaser: ((filters: Array<{ destroy(): void }>) => void) | null = null;
  private depthLoader: ((sceneId: string, sceneData: SceneData, worldToPixelX: number, worldToPixelY: number) => Promise<void>) | null = null;
  private depthUnloader: (() => void) | null = null;
  /** 场景根 `onEnter` 动作：由 Game 注入 ActionExecutor.executeBatchAwait */
  private sceneEnterRunner: ((actions: ActionDef[]) => Promise<void>) | null = null;
  private currentSceneScopeId: string | null = null;

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

  setAudioManifestResolver(fn: ((bgm?: string, ambient?: string[]) => AssetRef[]) | null): void {
    this.audioManifestResolver = fn;
  }

  setZoneSetter(fn: (zones: import('../data/types').ZoneDef[]) => void): void {
    this.zoneSetter = fn;
  }

  setInteractionSetter(fn: (hotspots: Hotspot[], npcs: Npc[]) => void): void {
    this.interactionSetter = fn;
  }

  setEntityFilterReleaser(fn: (filters: Array<{ destroy(): void }>) => void): void {
    this.entityFilterReleaser = fn;
  }

  /** 摘除并销毁热点的深度滤镜（先从深度系统列表移除，再销毁 GPU 资源）。重复调用安全（detach 返回 null）。 */
  private releaseHotspotFilters(h: Hotspot): void {
    const f = h.detachDepthOcclusionFilter();
    if (!f) return;
    if (this.entityFilterReleaser) this.entityFilterReleaser([f]);
    else f.destroy();
  }

  /** 摘除并销毁 NPC 容器上的滤镜，并清空 container.filters。 */
  private releaseNpcFilters(n: Npc): void {
    const filters = n.container.filters as readonly { destroy(): void }[] | null | undefined;
    if (filters && filters.length > 0) {
      if (this.entityFilterReleaser) this.entityFilterReleaser([...filters]);
      else for (const f of filters) f.destroy();
    }
    n.container.filters = [];
  }

  setDepthLoader(fn: (sceneId: string, sceneData: SceneData, worldToPixelX: number, worldToPixelY: number) => Promise<void>): void {
    this.depthLoader = fn;
  }

  setDepthUnloader(fn: () => void): void {
    this.depthUnloader = fn;
  }

  setSceneEnterRunner(fn: ((actions: ActionDef[]) => Promise<void>) | null): void {
    this.sceneEnterRunner = fn;
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

  setActivePlaneGetter(fn: (() => ActivePlaneSnapshot) | null): void {
    this.activePlaneGetter = fn;
  }

  /**
   * 实体/zone 是否归属当前激活位面。缺省（无 planes 字段/空数组）由激活位面的世界模型决定：
   * shared（共享世界型）= 存在；exclusive（独立世界型）= 不存在，只有显式归属实体在。
   * 显式 planes 为白名单：须包含激活位面 id。
   */
  private entityInPlane(def: { planes?: string[] }): boolean {
    const planes = def.planes;
    const active = this.activePlaneGetter?.() ?? { id: 'normal', membership: 'shared' as const };
    if (!Array.isArray(planes) || planes.length === 0) return active.membership === 'shared';
    return planes.includes(active.id);
  }

  /**
   * 位面归属判定公开口（与内部 entityInPlane 同口径）。给绕过 ZoneSystem 的
   * zone 消费者用——如 Game.tick 的 depth_floor 偏移直读 sceneData.zones，
   * 不经 shouldRegisterZoneWithZoneSystem 的位面过滤。
   */
  isEntityInActivePlane(def: { planes?: string[] }): boolean {
    return this.entityInPlane(def);
  }

  /**
   * 根据 cutsceneOnly/shared/普通实体 + 位面归属语义刷新当前已加载实体显隐。
   * 判定委托 getHotspotBaseEnabledForInteraction / getNpcBaseVisibleForInteraction
   * （派生基底的唯一真源），保证与 InteractionSystem 每帧回写口径一致、不漂移。
   */
  private refreshCutsceneBoundEntityVisibility(): void {
    for (const h of this.currentHotspots) {
      h.setDerivedBaseEnabled(this.getHotspotBaseEnabledForInteraction(h));
    }

    for (const n of this.currentNpcs) {
      n.setDerivedBaseVisible(this.getNpcBaseVisibleForInteraction(n));
    }
  }

  /** 切位面后的统一刷新（实体+zone）。zone 侧有动作副作用约束，见 refreshZonesForPlaneChange。 */
  refreshForPlaneChange(sceneId: string): void {
    this.refreshEntitiesForPlaneChange(sceneId);
    this.refreshZonesForPlaneChange(sceneId);
  }

  /** 切位面·实体侧：批量重贴派生基底显隐。纯显隐无动作副作用，任何 GameState 下可调。 */
  refreshEntitiesForPlaneChange(sceneId: string): void {
    const sid = sceneId.trim();
    if (!sid || this.currentScene?.id !== sid) return;
    this.refreshCutsceneBoundEntityVisibility();
  }

  /**
   * 切位面·zone 侧：按位面归属重注册 zones（ZoneSystem.setZones 差分更新，因位面消失的
   * zone 正常走 exitZone/onExit）。调用方（PlaneReconciler）保证仅在 Exploring 态调用——
   * 过场策略栈会吞掉 onExit 里的改存档动作且不补发。仅对当前已加载场景生效。
   */
  refreshZonesForPlaneChange(sceneId: string): void {
    const sid = sceneId.trim();
    if (!sid || this.currentScene?.id !== sid) return;
    this.refreshZonesAfterRuntimeChange(sid);
  }

  /**
   * 供 Action（setEntityEnabled）接线：会话级实体显隐（不写档）。
   * enabled=false 写 override 通道并即时应用到活实例；enabled=true 清除覆盖，
   * 显隐回落到派生基底（sceneMemory / 过场绑定 / 条件）决定。
   */
  setEntitySessionEnabled(kind: SceneEntityKind, entityId: string, enabled: boolean): boolean {
    const sceneId = this.currentScene?.id;
    const id = entityId.trim();
    if (!sceneId || !id) {
      console.warn('SceneManager.setEntitySessionEnabled: 无当前场景或空 entityId');
      return false;
    }
    let bucket = this.entitySessionOverrides.get(sceneId);
    if (enabled) {
      if (bucket) {
        bucket[kind === 'npc' ? 'npcs' : 'hotspots'].delete(id);
        if (bucket.npcs.size === 0 && bucket.hotspots.size === 0) {
          this.entitySessionOverrides.delete(sceneId);
        }
      }
    } else {
      if (!bucket) {
        bucket = { npcs: new Set(), hotspots: new Set() };
        this.entitySessionOverrides.set(sceneId, bucket);
      }
      bucket[kind === 'npc' ? 'npcs' : 'hotspots'].add(id);
    }
    const override = enabled ? null : false;
    if (kind === 'npc') {
      this.currentNpcs.find((n) => n.def.id === id)?.setSessionEnabledOverride(override);
    } else {
      this.currentHotspots.find((h) => h.def.id === id)?.setSessionEnabledOverride(override);
    }
    return true;
  }

  /** 实体实例化时从会话桶恢复运行态覆盖（不入档；重进场景/过场重建同会话内保持）。 */
  private applySessionOverrideOnInstantiate(kind: SceneEntityKind, entity: Hotspot | Npc): void {
    const sceneId = this.currentScene?.id;
    if (!sceneId) return;
    const bucket = this.entitySessionOverrides.get(sceneId);
    if (!bucket) return;
    const hidden = kind === 'npc' ? bucket.npcs : bucket.hotspots;
    if (hidden.has(entity.def.id)) {
      entity.setSessionEnabledOverride(false);
    }
  }

  /**
   * InteractionSystem 中与位面归属、过场绑定、sceneMemory.enabled 一致的基础显隐（不含触发条件图层）。
   */
  getHotspotBaseEnabledForInteraction(hotspot: Hotspot): boolean {
    if (!this.entityInPlane(hotspot.def)) return false;
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
    if (!this.entityInPlane(npc.def)) return false;
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
    if (!this.entityInPlane(z)) return false;
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
    // instantiate 的 await 间隙可能与并发卸载/切场竞态：世代号变化即中止并销毁刚建的孤儿实例
    const epoch = this.sceneEpoch;
    const rebuiltHotspotIds: string[] = [];
    const rebuiltNpcIds: string[] = [];

    if (scene.hotspots) {
      for (const def of scene.hotspots) {
        if (!isEntityBoundToCutscene(def, cutsceneId)) continue;
        // destroy existing outer instance
        const idx = this.currentHotspots.findIndex(h => h.def.id === def.id);
        if (idx >= 0) {
          const h = this.currentHotspots[idx];
          this.releaseHotspotFilters(h);
          this.renderer.entityLayer.removeChild(h.container);
          h.destroy();
          this.currentHotspots.splice(idx, 1);
        }
        // re-instantiate with cutscene context
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'cutscene');
        const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
        if (this.commitRebuiltEntityOrDiscard(hotspot, epoch, this.currentHotspots, rebuiltHotspotIds, def.id)) {
          return;
        }
      }
    }
    if (scene.npcs) {
      for (const npcDef of scene.npcs) {
        if (!isEntityBoundToCutscene(npcDef, cutsceneId)) continue;
        // destroy existing outer instance
        const idx = this.currentNpcs.findIndex(n => n.def.id === npcDef.id);
        if (idx >= 0) {
          const n = this.currentNpcs[idx];
          this.releaseNpcFilters(n);
          this.renderer.entityLayer.removeChild(n.container);
          n.destroy();
          this.currentNpcs.splice(idx, 1);
        }
        // re-instantiate with cutscene context
        const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'cutscene') as NpcRuntimeOverride | undefined;
        const npc = await this.instantiateNpc(npcDef, snap);
        if (this.commitRebuiltEntityOrDiscard(npc, epoch, this.currentNpcs, rebuiltNpcIds, npcDef.id)) {
          return;
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
    this.emitEntitiesRebuilt(cutsceneId, 'enter', rebuiltHotspotIds, rebuiltNpcIds);
  }

  async exitCutsceneInstancesForCurrent(cutsceneId: string): Promise<void> {
    const scene = this.currentScene;
    if (!scene) return;
    const sceneId = scene.id;
    const committedMemory = this.getCommittedMemory(sceneId);
    const epoch = this.sceneEpoch;
    const rebuiltHotspotIds: string[] = [];
    const rebuiltNpcIds: string[] = [];

    if (scene.hotspots) {
      for (const def of scene.hotspots) {
        if (!isEntityBoundToCutscene(def, cutsceneId)) continue;
        // destroy cutscene instance
        const idx = this.currentHotspots.findIndex(h => h.def.id === def.id);
        if (idx >= 0) {
          const h = this.currentHotspots[idx];
          this.releaseHotspotFilters(h);
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
          if (this.commitRebuiltEntityOrDiscard(hotspot, epoch, this.currentHotspots, rebuiltHotspotIds, def.id)) {
            return;
          }
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
          this.releaseNpcFilters(n);
          this.renderer.entityLayer.removeChild(n.container);
          n.destroy();
          this.currentNpcs.splice(idx, 1);
        }
        // B-type (cutsceneOnly:false): rebuild outer instance
        if (!isCutsceneOnlyEntity(npcDef)) {
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
          const npc = await this.instantiateNpc(npcDef, snap);
          if (this.commitRebuiltEntityOrDiscard(npc, epoch, this.currentNpcs, rebuiltNpcIds, npcDef.id)) {
            return;
          }
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
    this.emitEntitiesRebuilt(cutsceneId, 'exit', rebuiltHotspotIds, rebuiltNpcIds);
  }

  /**
   * 实例化 await 后统一的世代守卫：若 sceneEpoch 已变（并发卸载/切场），
   * 销毁刚建的孤儿实例并返回 true（调用方据此 return 中止整个重建）；
   * 否则将实例登记进 sink + idSink 并返回 false（继续重建）。
   * 收拢四处（hotspot/npc × enter/exit）逐字复制的守卫，语义完全一致。
   */
  private commitRebuiltEntityOrDiscard<T extends { destroy(): void }>(
    entity: T,
    epoch: number,
    sink: T[],
    idSink: string[],
    id: string,
  ): boolean {
    if (this.sceneEpoch !== epoch) {
      entity.destroy();
      return true;
    }
    sink.push(entity);
    idSink.push(id);
    return false;
  }

  /**
   * 过场进入/退出重建实体后广播，供 Game 重挂深度滤镜/像素密度/巡逻
   * （重建的是全新实例，scene:ready 时附加的滤镜与巡逻协程都随旧实例销毁了）。
   */
  private emitEntitiesRebuilt(
    cutsceneId: string,
    phase: 'enter' | 'exit',
    hotspotIds: string[],
    npcIds: string[],
  ): void {
    if (hotspotIds.length === 0 && npcIds.length === 0) return;
    this.eventBus.emit('scene:entitiesRebuilt', { cutsceneId, phase, hotspotIds, npcIds });
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

  getDebugRenderState(): Record<string, unknown> {
    const backgrounds = this.sceneContainerBg?.children
      .filter((child): child is Sprite => child instanceof Sprite)
      .map((sprite) => ({
        x: sprite.x,
        y: sprite.y,
        scaleX: sprite.scale.x,
        scaleY: sprite.scale.y,
        textureWidth: sprite.texture.width,
        textureHeight: sprite.texture.height,
      })) ?? [];
    return {
      filterId: this.currentScene?.filterId ?? null,
      backgrounds,
    };
  }

  getDebugEntityVisualState(): Record<string, unknown>[] {
    return this.currentNpcs
      .map((npc) => npc.getDebugVisualState())
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  resetEntityAnimationClocks(): void {
    for (const npc of this.currentNpcs) npc.resetAnimationClock();
  }

  /** 第一层背景的纹理（用于构建辐照度探针）；无有效背景精灵时返回 null。 */
  getPrimaryBackgroundTexture(): Texture | null {
    const bg = this.sceneContainerBg;
    if (!bg) return null;
    const first = bg.children.find(
      (c): c is Sprite => c instanceof Sprite && c.texture?.width > 0 && c.texture?.height > 0,
    );
    return first ? first.texture : null;
  }

  private async instantiateHotspot(def: HotspotDef, overrides: HotspotRuntimeOverride | undefined): Promise<Hotspot> {
    const defToUse = applyHotspotRuntimeOverride(def, overrides as Record<string, SceneEntityRuntimeValue> | undefined);
    const hotspot = new Hotspot(defToUse);
    this.applySessionOverrideOnInstantiate('hotspot', hotspot);
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
    // 合并顺序：角色注册表默认（base）→ 运行时字段覆盖（session/sceneMemory，最高优先）
    const withChar = applyCharacterDefaults(npcDef, this.characterRegistry);
    const defToUse = applyNpcRuntimeOverride(withChar, overrides as Record<string, SceneEntityRuntimeValue> | undefined);
    const npc = new Npc(defToUse);
    this.applySessionOverrideOnInstantiate('npc', npc);
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

  /**
   * 与 loadScene 中实例化逻辑一致，用于切场景进度条总步数估算。
   */
  private countSceneInstantiateWork(
    sceneData: SceneData,
    sceneId: string,
    committedMemory: SceneMemory | undefined,
    activeCutsceneId: string | null,
  ): { bgLayers: number; hotspots: number; npcs: number } {
    const bgLayers = sceneData.backgrounds?.length ?? 0;
    let hotspots = 0;
    for (const def of sceneData.hotspots ?? []) {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId));
      if (boundToActive) {
        hotspots++;
      } else {
        if (isCutsceneOnlyEntity(def)) continue;
        if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
        if (ovr?.enabled === false) continue;
        hotspots++;
      }
    }
    let npcs = 0;
    for (const npcDef of sceneData.npcs ?? []) {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId));
      if (boundToActive) {
        npcs++;
      } else {
        if (isCutsceneOnlyEntity(npcDef)) continue;
        npcs++;
      }
    }
    return { bgLayers, hotspots, npcs };
  }

  private async buildSceneResourceManifest(sceneId: string, sceneData: SceneData): Promise<AssetManifest> {
    const refs: AssetRef[] = [];
    const add = (ref: AssetRef | null | undefined): void => {
      if (!ref?.path?.trim()) return;
      refs.push(ref);
    };

    for (const layer of sceneData.backgrounds ?? []) {
      add({ type: 'texture', path: layer.image, label: `背景: ${layer.image}` });
    }

    const committedMemory = this.getCommittedMemory(sceneId);
    const activeCutsceneId = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.cutsceneId : null;
    for (const def of sceneData.hotspots ?? []) {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId));
      if (!boundToActive) {
        if (isCutsceneOnlyEntity(def)) continue;
        if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
        if (ovr?.enabled === false) continue;
      }
      const defToUse = applyHotspotRuntimeOverride(
        def,
        this.getRuntimeOverrideForContext(
          sceneId,
          'hotspot',
          def.id,
          def,
          boundToActive ? 'cutscene' : 'outer',
        ) as Record<string, SceneEntityRuntimeValue> | undefined,
      );
      if (defToUse.displayImage?.image) {
        add({ type: 'texture', path: defToUse.displayImage.image, label: `Hotspot: ${def.id}` });
      }
    }

    for (const npcDef of sceneData.npcs ?? []) {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId));
      if (!boundToActive && isCutsceneOnlyEntity(npcDef)) continue;
      const snap = this.getRuntimeOverrideForContext(
        sceneId,
        'npc',
        npcDef.id,
        npcDef,
        boundToActive ? 'cutscene' : 'outer',
      ) as NpcRuntimeOverride | undefined;
      const defToUse = applyNpcRuntimeOverride(
        applyCharacterDefaults(npcDef, this.characterRegistry),
        snap as Record<string, SceneEntityRuntimeValue> | undefined,
      );
      if (!defToUse.animFile) continue;
      add({ type: 'json', path: defToUse.animFile, label: `NPC 动画清单: ${npcDef.id}` });
      try {
        const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(defToUse.animFile);
        if (animRaw.spritesheet) {
          add({
            type: 'texture',
            path: resolvePathRelativeToAnimManifest(defToUse.animFile, animRaw.spritesheet),
            label: `NPC 图集: ${npcDef.id}`,
          });
        }
      } catch {
        // 实例化时仍会降级为占位；manifest 只做尽力收集。
      }
    }

    if (sceneData.depthConfig) {
      const basePath = `resources/runtime/scenes/${sceneId}/`;
      if (sceneData.depthConfig.depth_map) {
        add({ type: 'texture', path: basePath + sceneData.depthConfig.depth_map, label: `深度图: ${sceneId}` });
      }
      if (sceneData.depthConfig.collision_map) {
        add({ type: 'bitmap', path: basePath + sceneData.depthConfig.collision_map, label: `碰撞图: ${sceneId}` });
      }
    }

    if (sceneData.filterId) {
      add({ type: 'filter', path: sceneData.filterId, label: `滤镜: ${sceneData.filterId}` });
    }

    for (const ref of this.audioManifestResolver?.(sceneData.bgm, sceneData.ambientSounds) ?? []) {
      add(ref);
    }

    return { scopeId: `scene:${sceneId}`, refs };
  }

  async loadScene(
    sceneId: string,
    spawnPointId?: string,
    cameraPosition?: { x: number; y: number },
    fromSceneId?: string | null,
    onLoadProgress?: (ratio01: number, debugLabel: string) => void,
    /**
     * 揭幕回调：场景资源装载、实体滤镜/光照就绪（scene:ready）之后、**onEnter 之前**调用，
     * 用于撤掉切场过渡遮罩把场景显示出来。传入者（switchScene）借此保证 onEnter 里的成段演出
     * 落在可见场景之上、且长演出不再把揭幕与进度收尾扣为人质。不传（初始进场/重载）= 无遮罩，跳过。
     */
    onReveal?: () => Promise<void>,
  ): Promise<void> {
    onLoadProgress?.(0, `场景 JSON · ${sceneId}`);
    const sceneData = await this.assetManager.loadSceneData(sceneId);
    this.currentScene = sceneData;
    const manifest = await this.buildSceneResourceManifest(sceneId, sceneData);

    const committedMemory = this.getCommittedMemory(sceneId);
    const activeCutsceneId = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.cutsceneId : null;

    let doneSteps = 0;
    let totalSteps = 1;
    const report = (label: string) => {
      if (!onLoadProgress || totalSteps < 1) return;
      onLoadProgress(Math.min(1, doneSteps / totalSteps), label);
    };
    const advance = (label: string) => {
      if (!onLoadProgress) return;
      doneSteps++;
      onLoadProgress(Math.min(1, doneSteps / totalSteps), label);
    };

    if (onLoadProgress) {
      const { bgLayers, hotspots: hsN, npcs: npcN } = this.countSceneInstantiateWork(
        sceneData,
        sceneId,
        committedMemory,
        activeCutsceneId,
      );
      const depthBonus = this.depthLoader ? 1 : 0;
      const filterBonus = sceneData.filterId ? 1 : 0;
      // onEnter 不再计入加载进度：它在进度打满、场景揭幕之后才跑（见 loadScene 尾部）。
      totalSteps = 1 + manifest.refs.length + bgLayers + hsN + npcN + depthBonus + filterBonus;
      if (totalSteps < 1) totalSteps = 1;
      advance(`JSON ✓ · ${sceneData.name ?? sceneId}`);
    }

    await this.assetManager.preloadManifest(manifest, {
      mode: 'stage',
      tolerateErrors: true,
      onProgress: (r, label) => {
        if (!onLoadProgress) return;
        doneSteps = 1 + Math.round(r * manifest.refs.length);
        onLoadProgress(Math.min(1, doneSteps / totalSteps), label);
      },
    });
    doneSteps = onLoadProgress ? 1 + manifest.refs.length : doneSteps;
    this.currentSceneScopeId = manifest.scopeId;

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
        report(`背景 ${i + 1}/${layers.length}: ${layer.image}`);
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
        advance(`背景层 ${i + 1}/${layers.length} ✓`);
      }
    } else {
      this.sceneContainerBg = createPlaceholderBackground(
        this.renderer.app,
        sceneData.worldWidth,
        sceneData.worldHeight,
      );
    }
    this.renderer.backgroundLayer.addChild(this.sceneContainerBg);

    if (sceneData.hotspots) {
      for (const def of sceneData.hotspots) {
        const boundToActive = activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId);
        if (boundToActive) {
          // cutscene context: skip pickedUpHotspots filter, skip committed enabled filter
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'cutscene');
          report(`Hotspot ${def.id} · cutscene`);
          const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
          this.currentHotspots.push(hotspot);
          advance(`Hotspot ${def.id} ✓`);
        } else {
          // outer context
          if (isCutsceneOnlyEntity(def)) continue;
          if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
          if (ovr?.enabled === false) continue;
          report(`Hotspot ${def.id}`);
          const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
          this.currentHotspots.push(hotspot);
          advance(`Hotspot ${def.id} ✓`);
        }
      }
    }

    if (sceneData.npcs) {
      for (const npcDef of sceneData.npcs) {
        const boundToActive = activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId);
        if (boundToActive) {
          // cutscene context
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'cutscene') as NpcRuntimeOverride | undefined;
          report(`NPC ${npcDef.id} · cutscene`);
          const npc = await this.instantiateNpc(npcDef, snap);
          this.currentNpcs.push(npc);
          advance(`NPC ${npcDef.id} ✓`);
        } else {
          // outer context
          if (isCutsceneOnlyEntity(npcDef)) continue;
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
          report(`NPC ${npcDef.id}`);
          const npc = await this.instantiateNpc(npcDef, snap);
          this.currentNpcs.push(npc);
          advance(`NPC ${npcDef.id} ✓`);
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);

    this.applyPlayerSpawnAndCamera(sceneData, spawnPointId, cameraPosition);

    this.audioApplier?.(sceneData.bgm, sceneData.ambientSounds);
    this.zoneSetter?.(this.computeEffectiveZones(sceneId, sceneData.zones));

    if (this.depthLoader) {
      report(`深度图 · ${sceneId}`);
      await this.depthLoader(sceneId, sceneData, worldToPixelX, worldToPixelY);
      advance(`深度图 ✓`);
    }

    if (sceneData.filterId) {
      report(`世界滤镜 · ${sceneData.filterId}`);
      try {
        await this.renderer.loadAndSetWorldFilter(sceneData.filterId);
      } catch (_e) {
        this.renderer.clearWorldFilter();
      }
      advance(`世界滤镜 ✓`);
    } else {
      this.renderer.clearWorldFilter();
    }

    if (onLoadProgress) {
      onLoadProgress(1, `就绪 · ${sceneId}`);
    }

    // scene:ready 会给玩家/NPC/热点挂上深度遮挡与光照滤镜、启动巡逻——必须在**揭幕之前**完成，
    // 揭出来的场景才是完整表现。scene:enter 供 HUD/地图等复位。二者与 onEnter 解耦、先于 onEnter。
    this.eventBus.emit('scene:enter', { sceneId, fromSceneId: fromSceneId ?? null, sceneName: sceneData.name });
    this.eventBus.emit('scene:ready');

    // 揭幕：撤掉切场过渡遮罩，把已就绪的场景显示出来，**再**跑 onEnter。这样 onEnter 里的
    // 成段演出（过场/对话）落在可见场景之上、而非被加载遮罩盖住；长演出也不再把揭幕/进度收尾扣住。
    if (onReveal) {
      try {
        await onReveal();
      } catch (e) {
        console.warn('SceneManager: 场景揭幕失败', e);
      }
    }

    // onEnter 语义 = 场景已进入且呈现完成之后的一次性脚本逻辑（置 flag / 发信号 / 起演出）。
    const rootEnter = sceneData.onEnter;
    if (rootEnter?.length && this.sceneEnterRunner) {
      // 批内的 changeScene 由 switchScene 识别为重入（见 sceneEnterBatchDepth）：
      // 只登记不排队自等——排队会造成「当前 job 等 onEnter、onEnter 等队尾新 job」的环形死锁
      this.sceneEnterBatchDepth++;
      try {
        await this.sceneEnterRunner(rootEnter);
      } catch (e) {
        console.warn('SceneManager: 场景根 onEnter 动作执行失败', e);
      } finally {
        this.sceneEnterBatchDepth--;
      }
    }

    // 直接 loadScene（初始进场等，不经 switchScene）路径：onEnter 内登记的切换在此 drain；
    // switchScene 路径由外层 job 完成后统一 drain（此时 isSwitching 为 true，跳过）。
    if (!this.isSwitching) {
      this.consumePendingReentrantSwitch();
    }
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
    this.sceneEpoch++;
    this.eventBus.emit('scene:beforeUnload');
    this.interactionSetter?.([], []);
    if (this.currentSceneScopeId) {
      this.assetManager.releaseScope(this.currentSceneScopeId);
      this.currentSceneScopeId = null;
    }

    for (const hotspot of this.currentHotspots) {
      // scene:beforeUnload 通常已摘除热点深度滤镜；此处再摘一次是幂等兜底（detach 返回 null 即跳过）。
      this.releaseHotspotFilters(hotspot);
      hotspot.destroy();
    }
    this.currentHotspots = [];

    for (const npc of this.currentNpcs) {
      this.releaseNpcFilters(npc);
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
    if (this.sceneEnterBatchDepth > 0) {
      // 场景根 onEnter 批内的 changeScene（重入）：排队自等会环形死锁——当前加载 job 正 await
      // 本批动作，本批若再 await 队尾的新 job 即互相等待、永久黑屏。改为登记后立即返回
      // （fire-and-forget）：onEnter 批内 changeScene 之后的动作仍在旧场景跑完，当前加载
      // 完成后自动执行登记的切换。连锁多次（B 的 onEnter 又 changeScene C）逐层 drain，同样安全。
      if (this.pendingReentrantSwitch) {
        console.warn(
          `SceneManager: onEnter 批内多次 changeScene，丢弃 "${this.pendingReentrantSwitch.targetSceneId}"、保留 "${targetSceneId}"`,
        );
      }
      this.pendingReentrantSwitch = { targetSceneId, spawnPointId, cameraPosition };
      return;
    }

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
        this.eventBus.emit('scene:transition', {
          fromSceneId: this.currentScene?.id ?? null,
          toSceneId: tid,
        });
        this.saveCurrentSceneMemory();

        await this.fadeOut(300);

        const fromSceneId = this.currentScene?.id ?? null;
        this.unloadScene();
        // 揭幕（fadeIn 撤黑幕）作为 onReveal 交给 loadScene 在 scene:ready 之后、onEnter 之前执行，
        // 使 onEnter 的成段演出显示在可见场景上；故此处 job 尾部不再另行 fadeIn。
        const reveal = (): Promise<void> => this.fadeIn(300);
        try {
          await this.loadScene(tid, spawnPointId, cameraPosition, fromSceneId, (r, label) => {
            this.setTransitionOverlayProgress(r, label);
          }, reveal);
        } catch (e) {
          console.error(`SceneManager: 加载场景 "${tid}" 失败`, e);
          // 清掉半装载的实体/背景，再尝试回载前一场景（其资源通常已在缓存）
          this.unloadScene();
          let recovered = false;
          if (fromSceneId) {
            try {
              await this.loadScene(fromSceneId, undefined, undefined, tid, (r, label) => {
                this.setTransitionOverlayProgress(r, label);
              }, reveal);
              recovered = true;
            } catch (e2) {
              console.error(`SceneManager: 回载前一场景 "${fromSceneId}" 亦失败`, e2);
            }
          }
          // 引擎级故障提示：此时数据/文案通道本身可能就是故障源，不走 [tag] 文案
          this.eventBus.emit('notification:show', {
            text: recovered ? `无法进入「${tid}」，已退回原场景` : `场景「${tid}」加载失败`,
            type: 'warning',
          });
          if (!recovered) {
            // 双双失败：至少不留 alpha=1 的黑幕锁死画面
            this.removeTransitionOverlay();
            return;
          }
        }
      } finally {
        this.isSwitching = false;
      }
    };

    const p = this.sceneSwitchTail.then(job, job);
    this.sceneSwitchTail = p.catch((e) => {
      console.warn('SceneManager: switchScene failed', e);
    });
    try {
      await p;
    } finally {
      // onEnter 批内登记的切换在当前 job 结束后执行（无论成败）
      this.consumePendingReentrantSwitch();
    }
  }

  /** 执行 onEnter 批内登记的切换请求（fire-and-forget；原调用方早已返回，失败仅日志）。 */
  private consumePendingReentrantSwitch(): void {
    const req = this.pendingReentrantSwitch;
    if (!req) return;
    this.pendingReentrantSwitch = null;
    void this.switchScene(req.targetSceneId, req.spawnPointId, req.cameraPosition).catch((e) => {
      console.warn('SceneManager: 延后的 onEnter changeScene 失败', e);
    });
  }


  /**
   * 当前场景运行态（拾取/巡查/实体覆盖）都在发生时即写入 sceneMemory（见
   * markHotspotPickedUp / markHotspotInspected / setEntityRuntimeField），本方法只确保
   * 内存桶存在——可随时安全调用（切场景、存档 serialize 前都会调）。
   * 不再从实体 `!active` 反推拾取：那会把条件隐藏 / 会话隐藏的 pickup 误记为已拾取。
   */
  private saveCurrentSceneMemory(): void {
    if (!this.currentScene) return;
    if (this.cutsceneStaging) return;
    this.ensureSceneMemory(this.currentScene.id);
  }

  private markHotspotPickedUp(hotspotId: string): void {
    const hotspot = this.currentHotspots.find(h => h.def.id === hotspotId);
    hotspot?.markPickedUp();
    // 拾取立刻入 sceneMemory（不等切场景反推）。与旧推断口径一致：只有 pickup 型入档；
    // encounter 型热点的 `hotspot:pickup:done` 自消费仅置实例运行态位——当次场景访问内
    // 失活，重进场景（或过场重建）后可再次触发，且不进存档。
    const def = hotspot?.def ?? this.currentScene?.hotspots?.find(h => h.id === hotspotId);
    if (def?.type !== 'pickup') return;
    if (!this.currentScene) return;
    const mem = this.getWritableMemory(this.currentScene.id);
    if (mem && !mem.pickedUpHotspots.includes(hotspotId)) {
      mem.pickedUpHotspots.push(hotspotId);
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
    this.ensureTransitionOverlay();
    this.transitionOverlay!.alpha = 0;
    await this.animateAlpha(this.transitionOverlay!, 0, 1, durationMs);
  }

  private async fadeIn(durationMs: number): Promise<void> {
    this.ensureTransitionOverlay();
    this.transitionOverlay!.alpha = 1;
    await this.animateAlpha(this.transitionOverlay!, 1, 0, durationMs);
    this.removeTransitionOverlay();
  }

  private ensureTransitionOverlay(): void {
    if (this.transitionOverlay) return;

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const root = new Container();
    root.x = -100;
    root.y = -100;

    const bg = new Graphics();
    bg.rect(0, 0, sw + 200, sh + 200).fill(0x000000);
    root.addChild(bg);

    const barW = Math.min(480, Math.max(200, Math.round(sw * 0.72)));
    const barH = Math.max(6, Math.round(sh * 0.014));
    const bx = 100 + (sw - barW) / 2;
    const by = 100 + Math.round(sh * 0.88);

    // 切场进度上的资源级调试文案只在 DEV 构建可见（T4）；生产不建该 Text，
    // setTransitionOverlayProgress 对 null 标签自然跳过
    if (import.meta.env.DEV) {
      const debugLabel = new Text({
        text: '',
        style: {
          fontFamily: 'system-ui, Segoe UI, sans-serif',
          fontSize: 10,
          fill: 0xa8b8cf,
          wordWrap: true,
          wordWrapWidth: barW,
          lineHeight: 12,
        },
      });
      debugLabel.anchor.set(0, 1);
      debugLabel.x = bx;
      debugLabel.y = by - 8;
      root.addChild(debugLabel);
      this.transitionDebugLabel = debugLabel;
    }

    const rad = Math.min(5, barH / 2);
    const track = new Graphics();
    track.roundRect(bx, by, barW, barH, rad);
    track.fill({ color: 0x1e293b, alpha: 0.92 });
    track.stroke({ color: 0x64748b, width: 1, alpha: 0.55 });
    root.addChild(track);

    const fill = new Graphics();
    fill.x = bx;
    fill.y = by;
    root.addChild(fill);

    this.transitionOverlay = root;
    this.transitionBarFill = fill;
    this.transitionBarW = barW;
    this.transitionBarH = barH;

    this.renderer.uiLayer.addChild(root);
    this.setTransitionOverlayProgress(0, '');
  }

  private setTransitionOverlayProgress(ratio01: number, debugLabel: string): void {
    const fill = this.transitionBarFill;
    if (fill) {
      const r = Math.max(0, Math.min(1, ratio01));
      const pw = Math.max(0, r * this.transitionBarW);
      const h = this.transitionBarH;
      const rad = Math.min(5, h / 2);
      fill.clear();
      if (pw >= 0.5) {
        fill.roundRect(0, 0, pw, h, Math.min(rad, pw / 2));
        fill.fill(0x38bdf8);
        fill.stroke({ color: 0xbae6fd, width: 1, alpha: 0.55 });
      }
    }
    const lbl = this.transitionDebugLabel;
    if (lbl) {
      const pct = Math.round(Math.max(0, Math.min(1, ratio01)) * 100);
      lbl.text = `[${pct}%] ${debugLabel}`;
    }
  }

  private removeTransitionOverlay(): void {
    if (this.transitionOverlay) {
      if (this.transitionOverlay.parent) {
        this.transitionOverlay.parent.removeChild(this.transitionOverlay);
      }
      this.transitionOverlay.destroy({ children: true });
      this.transitionOverlay = null;
      this.transitionBarFill = null;
      this.transitionDebugLabel = null;
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
    // 存档前 flush 当前场景运行态（幂等；运行态本身已即时入 memory，此处兜底建桶）
    this.saveCurrentSceneMemory();
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
    // 读档=新时间线：会话级（不入档）的 zone 禁用与实体隐藏覆盖全部作废
    this.zoneSessionDisabled.clear();
    this.entitySessionOverrides.clear();
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
    this.entitySessionOverrides.clear();
    this.pendingReentrantSwitch = null;
    this.eventBus.off('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.off('hotspot:inspected', this.onHotspotInspected);
    this.unloadScene();
    this.removeTransitionOverlay();
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
