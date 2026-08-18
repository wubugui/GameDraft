import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import { parseRichMarkup, type RichBlock } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, SlangEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

/** 字段标签（"例：/来源："）转小节标题时去掉尾冒号——标题自带横线，再带冒号就双重标点 */
function headingLabel(s: string): string {
  return s.replace(/[:：]\s*$/, '');
}

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
        buildDetailDoc: () => this.buildDetailDoc(entry, cat.completeText),
      })),
    }));
  }

  /**
   * 考据正文 → 例句（引文）→ 来源（弱化）→ 拆台备注（次声部，笑点落最后）→ 集齐评语。
   * 数据的五种语义字段各归各的声部——旧版拍平成同字号同色纯文本是审查 P1 最实锤的一处。
   * **不含条目名**：标题由 `ArchiveBookView` 画成右栏大字，这里再来一遍就是重影。
   */
  private buildDetailDoc(entry: SlangEntry, categoryCompleteText: string): RichBlock[] {
    const rd = (s: string | undefined): string => this.archiveData.resolveLine(s);
    const blocks: RichBlock[] = [...parseRichMarkup(rd(entry.content))];

    const example = rd(entry.example);
    if (example) {
      blocks.push({ kind: 'heading', text: headingLabel(this.strings.get('slangBook', 'example')) });
      blocks.push({ kind: 'quote', text: example });
    }
    const source = rd(entry.source);
    if (source) blocks.push({ kind: 'paragraph', tone: 'faint', text: `${this.strings.get('slangBook', 'source')} ${source}` });
    const note = rd(entry.note);
    if (note) blocks.push({ kind: 'paragraph', tone: 'muted', text: `${this.strings.get('slangBook', 'note')} ${note}` });

    // 集齐的唯一"奖励"就是这句嘲讽文案——不给任何能力（红线见玩法文档 K5 书五）
    const p = this.archiveData.getSlangProgress();
    const completeText = p.allComplete && p.allCompleteText ? p.allCompleteText : categoryCompleteText;
    if (completeText) {
      blocks.push({ kind: 'divider' });
      blocks.push({ kind: 'paragraph', tone: 'muted', text: completeText });
    }
    return blocks;
  }

  open(): void { this.view.open(); }
  /** 按怪话 id 定位（事件日志跳转落点）。未收集的灰槽由 view 侧拒绝，不会被指认。 */
  focusEntry(entryId: string): boolean { return this.view.focusEntryByKey(`slang_${entryId}`); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
