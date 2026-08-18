import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type {
  DialogueLine, DialogueLogEntry, DialogueStartPayload, GameContext,
  GameLogChannel, GameLogEntry, GameLogLink, IGameLogDataProvider, IGameSystem,
} from '../data/types';

/**
 * 事件日志（玩法文档 K3）——**这一局游戏的时间线**。
 *
 * 分工是硬边界：提示条（toast / 入袋回执 / 任务横幅）负责**当下的一瞥，可以丢**；
 * 本系统负责**事后的复查，不可丢**。玩家错过任何一条提示都能在这里找回来，
 * 并且能点着跳到那件东西上（条目自带 {@link GameLogLink}）。
 *
 * 真相在这里、不在面板：`DialogueLogUI` 只是本系统的一个只读视图
 * （与 HUD / GuidanceLayer 同一范式——事件只说"变了"，显示层回头查 provider）。
 * 升级前日志是 UI 自持状态 + 手工挂存档桶，往里加物品/任务/线索就得让 UI 反向依赖一堆
 * 系统，那是分层红线（runtime-norms 不变量 11）。
 *
 * ## 收录是白名单，不是事件总线的镜子
 *
 * 只记**玩家可见的既成事实**。flag 变更、位面切换、场景装载一概不记——
 * 镜像总线会让日志自己变成第二次轰炸，那正是要解决的问题。加通道 = 改
 * {@link GameLogManager.bindListeners} 一处。
 *
 * ## 三条静默闸门（都是"记多了比记少了更糟"的地方）
 *
 * 1. **读档恢复期**（`setRestoring(true)`）：各系统 deserialize 会补发
 *    `quest:accepted{restored}` / 档案重评等一大堆事件，不挡住的话读一次档
 *    日志里就多出一屏假记录（K3 红线一）。另对 `restored === true` 再兜一道。
 * 2. **hidden 线索**：纯机制线索连线索簿都不进，日志同样不留字面
 *    （见 ClueManager 的 K7 语义）。
 * 3. **对话嵌套**：图对话里 `playScriptedDialogue` 会再发一次 `dialogue:start`，
 *    抬头必须不重复——判据见 {@link GameLogManager.shouldWriteHeader}。
 */

/**
 * 分桶配额：对话与事件**各自** FIFO。
 *
 * 单一上限（升级前是 200 条不分种类）会让对话洪水把事件条冲掉——而事件条恰恰是
 * 玩家事后最要查的那部分（"我刚才到底得了些什么"）。事件条稀疏，100 条能覆盖很长一段。
 * 显示对象仍走虚拟化（见面板），常驻行数与总条数无关，抬配额不涨 draw call。
 */
const MAX_DIALOGUE = 200;
const MAX_EVENT = 100;
/** 单条最长字符数：超出截断加省略号（日志是"翻一眼刚才发生了啥"，不是全文存档） */
const MAX_ENTRY_CHARS = 600;

/** 存档桶形状（本系统自持，经 registeredSystems 走统一序列化通道） */
interface GameLogSaveData {
  entries?: GameLogEntry[];
  nextSeq?: number;
  lastSeenSeq?: number;
}

