import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import type { RichBlock } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, CharacterEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

/**
 * 人物簿头像用的表情帧：立绘集九表情里的中性位（生产管线约定文件名 `<slug>_calm.png`）。
 * validator 对 `CharacterEntry.portrait` 的资产存在性检查按同一帧对账，改这里要同步那边。
 */
const PORTRAIT_EMOTION = 'calm';

/**
 * 人物簿：关二狗接触过的人。
 * 与其余三本册子共用 {@link ArchiveBookView}；本文件只负责数据→分组与正文。
 */
export class CharacterBookUI {
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
      title: strings.get('characterBook', 'title'),
      closeHint: strings.get('characterBook', 'back'),
      emptyText: strings.get('characterBook', 'empty'),
      onClose,
      buildSections: () => this.buildSections(),
    });
  }

  private buildSections(): ArchiveSection[] {
    const rows = this.archiveData.getUnlockedCharacters().map(ch => ({
      key: `char_${ch.id}`,
      label: this.archiveData.resolveLine(ch.name),
      enabled: true,
      firstViewActions: ch.firstViewActions,
      buildDetailDoc: () => this.buildDetailDoc(ch),
    }));
    return [{ rows }];
  }

  /**
   * 头像（可选，entry.portrait 指对话立绘集 slug）→ 称号（弱化副行）→「印象」小节
   * （随交往更新）→「已知情报」小节；只列当前条件可见的行。
   * 印象/情报的标签旧版与正文同权重（审查 P1），现在是带横线的小节标题、条目带墨点。
   * **不含名号**：名号由 `ArchiveBookView` 画成右栏大字。
   */
  private buildDetailDoc(ch: CharacterEntry): RichBlock[] {
    const rd = (s: string | undefined): string => this.archiveData.resolveLine(s);
    const blocks: RichBlock[] = [];
    const slug = ch.portrait?.trim();
    if (slug) {
      // 路径与 DialogueUI.portraitPath 同构（对话立绘管线唯一命名约定）；
      // RichContent 的 image 块经 mediaUrlFromShortPath 解析，缺图自动落素净占位块。
      blocks.push({
        kind: 'image',
        path: `resources/runtime/images/dialogue_portraits/${slug}/${slug}_${PORTRAIT_EMOTION}.png`,
        size: 'inline',
      });
    }
    const title = rd(ch.title);
    if (title) blocks.push({ kind: 'paragraph', tone: 'muted', text: title });

    const impressions = this.archiveData.getCharacterVisibleImpressions(ch);
    if (impressions.length > 0) {
      blocks.push({ kind: 'heading', text: this.strings.get('characterBook', 'impression') });
      for (const imp of impressions) blocks.push({ kind: 'paragraph', text: `· ${imp}` });
    }

    const infos = this.archiveData.getCharacterVisibleInfo(ch);
    if (infos.length > 0) {
      blocks.push({ kind: 'heading', text: this.strings.get('characterBook', 'knownIntel') });
      for (const info of infos) blocks.push({ kind: 'paragraph', text: `· ${info}` });
    }

    return blocks;
  }

  open(): void { this.view.open(); }
  /** 按人物 id 定位（事件日志跳转落点）。key 的构造归本册子自己，路由层只给 id。 */
  focusEntry(entryId: string): boolean { return this.view.focusEntryByKey(`char_${entryId}`); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
