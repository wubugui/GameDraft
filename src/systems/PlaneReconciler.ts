import type { EventBus } from '../core/EventBus';
import type { AssetManager } from '../core/AssetManager';
import type { NarrativeGraph, NarrativeStateNode } from '../core/NarrativeStateManager';
import type { GameContext, IGameSystem, SceneLightEnv } from '../data/types';
import { GameState } from '../data/types';
import { TEXT_URLS } from '../core/projectPaths';
import type { PlaneDef } from './plane/types';
import type { PlayerMovementModifier } from '../entities/Player';
import type { PlaneInteractionPolicy } from './InteractionSystem';

/** 开局默认位面 id：无叙事点名、无手动覆盖时激活。 */
export const NORMAL_PLANE_ID = 'normal';

/**
 * PlaneReconciler 的重依赖注入（照 PressureHoldManager.bindRuntime 范式，由 Game 组装层接线）。
 */
export interface PlaneReconcilerRuntimeBinding {
  /** 叙事状态只读口（激活位面从叙事点名派生） */
  narrative: {
    getGraphs(): NarrativeGraph[];
    getActiveState(graphId: string): string | undefined;
  };
  /** 玩家控制器槽：Player.setMovementModifier */
  setPlayerMovementModifier(fn: (() => PlayerMovementModifier) | null): void;
  /** 交互拾取槽：InteractionSystem.setPlaneInteractionPolicy */
  setPlaneInteractionPolicy(fn: (() => PlaneInteractionPolicy) | null): void;
  /** 实体显隐槽：SceneManager.refreshEntitiesForPlaneChange(当前场景)；无场景时应为 no-op。任何 GameState 下均可安全调用（纯显隐，无动作副作用）。 */
  refreshEntitiesForPlaneChange(): void;
  /**
   * zone 显隐槽：SceneManager.refreshZonesForPlaneChange(当前场景)。zone 差分注销会触发
   * onExit 动作批——过场期间策略栈屏蔽改存档动作且不补发，故仅在 Exploring 态调用
   * （非 Exploring 时挂起，回 Exploring 边沿补刷，见 pendingZoneRefresh）。
   */
  refreshZonesForPlaneChange(): void;
  /** 相机槽：Camera.setZoom（与 setCameraZoom action 同 dep） */
  setCameraZoom(zoom: number): void;
  /** 相机槽复原：恢复当前场景 JSON 配置的 zoom（与 restoreSceneCameraZoom action 同 dep） */
  restoreSceneCameraZoom(): void;
  /** 光照槽：Game.applyPlaneLightEnvOverride（null = 清除、恢复场景默认/曲线） */
  applyPlaneLightEnvOverride(partial: SceneLightEnv | null): void;
  /** 掉阳气：HealthSystem.damage（可触发死亡系绳；async，不 await 堆积） */
  damagePlayer(amount: number): Promise<void>;
  /** GameStateController.currentState getter（边沿检测 + 槽生效条件） */
  getGameState(): GameState;
}

/** F2 调试快照（「位面」区块用）。 */
export interface PlaneDebugState {
  activePlaneId: string;
  source: 'manual' | 'narrative' | 'default';
  def: PlaneDef | null;
  /** 当前各叙事图的点名（插入序，末项 = 最后进入 = 生效者） */
  namedBy: Array<{ graphId: string; planeId: string }>;
}

/**
 * 位面对账器（位面基建的唯一新系统，见 plans/位面基建 与 `plane/types.ts`）。
 *
 * 职责：监听叙事状态广播派生**激活位面**（manual override ?? 最后进入的点名状态 ?? normal），
 * 把世界对账为 f(激活位面)：实体/zone 显隐（经 SceneManager 派生基底通道 + 位面归属字段）、
 * 玩家移动修饰、交互门闸、相机 zoom（仅 Exploring）、光照档、掉阳气 ticker。
 *
 * 对账时机：narrative:stateChanged（激活位面变化时）、scene:ready（全量重算 + 对账，
 * 兜住读档——deserialize 不发叙事事件）、scene:entitiesRebuilt（过场重建实体后重贴显隐）、
 * update() 内 GameState 边沿（setState 无广播，回到 Exploring 时重贴 camera/lighting）。
 *
 * 自身零持久化：激活位面从叙事状态（已持久化）重派生；manual override 不入档，
 * 且按写入时机分作用域（过场内随 cutscene:end 清除；过场外为 session 语义）。
 * §1 合规：重依赖全部经 bindRuntime 注入，不直接 import 其它系统实例。
 */
