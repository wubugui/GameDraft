import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import { parseRichMarkup, type RichBlock } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, DocumentEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

/**
 * 杂书匣：世界中拾取的信件 / 纸条 / 残页 / 告示。
 * 与其余三本册子共用 {@link ArchiveBookView}；本文件只负责数据→分组与正文。
 */
export class DocumentBoxUI {
  private view: ArchiveBookView;
  private archiveData: IArchiveDataProvider;
  private strings: StringsProvider;

  constructor(
    renderer: Renderer,
    archiveData: IArchiveDataProvider,
    onClose: () => void,
    strings: StringsProvider,
    assetManager: AssetManager,
  ) {
    this.archiveData = archiveData;
    this.strings = strings;
    this.view = new ArchiveBookView(renderer, archiveData, assetManager, {
      title: strings.get('documentBox', 'title'),
      closeHint: strings.get('documentBox', 'back'),
      emptyText: strings.get('documentBox', 'empty'),
      onClose,
      buildSections: () => this.buildSections(),
    });
  }

  private buildSections(): ArchiveSection[] {
    const rows = this.archiveData.getUnlockedDocuments().map(doc => ({
      key: `doc_${doc.id}`,
      label: this.archiveData.resolveLine(doc.name),
      enabled: true,
      firstViewActions: doc.firstViewActions,
      buildDetailDoc: () => this.buildDetailDoc(doc),
    }));
    return [{ rows }];
  }

  /**
   * 原文（支持块级标记）→ 分隔线 → 关二狗的批注（引文声部）。
   * 旧版批注与原文同字号同色（审查 P1）：现在批注是纸页下方一段带竖线的旁注。
   */
  private buildDetailDoc(doc: DocumentEntry): RichBlock[] {
    const blocks: RichBlock[] = [...parseRichMarkup(this.archiveData.resolveLine(doc.content))];
    if (doc.annotation !== undefined) {
      const note = this.archiveData.resolveLine(doc.annotation);
      if (note) {
        blocks.push({ kind: 'divider' });
        blocks.push({ kind: 'quote', text: `${this.strings.get('documentBox', 'note')} ${note}` });
      }
    }
    return blocks;
  }

  open(): void { this.view.open(); }
  /** 按文书 id 定位（事件日志跳转落点）。key 的构造归本册子自己，路由层只给 id。 */
  focusEntry(entryId: string): boolean { return this.view.focusEntryByKey(`doc_${entryId}`); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
