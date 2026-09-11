import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { IGameSystem, GameContext, ZoneSmellConfig } from '../data/types';
import { FlagKeys } from '../core/FlagKeys';

/** 气味来源：action（编排显式 setSmell，优先级高）/ zone（场景触发器，玩家在区内）/ none（无味）。 */
export type SmellSource = 'action' | 'zone' | 'none';

/** 气味源（世界坐标）：气缕被"吹"离它，飘向的反方向就是它。 */
export interface SmellSourcePoint { x: number; y: number }

/** 一层气味状态（scent 空串=该层无味）。source = 这一层自带的气味源（zone 配的 / setSmellSource 配的）。 */
interface SmellLayer { scent: string; intensity: number; flicker: boolean; source: SmellSourcePoint | null }

function emptyLayer(): SmellLayer {
  return { scent: '', intensity: 0, flicker: false, source: null };
}

function normalizePoint(p: unknown): SmellSourcePoint | null {
  const o = p as { x?: unknown; y?: unknown } | null | undefined;
  const x = Number(o?.x);
  const y = Number(o?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** 把任意来源（action 参数 / ZoneSmellConfig）规整成一层；scent 空=无味层。 */
function normalizeLayer(scent: string, intensity?: number, flicker?: boolean, source?: unknown): SmellLayer {
  const s = String(scent ?? '');
  if (!s) return emptyLayer();
  const n = Number(intensity);
  return {
    scent: s,
    intensity: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 60,
    flicker: !!flicker,
    source: normalizePoint(source),
  };
}

/** 手动（F2 调试）驱动 zone 层时用的伪 zoneId，与真实 zone 共用同一张活跃表。 */
const MANUAL_ZONE_KEY = '__manual__';
/** 玩家离气味源这么远（世界像素）时气缕歪到底（dir=±1）；再远不会更歪。横向 / 纵深各一档（纵深轴屏幕上压扁，饱和距离取短一点）。 */
const DIR_SATURATE_PX = 320;
const DEPTH_SATURATE_PX = 220;
/** 飘向变化小于这个量不重发事件（每帧算、只在肉眼可见的变化时广播）。 */
const DIR_EMIT_EPSILON = 0.01;

/**
 * 气味系统（见《系统设计/气味系统设计文档》方案 E）。和三把火 / 离死之距（HealthSystem）同构：
 * 系统 own 当前主导气味的**持续状态**，经 EventBus（`player:smellChanged`）广播给 HUD 的气味指示器渲染。
 *
 * **双层 + 优先级**：内部维护两层气味——
 *   - action 层：编排显式 `setSmell` / `clearSmell` 驱动；
 *   - zone 层：玩家进入带 `smell` 配置的场景触发器时自动呈现、离开自动撤回
 *     （监听 `zone:enter` / `zone:exit`，按 ZoneDef.smell 驱动；多区重叠取**最后进入**者）。
 * 生效气味 = action 层非空则取 action，否则取 zone，否则无味（**action 永远压过 zone**）。
 * 这样：剧情用 action 强行覆盖环境气味，结束 clearSmell 后若玩家仍在 zone 内，zone 气味自动浮回。
 *
 * **飘向 = 来源的反方向**（玩法清单 G.6，2026-09-10）：气缕像被从气味源那边吹过来，
 * 飘向哪边、源就在另一边。飘向 `dir` 不再是作者手填的静态值，而是每帧按**玩家位置相对气味源**现算：
 *   - 气味源来自 `setSmellSource{x,y[,scene]}`（action 源，入存档、只在那个场景生效）
 *     或 zone 配的 `smell.source`（进区带上、出区撤回）；action 源压过 zone 源；
 *   - 追踪可随时开关（`setSmellTracking{enabled}`，flag `smell_tracking`，缺省开）；
 *   - 关着、或没放气味源、或源不在当前场景 → 气缕一直是直的（dir=0）。
 *
 * §1 合规：状态进 FlagStore，只经 EventBus 通信（含监听 zone 进出），不持有其它系统引用；
 * 玩家位置/当前场景经组装层注入的 getter 取（同 ZoneSystem / CutsceneManager 的做法）。
 */
export class SmellSystem implements IGameSystem {
  private readonly eventBus: EventBus;
  private readonly flagStore: FlagStore;

  /** action 层（编排 setSmell；优先级高）。 */
  private action: SmellLayer = emptyLayer();
  /** 当前生效的 zone 层（由 activeZoneSmells 解出的"最后进入"者）。 */
  private zone: SmellLayer = emptyLayer();
  /** 活跃 zone 气味：zoneId → 层（含 MANUAL_ZONE_KEY 调试项）。Map 保留插入序 → 末项=最后进入。 */
  private activeZoneSmells: Map<string, SmellLayer> = new Map();
  /** action 气味源（setSmellSource）：带场景，只在那个场景里生效；入存档。 */
  private actionSource: { scene: string; x: number; y: number } | null = null;
  /** 追踪开关：关 = 气缕永远直的。 */
  private tracking = true;
  /** 上一次广播出去的飘向（每帧算、变了才发）：横向 / 纵深。 */
  private lastDir = 0;
  private lastDepth = 0;

  private playerPosGetter: (() => { x: number; y: number }) | null = null;
  private sceneIdGetter: (() => string | null | undefined) | null = null;

  private readonly onZoneEnter: (p: unknown) => void;
  private readonly onZoneExit: (p: unknown) => void;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    // 回调在构造期绑定一次；订阅在 init 挂、destroy 摘（律8：destroy→init 后行为与首次一致）。
    this.onZoneEnter = (p) => {
      const zone = (p as { zone?: { id?: string; smell?: ZoneSmellConfig } } | undefined)?.zone;
      if (!zone?.id || !zone.smell?.scent) return;
      const c = zone.smell;
      this.activeZoneSmells.set(zone.id, normalizeLayer(c.scent, c.intensity, c.flicker, c.source));
      this.refreshZoneLayer();
    };
    this.onZoneExit = (p) => {
      const pp = p as { zoneId?: string; zone?: { id?: string } } | undefined;
      const id = pp?.zoneId ?? pp?.zone?.id;
      if (id && this.activeZoneSmells.delete(id)) this.refreshZoneLayer();
    };
  }

  /** 组装层注入：玩家世界坐标（算飘向用）。 */
  setPlayerPositionGetter(fn: (() => { x: number; y: number }) | null): void {
    this.playerPosGetter = fn;
  }

  /** 组装层注入：当前场景 id（action 气味源只在它所属场景生效）。 */
  setSceneIdGetter(fn: (() => string | null | undefined) | null): void {
    this.sceneIdGetter = fn;
  }

  init(_ctx: GameContext): void {
    // off 先行保证 init 重复调用不叠订阅（EventBus.off 对未订阅回调是幂等 no-op）
    this.eventBus.off('zone:enter', this.onZoneEnter);
    this.eventBus.off('zone:exit', this.onZoneExit);
    this.eventBus.on('zone:enter', this.onZoneEnter);
    this.eventBus.on('zone:exit', this.onZoneExit);
    this.action = emptyLayer();
    this.zone = emptyLayer();
    this.activeZoneSmells.clear();
    this.actionSource = null;
    this.tracking = true;
    this.lastDir = 0;
    this.lastDepth = 0;
    this.syncFlags();
    this.emitChanged();
  }

  /** 每帧按玩家位置重算飘向；肉眼可见地变了才广播（HUD 自己有缓动，不怕跳）。 */
  update(_dt: number): void {
    const { x: dir, depth } = this.computeDir();
    if (Math.abs(dir - this.lastDir) >= DIR_EMIT_EPSILON || Math.abs(depth - this.lastDepth) >= DIR_EMIT_EPSILON) {
      this.lastDir = dir;
      this.lastDepth = depth;
      this.flagStore.set('current_smell_dir', dir);
      this.flagStore.set('current_smell_dir_depth', depth);
      this.emitChanged();
    }
  }

  /** 生效层：action 非空则 action，否则 zone，否则无味。 */
  private resolve(): { layer: SmellLayer; source: SmellSource } {
    if (this.action.scent) return { layer: this.action, source: 'action' };
    if (this.zone.scent) return { layer: this.zone, source: 'zone' };
    return { layer: emptyLayer(), source: 'none' };
  }

  /**
   * 生效的气味源：action 源（且在当前场景）压过 zone 源；没有则 null。
   * zone 源跟着生效层走——action 层压着 zone 层时 zone 源也不算（味都不是它的，方向更不能是它的）。
   */
  private effectiveSource(): SmellSourcePoint | null {
    if (this.actionSource) {
      const scene = this.sceneIdGetter?.() ?? '';
      if (scene && scene === this.actionSource.scene) return { x: this.actionSource.x, y: this.actionSource.y };
    }
    const { layer } = this.resolve();
    return layer.scent ? layer.source : null;
  }

  /**
   * 飘向：追踪开 + 有源 + 有味 → 玩家相对源的位置折到 -1..1；否则 0（直的）。
   *   x：源在左 → 往右飘（正）；
   *   depth：源在前面（屏幕下方、更靠镜头，src.y > p.y）→ 被吹向深处（负）；源在后面 → 朝镜头扑来（正）。
   */
  private computeDir(): { x: number; depth: number } {
    const none = { x: 0, depth: 0 };
    if (!this.tracking) return none;
    if (!this.resolve().layer.scent) return none;
    const src = this.effectiveSource();
    if (!src) return none;
    const p = this.playerPosGetter?.();
    if (!p) return none;
    const x = Math.max(-1, Math.min(1, (p.x - src.x) / DIR_SATURATE_PX));
    const depth = Math.max(-1, Math.min(1, (p.y - src.y) / DEPTH_SATURATE_PX));
    return { x, depth };
  }

  /** 重算 zone 层 = activeZoneSmells 末项（最后进入者）；变了则同步+广播。 */
  private refreshZoneLayer(): void {
    let dominant = emptyLayer();
    for (const layer of this.activeZoneSmells.values()) dominant = layer; // 末次赋值=最后插入
    this.zone = { ...dominant };
    this.syncFlags();
    this.emitChanged();
  }

  /**
   * 设 **action 层**气味（编排显式；压过 zone）。空 scent = 清 action 层（zone 气味会自动浮回）。
   * 逼近 = 编排侧用递增 intensity 多次调用即可。
   * ⚠ 旧参数 `dir`（静态方位）已废：飘向只按气味源现算（见类注释），传了也不生效。
   */
  setSmell(scent: string, intensity?: number, _dir?: number, flicker?: boolean): void {
    this.action = normalizeLayer(scent, intensity, flicker, null);
    this.syncFlags();
    this.emitChanged();
  }

  /** 清 **action 层**：若玩家仍在某 zone 内，该 zone 气味会自动浮回；否则回落正常态。 */
  clearSmell(): void {
    this.action = emptyLayer();
    this.syncFlags();
    this.emitChanged();
  }

  /** 放 action 气味源（世界坐标 + 所属场景；缺省当前场景）。只在那个场景里指向；入存档。 */
  setSource(x: number, y: number, scene?: string): void {
    const sx = Number(x);
    const sy = Number(y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
      console.warn('SmellSystem.setSource: 坐标不是数字，忽略', x, y);
      return;
    }
    const sc = String(scene ?? '').trim() || (this.sceneIdGetter?.() ?? '');
    if (!sc) {
      console.warn('SmellSystem.setSource: 取不到场景 id（未注入 getter 且未显式传 scene），忽略');
      return;
    }
    this.actionSource = { scene: sc, x: sx, y: sy };
    this.syncFlags();
    this.emitChanged();
  }

  /** 撤 action 气味源（zone 源不受影响）。 */
  clearSource(): void {
    this.actionSource = null;
    this.syncFlags();
    this.emitChanged();
  }

  /** 追踪开关：关了气缕一律直的；开了也得有源才歪。 */
  setTracking(enabled: boolean): void {
    this.tracking = enabled !== false;
    this.syncFlags();
    this.emitChanged();
  }

  isTracking(): boolean {
    return this.tracking;
  }

  /** action 气味源（setSmellSource 放的；null=没放）。 */
  getActionSource(): { scene: string; x: number; y: number } | null {
    return this.actionSource ? { ...this.actionSource } : null;
  }

  /** 手动设 **zone 层**气味（F2 调试用；真实 zone 由 zone:enter/exit 自动驱动）。空 scent=清手动项。 */
  setZoneSmell(scent: string, intensity?: number, _dir?: number, flicker?: boolean): void {
    const layer = normalizeLayer(scent, intensity, flicker, null);
    if (layer.scent) this.activeZoneSmells.set(MANUAL_ZONE_KEY, layer);
    else this.activeZoneSmells.delete(MANUAL_ZONE_KEY);
    this.refreshZoneLayer();
  }

  /** 清手动 zone 层调试项（不影响玩家实际所在 zone 的气味）。 */
  clearZoneSmell(): void {
    if (this.activeZoneSmells.delete(MANUAL_ZONE_KEY)) this.refreshZoneLayer();
  }

  /** 主动嗅一下：当前生效气缕短暂拔高变清（视觉脉冲，几秒自落）。无生效气味则无效。 */
  sniff(): void {
    const { layer } = this.resolve();
    if (!layer.scent) return;
    this.eventBus.emit('player:smellSniff', { scent: layer.scent });
  }

  /** 当前**生效**气味 id（空串=无味）。 */
  getScent(): string {
    return this.resolve().layer.scent;
  }

  getIntensity(): number {
    return this.resolve().layer.intensity;
  }

  /** 当前生效来源（F2 系统页用：标记现在是 action 还是 zone 在生效）。 */
  getSource(): SmellSource {
    return this.resolve().source;
  }

  /** 当前横向飘向（-1..1；0=直的）。 */
  getDir(): number {
    return this.lastDir;
  }

  /** 当前纵深飘向（-1..1；负=吹向深处/源在前，正=朝镜头/源在后；0=直的）。 */
  getDirDepth(): number {
    return this.lastDepth;
  }

  /** F2 调试快照：两层各自状态 + 生效结果 + 源/追踪（系统页展示用）。 */
  getDebugState(): {
    source: SmellSource;
    effective: SmellLayer & { dir: number; dirDepth: number };
    action: SmellLayer;
    zone: SmellLayer;
    tracking: boolean;
    actionSource: { scene: string; x: number; y: number } | null;
    effectiveSource: SmellSourcePoint | null;
  } {
    const { layer, source } = this.resolve();
    return {
      source,
      effective: { ...layer, dir: this.lastDir, dirDepth: this.lastDepth },
      action: { ...this.action },
      zone: { ...this.zone },
      tracking: this.tracking,
      actionSource: this.actionSource ? { ...this.actionSource } : null,
      effectiveSource: this.effectiveSource(),
    };
  }

  private syncFlags(): void {
    const { layer, source } = this.resolve();
    const d = this.computeDir();
    this.lastDir = d.x;
    this.lastDepth = d.depth;
    this.flagStore.set('current_smell', layer.scent);
    this.flagStore.set('smell_intensity', layer.intensity);
    this.flagStore.set('current_smell_dir', this.lastDir);
    this.flagStore.set('current_smell_dir_depth', this.lastDepth);
    this.flagStore.set('current_smell_flicker', layer.flicker);
    this.flagStore.set('current_smell_source', source);
    this.flagStore.set(FlagKeys.smellTracking, this.tracking);
  }

  private emitChanged(): void {
    const { layer, source } = this.resolve();
    this.eventBus.emit('player:smellChanged', {
      scent: layer.scent,
      intensity: layer.intensity,
      dir: this.lastDir,
      dirDepth: this.lastDepth,
      flicker: layer.flicker,
      source,
      tracking: this.tracking,
      hasSource: this.effectiveSource() !== null,
    });
  }

  serialize(): object {
    // 只存 action 层 + action 源 + 追踪开关；zone 层是玩家位置的瞬时函数，读档进场后由 zone:enter 自然重建。
    return {
      action: { scent: this.action.scent, intensity: this.action.intensity, flicker: this.action.flicker },
      source: this.actionSource ? { ...this.actionSource } : null,
      tracking: this.tracking,
    };
  }

  deserialize(data: object): void {
    const d = data as {
      action?: { scent?: unknown; intensity?: unknown; flicker?: unknown };
      source?: { scene?: unknown; x?: unknown; y?: unknown } | null;
      tracking?: unknown;
      // 旧档兼容：扁平单层 → 归入 action 层
      scent?: string; intensity?: number; flicker?: boolean;
    };
    const src = d.action ?? (typeof d.scent === 'string' ? d : undefined);
    if (src) {
      this.action = {
        scent: typeof src.scent === 'string' ? src.scent : '',
        intensity: typeof src.intensity === 'number' ? src.intensity : 0,
        flicker: typeof src.flicker === 'boolean' ? src.flicker : false,
        source: null,
      };
    }
    const sp = d.source;
    if (sp && typeof sp.scene === 'string' && sp.scene && Number.isFinite(Number(sp.x)) && Number.isFinite(Number(sp.y))) {
      this.actionSource = { scene: sp.scene, x: Number(sp.x), y: Number(sp.y) };
    } else {
      this.actionSource = null;
    }
    this.tracking = d.tracking !== false;
    this.syncFlags();
    this.emitChanged();
  }

  destroy(): void {
    this.eventBus.off('zone:enter', this.onZoneEnter);
    this.eventBus.off('zone:exit', this.onZoneExit);
    this.activeZoneSmells.clear();
    this.playerPosGetter = null;
    this.sceneIdGetter = null;
  }
}
