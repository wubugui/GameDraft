import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { AssetManager } from '../core/AssetManager';
import type { GameContext, IGameSystem, SystemNoteDef } from '../data/types';
import { FlagKeys } from '../core/FlagKeys';
import { TEXT_URLS } from '../core/projectPaths';

/** 组装层注入的开卡函数：把一条说明卡画出来、等玩家关掉再 resolve（必然封口）。 */
export type SystemNoteOpener = (def: SystemNoteDef) => Promise<void>;

interface SystemNotesJson {
  notes?: SystemNoteDef[];
}

/**
 * 系统说明卡（玩法需求清单 K4「系统说明卡」；首个用例 = 三把火）。
 *
 * 「当下只交代清楚，解释全放档案里」：动作 `showSystemNote{noteId}` 发起，本类只管
 * 注册表、每档一次的判定与「关卡即落 flag」；卡怎么画归 ui（SystemNoteUI），
 * 见闻录条目怎么解锁归 ArchiveManager——它的 `unlockConditions` 引用同一个 flag，
 * flag 一落，"见闻录更新"那条提示自己会冒（本类不直接碰档案，分层律 11）。
 *
 * 真相源纪律（runtime-norms 不变量 8）：「弹过没有」= 全局 flag `sysnote_<id>`，
 * 本类**不自持久化**（serialize 空桶），存档/读档由 FlagStore 一家搞定。
 * 旧时间线不写新状态（不变量 4）：卡开着的时候读了档 / 销毁了，关卡那一下不再落 flag。
 */
export class SystemNoteManager implements IGameSystem {
  private readonly eventBus: EventBus;
  private readonly flagStore: FlagStore;
  private assetManager!: AssetManager;
  private defs: Map<string, SystemNoteDef> = new Map();
  private opener: SystemNoteOpener | null = null;
  /** 同屏只许一张卡在场 */
  private showing = false;
  /** 时间线代号：deserialize / destroy 自增，在途的那张卡关掉时发现代号变了就不写 flag */
  private generation = 0;
  private destroyed = false;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
  }

  /** 组装层注入开卡函数（UI 归 ui 层，本类不 import 它）。 */
  setOpener(fn: SystemNoteOpener | null): void {
    this.opener = fn;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.destroyed = false;
  }

  update(_dt: number): void {}

  /** 装载 `system_notes.json`。缺文件 / 坏文件只 warn：说明卡是附属机制，不阻断启动。 */
  async loadDefs(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<SystemNotesJson | SystemNoteDef[]>(`${TEXT_URLS.dataDir}/system_notes.json`);
      const rows = Array.isArray(data) ? data : (data?.notes ?? []);
      this.defs.clear();
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const id = String(row.id ?? '').trim();
        if (!id) continue;
        if (this.defs.has(id)) console.warn(`SystemNoteManager: 说明卡 id 重复 ${id}（后者覆盖前者）`);
        this.defs.set(id, { ...row, id });
      }
    } catch (e) {
      console.warn('SystemNoteManager: system_notes.json 装载失败，说明卡不可用', e);
    }
  }

  getDef(id: string): SystemNoteDef | undefined {
    return this.defs.get(id);
  }

  /** 这条卡在本档里弹过没有（真相 = flag）。 */
  hasShown(id: string): boolean {
    return this.flagStore.get(FlagKeys.systemNoteShown(id)) === true;
  }

  /**
   * 弹一张说明卡；玩家关掉后落 flag `sysnote_<id>` 并 resolve。
   * 每档只自动弹一次，`force` 可重弹。未知 id / 未注入开卡函数 / 已在场：warn 并立即 resolve
   * （动作批不悬挂，律 3）。
   */
  async show(id: string, force: boolean = false): Promise<void> {
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`showSystemNote: 未知说明卡 id ${JSON.stringify(id)}（system_notes.json）`);
      return;
    }
    if (!force && this.hasShown(id)) return;
    if (this.showing) {
      console.warn(`showSystemNote: 已有说明卡在场，忽略 ${id}`);
      return;
    }
    if (!this.opener) {
      console.warn('showSystemNote: 未注入开卡函数（组装层未接线），跳过');
      return;
    }
    const gen = ++this.generation;
    this.showing = true;
    try {
      await this.opener(def);
    } catch (e) {
      console.warn('SystemNoteManager: 开卡失败', e);
    } finally {
      this.showing = false;
    }
    // 卡开着的时候读了档 / 销毁了：这是旧时间线，不往新时间线写 flag
    if (this.destroyed || gen !== this.generation) return;
    this.flagStore.set(FlagKeys.systemNoteShown(id), true);
    this.eventBus.emit('systemNote:shown', { id });
  }

  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {
    this.generation++;
  }

  destroy(): void {
    this.destroyed = true;
    this.generation++;
    this.defs.clear();
    this.opener = null;
  }
}
