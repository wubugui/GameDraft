import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { IRulesDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

const PANEL_W_MAX = 600;
const PADDING = 20;
const SECTION_GAP = 14;
const ITEM_GAP = 4;

const VERIFIED_COLORS: Record<string, number> = {
  unverified: UITheme.colors.ruleUnverified,
  effective: UITheme.colors.ruleEffective,
  questionable: UITheme.colors.ruleQuestionable,
};

export class RulesPanelUI {
  private renderer: Renderer;
  private rulesData: IRulesDataProvider;
  private strings: StringsProvider;
  private container: Container | null = null;
  private _isOpen: boolean = false;
  private expandedRules: Set<string> = new Set();
  private scrollOffset = 0;
  private contentH = 0;
  private content: Container | null = null;
  private panelInnerH = 0;
  private onWheelBound: (e: WheelEvent) => void;
  private onScrollKeyBound: (e: KeyboardEvent) => void;

  constructor(renderer: Renderer, rulesData: IRulesDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.rulesData = rulesData;
    this.strings = strings;
    this.onWheelBound = this.onWheel.bind(this);
    this.onScrollKeyBound = this.onScrollKey.bind(this);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.scrollOffset = 0;
    this.build();
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
    window.addEventListener('keydown', this.onScrollKeyBound);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('wheel', this.onWheelBound);
    window.removeEventListener('keydown', this.onScrollKeyBound);
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private rebuild(): void {
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
    this.build();
  }

  private build(): void {
    this.container = new Container();
    const content = new Container();

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = Math.min(PANEL_W_MAX, sw - 40);
    const wrapWidth = panelW - PADDING * 2 - 20;

    let cy = 0;

    const addSectionLabel = (text: string) => {
      const label = new Text({
        text,
        style: { fontSize: 13, fill: UITheme.colors.section, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 540 },
      });
      label.x = 0;
      label.y = cy;
      content.addChild(label);
      cy += 22;
    };

    const addEmpty = (text: string) => {
      const t = new Text({
        text,
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 540 },
      });
      t.x = 10;
      t.y = cy;
      content.addChild(t);
      cy += 20;
    };

    const acquiredRules = this.rulesData.getAcquiredRules();
    const discoveredRules = this.rulesData.getDiscoveredRules();

    if (acquiredRules.length === 0 && discoveredRules.length === 0) {
      addEmpty(this.strings.get('rulesPanel', 'empty'));
    } else {
      // ---- Area 1: Completed rules ----
      if (acquiredRules.length > 0) {
        addSectionLabel(this.strings.get('rulesPanel', 'mastered'));

        const categories = ['ward', 'taboo', 'jargon', 'streetwise'] as const;
        for (const cat of categories) {
          const rulesInCat = acquiredRules.filter(r => r.def.category === cat);
          if (rulesInCat.length === 0) continue;

          const catName = this.rulesData.getCategoryName(cat);
          addSectionLabel(`-- ${catName} --`);

          for (const r of rulesInCat) {
            const vLabel = this.rulesData.getVerifiedLabel(r.def.verified);
            const vColor = VERIFIED_COLORS[r.def.verified] ?? VERIFIED_COLORS.unverified;

            const nameText = new Text({
              text: `${r.def.name}`,
              style: { fontSize: 13, fill: UITheme.colors.ruleName, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, wordWrapWidth: 520 },
            });
            nameText.x = 10;
            nameText.y = cy;
            content.addChild(nameText);

            const tagText = new Text({
              text: `[${vLabel}]`,
              style: { fontSize: 11, fill: vColor, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 200 },
            });
            tagText.x = 10 + nameText.width + 8;
            tagText.y = cy + 1;
            content.addChild(tagText);
            cy += 20;

            if (r.def.description) {
              const descText = new Text({
                text: r.def.description,
                style: { fontSize: 11, fill: UITheme.colors.ruleDesc, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: wrapWidth },
              });
              descText.x = 10;
              descText.y = cy;
              content.addChild(descText);
              cy += descText.height + ITEM_GAP;
            }

            if (r.def.source) {
              const srcText = new Text({
                text: `${this.strings.get('rulesPanel', 'source')} ${r.def.source}`,
                style: { fontSize: 10, fill: UITheme.colors.ruleSource, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 520 },
              });
              srcText.x = 10;
              srcText.y = cy;
              content.addChild(srcText);
              cy += 16;
            }

            const progress = this.rulesData.getFragmentProgress(r.def.id);
            if (progress.total > 0) {
              const progText = new Text({
                text: `${this.strings.get('rulesPanel', 'fragments')} ${progress.collected}/${progress.total}`,
                style: { fontSize: 10, fill: UITheme.colors.ruleProgress, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 520 },
              });
              progText.x = 10;
              progText.y = cy;
              content.addChild(progText);
              cy += 16;
            }

            cy += ITEM_GAP;
          }
          cy += SECTION_GAP / 2;
        }
        cy += SECTION_GAP;
      }

      // ---- Area 2: Discovering (incomplete) rules ----
      if (discoveredRules.length > 0) {
        addSectionLabel(this.strings.get('rulesPanel', 'collecting'));

        for (const entry of discoveredRules) {
          const displayName = entry.def.incompleteName ?? this.strings.get('rulesPanel', 'unknown');
          const isExpanded = this.expandedRules.has(entry.def.id);
          const arrow = isExpanded ? '▼' : '▶';

          const hitArea = new Container();
          hitArea.eventMode = 'static';
          hitArea.cursor = 'pointer';

          const nameText = new Text({
            text: `${arrow} ${displayName}`,
            style: { fontSize: 13, fill: UITheme.colors.ruleCollecting, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, wordWrapWidth: 520 },
          });
          nameText.x = 10;
          nameText.y = cy;
          hitArea.addChild(nameText);

          const progressLabel = new Text({
            text: `(${entry.collected}/${entry.total})`,
            style: { fontSize: 12, fill: UITheme.colors.ruleProgress, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 200 },
          });
          progressLabel.x = 10 + nameText.width + 8;
          progressLabel.y = cy + 1;
          hitArea.addChild(progressLabel);

          const ruleId = entry.def.id;
          hitArea.on('pointerdown', () => {
            if (this.expandedRules.has(ruleId)) {
              this.expandedRules.delete(ruleId);
            } else {
              this.expandedRules.add(ruleId);
            }
            this.rebuild();
          });

          content.addChild(hitArea);
          cy += 20;

          // Progress bar
          const barW = 140;
          const barH = 6;
          const barBg = new Graphics();
          barBg.roundRect(10, cy, barW, barH, 3);
          barBg.fill({ color: UITheme.colors.progressBg });
          content.addChild(barBg);

          if (entry.total > 0) {
            const fillW = Math.max(4, (entry.collected / entry.total) * barW);
            const barFill = new Graphics();
            barFill.roundRect(10, cy, fillW, barH, 3);
            barFill.fill({ color: UITheme.colors.progressFill });
            content.addChild(barFill);
          }
          cy += barH + 8;

          if (isExpanded) {
            const allFragProgress = this.rulesData.getFragmentProgress(entry.def.id);
            for (const frag of allFragProgress.fragments) {
              const isCollected = this.rulesData.hasFragment(frag.id);
              if (isCollected) {
                const fragText = new Text({
                  text: `"${frag.text}"`,
                  style: { fontSize: 11, fill: UITheme.colors.ruleDesc, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: wrapWidth - 20 },
                });
                fragText.x = 20;
                fragText.y = cy;
                content.addChild(fragText);
                cy += fragText.height + 2;

                if (frag.source) {
                  const srcText = new Text({
                    text: `-- ${frag.source}`,
                    style: { fontSize: 10, fill: UITheme.colors.ruleSource, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 520 },
                  });
                  srcText.x = 24;
                  srcText.y = cy;
                  content.addChild(srcText);
                  cy += 14;
                }
              } else {
                const unknownText = new Text({
                  text: this.strings.get('rulesPanel', 'hidden'),
                  style: { fontSize: 11, fill: UITheme.colors.disabledDark, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 520 },
                });
                unknownText.x = 20;
                unknownText.y = cy;
                content.addChild(unknownText);
                cy += 16;
              }
              cy += 2;
            }
          }

          cy += ITEM_GAP;
        }
      }
    }

    this.contentH = cy;
    const panelH = Math.min(this.contentH + 80, sh - 40);
    this.panelInnerH = panelH - 80;
    const maxScroll = Math.max(0, this.contentH - this.panelInnerH);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const px = (sw - panelW) / 2;
    const py = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, UITheme.panel.borderRadius);
    panel.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    panel.roundRect(px, py, panelW, panelH, UITheme.panel.borderRadius);
    panel.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: this.strings.get('rulesPanel', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, wordWrapWidth: 560 },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    content.x = px + PADDING;
    content.y = py + 46 - this.scrollOffset;

    const contentMask = new Graphics();
    contentMask.rect(px + PADDING, py + 46, panelW - PADDING * 2, panelH - 80);
    contentMask.fill({ color: 0xffffff });
    this.container.addChild(contentMask);
    content.mask = contentMask;

    this.container.addChild(content);
    this.content = content;

    const hint = new Text({
      text: this.strings.get('rulesPanel', 'closeHint'),
      style: { fontSize: 11, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 540 },
    });
    hint.x = px + panelW - 70;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const maxScroll = Math.max(0, this.contentH - this.panelInnerH);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + (e.deltaY > 0 ? 30 : -30)));
    if (this.content) {
      const sh = this.renderer.screenHeight;
      const panelH = Math.min(this.contentH + 80, sh - 40);
      const py = (sh - panelH) / 2;
      this.content.y = py + 46 - this.scrollOffset;
    }
  }

  private onScrollKey(e: KeyboardEvent): void {
    if (e.code === 'ArrowUp') { this.scrollOffset = Math.max(0, this.scrollOffset - 30); }
    else if (e.code === 'ArrowDown') {
      const maxScroll = Math.max(0, this.contentH - this.panelInnerH);
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 30);
    } else return;
    if (this.content) {
      const sh = this.renderer.screenHeight;
      const panelH = Math.min(this.contentH + 80, sh - 40);
      const py = (sh - panelH) / 2;
      this.content.y = py + 46 - this.scrollOffset;
    }
  }

  destroy(): void {
    if (this._isOpen) {
      window.removeEventListener('wheel', this.onWheelBound);
      window.removeEventListener('keydown', this.onScrollKeyBound);
    }
    this.close();
  }
}
