import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { AssetManager } from '../core/AssetManager';
import type {
  ActionDef,
  CharacterEntry,
  LoreEntry,
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

type BookType = 'character' | 'lore' | 'document' | 'book' | 'bookEntry';

export class ArchiveManager implements IGameSystem, IArchiveDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private characterDefs: Map<string, CharacterEntry> = new Map();
  private loreDefs: Map<string, LoreEntry> = new Map();
  private documentDefs: Map<string, DocumentEntry> = new Map();
  private bookDefs: Map<string, BookDef> = new Map();
  private bookEntryIds: Set<string> = new Set();
  private itemDisplayNames: Map<string, string> = new Map();

  private unlockedCharacters: Set<string> = new Set();
  private unlockedLore: Set<string> = new Set();
  private unlockedDocuments: Set<string> = new Set();
  private unlockedBooks: Set<string> = new Set();

  private readEntries: Set<string> = new Set();
  /** 已执行过「首次阅览」动作的 stable key（与 markRead 的 key 独立） */
  private firstViewFired: Set<string> = new Set();
  private loreCategoryNames: Record<string, string> = {};
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private onFlagChanged: () => void;
  private onDialogueStart: (payload: { npcName?: string }) => void;
  private resolveForDisplay: ((raw: string | undefined) => string) | null = null;
  /** 读档期间为 true：抑制 flag:changed 触发的解锁重评，避免在 unlocked 集合尚未恢复时喷出虚假“档案更新”通知/音效 */
  private restoring: boolean = false;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;

    this.onFlagChanged = () => { if (!this.restoring) this.evaluateUnlocks(); };
    this.onDialogueStart = (payload) => {
      if (payload.npcName) this.tryUnlockCharacterByNpc(payload.npcName);
    };
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
    this.eventBus.on('flag:changed', this.onFlagChanged);
    // 解锁条件可为叙事状态叶子（{narrative, state, reached}）：状态迁移后须重评
    this.eventBus.on('narrative:stateChanged', this.onFlagChanged);
    this.eventBus.on('dialogue:start', this.onDialogueStart);
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
      this.loadDocuments(),
      this.loadBooks(),
      this.loadItemDisplayNames(),
    ]);
    this.evaluateUnlocks();
    this.syncUnlockedBooksFromFlags();
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
    const imgRe = /\[img:([^\]]+)\]/g;

    const addMedia = (ref: string | undefined): void => {
      if (!ref) return;
      try {
        paths.add(mediaUrlFromShortPath(ref));
      } catch {
        // 媒体不再允许落到 assets/，跳过非法引用
      }
    };

    for (const book of this.bookDefs.values()) {
      for (const page of book.pages) {
        addMedia(page.illustration);
        for (const m of page.content.matchAll(imgRe)) addMedia(m[1]);
        for (const ent of page.entries ?? []) {
          addMedia(ent.illustration);
          for (const m of ent.content.matchAll(imgRe)) addMedia(m[1]);
          if (ent.annotation) {
            for (const m of ent.annotation.matchAll(imgRe)) addMedia(m[1]);
          }
        }
      }
    }
    for (const entry of this.loreDefs.values()) {
      for (const m of entry.content.matchAll(imgRe)) addMedia(m[1]);
    }
    for (const doc of this.documentDefs.values()) {
      for (const m of doc.content.matchAll(imgRe)) addMedia(m[1]);
    }

    if (paths.size > 0) {
      await Promise.all(
        [...paths].map(p => this.assetManager.loadTexture(p).catch(() => null)),
      );
    }
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

  private emitUpdate(bookType: string, entryId: string): void {
    this.eventBus.emit('archive:updated', { bookType, entryId });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'archiveUpdated'),
      type: 'archive',
    });
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

  private tryUnlockCharacterByNpc(npcId: string): void {
    this.characterDefs.forEach((def) => {
      const matchesNpc = def.id === npcId || def.name === npcId;
      if (matchesNpc && !this.unlockedCharacters.has(def.id)) {
        if (this.checkConditions(def.unlockConditions)) {
          this.unlockedCharacters.add(def.id);
          this.flagStore.set(FlagKeys.archiveCharacter(def.id), true);
          this.emitUpdate('character', def.id);
        }
      }
    });
  }

  private evaluateUnlocks(): void {
    this.loreDefs.forEach((def, id) => {
      if (!this.unlockedLore.has(id) && this.checkConditions(def.unlockConditions)) {
        this.unlockedLore.add(id);
        this.flagStore.set(`archive_lore_${id}`, true);
        this.emitUpdate('lore', id);
      }
    });

    this.documentDefs.forEach((def, id) => {
      if (!this.unlockedDocuments.has(id) && this.checkConditions(def.discoverConditions)) {
        this.unlockedDocuments.add(id);
        this.flagStore.set(`archive_document_${id}`, true);
        this.emitUpdate('document', id);
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
            this.emitUpdate('book', ent.id);
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
      documents: Array.from(this.unlockedDocuments),
      books: Array.from(this.unlockedBooks),
      read: Array.from(this.readEntries),
      firstViewFired: Array.from(this.firstViewFired),
    };
  }

  deserialize(data: {
    characters?: string[];
    lore?: string[];
    documents?: string[];
    books?: string[];
    read?: string[];
    firstViewFired?: string[];
  }): void {
    this.unlockedCharacters = new Set(data.characters ?? []);
    this.unlockedLore = new Set(data.lore ?? []);
    this.unlockedDocuments = new Set(data.documents ?? []);
    this.unlockedBooks = new Set(data.books ?? []);
    this.readEntries = new Set(data.read ?? []);
    this.firstViewFired = new Set(data.firstViewFired ?? []);
    this.syncUnlockedBooksFromFlags();
  }

  destroy(): void {
    this.eventBus.off('flag:changed', this.onFlagChanged);
    this.eventBus.off('narrative:stateChanged', this.onFlagChanged);
    this.eventBus.off('dialogue:start', this.onDialogueStart);
    this.characterDefs.clear();
    this.loreDefs.clear();
    this.documentDefs.clear();
    this.bookDefs.clear();
    this.bookEntryIds.clear();
    this.itemDisplayNames.clear();
    this.unlockedCharacters.clear();
    this.unlockedLore.clear();
    this.unlockedDocuments.clear();
    this.unlockedBooks.clear();
    this.readEntries.clear();
    this.firstViewFired.clear();
  }
}
