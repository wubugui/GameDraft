import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { Renderer } from '../../rendering/Renderer';
import type {
  PaperCraftFinishOption,
  PaperCraftInstance,
  PaperCraftOrderDef,
  PaperCraftPaperOption,
  PaperCraftPartDef,
  PaperCraftResult,
  PaperCraftSlotDef,
} from './types';
import {
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from 'pixi.js';

const DEFAULT_PART_IMAGE_ROOT = '/resources/runtime/images/minigames/paper_craft/parts/';

type DragState = {
  part: PaperCraftPartDef;
  sprite: Container;
  dx: number;
  dy: number;
};

export class PaperCraftMinigameScene {
  readonly root: Container;
  private readonly renderer: Renderer;
  private readonly assetManager: AssetManager;
  private readonly actionExecutor: ActionExecutor;
  private readonly resolveText: (s: string) => string;
  private readonly onResult: (result: PaperCraftResult) => void;
  private readonly onClose: () => void;

  private instance!: PaperCraftInstance;
  private order!: PaperCraftOrderDef;
  private bg = new Graphics();
  private backgroundSprite: Sprite | null = null;
  private uiLayer = new Container();
  private workLayer = new Container();
  private paletteLayer = new Container();
  private feedback = new Text({
    text: '',
    style: { fontFamily: 'sans-serif', fontSize: 15, fill: 0xf8fafc, wordWrap: true, wordWrapWidth: 420 },
  });
  private selectedPart: PaperCraftPartDef | null = null;
  private selectedPaper: PaperCraftPaperOption | null = null;
  private selectedFinish: PaperCraftFinishOption | null = null;
  private placed = new Map<string, PaperCraftPartDef>();
  private textures = new Map<string, Texture>();
  private drag: DragState | null = null;
  private unsubResize: (() => void) | null = null;
  private closing = false;

  constructor(
    renderer: Renderer,
    assetManager: AssetManager,
    actionExecutor: ActionExecutor,
    resolveText: (s: string) => string,
    onResult: (result: PaperCraftResult) => void,
    onClose: () => void,
  ) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.actionExecutor = actionExecutor;
    this.resolveText = resolveText;
    this.onResult = onResult;
    this.onClose = onClose;

    this.root = new Container();
    this.root.eventMode = 'static';
    this.root.hitArea = new Rectangle(0, 0, renderer.screenWidth, renderer.screenHeight);
    this.root.addChild(this.bg, this.workLayer, this.paletteLayer, this.uiLayer);
    this.uiLayer.addChild(this.feedback);
    this.unsubResize = this.renderer.subscribeAfterResize(() => this.layout());
  }

  async load(instance: PaperCraftInstance): Promise<void> {
    this.instance = instance;
    this.order = instance.orders[0];
    const paperOptions = this.getPaperOptions();
    const finishOptions = this.getFinishOptions();
    this.selectedPaper = paperOptions[0] ?? null;
    this.selectedFinish = finishOptions[0] ?? null;

    await this.loadTextures();
    if (instance.backgroundImage) {
      try {
        this.backgroundSprite = new Sprite(await this.assetManager.loadTexture(instance.backgroundImage));
        this.root.addChildAt(this.backgroundSprite, 1);
      } catch {
        this.backgroundSprite = null;
      }
    }
    this.rebuild();
  }

  update(_dt: number): void {
    /* Interaction is event driven. */
  }

  abort(): void {
    if (this.closing) return;
    this.closing = true;
    this.onClose();
  }

  destroy(): void {
    this.unsubResize?.();
    this.unsubResize = null;
    this.root.destroy({ children: true });
  }

  private async loadTextures(): Promise<void> {
    await Promise.all(this.order.parts.map(async (part) => {
      const image = this.partImage(part);
      try {
        this.textures.set(part.id, await this.assetManager.loadTexture(image));
      } catch {
        /* fallback is drawn with Graphics */
      }
    }));
  }

  private rebuild(): void {
    this.workLayer.removeChildren();
    this.paletteLayer.removeChildren();
    this.uiLayer.removeChildren();
    this.uiLayer.addChild(this.feedback);
    this.buildSlots();
    this.buildPalette();
    this.buildPaperButtons();
    this.buildFinishButtons();
    this.buildTopChrome();
    this.updateFeedback();
    this.layout();
  }

  private layout(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    this.root.hitArea = new Rectangle(0, 0, sw, sh);
    this.bg.clear();
    this.bg.rect(0, 0, sw, sh);
    this.bg.fill({ color: 0x15100b, alpha: 0.94 });
    this.bg.rect(0, 0, sw, sh);
    this.bg.stroke({ color: 0x3b2c1f, width: 2 });

    if (this.backgroundSprite) {
      const tex = this.backgroundSprite.texture;
      const scale = Math.max(sw / tex.width, sh / tex.height);
      this.backgroundSprite.scale.set(scale);
      this.backgroundSprite.position.set((sw - tex.width * scale) / 2, (sh - tex.height * scale) / 2);
      this.backgroundSprite.alpha = 0.35;
    }

    const workW = Math.max(360, Math.min(620, sw - 340));
    const workH = Math.max(340, sh - 160);
    this.workLayer.position.set(28, 86);
    this.workLayer.scale.set(workW / 560, workH / 410);
    this.paletteLayer.position.set(Math.min(sw - 286, 28 + workW + 34), 86);
    this.feedback.position.set(28, sh - 48);
  }

  private buildSlots(): void {
    const table = new Graphics();
    table.roundRect(0, 0, 560, 410, 8);
    table.fill({ color: 0x2a2118, alpha: 0.92 });
    table.stroke({ color: 0x7c5f3a, width: 2 });
    this.workLayer.addChild(table);

    const title = new Text({
      text: this.resolveText(this.order.title),
      style: { fontFamily: 'sans-serif', fontSize: 20, fill: 0xf8e7c0, fontWeight: '700' },
    });
    title.position.set(18, 12);
    this.workLayer.addChild(title);

    const desc = new Text({
      text: this.resolveText(this.order.description ?? '按活计单子选纸、搭骨、糊面。部件可换，但分数和忌讳不一样。'),
      style: { fontFamily: 'sans-serif', fontSize: 12, fill: 0xd8c4a4, wordWrap: true, wordWrapWidth: 510 },
    });
    desc.position.set(18, 43);
    this.workLayer.addChild(desc);

    for (const slot of this.order.slots) {
      this.workLayer.addChild(this.makeSlot(slot));
    }
  }

  private makeSlot(slot: PaperCraftSlotDef): Container {
    const wrap = new Container();
    wrap.position.set(slot.x, slot.y);
    wrap.eventMode = 'static';
    wrap.cursor = 'pointer';
    wrap.hitArea = new Rectangle(0, 0, slot.width, slot.height);

    const g = new Graphics();
    g.roundRect(0, 0, slot.width, slot.height, 6);
    g.fill({ color: 0x0f172a, alpha: 0.34 });
    g.stroke({ color: slot.optional ? 0x806744 : 0xc4a35a, width: 2 });
    wrap.addChild(g);

    const placed = this.placed.get(slot.id);
    if (placed) {
      const art = this.makePartVisual(placed, Math.min(slot.width * 0.84, 88), Math.min(slot.height * 0.78, 96));
      art.position.set(slot.width / 2, slot.height / 2 + 6);
      wrap.addChild(art);
    }

    const t = new Text({
      text: `${slot.label}${slot.optional ? '（可空）' : ''}`,
      style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xf1d99c },
    });
    t.anchor.set(0.5, 0);
    t.position.set(slot.width / 2, 5);
    wrap.addChild(t);

    wrap.on('pointertap', () => {
      if (!this.selectedPart) return;
      if (!slot.accepts.includes(this.selectedPart.id)) {
        this.feedback.text = `${slot.label} 放不上 ${this.selectedPart.label}`;
        return;
      }
      this.placed.set(slot.id, this.selectedPart);
      this.selectedPart = null;
      this.rebuild();
    });
    return wrap;
  }

  private buildPalette(): void {
    const bg = new Graphics();
    bg.roundRect(0, 0, 250, 410, 8);
    bg.fill({ color: 0x211a13, alpha: 0.95 });
    bg.stroke({ color: 0x6f5634, width: 2 });
    this.paletteLayer.addChild(bg);

    const title = new Text({
      text: '纸扎部件',
      style: { fontFamily: 'sans-serif', fontSize: 17, fill: 0xf8e7c0, fontWeight: '700' },
    });
    title.position.set(14, 12);
    this.paletteLayer.addChild(title);

    this.order.parts.forEach((part, i) => {
      const x = 14 + (i % 2) * 112;
      const y = 46 + Math.floor(i / 2) * 74;
      const item = this.makePaletteItem(part);
      item.position.set(x, y);
      this.paletteLayer.addChild(item);
    });
  }

  private makePaletteItem(part: PaperCraftPartDef): Container {
    const wrap = new Container();
    wrap.eventMode = 'static';
    wrap.cursor = 'grab';
    wrap.hitArea = new Rectangle(0, 0, 100, 64);

    const bg = new Graphics();
    bg.roundRect(0, 0, 100, 64, 6);
    bg.fill({ color: this.selectedPart?.id === part.id ? 0x573b1b : 0x31251a, alpha: 0.98 });
    bg.stroke({ color: this.selectedPart?.id === part.id ? 0xffd166 : 0x765b38, width: 1.5 });
    wrap.addChild(bg);

    const art = this.makePartVisual(part, 44, 36);
    art.position.set(50, 24);
    wrap.addChild(art);
    const label = new Text({
      text: part.label,
      style: { fontFamily: 'sans-serif', fontSize: 10, fill: 0xf3dfba, wordWrap: true, wordWrapWidth: 90, align: 'center' },
    });
    label.anchor.set(0.5, 0);
    label.position.set(50, 43);
    wrap.addChild(label);

    wrap.on('pointertap', () => {
      this.selectedPart = part;
      this.rebuild();
    });
    wrap.on('pointerdown', (ev: FederatedPointerEvent) => {
      this.selectedPart = part;
      const p = ev.global;
      const sprite = this.makePartVisual(part, 72, 72);
      sprite.position.set(p.x, p.y);
      this.root.addChild(sprite);
      this.drag = { part, sprite, dx: 0, dy: 0 };
      this.root.on('pointermove', this.onDragMove, this);
      this.root.on('pointerup', this.onDragEnd, this);
      this.root.on('pointerupoutside', this.onDragEnd, this);
    });
    return wrap;
  }

  private onDragMove(ev: FederatedPointerEvent): void {
    if (!this.drag) return;
    this.drag.sprite.position.set(ev.global.x + this.drag.dx, ev.global.y + this.drag.dy);
  }

  private onDragEnd(ev: FederatedPointerEvent): void {
    if (!this.drag) return;
    const local = this.workLayer.toLocal(ev.global);
    const slot = this.order.slots.find((s) =>
      local.x >= s.x && local.x <= s.x + s.width && local.y >= s.y && local.y <= s.y + s.height,
    );
    if (slot && slot.accepts.includes(this.drag.part.id)) {
      this.placed.set(slot.id, this.drag.part);
    } else if (slot) {
      this.feedback.text = `${slot.label} 放不上 ${this.drag.part.label}`;
    }
    this.drag.sprite.destroy({ children: true });
    this.drag = null;
    this.root.off('pointermove', this.onDragMove, this);
    this.root.off('pointerup', this.onDragEnd, this);
    this.root.off('pointerupoutside', this.onDragEnd, this);
    this.rebuild();
  }

  private buildPaperButtons(): void {
    const opts = this.getPaperOptions();
    const title = new Text({
      text: '纸色',
      style: { fontFamily: 'sans-serif', fontSize: 13, fill: 0xe7d5b6, fontWeight: '700' },
    });
    title.position.set(28, 18);
    this.uiLayer.addChild(title);
    opts.forEach((opt, i) => {
      const b = this.makeSmallButton(opt.label, 72, opt.id === this.selectedPaper?.id, () => {
        this.selectedPaper = opt;
        this.rebuild();
      });
      b.position.set(78 + i * 82, 14);
      const swatch = new Graphics();
      swatch.circle(12, 13, 6);
      swatch.fill({ color: this.parseColor(opt.tint, 0xf4ecd8), alpha: 1 });
      b.addChild(swatch);
      this.uiLayer.addChild(b);
    });
  }

  private buildFinishButtons(): void {
    const opts = this.getFinishOptions();
    const title = new Text({
      text: this.resolveText(this.order.finishQuestion ?? '收口'),
      style: { fontFamily: 'sans-serif', fontSize: 13, fill: 0xe7d5b6, fontWeight: '700' },
    });
    title.position.set(28, 48);
    this.uiLayer.addChild(title);
    opts.forEach((opt, i) => {
      const b = this.makeSmallButton(opt.label, 108, opt.id === this.selectedFinish?.id, () => {
        this.selectedFinish = opt;
        this.rebuild();
      });
      b.position.set(108 + i * 120, 44);
      this.uiLayer.addChild(b);
    });
  }

  private buildTopChrome(): void {
    const finish = this.makeSmallButton('交活', 86, true, () => void this.finish());
    finish.position.set(this.renderer.screenWidth - 190, 18);
    this.uiLayer.addChild(finish);
    const close = this.makeSmallButton('退出', 74, false, () => this.abort());
    close.position.set(this.renderer.screenWidth - 94, 18);
    this.uiLayer.addChild(close);
  }

  private makeSmallButton(label: string, width: number, active: boolean, cb: () => void): Container {
    const wrap = new Container();
    wrap.eventMode = 'static';
    wrap.cursor = 'pointer';
    wrap.hitArea = new Rectangle(0, 0, width, 26);
    const g = new Graphics();
    g.roundRect(0, 0, width, 26, 6);
    g.fill({ color: active ? 0x805b24 : 0x2d241b, alpha: 0.98 });
    g.stroke({ color: active ? 0xffd166 : 0x6b5436, width: 1 });
    const t = new Text({
      text: label,
      style: { fontFamily: 'sans-serif', fontSize: 12, fill: 0xfff4d6 },
    });
    t.anchor.set(0.5);
    t.position.set(width / 2, 13);
    wrap.addChild(g, t);
    wrap.on('pointertap', cb);
    return wrap;
  }

  private async finish(): Promise<void> {
    const missing = this.order.slots.filter((slot) => !slot.optional && !this.placed.has(slot.id));
    if (missing.length > 0) {
      this.feedback.text = `还缺：${missing.map((s) => s.label).join('、')}`;
      return;
    }
    const result = this.calculateResult();
    this.onResult(result);
    const actions =
      result.level === 'success'
        ? this.order.onSuccessActions
        : result.level === 'warn'
          ? this.order.onWarnActions
          : this.order.onBadActions;
    if (actions?.length) {
      await this.actionExecutor.executeBatchAwait(actions);
    }
    this.abort();
  }

  private calculateResult(): PaperCraftResult {
    const tags = new Set<string>();
    let score = 0;
    const paper = this.selectedPaper;
    const finish = this.selectedFinish;
    if (paper) {
      score += paper.score ?? (paper.id === this.order.correctPaper ? 12 : -6);
      for (const t of paper.tags ?? []) tags.add(t);
    }
    if (finish) {
      score += finish.score ?? 0;
      for (const t of finish.tags ?? []) tags.add(t);
    }
    for (const part of this.placed.values()) {
      score += part.score ?? 0;
      for (const t of part.tags ?? []) tags.add(t);
    }
    const success = this.order.successScore ?? 76;
    const warn = this.order.warnScore ?? 50;
    const level: PaperCraftResult['level'] = score >= success ? 'success' : score >= warn ? 'warn' : 'bad';
    return {
      instanceId: this.instance.id,
      instanceLabel: this.instance.label,
      orderId: this.order.id,
      orderTitle: this.order.title,
      score,
      level,
      paperId: paper?.id ?? '',
      finishId: finish?.id ?? '',
      tags: [...tags],
      placed: [...this.placed.entries()].map(([slotId, part]) => ({
        slotId,
        partId: part.id,
        partLabel: part.label,
      })),
    };
  }

  private updateFeedback(): void {
    const result = this.calculateResult();
    const levelText = result.level === 'success' ? '像样' : result.level === 'warn' ? '能交但犯忌' : '不像活';
    this.feedback.text = `当前：${levelText} / ${result.score} 分${result.tags.length ? ` / ${result.tags.join('、')}` : ''}`;
  }

  private makePartVisual(part: PaperCraftPartDef, maxW: number, maxH: number): Container {
    const wrap = new Container();
    const tex = this.textures.get(part.id);
    if (tex) {
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      const scale = Math.min(maxW / tex.width, maxH / tex.height, 1);
      sprite.scale.set(scale);
      wrap.addChild(sprite);
      return wrap;
    }
    const g = new Graphics();
    g.roundRect(-maxW / 2, -maxH / 2, maxW, maxH, 8);
    g.fill({ color: 0xe9ddc3, alpha: 0.95 });
    g.stroke({ color: 0x5e4630, width: 2 });
    const t = new Text({
      text: part.label,
      style: { fontFamily: 'sans-serif', fontSize: 10, fill: 0x2b2118, wordWrap: true, wordWrapWidth: maxW - 8, align: 'center' },
    });
    t.anchor.set(0.5);
    wrap.addChild(g, t);
    return wrap;
  }

  private partImage(part: PaperCraftPartDef): string {
    if (part.image) return part.image;
    return `${DEFAULT_PART_IMAGE_ROOT}${part.id}.png`;
  }

  private getPaperOptions(): PaperCraftPaperOption[] {
    return this.order.paperOptions ?? [
      { id: 'white', label: '白纸', tint: '#f4ecd8', score: 10 },
      { id: 'yellow', label: '黄表', tint: '#d8a942', score: 4 },
      { id: 'blue', label: '青纸', tint: '#7ba4b8', score: -6, tags: ['纸色不合'] },
    ];
  }

  private getFinishOptions(): PaperCraftFinishOption[] {
    return this.order.finishOptions ?? [
      { id: 'paste_plain', label: '糨糊收口', score: 8 },
      { id: 'seal_mouth', label: '封口', score: 2, tags: ['封口犯忌'] },
      { id: 'paint_eye', label: '点眼', score: -18, tags: ['点眼犯忌'] },
    ];
  }

  private parseColor(raw: string, fallback: number): number {
    const s = String(raw ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(s)) return Number.parseInt(s, 16);
    return fallback;
  }
}
