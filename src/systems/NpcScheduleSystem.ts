import type { EventBus } from '../core/EventBus';
import type { AssetManager } from '../core/AssetManager';
import type { Npc } from '../entities/Npc';
import type {
  ConditionExpr,
  GameContext,
  IGameSystem,
  NpcDef,
  NpcScheduleDef,
  NpcScheduleEntry,
  NpcScheduleFile,
  Position,
  SceneData,
  TimeTransition,
} from '../data/types';
import { TEXT_URLS } from '../core/projectPaths';
import { isWithinRange, parseClock } from '../utils/dayTime';

/**
 * NPC 日程：**几点该在哪**（查表），以及**怎么当着玩家的面体面地离场**（演出）。
 *
 * 两条路径严格分开，混了就等于"当面消失"：
 *
 * - **玩家不在那个场景**：位置纯查表。进场景时实体按判定点直接生成/不生成，
 *   玩家没看见，不存在穿帮，零成本（本作是离散房间制，28/29 的场景都走这条）。
 * - **玩家在场且推进无画面遮挡（`seamless`）**：NPC 先说一句、走到**场景出口**才隐去；
 *   入场反过来从出口走进来。走的过程中它必须**仍被判定为在场**，否则每帧派生回写
 *   会在它走到一半时直接关掉——这就是 `leaving` / `arriving` 宽限集存在的唯一理由。
 *
 * 有画面遮挡的推进（`timelapse` / `fade` / `cut`）不演离场：遮挡期间直接重贴即可。
 *
 * 日程本身**不入存档**（是"时刻 + 条件"的派生结果），只有 `setOverride` 写的剧情覆盖入档。
 */

/** 走到出口的判定半径（世界单位）。moveTo 到点即停，留一点余量吸收浮点误差。 */
const ARRIVE_EPSILON = 4;
/** 无 exitAnchors 时按场景边界推导出口，额外往画外多走这么远，确保真的看不见了。 */
const OFFSCREEN_MARGIN = 80;
/** 离场/入场的行走速度（世界单位/秒）。 */
const WALK_SPEED = 70;

/** 日程解析结果。`scene: null` = 受日程管但此刻不在任何场景。 */
export interface NpcPlacement {
  scene: string | null;
  spot?: Position;
  activity?: string;
}

export interface NpcScheduleRuntimeBinding {
  getMinutesOfDay(): number;
  getCurrentSceneId(): string | null;
  getCurrentSceneData(): SceneData | null;
  getCurrentNpcs(): Npc[];
  /** 仅探索态推进离场演出：对话/过场里绝不走人（Gothic 的日程被打断即挂起，同理）。 */
  isExploring(): boolean;
  /** 条件求值——必须走 Game 的唯一上下文工厂，禁止自拼缩水上下文。 */
  evalConditions(conds: ConditionExpr[] | undefined): boolean;
  /** 播一句离场气泡。 */
  speak(npc: Npc, text: string): void;
  /** 按派生基底唯一真源重贴当前场景实体显隐（SceneManager 的统一刷新口）。 */
  refreshEntityVisibility(): void;
}

interface WalkState {
  npcId: string;
  targetX: number;
  targetY: number;
  /** 已发出的 moveTo 尚未落定。被对话打断时 moveTo 也会 resolve，故不能凭它判定"到了"。 */
  moving: boolean;
  /** 到位后播放的动画（仅入场用）。 */
  activity?: string;
  /** 离场台词是否已播。 */
  spoke: boolean;
}

export class NpcScheduleSystem implements IGameSystem {
  private eventBus: EventBus;
  private assetManager: AssetManager | null = null;
  private binding: NpcScheduleRuntimeBinding | null = null;

  private schedules: Map<string, NpcScheduleDef> = new Map();
  /** 剧情覆盖（`setOverride`）：命中的角色直接用它，跳过日程表。入存档。 */
  private overrides: Map<string, NpcPlacement> = new Map();

  /** 正在走向出口（仍判定为在场）。key = NPC 实例 id。 */
  private leaving: Map<string, WalkState> = new Map();
  /** 正在从出口走进来（同样判定为在场）。 */
  private arriving: Map<string, WalkState> = new Map();
  /** 上一帧各 NPC 的日程在场性，用于检出"该走了 / 该来了"的边沿。 */
  private lastPresent: Map<string, boolean> = new Map();
  /** 已告警过的未知 characterId，去重刷屏。 */
  private warnedUnknown: Set<string> = new Set();

