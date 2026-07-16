import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { IGameSystem, GameContext, ZoneSmellConfig } from '../data/types';

/** 气味来源：action（编排显式 setSmell，优先级高）/ zone（场景触发器，玩家在区内）/ none（无味）。 */
export type SmellSource = 'action' | 'zone' | 'none';

/** 一层气味状态（scent 空串=该层无味）。 */
interface SmellLayer { scent: string; intensity: number; dir: number; flicker: boolean }

function emptyLayer(): SmellLayer {
  return { scent: '', intensity: 0, dir: 0, flicker: false };
}

/** 把任意来源（action 参数 / ZoneSmellConfig）规整成一层；scent 空=无味层。 */
function normalizeLayer(scent: string, intensity?: number, dir?: number, flicker?: boolean): SmellLayer {
  const s = String(scent ?? '');
  if (!s) return emptyLayer();
  const n = Number(intensity);
  const d = Number(dir);
  return {
    scent: s,
    intensity: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 60,
    dir: dir !== undefined && Number.isFinite(d) ? Math.max(-1, Math.min(1, d)) : 0,
    flicker: !!flicker,
  };
}

/** 手动（F2 调试）驱动 zone 层时用的伪 zoneId，与真实 zone 共用同一张活跃表。 */
const MANUAL_ZONE_KEY = '__manual__';

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
 * §1 合规：状态进 FlagStore，只经 EventBus 通信（含监听 zone 进出），不持有其它系统引用。
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
      this.activeZoneSmells.set(zone.id, normalizeLayer(c.scent, c.intensity, c.dir, c.flicker));
      this.refreshZoneLayer();
    };
    this.onZoneExit = (p) => {
      const pp = p as { zoneId?: string; zone?: { id?: string } } | undefined;
      const id = pp?.zoneId ?? pp?.zone?.id;
      if (id && this.activeZoneSmells.delete(id)) this.refreshZoneLayer();
    };
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
    this.syncFlags();
    this.emitChanged();
  }

  update(_dt: number): void {}

  /** 生效层：action 非空则 action，否则 zone，否则无味。 */
  private resolve(): { layer: SmellLayer; source: SmellSource } {
    if (this.action.scent) return { layer: this.action, source: 'action' };
    if (this.zone.scent) return { layer: this.zone, source: 'zone' };
    return { layer: emptyLayer(), source: 'none' };
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
   */
  setSmell(scent: string, intensity?: number, dir?: number, flicker?: boolean): void {
    this.action = normalizeLayer(scent, intensity, dir, flicker);
    this.syncFlags();
    this.emitChanged();
  }

  /** 清 **action 层**：若玩家仍在某 zone 内，该 zone 气味会自动浮回；否则回落正常态。 */
  clearSmell(): void {
    this.action = emptyLayer();
    this.syncFlags();
    this.emitChanged();
  }

  /** 手动设 **zone 层**气味（F2 调试用；真实 zone 由 zone:enter/exit 自动驱动）。空 scent=清手动项。 */
  setZoneSmell(scent: string, intensity?: number, dir?: number, flicker?: boolean): void {
    const layer = normalizeLayer(scent, intensity, dir, flicker);
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

  /** F2 调试快照：两层各自状态 + 生效结果（系统页展示用）。 */
  getDebugState(): {
    source: SmellSource;
    effective: SmellLayer;
    action: SmellLayer;
    zone: SmellLayer;
  } {
    const { layer, source } = this.resolve();
    return {
      source,
      effective: { ...layer },
      action: { ...this.action },
      zone: { ...this.zone },
    };
  }

  private syncFlags(): void {
    const { layer, source } = this.resolve();
    this.flagStore.set('current_smell', layer.scent);
    this.flagStore.set('smell_intensity', layer.intensity);
    this.flagStore.set('current_smell_dir', layer.dir);
    this.flagStore.set('current_smell_flicker', layer.flicker);
    this.flagStore.set('current_smell_source', source);
  }

  private emitChanged(): void {
    const { layer, source } = this.resolve();
    this.eventBus.emit('player:smellChanged', {
      scent: layer.scent,
      intensity: layer.intensity,
      dir: layer.dir,
      flicker: layer.flicker,
      source,
    });
  }

  serialize(): object {
    // 只存 action 层；zone 层是玩家位置的瞬时函数，读档进场后由 zone:enter 自然重建。
    return { action: { ...this.action } };
  }

  deserialize(data: object): void {
    const d = data as {
      action?: Partial<SmellLayer>;
      // 旧档兼容：扁平单层 → 归入 action 层
      scent?: string; intensity?: number; dir?: number; flicker?: boolean;
    };
    const src = d.action ?? (typeof d.scent === 'string' ? d : undefined);
    if (src) {
      this.action = {
        scent: typeof src.scent === 'string' ? src.scent : '',
        intensity: typeof src.intensity === 'number' ? src.intensity : 0,
        dir: typeof src.dir === 'number' ? src.dir : 0,
        flicker: typeof src.flicker === 'boolean' ? src.flicker : false,
      };
    }
    this.syncFlags();
    this.emitChanged();
  }

  destroy(): void {
    this.eventBus.off('zone:enter', this.onZoneEnter);
    this.eventBus.off('zone:exit', this.onZoneExit);
    this.activeZoneSmells.clear();
  }
}
