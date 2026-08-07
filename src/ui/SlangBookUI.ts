import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, SlangEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

/**
 * 怪话册：成就式搜集册。
 *
 * 与其余三本册子共用 {@link ArchiveBookView}；本文件只负责「数据怎么变成分组与正文」。
 * 本册独有的两点也在这里表达：**按类分组 + 显示 N/M**、**未收集条目列成灰槽**
 * （空槽是这本的驱动力；规矩本"未掌握零像素"那条红线保护的是案件知识不许剧透，
 * 怪话是纯 flavor 无剧透风险，两本刻意不同构）。
 */
export class SlangBookUI {
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
      title: strings.get('slangBook', 'title'),
      subtitle: () => this.progressText(),
      closeHint: strings.get('slangBook', 'back'),
      emptyText: strings.get('slangBook', 'empty'),
      onClose,
      buildSections: () => this.buildSections(),
    });
  }

  private progressText(): string {
    const p = this.archiveData.getSlangProgress();
    return this.strings.get('slangBook', 'progress', { collected: p.collected, total: p.total });
  }

  private buildSections(): ArchiveSection[] {
    return this.archiveData.getSlangCategories().map(cat => ({
      header: `${cat.name}  ${cat.collected}/${cat.total}`,
      headerAccent: cat.complete,
      rows: cat.entries.map(({ entry, unlocked }) => ({
        key: `slang_${entry.id}`,
        label: unlocked
          ? this.archiveData.resolveLine(entry.title)
          : this.strings.get('slangBook', 'lockedSlot'),
        enabled: unlocked,
        firstViewActions: entry.firstViewActions,
        buildDetail: () => this.buildDetail(entry, cat.completeText),
      })),
    }));
  }

  /**
   * 考据正文 → 例句 → 来源 → 拆台备注（笑点落在最后一行）→ 集齐评语。
   * **不含条目名**：标题由 `ArchiveBookView` 用行 label 画成右栏的琥珀大字，这里再来一遍就是重影。
   */
  private buildDetail(entry: SlangEntry, categoryCompleteText: string): string {
    const rd = (s: string | undefined): string => this.archiveData.resolveLine(s);
    const parts: string[] = [rd(entry.content)];

    const example = rd(entry.example);
    if (example) parts.push('', `${this.strings.get('slangBook', 'example')} ${example}`);
    const source = rd(entry.source);
    if (source) parts.push(`${this.strings.get('slangBook', 'source')} ${source}`);
    const note = rd(entry.note);
    if (note) parts.push('', `${this.strings.get('slangBook', 'note')} ${note}`);

    // 集齐的唯一"奖励"就是这句嘲讽文案——不给任何能力（红线见玩法文档 K5 书五）
    const p = this.archiveData.getSlangProgress();
    if (p.allComplete && p.allCompleteText) parts.push('', p.allCompleteText);
    else if (categoryCompleteText) parts.push('', categoryCompleteText);

    return parts.join('\n');
  }

  open(): void { this.view.open(); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
