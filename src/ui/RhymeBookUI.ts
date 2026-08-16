import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, RhymeEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

/**
 * 歪歌册：成就式搜集册（第六本）。
 *
 * 与怪话册共用 {@link ArchiveBookView}；本文件只负责「数据怎么变成列表与正文」。
 * 与怪话册的差异只有两点：**不分类**（单 section 无组头的 flat 列表，数据侧预留分类键位）、
 * 正文是多行顺口溜全文（`\n` 由 RichContent 原生换行）。灰槽与只读红线同怪话册（K5 书六）。
 */
export class RhymeBookUI {
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
      title: strings.get('rhymeBook', 'title'),
      subtitle: () => this.progressText(),
      closeHint: strings.get('rhymeBook', 'back'),
      emptyText: strings.get('rhymeBook', 'empty'),
      onClose,
      buildSections: () => this.buildSections(),
    });
  }

  private progressText(): string {
    const p = this.archiveData.getRhymeProgress();
    return this.strings.get('rhymeBook', 'progress', { collected: p.collected, total: p.total });
  }

  private buildSections(): ArchiveSection[] {
    return [{
      rows: this.archiveData.getRhymeList().map(({ entry, unlocked }) => ({
        key: `rhyme_${entry.id}`,
        label: unlocked
          ? this.archiveData.resolveLine(entry.title)
          : this.strings.get('rhymeBook', 'lockedSlot'),
        enabled: unlocked,
        firstViewActions: entry.firstViewActions,
        buildDetail: () => this.buildDetail(entry),
      })),
    }];
  }

  /**
   * 全文 → 来源 → 拆台备注 → 集齐评语。
   * **不含条目名**：标题由 `ArchiveBookView` 用行 label 画成右栏的琥珀大字，这里再来一遍就是重影。
   */
  private buildDetail(entry: RhymeEntry): string {
    const rd = (s: string | undefined): string => this.archiveData.resolveLine(s);
    const parts: string[] = [rd(entry.content)];

    const source = rd(entry.source);
    if (source) parts.push('', `${this.strings.get('rhymeBook', 'source')} ${source}`);
    const note = rd(entry.note);
    if (note) parts.push('', `${this.strings.get('rhymeBook', 'note')} ${note}`);

    // 集齐的唯一"奖励"就是这句评语——不给任何能力（红线见玩法文档 K5 书六）
    const p = this.archiveData.getRhymeProgress();
    if (p.allComplete && p.allCompleteText) parts.push('', p.allCompleteText);

    return parts.join('\n');
  }

  open(): void { this.view.open(); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
