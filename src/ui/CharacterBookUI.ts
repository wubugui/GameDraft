import { ArchiveBookView } from './components/ArchiveBookView';
import type { ArchiveSection } from './components/ArchiveBookView';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, CharacterEntry } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

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
      buildDetail: () => this.buildDetail(ch),
    }));
    return [{ rows }];
  }

  /**
   * 称号 → 印象（随交往更新）→ 已知情报；两段都只列当前条件可见的行。
   * **不含名号**：名号由 `ArchiveBookView` 用行 label 画成右栏的琥珀大字。
   */
  private buildDetail(ch: CharacterEntry): string {
    const rd = (s: string | undefined): string => this.archiveData.resolveLine(s);
    const parts: string[] = [];
    const title = rd(ch.title);
    if (title) parts.push(title);

    const impressions = this.archiveData.getCharacterVisibleImpressions(ch);
    if (impressions.length > 0) {
      parts.push(`\n${this.strings.get('characterBook', 'impression')}`);
      for (const imp of impressions) parts.push(`  ${imp}`);
    }

    const infos = this.archiveData.getCharacterVisibleInfo(ch);
    if (infos.length > 0) {
      parts.push(`\n${this.strings.get('characterBook', 'knownIntel')}`);
      for (const info of infos) parts.push(`  ${info}`);
    }

    return parts.join('\n');
  }

  open(): void { this.view.open(); }
  close(): void { this.view.close(); }
  destroy(): void { this.view.destroy(); }
}