function clampText(text: string): string {
  return text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}…`;
}

export class GameLogManager implements IGameSystem, IGameLogDataProvider {
  private eventBus: EventBus;
  private strings: StringsProvider | null = null;
  private entries: GameLogEntry[] = [];
  private nextSeq = 1;
  /** 未读游标：`seq > lastSeenSeq` 且非对话通道的条目算未读 */
  private lastSeenSeq = 0;
  /** 未读数缓存（HUD 逐帧问）；任何写入/游标变更置脏 */
  private unreadCached = 0;
  private unreadDirty = true;
  private restoring = false;
  /** 通道计数（配额裁剪用；与 entries 同步维护，避免每次 push 全表扫） */
  private dialogueCount = 0;
  private eventCount = 0;
  /** 游戏内时刻来源（组装层注入 DayManager；不注入 = 条目不带时刻，面板不分组） */
  private stampProvider: (() => { day: number; phase: string }) | null = null;
  private bound: { event: string; fn: (...args: any[]) => void }[] = [];
  /** 上一条抬头写的是谁（同一人连着说不重复写抬头） */
  private lastHeaderName: string | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.bindListeners();
  }

  update(_dt: number): void {}

  /** 游戏内时刻来源（组装层注入；日志按「第几日·哪个时段」分组要用它） */
  setStampProvider(fn: (() => { day: number; phase: string }) | null): void {
    this.stampProvider = fn;
  }

  /**
   * 读档恢复期闸门。开着的时候**一条都不记**——各系统 deserialize 补发的事件
   * 是"把旧局重放一遍"，不是"现在发生了什么"（K3 红线一）。
   */
  setRestoring(on: boolean): void {
    this.restoring = on;
    // 恢复完成后抬头判据要重新起算：读回来的最后一条可能是对话行，
    // 但玩家接下来开的是全新一段对话，不该被判成"同一段的延续"。
    if (!on) this.lastHeaderName = null;
  }

  // ---- 只读数据口（IGameLogDataProvider）-------------------------------------

  getEntries(): readonly GameLogEntry[] {
    return this.entries;
  }

  /**
   * 未读**事件**条数。对话行不计——每句台词都算未读的话，HUD 那个点永远亮着，
   * 等于没有这个功能。
   *
   * HUD 每帧都会问，所以结果**缓存到下次写入**：不缓存的话就是每帧扫一遍全表
   * （白烧，且随配额线性增长）。
   */
  unreadCount(): number {
    if (!this.unreadDirty) return this.unreadCached;
    let n = 0;
    for (const e of this.entries) {
      if (e.seq > this.lastSeenSeq && e.channel !== 'dialogue') n++;
    }
    this.unreadCached = n;
    this.unreadDirty = false;
    return n;
  }

  markAllSeen(): void {
    this.lastSeenSeq = this.nextSeq - 1;
    this.unreadDirty = true;
  }

  // ---- 写入 ------------------------------------------------------------------

  /**
   * 落一条。返回落下的那条（被合并时返回被合并到的那条）。
   *
   * `mergeKey` 非空时先试**相邻合并**：上一条是同通道同目标就并计数、重算正文
   * （连拿三张纸钱是一条 ×3，不是三条）。只并**相邻**的——中间隔了别的事，
   * 那就是两件事，硬并会把时间线揉乱。
   */
  private push(
    entry: Omit<GameLogEntry, 'seq'>,
    merge?: { count: number; recompose: (total: number) => string },
  ): GameLogEntry | null {
    if (this.restoring) return null;

    if (merge) {
      const last = this.entries[this.entries.length - 1];
      if (last
        && last.channel === entry.channel
        && last.type === entry.type
        && last.link?.kind === entry.link?.kind
        && last.link?.id === entry.link?.id
      ) {
        last.count = (last.count ?? 1) + merge.count;
        last.text = clampText(merge.recompose(last.count));
        // 序号**要换新的**：合并进来的是刚发生的事，沿用旧序号会让它躲过未读判据
        // （玩家翻过日志、又捡了一张同样的纸钱，红点不亮）。它仍是表尾，时间序不乱。
        last.seq = this.nextSeq++;
        this.unreadDirty = true;
        // 合并也是"内容变了"：面板开着且贴着底时要跟上（×2 变 ×3 也得看得见）
        this.eventBus.emit('gameLog:changed', {});
        return last;
      }
    }

    const created: GameLogEntry = {
      ...entry,
      seq: this.nextSeq++,
      text: clampText(entry.text),
      ...(this.stampProvider ? { stamp: this.stampProvider() } : {}),
    };
    this.entries.push(created);
    if (created.channel === 'dialogue') this.dialogueCount++;
    else this.eventCount++;
    this.unreadDirty = true;
    this.trim();
    this.eventBus.emit('gameLog:changed', {});
    return created;
  }

  /**
   * 分桶裁剪：超配额的那一桶丢自己最老的一条，另一桶不受影响。
   * 从头扫找最老的同类条——它按定义就在表头附近，不是全表遍历。
   */
  private trim(): void {
    this.unreadDirty = true;
    while (this.dialogueCount > MAX_DIALOGUE) {
      const i = this.entries.findIndex((e) => e.channel === 'dialogue');
      if (i < 0) { this.dialogueCount = 0; break; }
      this.entries.splice(i, 1);
      this.dialogueCount--;
    }
    while (this.eventCount > MAX_EVENT) {
      const i = this.entries.findIndex((e) => e.channel !== 'dialogue');
      if (i < 0) { this.eventCount = 0; break; }
      this.entries.splice(i, 1);
      this.eventCount--;
    }
  }

  private s(section: string, key: string, params?: Record<string, string | number>): string {
    return this.strings?.get(section, key, params) ?? '';
  }

  /**
   * 该不该给这段对话写抬头。
   *
   * 抬头的作用是把对白与事件条分开，让"这里开始是一段对话"看得出来。
   * 判据**只看已落下的内容，不记会话深度**：深度计数只要漏掉一次 `dialogue:end`
   * 就再也回不到 0、抬头从此全丢（静默失效，最难查的那种）。内容判据自愈：
   *
   * - 上一条不是对话条目 → 这是一段新对话的开头，写；
   * - 上一条是对话条目但说话人换了 → 换人起一段，写；
   * - 否则（图对话里嵌 `playScriptedDialogue` 的典型形状）→ 不写。
   */
  private shouldWriteHeader(npcName: string): boolean {
    const last = this.entries[this.entries.length - 1];
    if (!last || last.channel !== 'dialogue') return true;
    return npcName !== this.lastHeaderName;
  }

  private bindListeners(): void {
    // ---- 对话通道 -----------------------------------------------------------
    this.listen('dialogue:start', (p: DialogueStartPayload) => {
      const name = String(p?.npcName ?? '').trim();
      // 无名（纯旁白脚本）不写抬头：一条没有主语的分隔线只是噪音
      if (!name || !this.shouldWriteHeader(name)) return;
      const written = this.push({
        channel: 'dialogue',
        type: 'header',
        text: this.s('dialogueLog', 'sessionHeader', { name }),
      });
      if (written) this.lastHeaderName = name;
    });
    this.listen('dialogue:line', (line: DialogueLine) => {
      this.push({
        channel: 'dialogue',
        type: 'line',
        speaker: line?.speaker,
        text: String(line?.text ?? ''),
      });
    });
    this.listen('dialogue:choiceSelected:log', (p: { index: number; text?: string }) => {
      if (!p?.text) return;
      this.push({ channel: 'dialogue', type: 'choice', text: p.text });
    });

    // ---- 物品 ---------------------------------------------------------------
    // 正文与右上入袋回执**逐字相同**（同一条 strings 键）：玩家要能把"刚才闪过去那条"
    // 和"日志里这条"一眼对上号，那是这套设计成立的前提。
    this.listen('item:acquired', (p: { itemId: string; itemName: string; count: number }) => {
      const id = String(p?.itemId ?? '');
      if (!id) return;
      const name = String(p?.itemName ?? id);
      const n = Number(p?.count ?? 1);
      // count<=0 = 堆叠已满、这次实际没进包（addItem 仍会发事件）——没进就不记
      if (!(n > 0)) return;
      const compose = (total: number): string => this.s('pickup', 'acquired', { name, count: total });
      this.push(
        {
          channel: 'item', type: 'event', text: compose(n),
          link: { kind: 'item', id }, count: n, subject: name,
        },
        { count: n, recompose: compose },
      );
    });

    // ---- 任务 ---------------------------------------------------------------
    // 「当前任务变更」**刻意不记**：自动聚焦紧跟在接取之后，记了就是
    // 「新任务：X」下面再顶一条「当前任务：X」——正是本次要消灭的那种重复噪音。
    this.listen('quest:accepted', (p: { questId: string; title: string; repeatable?: boolean; restored?: boolean }) => {
      if (p?.restored === true) return;
      const id = String(p?.questId ?? '');
      if (!id) return;
      const title = String(p?.title ?? id);
      this.push({
        channel: 'quest', type: 'event',
        text: this.s('notifications', p?.repeatable ? 'jobAccepted' : 'questAccepted', { title }),
        link: { kind: 'quest', id },
      });
    });
    this.listen('quest:completed', (p: { questId: string; title: string; repeatable?: boolean }) => {
      const id = String(p?.questId ?? '');
      if (!id) return;
      const title = String(p?.title ?? id);
      this.push({
        channel: 'quest', type: 'event',
        text: this.s('notifications', p?.repeatable ? 'jobCompleted' : 'questCompleted', { title }),
        link: { kind: 'quest', id },
      });
    });

    // ---- 线索 ---------------------------------------------------------------
    this.listen('clue:collected', (p: { id: string; title: string; hidden?: boolean }) => {
      // hidden = 纯机制线索，连线索簿都不进，日志同样不留字面（K7 语义）
      if (p?.hidden === true) return;
      const id = String(p?.id ?? '');
      if (!id) return;
      this.push({
        channel: 'clue', type: 'event',
        text: this.s('notifications', 'clueCollected', { title: String(p?.title ?? id) }),
        link: { kind: 'clue', id },
      });
    });

    // ---- 规矩 ---------------------------------------------------------------
    this.listen('rule:acquired', (p: { ruleId: string; name: string }) => {
      const id = String(p?.ruleId ?? '');
      if (!id) return;
      this.push({
        channel: 'rule', type: 'event',
        text: this.s('notifications', 'ruleAcquired', { name: String(p?.name ?? id) }),
        link: { kind: 'rule', id },
      });
    });
    // 碎片**不挂跳转**：碎片提示文案本身刻意不报是哪条规矩（`fragmentAcquired` 无参数），
    // 给个跳转就等于把它指出来了，把策划有意留的悬念抹掉。
    this.listen('rule:fragment', () => {
      this.push({
        channel: 'rule', type: 'event',
        text: this.s('notifications', 'fragmentAcquired'),
      });
    });

    // ---- 档案 ---------------------------------------------------------------
    // 正文直接取事件带上来的那一串：册名×条目名的映射表在 ArchiveManager 里
    // （七种册子七个文案键），在这儿抄第二份必然漂。
    this.listen('archive:updated', (p: { bookType: string; entryId: string; text?: string }) => {
      const id = String(p?.entryId ?? '');
      const bookType = String(p?.bookType ?? '');
      const text = String(p?.text ?? '');
      if (!id || !bookType || !text) return;
      this.push({
        channel: 'archive', type: 'event', text,
        link: { kind: 'archive', id, bookType },
      });
    });
  }

  private listen(event: string, fn: (...args: any[]) => void): void {
    this.eventBus.on(event, fn);
    this.bound.push({ event, fn });
  }

  // ---- 存档 ------------------------------------------------------------------

  serialize(): object {
    return {
      entries: this.entries,
      nextSeq: this.nextSeq,
      lastSeenSeq: this.lastSeenSeq,
    } satisfies GameLogSaveData;
  }

  deserialize(data: object): void {
    const d = (data ?? {}) as GameLogSaveData;
    this.entries = Array.isArray(d.entries) ? d.entries.filter((e) => e && typeof e.text === 'string') : [];
    // 配额在读档端**同样要夹**：闸门只装在写入端时，一份旧档（或改过的档）能把任意长的表
    // 整个灌回来，此后每次开面板都要按这张表量高。
    this.recount();
    this.trim();
    this.nextSeq = Math.max(
      1,
      Number(d.nextSeq ?? 0) || 0,
      ...this.entries.map((e) => (Number(e.seq) || 0) + 1),
    );
    this.lastSeenSeq = Math.min(Number(d.lastSeenSeq ?? 0) || 0, this.nextSeq - 1);
    this.lastHeaderName = null;
    this.unreadDirty = true;
  }

  /**
   * 吃下旧存档桶 `data.dialogueLog`（只有对话、没有序号与通道）。
   *
   * 只在**新桶缺席**时调用（见 Game 的 distributeSaveData）：旧档读进来仍是一份能翻的
   * 对话记录，不至于开了新版本就把老档的记录清空。迁进来的条目 seq 从 1 起重编。
   */
  migrateLegacyDialogueLog(data: { entries?: DialogueLogEntry[] }): void {
    const raw = Array.isArray(data?.entries) ? data.entries : [];
    this.entries = raw
      .filter((e) => e && typeof e.text === 'string')
      .slice(-MAX_DIALOGUE)
      .map((e, i) => ({
        seq: i + 1,
        channel: 'dialogue' as GameLogChannel,
        type: e.type === 'choice' ? ('choice' as const) : ('line' as const),
        ...(e.speaker ? { speaker: e.speaker } : {}),
        text: clampText(e.text),
      }));
    this.recount();
    this.nextSeq = this.entries.length + 1;
    // 迁进来的旧记录一律算已读：老档里那些对话玩家当时就读过了，
    // 升级完看见一个红点、点开却是几十条旧台词，只会是噪音。
    this.lastSeenSeq = this.nextSeq - 1;
    this.lastHeaderName = null;
    this.unreadDirty = true;
  }

  private recount(): void {
    this.dialogueCount = 0;
    this.eventCount = 0;
    for (const e of this.entries) {
      if (e.channel === 'dialogue') this.dialogueCount++;
      else this.eventCount++;
    }
  }

  destroy(): void {
    for (const { event, fn } of this.bound) this.eventBus.off(event, fn);
    this.bound = [];
    this.entries = [];
    this.dialogueCount = 0;
    this.eventCount = 0;
    this.nextSeq = 1;
    this.lastSeenSeq = 0;
    this.lastHeaderName = null;
    this.unreadCached = 0;
    this.unreadDirty = true;
    this.stampProvider = null;
    this.strings = null;
  }
}
