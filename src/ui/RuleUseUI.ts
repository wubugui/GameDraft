import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { IZoneDataProvider, IRulesDataProvider, ZoneRuleSlot, ActionDef } from '../data/types';

interface ResolvedRuleSlot {
  slot: ZoneRuleSlot;
  ruleName: string;
  enabled: boolean;
  progressText?: string;
}

export class RuleUseUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private zoneData: IZoneDataProvider;
  private rulesData: IRulesDataProvider;

  private container: Container | null = null;
  private _isOpen: boolean = false;

  constructor(
    renderer: Renderer,
    eventBus: EventBus,
    zoneData: IZoneDataProvider,
    rulesData: IRulesDataProvider,
  ) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.zoneData = zoneData;
    this.rulesData = rulesData;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) return;
    const slots = this.resolveSlots();
    if (slots.length === 0) return;

    this._isOpen = true;
    this.build(slots);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.destroyUI();
  }

  private resolveSlots(): ResolvedRuleSlot[] {
    const rawSlots = this.zoneData.getCurrentRuleSlots();
    const result: ResolvedRuleSlot[] = [];

    for (const slot of rawSlots) {
      const ruleDef = this.rulesData.getRuleDef(slot.ruleId);
      if (!ruleDef) continue;

      if (this.rulesData.hasRule(slot.ruleId)) {
        result.push({ slot, ruleName: ruleDef.name, enabled: true });
      } else if (this.rulesData.isDiscovered(slot.ruleId)) {
        const progress = this.rulesData.getFragmentProgress(slot.ruleId);
        const displayName = ruleDef.incompleteName ?? '未知规矩';
        result.push({
          slot,
          ruleName: displayName,
          enabled: false,
          progressText: `${progress.collected}/${progress.total}`,
        });
      }
    }
    return result;
  }

  private build(slots: ResolvedRuleSlot[]): void {
    this.destroyUI();

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = 400;
    const rowH = 38;
    const padY = 12;
    const titleH = 36;
    const panelH = titleH + padY + slots.length * rowH + padY;
    const px = (sw - panelW) / 2;
    const py = (sh - panelH) / 2;

    this.container = new Container();

    const bg = new Graphics();
    bg.roundRect(px, py, panelW, panelH, 8);
    bg.fill({ color: 0x0e0e1a, alpha: 0.95 });
    bg.roundRect(px, py, panelW, panelH, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: '使用规矩',
      style: { fontSize: 16, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + (panelW - title.width) / 2;
    title.y = py + 10;
    this.container.addChild(title);

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const ry = py + titleH + padY + i * rowH;

      const rowBg = new Graphics();
      rowBg.roundRect(px + 10, ry, panelW - 20, rowH - 4, 4);
      rowBg.fill({ color: s.enabled ? 0x1a1a2e : 0x151520, alpha: 0.9 });
      rowBg.roundRect(px + 10, ry, panelW - 20, rowH - 4, 4);
      rowBg.stroke({ color: s.enabled ? 0x555577 : 0x333344, width: 1 });
      this.container.addChild(rowBg);

      let label = `${i + 1}. ${s.ruleName}`;
      if (s.progressText) label += ` (${s.progressText})`;

      const text = new Text({
        text: label,
        style: { fontSize: 14, fill: s.enabled ? 0xdddddd : 0x666666, fontFamily: 'sans-serif' },
      });
      text.x = px + 24;
      text.y = ry + 8;
      this.container.addChild(text);

      if (s.enabled) {
        const hoverBg = new Graphics();
        hoverBg.roundRect(px + 10, ry, panelW - 20, rowH - 4, 4);
        hoverBg.fill({ color: 0x2a2a4e, alpha: 0.9 });
        hoverBg.visible = false;
        this.container.addChildAt(hoverBg, this.container.children.indexOf(rowBg));

        rowBg.eventMode = 'static';
        rowBg.cursor = 'pointer';
        rowBg.on('pointerover', () => { hoverBg.visible = true; rowBg.visible = false; });
        rowBg.on('pointerout', () => { hoverBg.visible = false; rowBg.visible = true; });
        rowBg.on('pointerdown', () => { this.selectSlot(s); });
      }
    }

    const hint = new Text({
      text: '按 Esc 关闭',
      style: { fontSize: 11, fill: 0x777777, fontFamily: 'sans-serif' },
    });
    hint.x = px + (panelW - hint.width) / 2;
    hint.y = py + panelH - 18;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
  }

  private selectSlot(slot: ResolvedRuleSlot): void {
    this.close();
    this.eventBus.emit('ruleUse:apply', {
      ruleId: slot.slot.ruleId,
      actions: slot.slot.resultActions,
      resultText: slot.slot.resultText,
    });
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  destroy(): void {
    this.destroyUI();
  }
}
