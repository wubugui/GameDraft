import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { buildRichContent } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { BookDef, BookReaderSlice, BookTocChapter, IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

const PANEL_W = 820;
const PANEL_H = 560;
const PADDING = 20;
const BOTTOM_BAR = 36;
const TOC_W = 208;
const TOC_GAP = 14;

type PanelWheelLayout = {
  px: number;
  py: number;
  tocLeft: number;
  tocRight: number;
  contentLeft: number;
  contentRight: number;
  scrollTop: number;
  scrollBottom: number;
};

export class BookReaderUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private assetManager: AssetManager;
  private container: Container | null = null;
  private currentBook: BookDef | null = null;
  /** 当前选中的章节页码 */
  private navPageNum = 1;
  /** null 表示阅读该章正文；非 null 表示该章下某条 entry */
  private navEntryId: string | null = null;
  private onCloseCb: (() => void) | null = null;
  private onWheelBound: (e: WheelEvent) => void;
  private strings: StringsProvider;
  private contentContainer: Container | null = null;
  private contentScrollOffset = 0;
  private contentTotalH = 0;
  private scrollAnchorY = 0;
  private contentViewportH = 0;
  private tocContainer: Container | null = null;
  private tocScrollOffset = 0;
  private tocTotalH = 0;
  private tocViewportH = 0;
  private tocAnchorY = 0;
  private wheelLayout: PanelWheelLayout | null = null;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.assetManager = assetManager;
    this.onWheelBound = this.onWheel.bind(this);
    this.strings = strings;
  }

  openBook(book: BookDef, onClose: () => void): void {
    this.currentBook = book;
    const toc = this.archiveData.getBookTocChapters(book);
    const first = toc[0];
    this.navPageNum = first?.pageNum ?? 1;
    this.navEntryId = null;
    this.onCloseCb = onClose;
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
    this.build(true);
  }

  close(): void {
    window.removeEventListener('wheel', this.onWheelBound);
    this.destroyUI();
    this.currentBook = null;
    this.onCloseCb = null;
  }

  destroy(): void {
    this.close();
  }

  private resolveSlice(book: BookDef): {
    slice: BookReaderSlice | null;
    entryLocked: boolean;
  } {
    if (this.navEntryId) {
      const slice = this.archiveData.getBookEntrySlice(book, this.navPageNum, this.navEntryId);
      if (slice) return { slice, entryLocked: false };
      const toc = this.archiveData.getBookTocChapters(book);
      const ch = toc.find((c) => c.pageNum === this.navPageNum);
      const ent = ch?.entries.find((e) => e.id === this.navEntryId);
      return { slice: null, entryLocked: !!ent && !ent.unlocked };
    }
    const slice = this.archiveData.getBookPageSlice(book, this.navPageNum);
    return { slice, entryLocked: false };
  }

  /**
   * @param animateOpen 仅首次打开书本时为 true（淡入）；目录切换时不做 alpha 动画，避免整面板闪一下。
   */
  private build(animateOpen = false): void {
    const prevTocScroll = animateOpen ? 0 : this.tocScrollOffset;
    this.destroyUI();
    if (!this.currentBook) return;

    this.contentScrollOffset = 0;
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - PANEL_H) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.fill({ color: UITheme.colors.bookBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.archiveData.resolveLine(this.currentBook.title),
      style: {
        fontSize: 18,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: PANEL_W - PADDING * 2,
      },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('bookReader', 'back'),
      style: {
        fontSize: 13,
        fill: UITheme.colors.link,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: 100,
      },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => { if (this.onCloseCb) this.onCloseCb(); });
    this.container.addChild(backBtn);

    const tocChapters = this.archiveData.getBookTocChapters(this.currentBook);
    const tocTitle = new Text({
      text: this.strings.get('bookReader', 'tocTitle'),
      style: {
        fontSize: 12,
        fill: UITheme.colors.section,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: TOC_W,
      },
    });
    tocTitle.x = px + PADDING;
    tocTitle.y = py + 44;
    this.container.addChild(tocTitle);

    this.tocAnchorY = py + 62;
    this.tocViewportH = Math.max(80, py + PANEL_H - BOTTOM_BAR - this.tocAnchorY);

    const tocInner = new Container();
    let tocY = 0;
    const tocLineW = TOC_W - 4;
    const makeTocLine = (
      label: string,
      pageNum: number,
      entryId: string | null,
      indent: number,
      opts: { muted: boolean; selected: boolean },
    ): void => {
      const fill = opts.selected
        ? UITheme.colors.gold
        : opts.muted
          ? UITheme.colors.disabled
          : UITheme.colors.bodyDim;
      const t = new Text({
        text: label,
        style: {
          fontSize: 12,
          fill,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: tocLineW - indent,
          lineHeight: 18,
        },
      });
      t.x = indent;
      t.y = tocY;
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.on('pointerdown', () => {
        this.navPageNum = pageNum;
        this.navEntryId = entryId;
        this.build(false);
      });
      tocInner.addChild(t);
      tocY += Math.max(20, t.height + 4);
    };

    for (const ch of tocChapters) {
      const chLabel = ch.title?.trim()
        || this.strings.get('bookReader', 'chapterFallback', { n: String(ch.pageNum) });
      const chSel = this.navPageNum === ch.pageNum && this.navEntryId === null;
      makeTocLine(chLabel, ch.pageNum, null, 0, { muted: !ch.unlocked, selected: chSel });
      for (const ent of ch.entries) {
        const entSel = this.navPageNum === ch.pageNum && this.navEntryId === ent.id;
        const prefix = ent.unlocked ? '· ' : '○ ';
        makeTocLine(prefix + ent.title, ch.pageNum, ent.id, 14, { muted: !ent.unlocked, selected: entSel });
      }
    }

    this.tocTotalH = tocY;
    tocInner.x = px + PADDING;
    const maxTocScroll = Math.max(0, this.tocTotalH - this.tocViewportH);
    this.tocScrollOffset = Math.min(Math.max(0, prevTocScroll), maxTocScroll);
    tocInner.y = this.tocAnchorY - this.tocScrollOffset;
    this.tocContainer = tocInner;

    const tocMaskG = new Graphics();
    tocMaskG.rect(px + PADDING, this.tocAnchorY, TOC_W, this.tocViewportH);
    tocMaskG.fill({ color: 0xffffff });
    tocMaskG.eventMode = 'none';
    this.container.addChild(tocMaskG);
    tocInner.mask = tocMaskG;

    const tocColBg = new Graphics();
    tocColBg.roundRect(px + PADDING - 4, this.tocAnchorY - 4, TOC_W + 8, this.tocViewportH + 8, 6);
    tocColBg.fill({ color: UITheme.colors.rowBgInactive, alpha: 0.55 });
    this.container.addChild(tocColBg);

    const divider = new Graphics();
    const divX = px + PADDING + TOC_W + TOC_GAP / 2;
    divider.moveTo(divX, this.tocAnchorY - 4);
    divider.lineTo(divX, this.tocAnchorY + this.tocViewportH + 4);
    divider.stroke({ width: 1, color: UITheme.colors.borderSubtle, alpha: 0.9 });
    this.container.addChild(divider);

    this.container.addChild(tocInner);

    const contentLeft = px + PADDING + TOC_W + TOC_GAP;
    const contentW = PANEL_W - PADDING * 2 - TOC_W - TOC_GAP;
    const { slice, entryLocked } = this.resolveSlice(this.currentBook);

    let titleBlockEndY = this.tocAnchorY;

    if (entryLocked) {
      const locked = new Text({
        text: this.strings.get('bookReader', 'entryLocked'),
        style: {
          fontSize: 15,
          fill: UITheme.colors.disabledDark,
          fontFamily: UITheme.fonts.display,
          fontStyle: 'italic',
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: contentW,
        },
      });
      locked.x = contentLeft;
      locked.y = this.tocAnchorY;
      this.container.addChild(locked);
      titleBlockEndY = this.tocAnchorY + locked.height + 16;
    } else if (slice) {
      if (slice.unlocked) {
        this.archiveData.triggerBookSliceFirstView(this.currentBook.id, slice);

        if (slice.kind === 'page') {
          if (slice.title) {
            const pt = new Text({
              text: slice.title,
              style: {
                fontSize: 15,
                fill: UITheme.colors.ruleName,
                fontFamily: UITheme.fonts.display,
                fontWeight: 'bold',
                wordWrap: true,
                breakWords: true,
                wordWrapWidth: contentW,
              },
            });
            pt.x = contentLeft;
            pt.y = this.tocAnchorY;
            this.container.addChild(pt);
            titleBlockEndY = this.tocAnchorY + pt.height + 10;
          } else {
            titleBlockEndY = this.tocAnchorY;
          }
        } else {
          const chapter = slice.chapterTitle?.trim();
          if (chapter) {
            const ch = new Text({
              text: this.strings.get('bookReader', 'entryFromChapter', { chapter }),
              style: {
                fontSize: 12,
                fill: UITheme.colors.pageInfo,
                fontFamily: UITheme.fonts.ui,
                wordWrap: true,
                breakWords: true,
                wordWrapWidth: contentW,
              },
            });
            ch.x = contentLeft;
            ch.y = this.tocAnchorY;
            this.container.addChild(ch);
            titleBlockEndY = this.tocAnchorY + ch.height + 4;
          }
          const et = new Text({
            text: slice.title,
            style: {
              fontSize: 15,
              fill: UITheme.colors.ruleName,
              fontFamily: UITheme.fonts.display,
              fontWeight: 'bold',
              wordWrap: true,
              breakWords: true,
              wordWrapWidth: contentW,
            },
          });
          et.x = contentLeft;
          et.y = titleBlockEndY;
          this.container.addChild(et);
          titleBlockEndY = titleBlockEndY + et.height + 10;

          const backCh = new Text({
            text: this.strings.get('bookReader', 'backToChapter'),
            style: {
              fontSize: 11,
              fill: UITheme.colors.link,
              fontFamily: UITheme.fonts.ui,
              wordWrap: true,
              breakWords: true,
              wordWrapWidth: contentW,
            },
          });
          backCh.x = contentLeft;
          backCh.y = titleBlockEndY;
          backCh.eventMode = 'static';
          backCh.cursor = 'pointer';
          backCh.on('pointerdown', () => {
            this.navEntryId = null;
            this.build(false);
          });
          this.container.addChild(backCh);
          titleBlockEndY = titleBlockEndY + backCh.height + 8;
        }

        let raw = slice.content;
        if (slice.illustration?.trim()) {
          raw = `[img:${slice.illustration.trim()}]\n${raw}`;
        }

        const { container: rc, totalHeight: mainH } = buildRichContent(raw, {
          width: contentW,
          fontSize: 13,
          fill: UITheme.colors.bodyDim,
          fontFamily: UITheme.fonts.display,
          lineHeight: 22,
        }, this.assetManager);

        const scrollInner = new Container();
        scrollInner.addChild(rc);
        let innerH = mainH;
        if (slice.kind === 'entry' && slice.annotation?.trim()) {
          const ann = new Text({
            text: `${this.strings.get('bookReader', 'annotationHeading')}：${slice.annotation.trim()}`,
            style: {
              fontSize: 12,
              fill: UITheme.colors.bodyMuted,
              fontFamily: UITheme.fonts.display,
              fontStyle: 'italic',
              wordWrap: true,
              breakWords: true,
              wordWrapWidth: contentW,
              lineHeight: 20,
            },
          });
          ann.y = mainH + 14;
          scrollInner.addChild(ann);
          innerH = ann.y + ann.height;
        }

        this.scrollAnchorY = titleBlockEndY;
        this.contentViewportH = Math.max(80, py + PANEL_H - BOTTOM_BAR - this.scrollAnchorY);

        scrollInner.x = contentLeft;
        scrollInner.y = this.scrollAnchorY;
        this.contentContainer = scrollInner;
        this.contentTotalH = innerH;

        const contentMask = new Graphics();
        contentMask.rect(contentLeft, this.scrollAnchorY, contentW, this.contentViewportH);
        contentMask.fill({ color: 0xffffff });
        this.container.addChild(contentMask);
        scrollInner.mask = contentMask;

        this.container.addChild(scrollInner);
      } else {
        const missing = new Text({
          text: this.strings.get('bookReader', 'pageMissing'),
          style: {
            fontSize: 16,
            fill: UITheme.colors.disabledDark,
            fontFamily: UITheme.fonts.display,
            fontStyle: 'italic',
            wordWrap: true,
            breakWords: true,
            wordWrapWidth: contentW,
          },
        });
        missing.x = contentLeft + (contentW - missing.width) / 2;
        missing.y = py + PANEL_H / 2 - 20;
        this.container.addChild(missing);
      }
    }

    const breadcrumb = this.breadcrumbText(tocChapters);
    const pageInfo = new Text({
      text: breadcrumb,
      style: {
        fontSize: 11,
        fill: UITheme.colors.pageInfo,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: PANEL_W - PADDING * 2,
      },
    });
    pageInfo.x = px + PADDING;
    pageInfo.y = py + PANEL_H - 26;
    this.container.addChild(pageInfo);

    this.wheelLayout = {
      px,
      py,
      tocLeft: px + PADDING,
      tocRight: px + PADDING + TOC_W,
      contentLeft,
      contentRight: px + PANEL_W - PADDING,
      scrollTop: this.tocAnchorY,
      scrollBottom: py + PANEL_H - BOTTOM_BAR,
    };

    this.renderer.uiLayer.addChild(this.container);
    if (animateOpen) {
      fadeIn(this.container);
    } else {
      this.container.alpha = 1;
    }
  }

  private breadcrumbText(tocChapters: BookTocChapter[]): string {
    const ch = tocChapters.find((c) => c.pageNum === this.navPageNum);
    const chName = ch?.title?.trim()
      || this.strings.get('bookReader', 'chapterFallback', { n: String(this.navPageNum) });
    if (!this.navEntryId) {
      return `${chName}  ·  ${this.strings.get('bookReader', 'pageHint')}`;
    }
    const ent = ch?.entries.find((e) => e.id === this.navEntryId);
    const entTitle = ent?.title ?? '';
    return `${chName} / ${entTitle}  ·  ${this.strings.get('bookReader', 'pageHint')}`;
  }

  private onWheel(e: WheelEvent): void {
    const layout = this.wheelLayout;
    if (!layout) return;
    const canvas = this.renderer.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const mx = (e.clientX - rect.left) * (sw / Math.max(1, rect.width));
    const my = (e.clientY - rect.top) * (sh / Math.max(1, rect.height));
    if (my < layout.scrollTop || my > layout.scrollBottom) return;
    if (mx >= layout.tocLeft && mx <= layout.tocRight && this.tocContainer) {
      const maxToc = Math.max(0, this.tocTotalH - this.tocViewportH);
      if (maxToc <= 0) return;
      e.preventDefault();
      this.tocScrollOffset = Math.max(0, Math.min(this.tocScrollOffset + e.deltaY, maxToc));
      this.tocContainer.y = this.tocAnchorY - this.tocScrollOffset;
      return;
    }
    if (mx >= layout.contentLeft && mx <= layout.contentRight && this.contentContainer) {
      const maxScroll = Math.max(0, this.contentTotalH - this.contentViewportH);
      if (maxScroll <= 0) return;
      e.preventDefault();
      this.contentScrollOffset = Math.max(0, Math.min(this.contentScrollOffset + e.deltaY, maxScroll));
      this.contentContainer.y = this.scrollAnchorY - this.contentScrollOffset;
    }
  }

  private destroyUI(): void {
    this.contentContainer = null;
    this.tocContainer = null;
    this.wheelLayout = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
