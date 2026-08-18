import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { AssetManager } from '../core/AssetManager';
import type {
  ActionDef,
  CharacterEntry,
  LoreEntry,
  SlangEntry,
  SlangCategoryView,
  SlangProgress,
  RhymeEntry,
  RhymeProgress,
  DocumentEntry,
  BookDef,
  BookPageEntry,
  BookReaderSlice,
  BookTocChapter,
  Condition,
  ConditionExpr,
  IGameSystem,
  GameContext,
  IArchiveDataProvider,
} from '../data/types';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { FlagKeys } from '../core/FlagKeys';
import { mediaUrlFromShortPath, TEXT_URLS } from '../core/projectPaths';
import { extractMarkupImagePaths } from '../core/richMarkup';

type BookType = 'character' | 'lore' | 'slang' | 'rhyme' | 'document' | 'book' | 'bookEntry';

export class ArchiveManager implements IGameSystem, IArchiveDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private characterDefs: Map<string, CharacterEntry> = new Map();
  private loreDefs: Map<string, LoreEntry> = new Map();
  private slangDefs: Map<string, SlangEntry> = new Map();
  private rhymeDefs: Map<string, RhymeEntry> = new Map();
  private documentDefs: Map<string, DocumentEntry> = new Map();
  private bookDefs: Map<string, BookDef> = new Map();
  private bookEntryIds: Set<string> = new Set();
  private itemDisplayNames: Map<string, string> = new Map();

  private unlockedCharacters: Set<string> = new Set();
  private unlockedLore: Set<string> = new Set();
  private unlockedSlang: Set<string> = new Set();
  private unlockedRhymes: Set<string> = new Set();
  private unlockedDocuments: Set<string> = new Set();
  private unlockedBooks: Set<string> = new Set();

  private readEntries: Set<string> = new Set();
  /** 已执行过「首次阅览」动作的 stable key（与 markRead 的 key 独立） */
  private firstViewFired: Set<string> = new Set();
  private loreCategoryNames: Record<string, string> = {};
  private slangCategoryNames: Record<string, string> = {};
  private slangCategoryCompleteText: Record<string, string> = {};
  private slangAllCompleteText = '';
  private rhymeAllCompleteText = '';
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private onFlagChanged: () => void;
  private resolveForDisplay: ((raw: string | undefined) => string) | null = null;
  /** 读档期间为 true：抑制 flag:changed 触发的解锁重评，避免在 unlocked 集合尚未恢复时喷出虚假“档案更新”通知/音效 */
  private restoring: boolean = false;
  /** loadDefs 初次播种期间为 true：解锁照常入集合/写 flag，但不喷“档案更新”（含 set() 再入的那一轮） */
  private seeding: boolean = false;
  /** 已排一个微任务级批处理重评（同一同步段内多次 flag:changed 只评一轮） */
  private unlockEvalScheduled: boolean = false;
  /** 收敛循环进行中：期间 evaluateUnlocks 自己 set flag 触发的 flag:changed 只置脏、不同步递归 */
  private unlockEvalRunning: boolean = false;
  private unlockEvalDirty: boolean = false;
  /** destroy 后置真：已排入空闲窗口/在飞的档案图预热见此早退，不触碰已清空的 defs / 已销毁的 assetManager。 */
  private destroyed: boolean = false;
  /** 空闲预热的 requestIdleCallback / setTimeout 句柄，destroy 时取消，避免销毁后再启动一轮预热。 */
  private preloadIdleHandle: number | null = null;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;

    this.onFlagChanged = () => {
      if (this.restoring) return;
      if (this.unlockEvalRunning) {
        // 本轮评估内部 set flag 引发的再入：记脏，由收敛循环补评，消除同步递归（连锁解锁最坏 O(n²)）
        this.unlockEvalDirty = true;
        return;
      }
      this.scheduleUnlockEval();
    };
  }

  /** flag:changed / narrative:stateChanged 的重评合并为微任务批处理：一帧内多次状态变更只评一轮。 */
  private scheduleUnlockEval(): void {
    if (this.unlockEvalScheduled) return;
    this.unlockEvalScheduled = true;
    queueMicrotask(() => {
      this.unlockEvalScheduled = false;
      if (this.restoring) return;
      this.runUnlockEvalToConvergence(this.seeding);
    });
  }

  /**
   * 评估到收敛：一轮评估中新写的 flag 可能满足其它条目的条件，旧实现靠同步递归再入实现级联；
   * 这里改为「本轮结束发现有脏再补一轮」，最终解锁结果与递归一致，且带轮数上限防坏数据条件环。
   */
  private runUnlockEvalToConvergence(silent: boolean): void {
    const MAX_ROUNDS = 16;
    this.unlockEvalRunning = true;
    try {
      for (let i = 0; i < MAX_ROUNDS; i++) {
        this.unlockEvalDirty = false;
        this.evaluateUnlocks(silent);
        if (!this.unlockEvalDirty) return;
      }
      console.warn(`ArchiveManager: 解锁重评 ${MAX_ROUNDS} 轮未收敛，疑似条目解锁条件互相依赖成环`);
    } finally {
      this.unlockEvalRunning = false;
    }
  }

  init(ctx: GameContext): void {
    // destroy() 后重 init 须恢复到首次行为：清掉销毁标志，让空闲预热重新可调度。
    this.destroyed = false;
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
    // lore / document / book-entry 走声明式条件解锁，状态迁移后须重评
    this.eventBus.on('flag:changed', this.onFlagChanged);
    this.eventBus.on('narrative:stateChanged', this.onFlagChanged);
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  /** 由 Game 在分发存档前后调用，包裹整个 deserialize 过程。 */
  setRestoring(v: boolean): void {
    this.restoring = v;
  }

  /** 由 Game 注入：统一解析 [tag:…] */
  setResolveForDisplay(fn: ((raw: string | undefined) => string) | null): void {
    this.resolveForDisplay = fn;
  }

  /** UI 侧展示档案正文时调用（ Lore / Document / Character 等） */
  resolveLine(raw: string | undefined): string {
    return this.resolveForDisplay ? this.resolveForDisplay(raw) : (raw ?? '');
  }

  getItemDisplayNames(): ReadonlyMap<string, string> {
    return this.itemDisplayNames;
  }

  private rd(raw: string | undefined): string {
    return this.resolveLine(raw);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    await Promise.all([
      this.loadCharacters(),
      this.loadLore(),
      this.loadSlang(),
      this.loadRhymes(),
      this.loadDocuments(),
      this.loadBooks(),
      this.loadItemDisplayNames(),
    ]);
    // 初次评估静默播种：开局/startupFlags 已命中的条目直接入解锁集合，但不喷“档案更新”
    // 通知/音效。seeding 同时让 set() 触发的 flag:changed 再入评估也保持静默，
    // 从而既保留级联解锁结果、又不在加载画面刷一串档案 toast。
    this.seeding = true;
    this.runUnlockEvalToConvergence(true);
    this.seeding = false;
    this.syncUnlockedBooksFromFlags();
    // 档案 [img:…] 插图/成书插画预热：这些图在玩家打开档案 UI 前都用不到，绝不能在启动关键路径
    // 与首场景纹理/音频抢带宽、抢主线程解码。因此推迟到浏览器空闲后再启动，且内部用并发上限的
    // 池化加载（而非一次性 Promise.all）避免突发。fire-and-forget：不阻塞 loadDefs 调用方，
    // 单图失败在内部吞掉并由素材审计把关。
    this.scheduleContentImagePreload();
  }

  /**
   * 把档案图预热推迟到浏览器空闲窗口：优先 requestIdleCallback，不可用时 fallback setTimeout。
   * 句柄记录到 preloadIdleHandle 供 destroy 取消，避免销毁后再空转一轮。
   */
  private scheduleContentImagePreload(): void {
    if (this.destroyed) return;
    const run = (): void => {
      this.preloadIdleHandle = null;
      if (this.destroyed) return;
      void this.preloadContentImages();
    };
    const ric = (globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === 'function') {
      this.preloadIdleHandle = ric(run, { timeout: 4000 });
    } else {
      this.preloadIdleHandle = setTimeout(run, 1500) as unknown as number;
    }
  }

  /** 与 FlagStore 中 archive_book_<id> 对齐（支持 game_config startupFlags 开局解锁成书） */
  private syncUnlockedBooksFromFlags(): void {
    for (const id of this.bookDefs.keys()) {
      if (this.flagStore.get(`archive_book_${id}`) === true) {
        this.unlockedBooks.add(id);
      }
    }
  }

  private async preloadContentImages(): Promise<void> {
    const paths = new Set<string>();

    const addMedia = (ref: string | undefined): void => {
      if (!ref) return;
      try {
        paths.add(mediaUrlFromShortPath(ref));
      } catch {
        // 媒体不再允许落到 assets/，跳过非法引用
      }
    };
    // 正文插图走与渲染同一份解析（core/richMarkup），预热到的 = 会画出来的。
    // 这里曾手写影子正则,v2 加 |wide 档位后没跟上、把假路径喂给加载器(2026-08-17)——语法知识不许再抄第二份。
    const addFromMarkup = (text: string | undefined): void => {
      if (!text) return;
      for (const p of extractMarkupImagePaths(text)) addMedia(p);
    };

    for (const book of this.bookDefs.values()) {
      for (const page of book.pages) {
        addMedia(page.illustration);
        addFromMarkup(page.content);
        for (const ent of page.entries ?? []) {
          addMedia(ent.illustration);
          addFromMarkup(ent.content);
          addFromMarkup(ent.annotation);
        }
      }
    }
    for (const entry of this.loreDefs.values()) addFromMarkup(entry.content);
    for (const entry of this.slangDefs.values()) addFromMarkup(entry.content);
    for (const entry of this.rhymeDefs.values()) addFromMarkup(entry.content);
    for (const doc of this.documentDefs.values()) addFromMarkup(doc.content);

    if (this.destroyed || paths.size === 0) return;
    await this.loadTexturesPooled([...paths], 3);
  }

  /**
   * 有并发上限的池化纹理预热：顺序取 paths，任一时刻至多 limit 个在飞，一个落定即补下一个。
   * 相比一次性 Promise.all，避免启动后突发几十个解码任务砸主线程。单图失败内部吞掉、不阻塞后续；
   * destroyed 时立即停止取新任务（在飞的落定后自然收束，其结果因 destroyed 守卫不再被消费）。
   */
  private async loadTexturesPooled(paths: string[], limit: number): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.destroyed && next < paths.length) {
        const path = paths[next++]!;
        try {
          await this.assetManager.loadTexture(path);
        } catch {
          // 单图失败吞掉：由素材审计把关，不因一张坏图阻塞其余预热
        }
      }
    };
    const poolSize = Math.max(1, Math.min(limit, paths.length));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  }

  private async loadCharacters(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<CharacterEntry[]>(`${TEXT_URLS.archiveDir}/characters.json`);
      for (const e of list) this.characterDefs.set(e.id, e);
    } catch { /* no data yet */ }
  }

  private async loadLore(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<LoreEntry[] | { entries?: LoreEntry[]; categories?: Record<string, string> }>(`${TEXT_URLS.archiveDir}/lore.json`);
      const list: LoreEntry[] = Array.isArray(data) ? data : data.entries ?? [];
      for (const e of list) this.loreDefs.set(e.id, e);
      if (!Array.isArray(data) && data.categories) {
        this.loreCategoryNames = data.categories;
      }
    } catch { /* no data yet */ }
  }

  private async loadSlang(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{
        entries?: SlangEntry[];
        categories?: Record<string, string>;
        categoryCompleteText?: Record<string, string>;
        allCompleteText?: string;
      }>(`${TEXT_URLS.archiveDir}/slang.json`);
      for (const e of data.entries ?? []) this.slangDefs.set(e.id, e);
      this.slangCategoryNames = data.categories ?? {};
      this.slangCategoryCompleteText = data.categoryCompleteText ?? {};
      this.slangAllCompleteText = data.allCompleteText ?? '';
    } catch { /* no data yet */ }
  }

  private async loadRhymes(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{
        entries?: RhymeEntry[];
        allCompleteText?: string;
      }>(`${TEXT_URLS.archiveDir}/rhymes.json`);
      for (const e of data.entries ?? []) this.rhymeDefs.set(e.id, e);
      this.rhymeAllCompleteText = data.allCompleteText ?? '';
    } catch { /* no data yet */ }
  }

  private async loadDocuments(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<DocumentEntry[]>(`${TEXT_URLS.archiveDir}/documents.json`);
      for (const e of list) this.documentDefs.set(e.id, e);
    } catch { /* no data yet */ }
  }

  private async loadBooks(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<BookDef[]>(`${TEXT_URLS.archiveDir}/books.json`);
      this.bookEntryIds.clear();
      for (const b of list) {
        this.bookDefs.set(b.id, b);
        for (const page of b.pages) {
          for (const ent of page.entries ?? []) {
            if (ent?.id) this.bookEntryIds.add(ent.id);
          }
        }
      }
    } catch { /* no data yet */ }
  }

  private async loadItemDisplayNames(): Promise<void> {
    this.itemDisplayNames.clear();
    try {
      const list = await this.assetManager.loadJson<{ id: string; name?: string }[]>(TEXT_URLS.items);
      for (const it of list) {
        if (it?.id) this.itemDisplayNames.set(it.id, it.name ?? it.id);
      }
    } catch { /* no data yet */ }
  }

  addEntry(bookType: BookType, entryId: string): void {
    switch (bookType) {
      case 'character':
        if (this.characterDefs.has(entryId) && !this.unlockedCharacters.has(entryId)) {
          this.unlockedCharacters.add(entryId);
          this.flagStore.set(FlagKeys.archiveCharacter(entryId), true);
          this.emitUpdate('character', entryId);
        }
        break;
      case 'lore':
        if (this.loreDefs.has(entryId) && !this.unlockedLore.has(entryId)) {
          this.unlockedLore.add(entryId);
          this.flagStore.set(`archive_lore_${entryId}`, true);
          this.emitUpdate('lore', entryId);
        }
        break;
      case 'slang':
        if (this.slangDefs.has(entryId) && !this.unlockedSlang.has(entryId)) {
          this.unlockedSlang.add(entryId);
          this.flagStore.set(`archive_slang_${entryId}`, true);
          this.emitUpdate('slang', entryId);
        }
        break;
      case 'rhyme':
        if (this.rhymeDefs.has(entryId) && !this.unlockedRhymes.has(entryId)) {
          this.unlockedRhymes.add(entryId);
          this.flagStore.set(`archive_rhyme_${entryId}`, true);
          this.emitUpdate('rhyme', entryId);
        }
        break;
      case 'document':
        if (this.documentDefs.has(entryId) && !this.unlockedDocuments.has(entryId)) {
          this.unlockedDocuments.add(entryId);
          this.flagStore.set(`archive_document_${entryId}`, true);
          this.emitUpdate('document', entryId);
        }
        break;
      case 'book':
        if (this.bookDefs.has(entryId) && !this.unlockedBooks.has(entryId)) {
          this.unlockedBooks.add(entryId);
          this.flagStore.set(`archive_book_${entryId}`, true);
          this.emitUpdate('book', entryId);
        }
        break;
      case 'bookEntry':
        if (!this.bookEntryIds.has(entryId)) {
          console.warn(`ArchiveManager: unknown book entry '${entryId}'`);
          break;
        }
        if (this.flagStore.get(`archive_book_entry_${entryId}`) === true) break;
        this.flagStore.set(`archive_book_entry_${entryId}`, true);
        this.emitUpdate('book', entryId);
        break;
    }
  }

  /** 进册提示的每册文案键（与规矩本 ruleAcquired 同一口径：册名 + 条目名，不发万金油） */
  private static readonly ARCHIVE_NOTIF_KEYS: Record<string, string> = {
    character: 'archiveCharacter',
    lore: 'archiveLore',
    slang: 'archiveSlang',
    rhyme: 'archiveRhyme',
    document: 'archiveDocument',
    book: 'archiveBook',
    bookEntry: 'archiveBookEntry',
  };

  /** 条目在提示里的显示名（经 [tag:] 解析）；查不到返回空串（回落万金油文案） */
  private entryDisplayName(bookType: string, entryId: string): string {
    switch (bookType) {
      case 'character': return this.rd(this.characterDefs.get(entryId)?.name);
      case 'lore': return this.rd(this.loreDefs.get(entryId)?.title);
      case 'slang': return this.rd(this.slangDefs.get(entryId)?.title);
      case 'rhyme': return this.rd(this.rhymeDefs.get(entryId)?.title);
      case 'document': return this.rd(this.documentDefs.get(entryId)?.name);
      case 'book': return this.rd(this.bookDefs.get(entryId)?.title);
      case 'bookEntry': {
        for (const b of this.bookDefs.values()) {
          for (const p of b.pages) {
            for (const e of p.entries ?? []) {
              if (e.id === entryId) return this.rd(e.title);
            }
          }
        }
        return '';
      }
      default: return '';
    }
  }

  /**
   * 进册提示是**系统默认绑定**（2026-08-17 制作人拍板：一切进册行为自带提示 UI，
   * 内容侧零手配）。文案带册名+条目名——此前的万金油「档案更新」等于没说
   * （玩家不知道哪本册子多了什么）。seeding/读档路径照旧静默（调用方不走本方法）。
   */
  private emitUpdate(bookType: string, entryId: string): void {
    // book 与 bookEntry 共用 'book' 通道进来：按「id 是不是一本书」分流文案
    const kind = bookType === 'book' && !this.bookDefs.has(entryId) ? 'bookEntry' : bookType;
    const name = this.entryDisplayName(kind, entryId).trim();
    const key = ArchiveManager.ARCHIVE_NOTIF_KEYS[kind];
    const text = name && key
      ? this.strings.get('notifications', key, { name })
      : this.strings.get('notifications', 'archiveUpdated');
    // 组装好的文案随事件带出（`kind`/`name`/`text` 三个增字段，既有消费方不受影响）：
    // 七种册子的文案映射表只此一份，事件日志抄第二份必漂。
    this.eventBus.emit('archive:updated', { bookType, entryId, kind, name, text });
    this.eventBus.emit('notification:show', { text, type: 'archive' });
  }

  markRead(key: string): void {
    this.readEntries.add(key);
  }

  isRead(key: string): boolean {
    return this.readEntries.has(key);
  }

  triggerFirstViewIfNeeded(qualifiedKey: string, actions: ActionDef[] | undefined): void {
    if (!actions || actions.length === 0) return;
    if (this.firstViewFired.has(qualifiedKey)) return;
    this.firstViewFired.add(qualifiedKey);
    this.eventBus.emit('archive:firstView', { actions: actions.map(a => ({ ...a, params: { ...a.params } })) });
  }

  triggerBookSliceFirstView(bookId: string, slice: BookReaderSlice): void {
    const book = this.bookDefs.get(bookId);
    if (!book) return;
    if (slice.kind === 'page') {
      const raw = book.pages.find(p => p.pageNum === slice.pageNum);
      if (!raw) return;
      if (!this.checkConditions(raw.unlockConditions ?? [])) return;
      this.triggerFirstViewIfNeeded(`bookpage_${bookId}_${slice.pageNum}`, raw.firstViewActions);
      return;
    }
    const page = book.pages.find(p => p.pageNum === slice.pageNum);
    const ent = page?.entries?.find(e => e.id === slice.entryId);
    if (!ent) return;
    this.triggerFirstViewIfNeeded(`bookentry_${bookId}_${slice.entryId}`, ent.firstViewActions);
  }

  getLoreCategoryName(key: string): string {
    return this.loreCategoryNames[key] ?? key;
  }

  hasUnread(bookType: BookType): boolean {
    switch (bookType) {
      case 'character':
        for (const id of this.unlockedCharacters) {
          if (!this.readEntries.has(`char_${id}`)) return true;
        }
        return false;
      case 'lore':
        for (const id of this.unlockedLore) {
          if (!this.readEntries.has(`lore_${id}`)) return true;
        }
        return false;
      case 'slang':
        for (const id of this.unlockedSlang) {
          if (!this.readEntries.has(`slang_${id}`)) return true;
        }
        return false;
      case 'rhyme':
        for (const id of this.unlockedRhymes) {
          if (!this.readEntries.has(`rhyme_${id}`)) return true;
        }
        return false;
      case 'document':
        for (const id of this.unlockedDocuments) {
          if (!this.readEntries.has(`doc_${id}`)) return true;
        }
        return false;
      case 'book':
      case 'bookEntry':
        return false;
    }
  }

  private evaluateUnlocks(silent = false): void {
    // 人物档案不在此自动解锁：唯一入口是 addArchiveEntry 动作（addEntry('character', …)）。
    // lore / document / book-entry 才走声明式条件解锁。
    this.loreDefs.forEach((def, id) => {
      if (!this.unlockedLore.has(id) && this.checkConditions(def.unlockConditions)) {
        this.unlockedLore.add(id);
        this.flagStore.set(`archive_lore_${id}`, true);
        if (!silent) this.emitUpdate('lore', id);
      }
    });

    this.slangDefs.forEach((def, id) => {
      if (!this.unlockedSlang.has(id) && this.checkConditions(def.unlockConditions)) {
        this.unlockedSlang.add(id);
        this.flagStore.set(`archive_slang_${id}`, true);
        if (!silent) this.emitUpdate('slang', id);
      }
    });

    this.rhymeDefs.forEach((def, id) => {
      if (!this.unlockedRhymes.has(id) && this.checkConditions(def.unlockConditions)) {
        this.unlockedRhymes.add(id);
        this.flagStore.set(`archive_rhyme_${id}`, true);
        if (!silent) this.emitUpdate('rhyme', id);
      }
    });

    this.documentDefs.forEach((def, id) => {
      if (!this.unlockedDocuments.has(id) && this.checkConditions(def.discoverConditions)) {
        this.unlockedDocuments.add(id);
        this.flagStore.set(`archive_document_${id}`, true);
        if (!silent) this.emitUpdate('document', id);
      }
    });

    for (const book of this.bookDefs.values()) {
      for (const page of book.pages) {
        for (const ent of page.entries ?? []) {
          if (!ent.id) continue;
          if (this.flagStore.get(`archive_book_entry_${ent.id}`) === true) continue;
          const conds = ent.discoverConditions;
          if (conds && conds.length > 0 && this.checkConditions(conds)) {
            this.flagStore.set(`archive_book_entry_${ent.id}`, true);
            if (!silent) this.emitUpdate('book', ent.id);
          }
        }
      }
    }
  }

  private checkConditions(conditions: ConditionExpr[]): boolean {
    if (!conditions || conditions.length === 0) return true;
    const ctx = this.conditionCtxFactory?.();
    if (ctx) return evaluateConditionExprList(conditions, ctx);
    return this.flagStore.checkConditions(conditions as Condition[]);
  }

  getUnlockedCharacters(): CharacterEntry[] {
    return Array.from(this.unlockedCharacters)
      .map(id => this.characterDefs.get(id))
      .filter((e): e is CharacterEntry => !!e);
  }

  getCharacterVisibleImpressions(entry: CharacterEntry): string[] {
    return entry.impressions
      .filter(i => this.checkConditions(i.conditions))
      .map(i => this.rd(i.text));
  }

  getCharacterVisibleInfo(entry: CharacterEntry): string[] {
    return entry.knownInfo
      .filter(i => this.checkConditions(i.conditions))
      .map(i => this.rd(i.text));
  }

  getUnlockedLore(): LoreEntry[] {
    return Array.from(this.unlockedLore)
      .map(id => this.loreDefs.get(id))
      .filter((e): e is LoreEntry => !!e);
  }

  /**
   * 怪话册按分类分组。**刻意返回全部条目（含未解锁）**：这本是成就式搜集册，灰槽是驱动力。
   * 与规矩本"未掌握零像素"的红线不冲突——那条红线保护的是案件知识不许剧透，怪话是纯 flavor。
   */
  getSlangCategories(): SlangCategoryView[] {
    // 分类顺序以 JSON 的 categories 为准，数据里出现的未登记分类兜底追加在后面
    const order = Object.keys(this.slangCategoryNames);
    for (const def of this.slangDefs.values()) {
      if (!order.includes(def.category)) order.push(def.category);
    }
    const views: SlangCategoryView[] = [];
    for (const key of order) {
      const entries = Array.from(this.slangDefs.values())
        .filter(e => e.category === key)
        .map(entry => ({ entry, unlocked: this.unlockedSlang.has(entry.id) }));
      if (entries.length === 0) continue;
      const collected = entries.filter(e => e.unlocked).length;
      const complete = collected === entries.length;
      views.push({
        key,
        name: this.slangCategoryNames[key] ?? key,
        total: entries.length,
        collected,
        complete,
        completeText: complete ? this.rd(this.slangCategoryCompleteText[key] ?? '') : '',
        entries,
      });
    }
    return views;
  }

  getSlangProgress(): SlangProgress {
    const total = this.slangDefs.size;
    const collected = this.unlockedSlang.size;
    const allComplete = total > 0 && collected >= total;
    return {
      collected,
      total,
      allComplete,
      allCompleteText: allComplete ? this.rd(this.slangAllCompleteText) : '',
    };
  }

  /** 歪歌册 flat 列表。**刻意返回全部条目（含未解锁灰槽）**，理由同怪话册：成就式搜集册，空槽是驱动力。 */
  getRhymeList(): { entry: RhymeEntry; unlocked: boolean }[] {
    return Array.from(this.rhymeDefs.values())
      .map(entry => ({ entry, unlocked: this.unlockedRhymes.has(entry.id) }));
  }

  getRhymeProgress(): RhymeProgress {
    const total = this.rhymeDefs.size;
    const collected = this.unlockedRhymes.size;
    const allComplete = total > 0 && collected >= total;
    return {
      collected,
      total,
      allComplete,
      allCompleteText: allComplete ? this.rd(this.rhymeAllCompleteText) : '',
    };
  }

  getUnlockedDocuments(): DocumentEntry[] {
    return Array.from(this.unlockedDocuments)
      .map(id => this.documentDefs.get(id))
      .filter((e): e is DocumentEntry => !!e);
  }

  getBooks(): BookDef[] {
    return Array.from(this.bookDefs.values());
  }

  getUnlockedBooks(): BookDef[] {
    return Array.from(this.unlockedBooks)
      .map(id => this.bookDefs.get(id))
      .filter((e): e is BookDef => !!e);
  }

  getBookTocChapters(book: BookDef): BookTocChapter[] {
    const pages = [...book.pages].sort((a, b) => a.pageNum - b.pageNum);
    return pages.map((p) => {
      const unlocked = this.checkConditions(p.unlockConditions ?? []);
      const entries = (p.entries ?? [])
        .filter((ent): ent is BookPageEntry => !!ent?.id)
        .map((ent) => ({
          id: ent.id,
          title: this.rd(ent.title?.trim() || this.strings.get('bookReader', 'untitledEntry')),
          unlocked: this.flagStore.get(`archive_book_entry_${ent.id}`) === true,
        }));
      return {
        pageNum: p.pageNum,
        title: p.title !== undefined ? this.rd(p.title) : undefined,
        unlocked,
        entries,
      };
    });
  }

  getBookPageSlice(book: BookDef, pageNum: number): BookReaderSlice | null {
    const p = book.pages.find((x) => x.pageNum === pageNum);
    if (!p) return null;
    const unlocked = this.checkConditions(p.unlockConditions ?? []);
    return {
      kind: 'page',
      pageNum: p.pageNum,
      title: p.title !== undefined ? this.rd(p.title) : undefined,
      content: this.rd(p.content),
      illustration: p.illustration,
      unlocked,
    };
  }

  getBookEntrySlice(book: BookDef, pageNum: number, entryId: string): BookReaderSlice | null {
    const p = book.pages.find((x) => x.pageNum === pageNum);
    if (!p) return null;
    if (!this.checkConditions(p.unlockConditions ?? [])) return null;
    const ent = p.entries?.find((e) => e.id === entryId);
    if (!ent) return null;
    if (this.flagStore.get(`archive_book_entry_${ent.id}`) !== true) return null;
    const titleTrim = ent.title?.trim() ?? '';
    const contentTrim = ent.content?.trim() ?? '';
    const annRaw = ent.annotation?.trim();
    const ill = ent.illustration?.trim();
    if (!titleTrim && !contentTrim && !annRaw && !ill) return null;
    const annotation = annRaw ? this.rd(annRaw) : undefined;
    return {
      kind: 'entry',
      pageNum: p.pageNum,
      chapterTitle: p.title !== undefined ? this.rd(p.title) : undefined,
      entryId: ent.id,
      title: this.rd(titleTrim || this.strings.get('bookReader', 'untitledEntry')),
      content: this.rd(contentTrim),
      annotation,
      illustration: ill,
      unlocked: true,
    };
  }

  serialize(): object {
    return {
      characters: Array.from(this.unlockedCharacters),
      lore: Array.from(this.unlockedLore),
      slang: Array.from(this.unlockedSlang),
      rhymes: Array.from(this.unlockedRhymes),
      documents: Array.from(this.unlockedDocuments),
      books: Array.from(this.unlockedBooks),
      read: Array.from(this.readEntries),
      firstViewFired: Array.from(this.firstViewFired),
    };
  }

  deserialize(data: {
    characters?: string[];
    lore?: string[];
    slang?: string[];
    rhymes?: string[];
    documents?: string[];
    books?: string[];
    read?: string[];
    firstViewFired?: string[];
  }): void {
    this.unlockedCharacters = new Set(data.characters ?? []);
    this.unlockedLore = new Set(data.lore ?? []);
    this.unlockedSlang = new Set(data.slang ?? []);
    this.unlockedRhymes = new Set(data.rhymes ?? []);
    this.unlockedDocuments = new Set(data.documents ?? []);
    this.unlockedBooks = new Set(data.books ?? []);
    this.readEntries = new Set(data.read ?? []);
    this.firstViewFired = new Set(data.firstViewFired ?? []);
    this.syncUnlockedBooksFromFlags();
  }

  destroy(): void {
    this.destroyed = true;
    // 取消尚未启动的空闲预热窗口；已在飞的预热靠 destroyed 守卫早退，不触碰已清空的 defs。
    if (this.preloadIdleHandle !== null) {
      const cic = (globalThis as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (typeof cic === 'function') cic(this.preloadIdleHandle);
      else clearTimeout(this.preloadIdleHandle);
      this.preloadIdleHandle = null;
    }
    this.eventBus.off('flag:changed', this.onFlagChanged);
    this.eventBus.off('narrative:stateChanged', this.onFlagChanged);
    // 注入回调与瞬态标志一并复位：重 init 后行为须与首次一致（已排队未执行的微任务
    // 会在空 defs 上空转一轮，无副作用）
    this.conditionCtxFactory = null;
    this.resolveForDisplay = null;
    this.restoring = false;
    this.seeding = false;
    this.unlockEvalRunning = false;
    this.unlockEvalDirty = false;
    this.slangCategoryNames = {};
    this.slangCategoryCompleteText = {};
    this.slangAllCompleteText = '';
    this.rhymeAllCompleteText = '';
    this.characterDefs.clear();
    this.loreDefs.clear();
    this.slangDefs.clear();
    this.rhymeDefs.clear();
    this.documentDefs.clear();
    this.bookDefs.clear();
    this.bookEntryIds.clear();
    this.itemDisplayNames.clear();
    this.unlockedCharacters.clear();
    this.unlockedLore.clear();
    this.unlockedSlang.clear();
    this.unlockedRhymes.clear();
    this.unlockedDocuments.clear();
    this.unlockedBooks.clear();
    this.readEntries.clear();
    this.firstViewFired.clear();
  }
}
