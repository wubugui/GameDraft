import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import type { RichBlock } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';
import type { IClueDataProvider } from '../systems/ClueManager';

/**
 * 线索簿（书架第七本，玩法需求清单 K7）：玩家从文本里亲手摘下来的词条。
 *
 * 与怪话册刻意不同构：**只列已采集**、不给总数、不留灰槽——线索的存在本身可能剧透
 * （K7 拍板）。数据口是 ClueManager（真相在 flag），已读标记仍走档案的通用读集
 * （`cluebook_<id>` 泛键），书架红点因此照常工作。
 */
export class ClueBookUI {
  private view: ArchiveBookView;
  private clueData: IClueDataProvider;
  private strings: StringsProvider;

  constructor(
    renderer: Renderer,
    archiveData: IArchiveDataProvider,
    clueData: IClueDataProvider,
    onClose: () => void,
    strings: StringsProvider,
    assetManager: AssetManager,
  ) {
    this.clueData = clueData;
    this.strings = strings;
    this.view = new ArchiveBookView(renderer, archiveData, assetManager, {
      title: strings.get('clueBook', 'title'),
      subtitle: () => this.strings.get('clueBook', 'progress', { count: this.clueData.collectedCount() }),
      closeHint: strings.get('clueBook', 'back'),
      emptyText: strings.get('clueBook', 'empty'),
      onClose,
      buildSections: () => this.buildSections(),
    });
  }

  private buildSections(): ArchiveSection[] {
    const byCategory = new Map<string, ReturnType<IClueDataProvider['getCollectedClues']>>();
    for (const def of this.clueData.getCollectedClues()) {
      const key = def.category ?? 'misc';
      const list = byCategory.get(key);
      if (list) list.push(def);
      else byCategory.set(key, [def]);
    }
    return [...byCategory.entries()].map(([category, defs]) => ({
      header: this.clueData.getCategoryName(category),
      rows: defs.map(def => ({
        key: `cluebook_${def.id}`,
        label: def.title,
        enabled: true,
        buildDetailDoc: (): RichBlock[] => [{ kind: 'paragraph', text: def.desc }],
      })),
    }));
  }

  open(): void { this.view.open(); }
  /** 按线索 id 定位（事件日志跳转落点）。key 的构造归本册子自己，路由层只给 id。 */
  focusEntry(entryId: string): boolean { return this.view.focusEntryByKey(`cluebook_${entryId}`); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
