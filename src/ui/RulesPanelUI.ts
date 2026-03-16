import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { IRulesDataProvider } from '../data/types';

const PANEL_W_MAX = 600;
const PADDING = 20;
const SECTION_GAP = 14;
const ITEM_GAP = 4;

const VERIFIED_COLORS: Record<string, number> = {
  unverified: 0xccaa44,
  effective: 0x66cc66,
  questionable: 0xcc6644,
};

export class RulesPanelUI {
  private renderer: Renderer;
  private rulesData: IRulesDataProvider;
  private container: Container | null = null;
  private _isOpen: boolean = false;
  private expandedRules: Set<string> = new Set();

  constructor(renderer: Renderer, rulesData: IRulesDataProvider) {
    this.renderer = renderer;
    this.rulesData = rulesData;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
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
        style: { fontSize: 13, fill: 0x888899, fontFamily: 'sans-serif' },
      });
      label.x = 0;
      label.y = cy;
      content.addChild(label);
      cy += 22;
    };

    const addEmpty = (text: string) => {
      const t = new Text({
        text,
        style: { fontSize: 12, fill: 0x555566, fontFamily: 'sans-serif' },
      });
      t.x = 10;
      t.y = cy;
      content.addChild(t);
      cy += 20;
    };

    const acquiredRules = this.rulesData.getAcquiredRules();
    const discoveredRules = this.rulesData.getDiscoveredRules();

    if (acquiredRules.length === 0 && discoveredRules.length === 0) {
      addEmpty('(尚未习得任何规矩)');
    } else {
      // ---- Area 1: Completed rules ----
      if (acquiredRules.length > 0) {
        addSectionLabel('== 已掌握 ==');

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
              style: { fontSize: 13, fill: 0xddccaa, fontFamily: 'sans-serif', fontWeight: 'bold' },
            });
            nameText.x = 10;
            nameText.y = cy;
            content.addChild(nameText);

            const tagText = new Text({
              text: `[${vLabel}]`,
              style: { fontSize: 11, fill: vColor, fontFamily: 'sans-serif' },
            });
            tagText.x = 10 + nameText.width + 8;
            tagText.y = cy + 1;
            content.addChild(tagText);
            cy += 20;

            if (r.def.description) {
              const descText = new Text({
                text: r.def.description,
                style: { fontSize: 11, fill: 0x999988, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: wrapWidth },
              });
              descText.x = 10;
              descText.y = cy;
              content.addChild(descText);
              cy += descText.height + ITEM_GAP;
            }

            if (r.def.source) {
              const srcText = new Text({
                text: `来源: ${r.def.source}`,
                style: { fontSize: 10, fill: 0x777766, fontFamily: 'sans-serif' },
              });
              srcText.x = 10;
              srcText.y = cy;
              content.addChild(srcText);
              cy += 16;
            }

            const progress = this.rulesData.getFragmentProgress(r.def.id);
            if (progress.total > 0) {
              const progText = new Text({
                text: `碎片: ${progress.collected}/${progress.total}`,
                style: { fontSize: 10, fill: 0x888877, fontFamily: 'sans-serif' },
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
        addSectionLabel('== 搜集中 ==');

        for (const entry of discoveredRules) {
          const displayName = entry.def.incompleteName ?? '未知规矩';
          const isExpanded = this.expandedRules.has(entry.def.id);
          const arrow = isExpanded ? '▼' : '▶';

          const hitArea = new Container();
          hitArea.eventMode = 'static';
          hitArea.cursor = 'pointer';

          const nameText = new Text({
            text: `${arrow} ${displayName}`,
            style: { fontSize: 13, fill: 0xbbaa77, fontFamily: 'sans-serif', fontWeight: 'bold' },
          });
          nameText.x = 10;
          nameText.y = cy;
          hitArea.addChild(nameText);

          const progressLabel = new Text({
            text: `(${entry.collected}/${entry.total})`,
            style: { fontSize: 12, fill: 0x888877, fontFamily: 'sans-serif' },
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
          barBg.fill({ color: 0x333333 });
          content.addChild(barBg);

          if (entry.total > 0) {
            const fillW = Math.max(4, (entry.collected / entry.total) * barW);
            const barFill = new Graphics();
            barFill.roundRect(10, cy, fillW, barH, 3);
            barFill.fill({ color: 0xccaa44 });
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
                  style: { fontSize: 11, fill: 0x999988, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: wrapWidth - 20 },
                });
                fragText.x = 20;
                fragText.y = cy;
                content.addChild(fragText);
                cy += fragText.height + 2;

                if (frag.source) {
                  const srcText = new Text({
                    text: `-- ${frag.source}`,
                    style: { fontSize: 10, fill: 0x777766, fontFamily: 'sans-serif' },
                  });
                  srcText.x = 24;
                  srcText.y = cy;
                  content.addChild(srcText);
                  cy += 14;
                }
              } else {
                const unknownText = new Text({
                  text: '???',
                  style: { fontSize: 11, fill: 0x555555, fontFamily: 'sans-serif' },
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

    const contentH = cy;
    const panelH = Math.min(contentH + 80, sh - 40);
    const px = (sw - panelW) / 2;
    const py = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.5 });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.fill({ color: 0x111122, alpha: 0.95 });
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: '规矩本',
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    content.x = px + PADDING;
    content.y = py + 46;

    const contentMask = new Graphics();
    contentMask.rect(px + PADDING, py + 46, panelW - PADDING * 2, panelH - 80);
    contentMask.fill({ color: 0xffffff });
    this.container.addChild(contentMask);
    content.mask = contentMask;

    this.container.addChild(content);

    const hint = new Text({
      text: '按 R 关闭',
      style: { fontSize: 11, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + panelW - 70;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
  }

  destroy(): void {
    this.close();
  }
}