export class PlaneReconciler implements IGameSystem {
  private readonly eventBus: EventBus;
  private assetManager: AssetManager | null = null;
  private binding: PlaneReconcilerRuntimeBinding | null = null;

  private defs: Map<string, PlaneDef> = new Map();
  /** activatePlane 动作/命令写入的手动覆盖（不入档） */
  private manualOverridePlaneId: string | null = null;
  /**
   * 手动覆盖作用域（anywhere_scoped 决议）：过场内写入的 override 标记 'cutscene'，
   * cutscene:end 自动清除并回落叙事点名；过场外/调试命令为 'session'（持续到
   * deactivatePlane / 读档）。
   */
  private manualOverrideScope: 'session' | 'cutscene' = 'session';
  /** 过场态（经 cutscene:start/end 维护），决定新写入 override 的作用域 */
  private inCutscene = false;
  /**
   * 会话内「最后进入的点名状态」：graphId → planeId。Map 保留插入序，末项 = 最后进入。
   * 经 narrative:stateChanged 增量维护；deserialize / scene:ready 全量重算（此时序为扫描序，
   * 多点名取任意并 console.error——校验器保证互斥，这本就是 error 路径）。
   */
  private lastNaming: Map<string, string> = new Map();
  private activePlaneId: string = NORMAL_PLANE_ID;

  /** 相机槽是否由本系统施加过 zoom（离开位面时才 restore，避免空 restore 冲掉别人的 zoom） */
  private cameraApplied = false;
  /** 掉阳气累计（节流成整数扣，damage 为 async 不 await 堆积） */
  private drainAccum = 0;
  /** GameState 边沿检测：上帧状态（null = 尚未采样） */
  private lastGameState: GameState | null = null;
  /** 未注册位面被激活的告警去重 */
  private warnedUnknownPlaneIds: Set<string> = new Set();
  /** 非 Exploring 态挂起的 zone 重注册（防过场策略栈吞掉 onExit 的改存档动作），回 Exploring 边沿补刷 */
  private pendingZoneRefresh = false;

