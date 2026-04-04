import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { AssetManager } from '../core/AssetManager';
import type { CharacterEntry, LoreEntry, DocumentEntry, BookDef, Condition, IGameSystem, GameContext, IArchiveDataProvider } from '../data/types';

type BookType = 'character' | 'lore' | 'document' | 'book';

export class ArchiveManager implements IGameSystem, IArchiveDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;

  private characterDefs: Map<string, CharacterEntry> = new Map();
  private loreDefs: Map<string, LoreEntry> = new Map();
  private documentDefs: Map<string, DocumentEntry> = new Map();
  private bookDefs: Map<string, BookDef> = new Map();

  private unlockedCharacters: Set<string> = new Set();
  private unlockedLore: Set<string> = new Set();
  private unlockedDocuments: Set<string> = new Set();
  private unlockedBooks: Set<string> = new Set();

  private readEntries: Set<string> = new Set();
  private loreCategoryNames: Record<string, string> = {};
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;

  private onFlagChanged: () => void;
  private onDialogueStart: (payload: { npcName?: string }) => void;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;

    this.onFlagChanged = () => this.evaluateUnlocks();
    this.onDialogueStart = (payload) => {
      if (payload.npcName) this.tryUnlockCharacterByNpc(payload.npcName);
    };
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
    this.eventBus.on('flag:changed', this.onFlagChanged);
    this.eventBus.on('dialogue:start', this.onDialogueStart);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    await Promise.all([
      this.loadCharacters(),
      this.loadLore(),
      this.loadDocuments(),
      this.loadBooks(),
    ]);
  }

  private async loadCharacters(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<CharacterEntry[]>('/assets/data/archive/characters.json');
      for (const e of list) this.characterDefs.set(e.id, e);
    } catch { /* no data yet */ }
  }

  private async loadLore(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<LoreEntry[] | { entries?: LoreEntry[]; categories?: Record<string, string> }>('/assets/data/archive/lore.json');
      const list: LoreEntry[] = Array.isArray(data) ? data : data.entries ?? [];
      for (const e of list) this.loreDefs.set(e.id, e);
      if (!Array.isArray(data) && data.categories) {
        this.loreCategoryNames = data.categories;
      }
    } catch { /* no data yet */ }
  }

  private async loadDocuments(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<DocumentEntry[]>('/assets/data/archive/documents.json');
      for (const e of list) this.documentDefs.set(e.id, e);
    } catch { /* no data yet */ }
  }

  private async loadBooks(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<BookDef[]>('/assets/data/archive/books.json');
      for (const b of list) this.bookDefs.set(b.id, b);
    } catch { /* no data yet */ }
  }

  addEntry(bookType: BookType, entryId: string): void {
    switch (bookType) {
      case 'character':
        if (this.characterDefs.has(entryId) && !this.unlockedCharacters.has(entryId)) {
          this.unlockedCharacters.add(entryId);
          this.flagStore.set(`archive_character_${entryId}`, true);
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
        return false;
    }
  }

  private tryUnlockCharacterByNpc(npcId: string): void {
    this.characterDefs.forEach((def) => {
      const matchesNpc = def.id === npcId || def.name === npcId;
      if (matchesNpc && !this.unlockedCharacters.has(def.id)) {
        if (this.checkConditions(def.unlockConditions)) {
          this.unlockedCharacters.add(def.id);
          this.flagStore.set(`archive_character_${def.id}`, true);
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
  }

  private checkConditions(conditions: Condition[]): boolean {
    if (!conditions || conditions.length === 0) return true;
    return this.flagStore.checkConditions(conditions);
  }

  getUnlockedCharacters(): CharacterEntry[] {
    return Array.from(this.unlockedCharacters)
      .map(id => this.characterDefs.get(id))
      .filter((e): e is CharacterEntry => !!e);
  }

  getCharacterVisibleImpressions(entry: CharacterEntry): string[] {
    return entry.impressions
      .filter(i => this.checkConditions(i.conditions))
      .map(i => i.text);
  }

  getCharacterVisibleInfo(entry: CharacterEntry): string[] {
    return entry.knownInfo
      .filter(i => this.checkConditions(i.conditions))
      .map(i => i.text);
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

  getBookVisiblePages(book: BookDef): { pageNum: number; title?: string; content: string; unlocked: boolean }[] {
    return book.pages.map(p => ({
      pageNum: p.pageNum,
      title: p.title,
      content: p.content,
      unlocked: this.checkConditions(p.unlockConditions),
    }));
  }

  serialize(): object {
    return {
      characters: Array.from(this.unlockedCharacters),
      lore: Array.from(this.unlockedLore),
      documents: Array.from(this.unlockedDocuments),
      books: Array.from(this.unlockedBooks),
      read: Array.from(this.readEntries),
    };
  }

  deserialize(data: {
    characters?: string[];
    lore?: string[];
    documents?: string[];
    books?: string[];
    read?: string[];
  }): void {
    this.unlockedCharacters = new Set(data.characters ?? []);
    this.unlockedLore = new Set(data.lore ?? []);
    this.unlockedDocuments = new Set(data.documents ?? []);
    this.unlockedBooks = new Set(data.books ?? []);
    this.readEntries = new Set(data.read ?? []);
  }

  destroy(): void {
    this.eventBus.off('flag:changed', this.onFlagChanged);
    this.eventBus.off('dialogue:start', this.onDialogueStart);
    this.characterDefs.clear();
    this.loreDefs.clear();
    this.documentDefs.clear();
    this.bookDefs.clear();
    this.unlockedCharacters.clear();
    this.unlockedLore.clear();
    this.unlockedDocuments.clear();
    this.unlockedBooks.clear();
    this.readEntries.clear();
  }
}
