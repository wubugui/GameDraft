import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
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
      buildDetail: () => this.buildDetail(doc),
    }));
    return [{ rows }];
  }

  /** 原文 +（可选）关二狗的批注 */
  private buildDetail(doc: DocumentEntry): string {
    const content = this.archiveData.resolveLine(doc.content);
    if (doc.annotation === undefined) return content;
    const note = this.archiveData.resolveLine(doc.annotation);
    return `${content}\n\n${this.strings.get('documentBox', 'note')} ${note}`;
  }

  open(): void { this.view.open(); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
