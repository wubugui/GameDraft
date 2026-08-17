import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import { parseRichMarkup, type RichBlock } from './RichContent';
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

  /**
   * 按分类分组（与怪话册同一套分组表头语法）。旧版是行首 `[传说]` 前缀——
   * 同一视图族两种分类语法（审查 P2），统一成表头后条目名不再被前缀顶掉一截列宽。
   */
  private buildSections(): ArchiveSection[] {
    const groups = new Map<string, LoreEntry[]>();
    for (const entry of this.archiveData.getUnlockedLore()) {
      const list = groups.get(entry.category);
      if (list) list.push(entry);
      else groups.set(entry.category, [entry]);
    }
    return [...groups.entries()].map(([category, entries]) => ({
      header: this.archiveData.getLoreCategoryName(category),
      rows: entries.map(entry => ({
        key: `lore_${entry.id}`,
        label: this.archiveData.resolveLine(entry.title),
        enabled: true,
        firstViewActions: entry.firstViewActions,
        buildDetailDoc: () => this.buildDetailDoc(entry),
      })),
    }));
  }

  /** 正文（支持块级标记）→ 出处（弱化小字，不再与正文同声部——审查 P1 拍平问题）。 */
  private buildDetailDoc(entry: LoreEntry): RichBlock[] {
    const blocks: RichBlock[] = [...parseRichMarkup(this.archiveData.resolveLine(entry.content))];
    const source = this.archiveData.resolveLine(entry.source);
    if (source) {
      blocks.push({ kind: 'paragraph', tone: 'faint', text: `${this.strings.get('loreBook', 'source')} ${source}` });
    }
    return blocks;
  }

  open(): void { this.view.open(); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