  private readonly onTimeChanged: (p: unknown) => void;
  private readonly onSceneReady: () => void;
  private readonly onEntitiesRebuilt: () => void;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.onTimeChanged = (p) => {
      const transition = String(
        (p as { transition?: unknown } | undefined)?.transition ?? 'seamless',
      ) as TimeTransition;
      if (transition === 'seamless') {
        /* 无遮挡：**当拍**就把边沿检出来建好宽限集，不等下一帧 update。
         * 等一帧的话，"日程判定已翻转、宽限集还没建立"之间存在一个窗口，
         * 这期间任何 isNpcPresentNow 查询都会答"不在场"——NPC 会闪一下再走出去。 */
        const b = this.binding;
        const sceneData = b?.getCurrentSceneData();
        if (b && sceneData?.dayNight?.enabled === true && b.isExploring()) {
          this.detectScheduleEdges(b, sceneData);
        }
        /* 先建宽限集、后重贴：顺序反了会把刚要起步的 NPC 当场抹掉。
         * 这一贴是给**实体级 phases 归属**（群演/摊子热点，无离场演出）用的——
         * 它们要在时段翻转当拍就生效，而正在离场的 NPC 已被宽限集判为在场，不受影响。 */
        b?.refreshEntityVisibility();
        return;
      }
      // 有画面遮挡（延时/黑场/直切）：演出没有意义，丢弃在途的走位并按新时刻直接重贴。
      this.cancelAllWalks();
      this.binding?.refreshEntityVisibility();
      this.resyncPresenceBaseline();
    };
    this.onSceneReady = () => {
      // 切场景/读档：新场景的实体按当前时刻直接就位，不演出（玩家还没看见旧样子）——
      // 这就是「玩家不在场就纯查表」那条路径的落点。
      this.cancelAllWalks();
      this.applyScheduledPositions();
      this.resyncPresenceBaseline();
    };
    this.onEntitiesRebuilt = () => {
      // 过场进出重建的是全新实例，在途走位指向的旧实例已不存在。
      this.cancelAllWalks();
      this.resyncPresenceBaseline();
    };
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.eventBus.off('time:changed', this.onTimeChanged);
    this.eventBus.off('scene:ready', this.onSceneReady);
    this.eventBus.off('scene:entitiesRebuilt', this.onEntitiesRebuilt);
    this.eventBus.on('time:changed', this.onTimeChanged);
    this.eventBus.on('scene:ready', this.onSceneReady);
    this.eventBus.on('scene:entitiesRebuilt', this.onEntitiesRebuilt);
    this.overrides.clear();
    this.cancelAllWalks();
    this.lastPresent.clear();
    this.warnedUnknown.clear();
  }

  bindRuntime(binding: NpcScheduleRuntimeBinding): void {
    this.binding = binding;
  }

  async loadDefs(): Promise<void> {
    if (!this.assetManager) {
      console.warn('NpcScheduleSystem: loadDefs 前未 init（无 AssetManager）');
      return;
    }
    try {
      const file = await this.assetManager.loadJson<NpcScheduleFile>(TEXT_URLS.npcSchedules);
      this.registerDefs(Array.isArray(file?.schedules) ? file.schedules : []);
    } catch {
      // 没有这个文件 = 全世界都不用日程，是合法状态（旧工程/未启用日夜）。
      this.registerDefs([]);
    }
  }

  /** 注册日程表（loadDefs 内部使用；测试可直接喂）。逐条校验，非法 warn + 跳过。 */
  registerDefs(defs: NpcScheduleDef[]): void {
    this.schedules.clear();
    for (const def of defs) {
      const cid = String(def?.characterId ?? '').trim();
      if (!cid) {
        console.warn('NpcScheduleSystem: 跳过缺 characterId 的日程表');
        continue;
      }
      if (this.schedules.has(cid)) {
        console.warn(`NpcScheduleSystem: 角色 "${cid}" 有重复日程表，保留首条`);
        continue;
      }
      const entries = Array.isArray(def.entries) ? def.entries : [];
      if (entries.length === 0) {
        console.warn(`NpcScheduleSystem: 角色 "${cid}" 的日程表为空，已跳过`);
        continue;
      }
      this.schedules.set(cid, { ...def, characterId: cid, entries });
    }
  }

  // ---- 查表 ----

  /**
   * 求某角色此刻该在哪。返回 `null` = **不受日程管**（没配表 / 表条件不满足），
   * 与「受管但不在任何场景」（`{scene: null}`）是两回事——前者回落成普通常驻 NPC。
   */
  resolvePlacement(characterId: string, minutesOfDay: number): NpcPlacement | null {
    const cid = String(characterId ?? '').trim();
    if (!cid) return null;
    const override = this.overrides.get(cid);
    if (override) return override;
    const def = this.schedules.get(cid);
    if (!def) return null;
    if (!this.evalConditions(def.conditions)) return null;
    const hit = this.findEntry(def, minutesOfDay);
    if (!hit) return null;
    return {
      scene: typeof hit.scene === 'string' && hit.scene.trim() ? hit.scene.trim() : null,
      spot: hit.spot,
      activity: hit.activity,
    };
  }

  /** 取第一条时间命中**且**条件满足的条目（多条覆盖同一时段时靠条件择一，同 Stardew 的 schedule key）。 */
  private findEntry(def: NpcScheduleDef, minutesOfDay: number): NpcScheduleEntry | null {
    for (const entry of def.entries) {
      const from = parseClock(entry?.from);
      const to = parseClock(entry?.to);
      if (from === null || to === null) {
        if (!this.warnedUnknown.has(`${def.characterId}:badclock`)) {
          this.warnedUnknown.add(`${def.characterId}:badclock`);
          console.warn(
            `NpcScheduleSystem: 角色 "${def.characterId}" 有非法时刻的日程条目（需 HH:MM），已跳过该条`,
          );
        }
        continue;
      }
      if (!isWithinRange(minutesOfDay, from, to)) continue;
      if (!this.evalConditions(entry.conditions)) continue;
      return entry;
    }
    return null;
  }

  private evalConditions(conds: ConditionExpr[] | undefined): boolean {
    if (!conds || conds.length === 0) return true;
    return this.binding?.evalConditions(conds) ?? true;
  }

  /**
   * 当前场景里这个 NPC 此刻该不该在——**派生基底判定点消费的唯一入口**。
   *
   * 离场/入场演出期间恒为 true（宽限集）：正在走出去的 NPC 仍然在场上，
   * 否则每帧派生回写会把它在半路上抹掉。
   */
  isNpcPresentNow(def: NpcDef): boolean {
    if (!def) return true;
    const id = String(def.id ?? '').trim();
    if (this.leaving.has(id) || this.arriving.has(id)) return true;
    const sceneData = this.binding?.getCurrentSceneData() ?? null;
    // 场景没开日夜 = 完全不受日程管（旧场景零影响）。
    if (sceneData?.dayNight?.enabled !== true) return true;
    const cid = String(def.characterId ?? '').trim();
    if (!cid) return true;
    const minutes = this.binding?.getMinutesOfDay() ?? 0;
    const placement = this.resolvePlacement(cid, minutes);
    if (!placement) return true;
    return placement.scene === (sceneData?.id ?? null);
  }

  // ---- 剧情覆盖 ----

  /** 把某角色钉在指定场景/位置（剧情覆盖，跳过日程表）。`placement` 传 null 清除覆盖。 */
  setOverride(characterId: string, placement: NpcPlacement | null): void {
    const cid = String(characterId ?? '').trim();
    if (!cid) {
      console.warn('NpcScheduleSystem.setOverride: 空 characterId');
      return;
    }
    if (placement === null) this.overrides.delete(cid);
    else this.overrides.set(cid, placement);
    this.binding?.refreshEntityVisibility();
  }

  // ---- 演出 ----

  update(_dt: number): void {
    const b = this.binding;
    if (!b) return;
    const sceneData = b.getCurrentSceneData();
    if (sceneData?.dayNight?.enabled !== true) {
      if (this.leaving.size || this.arriving.size) this.cancelAllWalks();
      return;
    }
    // 非探索态（对话/过场/面板）：在途走位原地挂起，回到探索态自动续走。
    if (!b.isExploring()) return;

    this.detectScheduleEdges(b, sceneData);
    this.advanceWalks(b);
  }

  /** 检出「该走了 / 该来了」的边沿，起演出。 */
  private detectScheduleEdges(b: NpcScheduleRuntimeBinding, sceneData: SceneData): void {
    for (const npc of b.getCurrentNpcs()) {
      const id = npc.id;
      if (this.leaving.has(id) || this.arriving.has(id)) continue;
      const cid = String(npc.def.characterId ?? '').trim();
      if (!cid) continue;
      const minutes = b.getMinutesOfDay();
      const placement = this.resolvePlacement(cid, minutes);
      if (!placement) {
        this.lastPresent.set(id, true);
        continue;
      }
      const shouldBeHere = placement.scene === sceneData.id;
      const was = this.lastPresent.get(id);
      if (was === undefined) {
        // 首次见到这个实例：以现状为基线，不演出。
        this.lastPresent.set(id, shouldBeHere);
        continue;
      }
      if (was === shouldBeHere) continue;
      this.lastPresent.set(id, shouldBeHere);
      if (shouldBeHere) this.beginArrive(npc, sceneData, placement);
      else this.beginLeave(npc, sceneData, cid);
    }
  }

  private beginLeave(npc: Npc, sceneData: SceneData, characterId: string): void {
    const def = this.schedules.get(characterId);
    const exit = this.resolveExitPoint(npc, sceneData, def?.preferredExit);
    this.leaving.set(npc.id, {
      npcId: npc.id,
      targetX: exit.x,
      targetY: exit.y,
      moving: false,
      spoke: false,
    });
  }

  private beginArrive(npc: Npc, sceneData: SceneData, placement: NpcPlacement): void {
    const cid = String(npc.def.characterId ?? '').trim();
    const def = this.schedules.get(cid);
    const exit = this.resolveExitPoint(npc, sceneData, def?.preferredExit);
    const target = placement.spot ?? { x: npc.def.x, y: npc.def.y };
    // 从出口起步：先瞬移到出口（此刻它刚被判定为在场，玩家看到的第一眼就是"从门口进来"）。
    npc.x = exit.x;
    npc.y = exit.y;
    this.arriving.set(npc.id, {
      npcId: npc.id,
      targetX: target.x,
      targetY: target.y,
      moving: false,
      activity: placement.activity,
      spoke: true,
    });
  }

  /** 推进在途走位；到位才收尾（离场收尾＝移出宽限集，下一帧派生回写自然把它隐去）。 */
  private advanceWalks(b: NpcScheduleRuntimeBinding): void {
    const byId = new Map<string, Npc>();
    for (const npc of b.getCurrentNpcs()) byId.set(npc.id, npc);

    for (const [id, st] of [...this.leaving]) {
      const npc = byId.get(id);
      if (!npc) {
        // 实体没了（切场景/过场重建）：直接收尾，避免宽限集把幽灵一直挂在"在场"。
        this.leaving.delete(id);
        continue;
      }
      const def = this.schedules.get(String(npc.def.characterId ?? '').trim());
      if (!st.spoke) {
        st.spoke = true;
        const line = def?.exitLine?.trim();
        if (line) b.speak(npc, line);
      }
      if (this.arrivedAt(npc, st)) {
        this.leaving.delete(id);
        continue;
      }
      this.ensureWalking(npc, st);
    }

    for (const [id, st] of [...this.arriving]) {
      const npc = byId.get(id);
      if (!npc) {
        this.arriving.delete(id);
        continue;
      }
      if (this.arrivedAt(npc, st)) {
        this.arriving.delete(id);
        const act = st.activity?.trim();
        if (act) npc.playAnimation(act);
        continue;
      }
      this.ensureWalking(npc, st);
    }
  }

  private arrivedAt(npc: Npc, st: WalkState): boolean {
    const dx = npc.x - st.targetX;
    const dy = npc.y - st.targetY;
    return dx * dx + dy * dy <= ARRIVE_EPSILON * ARRIVE_EPSILON;
  }

  /**
   * 确保这一步在走。
   *
   * `moveTo` 的 Promise **被打断时也会 resolve**（对话开始会 `cancelActiveMove`），
   * 所以它落定只代表"这一段结束了"，不代表"走到了"——到没到一律用坐标判定，
   * 没到就在下一个探索态帧重发。这样对话打断后回到探索态会自动续走。
   */
  private ensureWalking(npc: Npc, st: WalkState): void {
    if (st.moving) return;
    st.moving = true;
    void npc
      .moveTo(st.targetX, st.targetY, WALK_SPEED, undefined, true)
      .catch((e) => {
        console.warn('NpcScheduleSystem: 走位失败', e);
      })
      .finally(() => {
        st.moving = false;
      });
  }

  private resolveExitPoint(
    npc: Npc,
    sceneData: SceneData,
    preferredExit: string | undefined,
  ): Position {
    const anchors = Array.isArray(sceneData.exitAnchors) ? sceneData.exitAnchors : [];
    const want = preferredExit?.trim();
    if (want) {
      const hit = anchors.find((a) => String(a?.id ?? '').trim() === want);
      if (hit) return { x: hit.x, y: hit.y };
      if (!this.warnedUnknown.has(`exit:${sceneData.id}:${want}`)) {
        this.warnedUnknown.add(`exit:${sceneData.id}:${want}`);
        console.warn(
          `NpcScheduleSystem: 场景 "${sceneData.id}" 没有出口锚点 "${want}"，回落最近出口`,
        );
      }
    }
    let best: Position | null = null;
    let bestD2 = Infinity;
    for (const a of anchors) {
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      const dx = a.x - npc.x;
      const dy = a.y - npc.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { x: a.x, y: a.y };
      }
    }
    if (best) return best;
    // 没配出口锚点：往最近的场景边界外走。宁可走出画面，也不能原地消失。
    const width = Number.isFinite(sceneData.worldWidth) ? sceneData.worldWidth : 0;
    const toLeft = npc.x;
    const toRight = Math.max(0, width - npc.x);
    return toLeft <= toRight
      ? { x: -OFFSCREEN_MARGIN, y: npc.y }
      : { x: width + OFFSCREEN_MARGIN, y: npc.y };
  }

  /** 丢弃全部在途走位。被丢弃的 NPC 由随后的派生回写按日程直接就位。 */
  private cancelAllWalks(): void {
    this.leaving.clear();
    this.arriving.clear();
  }

  /**
   * 按当前时刻把在场 NPC 直接摆到日程位置（无演出）。只在玩家看不见这一跳时调用
   * ——切场景/读档/过场重建。位置是运行时态，不写回 def：重进场景会照日程重算。
   */
  private applyScheduledPositions(): void {
    const b = this.binding;
    const sceneData = b?.getCurrentSceneData();
    if (!b || !sceneData || sceneData.dayNight?.enabled !== true) return;
    const minutes = b.getMinutesOfDay();
    for (const npc of b.getCurrentNpcs()) {
      const cid = String(npc.def.characterId ?? '').trim();
      if (!cid) continue;
      const placement = this.resolvePlacement(cid, minutes);
      if (!placement || placement.scene !== sceneData.id) continue;
      if (placement.spot) {
        npc.x = placement.spot.x;
        npc.y = placement.spot.y;
      }
      const act = placement.activity?.trim();
      if (act) npc.playAnimation(act);
    }
  }

  /** 把在场性基线重置为"当前即正确"，使随后的 diff 不会把这一跳当成边沿再演一次。 */
  private resyncPresenceBaseline(): void {
    this.lastPresent.clear();
    const b = this.binding;
    const sceneData = b?.getCurrentSceneData();
    if (!b || !sceneData) return;
    const minutes = b.getMinutesOfDay();
    for (const npc of b.getCurrentNpcs()) {
      const cid = String(npc.def.characterId ?? '').trim();
      if (!cid) continue;
      const placement = this.resolvePlacement(cid, minutes);
      this.lastPresent.set(npc.id, placement ? placement.scene === sceneData.id : true);
    }
  }

  /** 调试面板用：当前在途演出快照。 */
  getDebugState(): { leaving: string[]; arriving: string[]; overrides: string[] } {
    return {
      leaving: [...this.leaving.keys()],
      arriving: [...this.arriving.keys()],
      overrides: [...this.overrides.keys()],
    };
  }

  serialize(): object {
    // 日程是 f(时刻, 条件) 的派生结果，不入档；只有剧情覆盖是真状态。
    return { overrides: [...this.overrides].map(([cid, p]) => ({ characterId: cid, ...p })) };
  }

  deserialize(data: { overrides?: Array<{ characterId?: string } & NpcPlacement> }): void {
    this.overrides.clear();
    for (const row of Array.isArray(data?.overrides) ? data.overrides : []) {
      const cid = String(row?.characterId ?? '').trim();
      if (!cid) continue;
      this.overrides.set(cid, {
        scene: typeof row.scene === 'string' && row.scene.trim() ? row.scene.trim() : null,
        spot: row.spot,
        activity: row.activity,
      });
    }
    this.cancelAllWalks();
    this.lastPresent.clear();
  }

  destroy(): void {
    this.eventBus.off('time:changed', this.onTimeChanged);
    this.eventBus.off('scene:ready', this.onSceneReady);
    this.eventBus.off('scene:entitiesRebuilt', this.onEntitiesRebuilt);
    this.binding = null;
    this.assetManager = null;
    this.schedules.clear();
    this.overrides.clear();
    this.cancelAllWalks();
    this.lastPresent.clear();
    this.warnedUnknown.clear();
  }
}