  private readonly onNarrativeStateChanged: (p: unknown) => void;
  private readonly onSceneReady: () => void;
  private readonly onEntitiesRebuilt: () => void;
  private readonly onSaveRestoring: () => void;
  private readonly onCutsceneStart: () => void;
  private readonly onCutsceneEnd: () => void;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    // 回调构造期绑定一次；订阅在 init 挂、destroy 摘（律8）。
    this.onNarrativeStateChanged = (p) => {
      const pp = p as { graphId?: unknown; to?: unknown } | undefined;
      const graphId = String(pp?.graphId ?? '').trim();
      if (!graphId) return;
      const to = String(pp?.to ?? '').trim();
      this.noteGraphState(graphId, to);
      this.recomputeActiveAndReconcileIfChanged();
    };
    this.onSceneReady = () => {
      // 读档 / 切场景后的全量重算 + 无条件对账（新场景实体/zone 需要按位面重贴一次）。
      this.recomputeNamingFromNarrative();
      this.recomputeActivePlaneId();
      this.reconcile();
    };
    this.onEntitiesRebuilt = () => {
      // 过场进出重建的实体是全新实例，位面显隐要重贴。只贴实体不动 zones——
      // 此事件发生在过场中，zone 差分的 onExit 会被过场策略栈吞掉改存档动作。
      this.binding?.refreshEntitiesForPlaneChange();
    };
    this.onSaveRestoring = () => {
      // 读档（含旧档无本系统桶、deserialize 不被调的路径）：手动覆盖为 session 态，
      // 任何读档都应清除，激活位面由存档里的叙事状态重派生。
      this.manualOverridePlaneId = null;
    };
    this.onCutsceneStart = () => {
      this.inCutscene = true;
    };
    this.onCutsceneEnd = () => {
      this.inCutscene = false;
      // 过场作用域的 override 随过场自动清除，回落叙事点名/normal（anywhere_scoped 决议）。
      if (this.manualOverridePlaneId !== null && this.manualOverrideScope === 'cutscene') {
        this.manualOverridePlaneId = null;
        this.recomputeActiveAndReconcileIfChanged();
      }
    };
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.eventBus.off('narrative:stateChanged', this.onNarrativeStateChanged);
    this.eventBus.off('scene:ready', this.onSceneReady);
    this.eventBus.off('scene:entitiesRebuilt', this.onEntitiesRebuilt);
    this.eventBus.off('save:restoring', this.onSaveRestoring);
    this.eventBus.off('cutscene:start', this.onCutsceneStart);
    this.eventBus.off('cutscene:end', this.onCutsceneEnd);
    this.eventBus.on('narrative:stateChanged', this.onNarrativeStateChanged);
    this.eventBus.on('scene:ready', this.onSceneReady);
    this.eventBus.on('scene:entitiesRebuilt', this.onEntitiesRebuilt);
    this.eventBus.on('save:restoring', this.onSaveRestoring);
    this.eventBus.on('cutscene:start', this.onCutsceneStart);
    this.eventBus.on('cutscene:end', this.onCutsceneEnd);
    this.manualOverridePlaneId = null;
    this.manualOverrideScope = 'session';
    this.inCutscene = false;
    this.lastNaming.clear();
    this.activePlaneId = NORMAL_PLANE_ID;
    this.cameraApplied = false;
    this.drainAccum = 0;
    this.lastGameState = null;
    this.warnedUnknownPlaneIds.clear();
    this.pendingZoneRefresh = false;
  }

  bindRuntime(binding: PlaneReconcilerRuntimeBinding): void {
    this.binding = binding;
  }

  async loadDefs(): Promise<void> {
    if (!this.assetManager) {
      console.warn('PlaneReconciler: loadDefs 前未 init（无 AssetManager）');
      return;
    }
    try {
      const defs = await this.assetManager.loadJson<PlaneDef[]>(TEXT_URLS.planes);
      this.registerDefs(Array.isArray(defs) ? defs : []);
    } catch {
      console.warn('PlaneReconciler: planes.json not found');
    }
  }

  /**
   * 注册位面配置（loadDefs 内部使用；测试可直接喂）。逐条校验，非法 warn + 跳过；
   * 随后按 `extends` 做加载期**槽级**展开（子写了某槽整槽用子的，缺槽继承父），
   * 环/缺父 warn + 忽略继承，运行时只消费展开后的扁平定义。
   */
  registerDefs(defs: PlaneDef[]): void {
    this.defs.clear();
    const raw = new Map<string, PlaneDef>();
    for (const def of defs) {
      try {
        this.validateDef(def);
        raw.set(def.id, def);
      } catch (e) {
        console.warn(`PlaneReconciler: 位面配置 "${def?.id}" 非法，已跳过`, e);
      }
    }
    for (const [id, flat] of this.expandExtends(raw)) {
      this.defs.set(id, flat);
    }
  }

  /** `extends` 继承时逐槽回填的键（id/label/extends 自身不继承）。 */
  private static readonly INHERITED_SLOT_KEYS = [
    'membership',
    'movement',
    'interaction',
    'camera',
    'lighting',
    'travel',
    'healthDrainPerSec',
  ] as const satisfies readonly (keyof PlaneDef)[];

  /**
   * 找出 extends 链上处于环中的全部位面 id（单父图：逐节点沿父链走色标记即可）。
   * 环必须在展开前整体剥离——只在递归撞环时短路是不够的：外层调用返回后仍会用已展开的
   * 父回填并覆盖缓存，形成"部分的、顺序相关的继承"（哪个环成员吃亏取决于条目顺序）。
   */
  private static findExtendsCycleMembers(raw: Map<string, PlaneDef>): Set<string> {
    const parentOf = (id: string): string => {
      const d = raw.get(id);
      const p = typeof d?.extends === 'string' ? d.extends.trim() : '';
      return p;
    };
    const onCycle = new Set<string>();
    const state = new Map<string, 'visiting' | 'done'>();
    for (const start of raw.keys()) {
      if (state.has(start)) continue;
      const path: string[] = [];
      let cur = start;
      while (cur && raw.has(cur) && !state.has(cur)) {
        state.set(cur, 'visiting');
        path.push(cur);
        cur = parentOf(cur);
      }
      // 停在"本轮正在访问"的节点 ⇒ 从该节点起到路径末尾构成环（先前轮次的节点已是 done）
      if (cur && state.get(cur) === 'visiting') {
        for (let i = path.indexOf(cur); i < path.length; i++) onCycle.add(path[i]!);
      }
      for (const id of path) state.set(id, 'done');
    }
    return onCycle;
  }

  /** 展开 extends 链为扁平定义。环上节点整体按无继承处理（真正"忽略继承"，顺序无关、
   *  与校验器 error 口径一致）；缺父同样 warn 并按无继承处理（运行时兜底）。 */
  private expandExtends(raw: Map<string, PlaneDef>): Map<string, PlaneDef> {
    const cycleMembers = PlaneReconciler.findExtendsCycleMembers(raw);
    for (const id of cycleMembers) {
      console.warn(`PlaneReconciler: 位面 "${id}" 的 extends 链存在环，已忽略继承`);
    }
    const out = new Map<string, PlaneDef>();
    const resolve = (id: string, trail: Set<string>): PlaneDef | undefined => {
      const cached = out.get(id);
      if (cached) return cached;
      const def = raw.get(id);
      if (!def) return undefined;
      const flat: PlaneDef = { ...def };
      const parentId =
        !cycleMembers.has(id) && typeof def.extends === 'string' ? def.extends.trim() : '';
      if (parentId) {
        if (trail.has(id)) {
          // 防御兜底：环已在预剥离阶段整体去除，正常不可达
          console.warn(`PlaneReconciler: 位面 "${id}" 的 extends 链存在环，已忽略继承`);
        } else {
          trail.add(id);
          const parent = resolve(parentId, trail);
          if (!parent) {
            console.warn(`PlaneReconciler: 位面 "${id}" extends 的父位面 "${parentId}" 不存在，已忽略继承`);
          } else {
            const sink = flat as unknown as Record<string, unknown>;
            for (const key of PlaneReconciler.INHERITED_SLOT_KEYS) {
              if (flat[key] === undefined && parent[key] !== undefined) {
                sink[key] = parent[key];
              }
            }
          }
        }
      }
      out.set(id, flat);
      return flat;
    };
    for (const id of raw.keys()) resolve(id, new Set());
    return out;
  }

  update(dt: number): void {
    const b = this.binding;
    if (!b) return;
    const state = b.getGameState();
    if (state !== this.lastGameState) {
      const entered = state === GameState.Exploring && this.lastGameState !== null;
      this.lastGameState = state;
      if (entered) {
        // 回到 Exploring：对话/过场等管理器归还相机与光照，重贴位面的 camera/lighting；
        // 非 Exploring 期间挂起的 zone 重注册在此补刷（onExit 动作批此刻不再被策略栈屏蔽）。
        this.applyCameraSlot();
        this.applyLightingSlot();
        if (this.pendingZoneRefresh) {
          this.pendingZoneRefresh = false;
          b.refreshZonesForPlaneChange();
        }
      }
    }
    if (state !== GameState.Exploring) return;

    const drain = this.activeDef()?.healthDrainPerSec;
    if (typeof drain === 'number' && Number.isFinite(drain) && drain > 0) {
      this.drainAccum += drain * dt;
      if (this.drainAccum >= 1) {
        const whole = Math.floor(this.drainAccum);
        this.drainAccum -= whole;
        // damage 为 async（触底会跑死亡系绳演出）；fire-and-forget，不 await 堆积。
        void b.damagePlayer(whole).catch((e) => {
          console.warn('PlaneReconciler: 掉阳气 damage 失败', e);
        });
      }
    } else {
      this.drainAccum = 0;
    }
  }

  /** 当前激活位面 id（SceneManager 位面归属判定经此读取；任何时刻可安全调用）。 */
  getActivePlaneId(): string {
    return this.activePlaneId;
  }

  /**
   * 激活位面的世界模型（见 PlaneDef.membership）：决定无 `planes` 归属字段的实体是否存在。
   * 未注册/未配置 = shared（保守：世界保持可见）；normal 恒 shared。
   */
  getActivePlaneMembership(): 'shared' | 'exclusive' {
    if (this.activePlaneId === NORMAL_PLANE_ID) return 'shared';
    return this.activeDef()?.membership === 'exclusive' ? 'exclusive' : 'shared';
  }

  /** travel 槽：当前位面是否允许地图快速旅行（缺省允许；面板 openGuard 与 map:travel 双闸消费）。 */
  isMapTravelAllowed(): boolean {
    return this.activeDef()?.travel?.allowMapTravel !== false;
  }

  /**
   * 激活位面的相机档（未配置/非法 = null）。Game 的"恢复场景 zoom"（restoreSceneCameraZoom /
   * fadingRestoreSceneCameraZoom，对话与过场收尾走它）以此为基线——否则收尾渐变会把
   * 位面 zoom 盖回场景值，位面相机档静默丢失。
   */
  getActiveCameraZoom(): number | null {
    const zoom = this.activeDef()?.camera?.zoom;
    return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : null;
  }

  /**
   * activatePlane 动作/调试命令：手动覆盖激活位面（压过叙事点名）。返回是否生效
   * （false=id 空/未注册被拒）。作用域自动判定（anywhere_scoped）：过场内写入随
   * cutscene:end 清除；过场外持续到 deactivatePlane / 读档。
   */
  activatePlaneManually(planeId: string): boolean {
    const id = String(planeId ?? '').trim();
    if (!id) {
      console.warn('PlaneReconciler: activatePlane 需要非空 id');
      return false;
    }
    if (id !== NORMAL_PLANE_ID && !this.defs.has(id)) {
      console.warn(`PlaneReconciler: activatePlane 未注册的位面 "${id}"（planes.json），已忽略`);
      return false;
    }
    this.manualOverridePlaneId = id;
    this.manualOverrideScope = this.inCutscene ? 'cutscene' : 'session';
    this.recomputeActiveAndReconcileIfChanged();
    return true;
  }

  /** deactivatePlane 动作/调试命令：清手动覆盖，回落到叙事点名（无点名回 normal）。 */
  deactivateManualPlane(): void {
    if (this.manualOverridePlaneId === null) return;
    this.manualOverridePlaneId = null;
    this.recomputeActiveAndReconcileIfChanged();
  }

  /** F2「位面」区块数据。 */
  getDebugState(): PlaneDebugState {
    let source: PlaneDebugState['source'] = 'default';
    if (this.manualOverridePlaneId !== null) source = 'manual';
    else if (this.lastNaming.size > 0) source = 'narrative';
    return {
      activePlaneId: this.activePlaneId,
      source,
      def: this.activeDef() ?? null,
      namedBy: [...this.lastNaming.entries()].map(([graphId, planeId]) => ({ graphId, planeId })),
    };
  }

  serialize(): object {
    // 零持久化：激活位面从叙事状态（已入档）重派生；manual override 为 session-only。
    return {};
  }

  deserialize(_data: object): void {
    // 名册序在 narrativeStateManager 之后：此刻叙事已恢复，可立即重派生激活位面，
    // 使随后的 reloadScene 装载期（computeEffectiveZones 等）读到正确位面；
    // 完整对账由读档必经的 scene:ready 兜底。
    this.manualOverridePlaneId = null;
    this.recomputeNamingFromNarrative();
    this.recomputeActivePlaneId();
  }

  destroy(): void {
    this.eventBus.off('narrative:stateChanged', this.onNarrativeStateChanged);
    this.eventBus.off('scene:ready', this.onSceneReady);
    this.eventBus.off('scene:entitiesRebuilt', this.onEntitiesRebuilt);
    this.eventBus.off('save:restoring', this.onSaveRestoring);
    this.eventBus.off('cutscene:start', this.onCutsceneStart);
    this.eventBus.off('cutscene:end', this.onCutsceneEnd);
    const b = this.binding;
    if (b) {
      b.setPlayerMovementModifier(null);
      b.setPlaneInteractionPolicy(null);
      b.applyPlaneLightEnvOverride(null);
      if (this.cameraApplied) b.restoreSceneCameraZoom();
    }
    this.binding = null;
    this.defs.clear();
    this.lastNaming.clear();
    this.manualOverridePlaneId = null;
    this.manualOverrideScope = 'session';
    this.inCutscene = false;
    this.activePlaneId = NORMAL_PLANE_ID;
    this.cameraApplied = false;
    this.drainAccum = 0;
    this.lastGameState = null;
    this.warnedUnknownPlaneIds.clear();
    this.pendingZoneRefresh = false;
  }

  // ---- 激活位面派生 ----

  private statePlaneOf(graph: NarrativeGraph, stateId: string): string | undefined {
    const state = graph.states?.[stateId] as NarrativeStateNode | undefined;
    const plane = typeof state?.activePlane === 'string' ? state.activePlane.trim() : '';
    return plane || undefined;
  }

  /** 增量维护「最后进入的点名状态」：graph 进入点名态 → 移到末尾；进入非点名态 → 移除。 */
  private noteGraphState(graphId: string, stateId: string): void {
    const nav = this.binding?.narrative;
    const graph = nav?.getGraphs().find((g) => g.id === graphId);
    const plane = graph && stateId ? this.statePlaneOf(graph, stateId) : undefined;
    this.lastNaming.delete(graphId);
    if (plane) this.lastNaming.set(graphId, plane);
  }

  /** 全量重算点名表（deserialize / scene:ready）：扫描全部图的激活状态。 */
  private recomputeNamingFromNarrative(): void {
    this.lastNaming.clear();
    const nav = this.binding?.narrative;
    if (!nav) return;
    const named: Array<{ graphId: string; stateId: string; planeId: string }> = [];
    for (const g of nav.getGraphs()) {
      const sid = nav.getActiveState(g.id);
      if (!sid) continue;
      const plane = this.statePlaneOf(g, sid);
      if (!plane) continue;
      named.push({ graphId: g.id, stateId: sid, planeId: plane });
      this.lastNaming.set(g.id, plane);
    }
    if (named.length > 1) {
      console.error(
        'PlaneReconciler: 多个叙事图同时点名位面（校验应保证互斥），任取其一：',
        named,
      );
    }
  }

  /** 激活位面 = manual override ?? 最后进入的点名 ?? normal。返回是否变化。 */
  private recomputeActivePlaneId(): boolean {
    let next = this.manualOverridePlaneId ?? undefined;
    if (!next) {
      for (const planeId of this.lastNaming.values()) next = planeId; // 末次赋值 = 最后进入
    }
    const resolved = next || NORMAL_PLANE_ID;
    if (resolved !== NORMAL_PLANE_ID && !this.defs.has(resolved) && !this.warnedUnknownPlaneIds.has(resolved)) {
      this.warnedUnknownPlaneIds.add(resolved);
      console.warn(`PlaneReconciler: 激活位面 "${resolved}" 未在 planes.json 注册（各槽按无配置处理）`);
    }
    if (resolved === this.activePlaneId) return false;
    this.activePlaneId = resolved;
    this.drainAccum = 0;
    return true;
  }

  private recomputeActiveAndReconcileIfChanged(): void {
    if (this.recomputeActivePlaneId()) this.reconcile();
  }

  private activeDef(): PlaneDef | undefined {
    return this.defs.get(this.activePlaneId);
  }

  // ---- 对账（世界 = f(激活位面)；apply 幂等） ----

  private reconcile(): void {
    const b = this.binding;
    if (!b) return;
    // 实体显隐随时安全；zone 差分注销会跑 onExit 动作批——非 Exploring（过场策略栈
    // 屏蔽改存档动作且不补发）时挂起，回 Exploring 边沿补刷（见 update()）。
    b.refreshEntitiesForPlaneChange();
    if (b.getGameState() === GameState.Exploring) {
      this.pendingZoneRefresh = false;
      b.refreshZonesForPlaneChange();
    } else {
      this.pendingZoneRefresh = true;
    }
    this.applyMovementSlot();
    this.applyInteractionSlot();
    this.applyCameraSlot();
    this.applyLightingSlot();
  }

  private applyMovementSlot(): void {
    const b = this.binding;
    if (!b) return;
    const m = this.activeDef()?.movement;
    if (!m) {
      b.setPlayerMovementModifier(null);
      return;
    }
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    const scale = num(m.speedScale, 1);
    const modifier: PlayerMovementModifier = {
      driftX: num(m.driftX, 0),
      driftY: num(m.driftY, 0),
      speedScale: scale > 0 ? scale : 1,
      allowRun: m.allowRun !== false,
    };
    b.setPlayerMovementModifier(() => modifier);
  }

  private applyInteractionSlot(): void {
    const b = this.binding;
    if (!b) return;
    const i = this.activeDef()?.interaction;
    if (!i) {
      b.setPlaneInteractionPolicy(null);
      return;
    }
    const policy: PlaneInteractionPolicy = {
      canPickup: i.canPickup !== false,
      canInteractHotspots: i.canInteractHotspots !== false,
      canTalkNpcs: i.canTalkNpcs !== false,
    };
    b.setPlaneInteractionPolicy(() => policy);
  }

  /** 相机 zoom 仅 Exploring 态应用；离开位面（或位面无 zoom 配置）时恢复场景默认。 */
  private applyCameraSlot(): void {
    const b = this.binding;
    if (!b) return;
    if (b.getGameState() !== GameState.Exploring) return; // 其它态由各自管理器持有相机
    const zoom = this.activeDef()?.camera?.zoom;
    if (typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0) {
      b.setCameraZoom(zoom);
      this.cameraApplied = true;
    } else if (this.cameraApplied) {
      b.restoreSceneCameraZoom();
      this.cameraApplied = false;
    }
  }

  private applyLightingSlot(): void {
    const b = this.binding;
    if (!b) return;
    b.applyPlaneLightEnvOverride(this.activeDef()?.lighting ?? null);
  }

  // ---- 校验 ----

  private validateDef(def: PlaneDef): void {
    if (typeof def?.id !== 'string' || !def.id.trim()) throw new Error('缺少 id');
    if (def.extends !== undefined && (typeof def.extends !== 'string' || !def.extends.trim())) {
      throw new Error('extends 须为非空字符串（父位面 id）');
    }
    if (def.membership !== undefined && def.membership !== 'shared' && def.membership !== 'exclusive') {
      throw new Error("membership 须为 'shared' 或 'exclusive'");
    }
    if (def.id.trim() === NORMAL_PLANE_ID && def.membership === 'exclusive') {
      throw new Error('normal 位面恒为 shared，不可配 exclusive');
    }
    const m = def.movement;
    if (m !== undefined) {
      for (const key of ['driftX', 'driftY', 'speedScale'] as const) {
        const v = m[key];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
          throw new Error(`movement.${key} 须为有限数字`);
        }
      }
      if (m.speedScale !== undefined && !(m.speedScale > 0)) {
        throw new Error('movement.speedScale 须为正数');
      }
      if (m.allowRun !== undefined && typeof m.allowRun !== 'boolean') {
        throw new Error('movement.allowRun 须为布尔');
      }
    }
    const zoom = def.camera?.zoom;
    if (zoom !== undefined && (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0)) {
      throw new Error('camera.zoom 须为有限正数');
    }
    const drain = def.healthDrainPerSec;
    if (drain !== undefined && (typeof drain !== 'number' || !Number.isFinite(drain) || drain < 0)) {
      throw new Error('healthDrainPerSec 须为非负有限数字');
    }
    const travel = def.travel;
    if (travel !== undefined) {
      if (typeof travel !== 'object' || travel === null || Array.isArray(travel)) {
        throw new Error('travel 须为对象');
      }
      if (travel.allowMapTravel !== undefined && typeof travel.allowMapTravel !== 'boolean') {
        throw new Error('travel.allowMapTravel 须为布尔');
      }
    }
  }
}
