import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { AssetManager } from '../core/AssetManager';
import type { ActionDef, GameContext, IGameSystem } from '../data/types';
import { TEXT_URLS } from '../core/projectPaths';

/**
 * 线索系统（玩法需求清单 K7）：玩家读文本时点击 `[clue:id]` 圈住的词条即"记下来"。
 *
 * **采集 = 内容事件，不是"往册子里加一行字"**（2026-08-17 制作人拍板）：
 * 每条线索可配 `collectActions` 动作批，首次采集即经统一动作执行器执行——
 * 解锁文书、推 flag、起对话、给任务，任何机制通道效果都行；
 * 落 flag / 回执 toast / 入线索簿只是**系统默认呈现**，`hidden` 线索连册子都不进
 * （纯机制线索：采了只走动作，不留字面）。
 *
 * 真相源纪律（runtime-norms 不变量 8）：采集状态 = 全局 flag `clue_<id>`，
 * **本类不自持久化**——serialize/deserialize 是空的，存档/读档由 FlagStore 一家搞定，
 * 条件面（对话分支/档案解锁/任务触发）经现有 ConditionExpr flag 叶即刻消费。
 * 动作批执行沿 `archive:firstView` 同一范式：本类只发事件带动作副本，
 * 组装层消费并走 `executeBatchAwait`（系统层不持执行器，分层不破）。
 *
 * K7 红线：线索不给能力、不做数值；未采集的线索在 UI 上不占位不给总数（存在即剧透）。
 */
export interface ClueDef {
  id: string;
  title: string;
  desc: string;
  /** 分组键（线索簿按它分组）；缺省归入 'misc' */
  category?: string;
  /** 首次采集时执行的动作批（统一动作执行器；幂等由 collect 的 flag 检查保证只发一次） */
  collectActions?: ActionDef[];
  /** true = 不进线索簿（纯机制线索：采集只为触发动作/flag，不留字面） */
  hidden?: boolean;
}

interface CluesJson {
  clues?: ClueDef[];
  /** category 键 → 展示名 */
  categories?: Record<string, string>;
}

/** 线索簿 UI 的只读数据口（UI→系统 单向依赖，组装层注入） */
export interface IClueDataProvider {
  isCollected(id: string): boolean;
  /** 已采集的线索，按注册表顺序 */
  getCollectedClues(): ClueDef[];
  getCategoryName(key: string): string;
  collectedCount(): number;
}

const FLAG_PREFIX = 'clue_';

export class ClueManager implements IGameSystem, IClueDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private assetManager!: AssetManager;
  private defs = new Map<string, ClueDef>();
  private categoryNames: Record<string, string> = {};
  /** 采集回执文案（组装层从 strings 注入；系统层不 import StringsProvider） */
  private collectTextProvider: ((def: ClueDef) => string) | null = null;
  /** dev 下未知 id 只警告一次 */
  private warnedUnknown = new Set<string>();

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
  }

  update(_dt: number): void {}

  /** 状态全在 FlagStore（统一真相源），这里没有自己的存档桶。 */
  serialize(): object { return {}; }
  deserialize(_data: object): void {}

  destroy(): void {
    this.defs.clear();
    this.warnedUnknown.clear();
  }

  setCollectTextProvider(fn: ((def: ClueDef) => string) | null): void {
    this.collectTextProvider = fn;
  }

  async loadDefs(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<CluesJson | ClueDef[]>(`${TEXT_URLS.dataDir}/clues.json`);
      const list = Array.isArray(data) ? data : data.clues ?? [];
      for (const def of list) {
        if (!def?.id) continue;
        this.defs.set(def.id, def);
      }
      if (!Array.isArray(data) && data.categories) this.categoryNames = data.categories;
    } catch { /* 注册表还没建立时静默——[clue:] 标记会因 isKnown=false 按普通文字渲染 */ }
  }

  isKnownClue(id: string): boolean {
    return this.defs.has(id);
  }

  isCollected(id: string): boolean {
    return this.flagStore.get(`${FLAG_PREFIX}${id}`) === true;
  }

  /**
   * 采集（幂等）。未知 id 不落 flag（dev 警告一次）；重复采集静默返回 false（无二次回执、
   * 动作批也不复发）。成功：落 flag + `clue:collected` 事件 + notification 回执（clue 类型）
   * + `collectActions` 动作批事件（组装层经统一执行器跑，与 archive:firstView 同一范式）。
   */
  collect(id: string): boolean {
    const def = this.defs.get(id);
    if (!def) {
      if (!this.warnedUnknown.has(id)) {
        this.warnedUnknown.add(id);
        console.warn(`ClueManager: 未知线索 id "${id}"（[clue:${id}] 引用了 clues.json 没有的条目）`);
      }
      return false;
    }
    if (this.isCollected(id)) return false;
    this.flagStore.set(`${FLAG_PREFIX}${id}`, true);
    // `hidden` 随事件带出：纯机制线索连线索簿都不进，事件日志同样不该留字面
    // （消费方自己查 defs 的话就得反向依赖本系统，那是分层红线）。
    this.eventBus.emit('clue:collected', { id, title: def.title, hidden: def.hidden === true });
    if (!def.hidden) {
      this.eventBus.emit('notification:show', {
        text: this.collectTextProvider?.(def) ?? `已录线索：${def.title}`,
        type: 'clue',
      });
    }
    if (def.collectActions && def.collectActions.length > 0) {
      // 深拷贝副本：执行器/处理器可能改写 params，不许污染注册表定义
      this.eventBus.emit('clue:collectActions', {
        id,
        actions: def.collectActions.map(a => ({ ...a, params: { ...a.params } })),
      });
    }
    return true;
  }

  /** 线索簿数据口：hidden 线索不入册（纯机制线索），计数/未读判定同口径 */
  getCollectedClues(): ClueDef[] {
    const out: ClueDef[] = [];
    for (const def of this.defs.values()) {
      if (!def.hidden && this.isCollected(def.id)) out.push(def);
    }
    return out;
  }

  getCategoryName(key: string): string {
    return this.categoryNames[key] ?? key;
  }

  collectedCount(): number {
    return this.getCollectedClues().length;
  }
}
