import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, LoreEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

/**
 * 见闻录：传说 / 地理 / 民俗 / 时事的世界知识条目。
 * 与其余三本册子共用 {@link ArchiveBookView}；本文件只负责数据→分组与正文。
 */
export class LoreBookUI {
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
      title: strings.get('loreBook', 'title'),
      closeHint: strings.get('loreBook', 'back'),
      emptyText: strings.get('loreBook', 'empty'),
      onClose,
      buildSections: () => this.buildSections(),
    });
  }

  /** 单组不分节；分类以行首 `[传说]` 前缀呈现（沿用原样式）。 */
  private buildSections(): ArchiveSection[] {
    const rows = this.archiveData.getUnlockedLore().map(entry => ({
      key: `lore_${entry.id}`,
      label: `[${this.archiveData.getLoreCategoryName(entry.category)}] ${this.archiveData.resolveLine(entry.title)}`,
      enabled: true,
      firstViewActions: entry.firstViewActions,
      buildDetail: () => this.buildDetail(entry),
    }));
    return [{ rows }];
  }

  private buildDetail(entry: LoreEntry): string {
    const content = this.archiveData.resolveLine(entry.content);
    const source = this.archiveData.resolveLine(entry.source);
    return `${content}\n\n${this.strings.get('loreBook', 'source')} ${source}`;
  }

  open(): void { this.view.open(); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
