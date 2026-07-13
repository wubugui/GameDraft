import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { Renderer } from '../../rendering/Renderer';
import { MinigameActionPlaybackGate } from '../minigameSession';
import { fillToken, fillTemplate } from '../../utils/fillTemplate';
import { drawPanelBase, SKINS } from '../../ui/PanelSkin';
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
  private destroyed = false;
  private orderIndex = 0;
  private finishing = false;
  private paletteContentH = 410;
  /** 交活结算 Action 批播放通道：锁输入 + 批后恢复 Minigame 状态（B13，公共实现见 minigameSession）。 */
  private readonly actionGate: MinigameActionPlaybackGate;

  constructor(
    renderer: Renderer,
    assetManager: AssetManager,
    actionExecutor: ActionExecutor,
    resolveText: (s: string) => string,
    onResult: (result: PaperCraftResult) => void,
    onClose: () => void,
    restoreMinigameStateAfterAction?: () => void,
  ) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.actionExecutor = actionExecutor;
    this.resolveText = resolveText;
    this.onResult = onResult;
    this.onClose = onClose;

    this.actionGate = new MinigameActionPlaybackGate(
      (acts) => this.actionExecutor.executeBatchAwait(acts),
      {
        onLockChanged: (locked) => this.setInputLocked(locked),
        restoreMinigameState: restoreMinigameStateAfterAction,
      },
    );

    this.root = new Container();
    this.root.eventMode = 'static';
    this.root.hitArea = new Rectangle(0, 0, renderer.screenWidth, renderer.screenHeight);
    this.root.addChild(this.bg, this.workLayer, this.paletteLayer, this.uiLayer);
    this.uiLayer.addChild(this.feedback);
    this.unsubResize = this.renderer.subscribeAfterResize(() => this.onResize());
  }

  /** Manager 侧 Esc 在动作播放期间让路（与转盘一致）。 */
  isActionsPlaybackLocked(): boolean {
    return this.actionGate.locked;
  }

  /** Visual-parity evidence; event-driven state only, with no wall-clock values. */
  getDebugVisualState(): Record<string, unknown> {
    return {
      instanceId: this.instance?.id ?? '',
      orderId: this.order?.id ?? '',
      orderIndex: this.orderIndex,
      selectedPartId: this.selectedPart?.id ?? '',
      selectedPaperId: this.selectedPaper?.id ?? '',
      selectedFinishId: this.selectedFinish?.id ?? '',
      placed: Object.fromEntries([...this.placed].map(([slotId, part]) => [slotId, part.id])),
      feedbackText: this.feedback.text,
      actionsPlaybackLocked: this.isActionsPlaybackLocked(),
      finishing: this.finishing,
    };
  }

  /** 动作播放期间整棵场景树不接输入（eventMode 'none' 对子树同样生效）。 */
  private setInputLocked(locked: boolean): void {
    this.root.eventMode = locked ? 'none' : 'static';
  }

  async load(instance: PaperCraftInstance): Promise<void> {
    this.instance = instance;
    if (!instance.orders || instance.orders.length === 0) {
      throw new Error('paperCraft: instance has no orders');
    }
    // 纸色 / 收尾选项携带分值与忌讳 tag，是游戏规则数值——必须由数据声明，
    // 缺失按坏数据报错（由 Manager 捕获并拆场），不做代码内静默兜底。
    for (const order of instance.orders) {
      if (!order.paperOptions || order.paperOptions.length === 0) {
        throw new Error(`paperCraft: order "${order.id}" 缺少 paperOptions（纸色选项须由数据声明）`);
      }
      if (!order.finishOptions || order.finishOptions.length === 0) {
        throw new Error(`paperCraft: order "${order.id}" 缺少 finishOptions（收尾选项须由数据声明）`);
      }
    }
    if (instance.backgroundImage) {
      try {
        this.backgroundSprite = new Sprite(await this.assetManager.loadTexture(instance.backgroundImage));
        this.root.addChildAt(this.backgroundSprite, 1);
      } catch {
        this.backgroundSprite = null;
      }
    }
    await this.enterOrder(0);
  }

  /** 进入第 index 张订单：重置选择与已放部件，载入该订单部件贴图并重建界面。 */
  private async enterOrder(index: number): Promise<void> {
    this.orderIndex = index;
    this.order = this.instance.orders[index];
    this.placed.clear();
    this.selectedPart = null;
    const paperOptions = this.getPaperOptions();
    const finishOptions = this.getFinishOptions();
    this.selectedPaper = paperOptions[0] ?? null;
    this.selectedFinish = finishOptions[0] ?? null;
    await this.loadTextures();
    // 贴图 await 期间可能已 Esc 拆场 / 销毁：不再对已销毁的容器 rebuild
    if (this.closing || this.destroyed) return;
    this.rebuild();
  }

  update(_dt: number): void {
    /* Interaction is event driven. */
  }

  /** 窗口尺寸变化：重建界面，使绝对定位的顶栏/纸色/收尾按钮一并跟随重排（修复 resize 后按钮错位）。 */
  private onResize(): void {
    if (this.order) this.rebuild();
    else this.layout();
  }

  abort(): void {
    if (this.closing) return;
    this.closing = true;
    this.onClose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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

    // 顶部留给纸色/收尾/交活·退出工具条，底部留给提示行；中间是内容区。
    const topStrip = 80;
    const bottomStrip = 46;
    const margin = 24;
    const gap = 24;
    const maxScale = 1.4;
    const regionH = Math.max(160, sh - topStrip - bottomStrip);
    const innerW = Math.max(240, sw - margin * 2 - gap);

    // 工作台占主宽、调色板占右侧窄列；两者各自按"统一缩放"(等比不拉伸)适配，再整体居中。
    const paletteRegionW = Math.min(innerW * 0.34, 250 * maxScale);
    const workRegionW = innerW - paletteRegionW;
    const workScale = Math.min(workRegionW / 560, regionH / 410, maxScale);
    const palScale = Math.min(paletteRegionW / 250, regionH / this.paletteContentH, maxScale);

    const workW = 560 * workScale;
    const workH = 410 * workScale;
    const palW = 250 * palScale;
    const palH = this.paletteContentH * palScale;

    const totalW = workW + gap + palW;
    const startX = Math.max(margin, (sw - totalW) / 2);
    const midY = topStrip + regionH / 2;

    this.workLayer.scale.set(workScale);
    this.workLayer.position.set(startX, midY - workH / 2);
    this.paletteLayer.scale.set(palScale);
    this.paletteLayer.position.set(startX + workW + gap, midY - palH / 2);
    this.feedback.position.set(margin, sh - 30);
  }

  private buildSlots(): void {
    const table = new Graphics();
    drawPanelBase(table, 0, 0, 560, 410, SKINS.panel);
    this.workLayer.addChild(table);

    const title = new Text({
      text: this.resolveText(this.order.title),
      style: { fontFamily: 'sans-serif', fontSize: 20, fill: 0xf8e7c0, fontWeight: '700' },
    });
    title.position.set(18, 12);
    this.workLayer.addChild(title);

    const desc = new Text({
      text: this.resolveText(this.order.description ?? '[tag:string:paperCraft:orderDescDefault]'),
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
    drawPanelBase(g, 0, 0, slot.width, slot.height, SKINS.row, { border: slot.optional ? 0x806744 : 0xc4a35a });
    wrap.addChild(g);

    const placed = this.placed.get(slot.id);
    if (placed) {
      const art = this.makePartVisual(placed, Math.min(slot.width * 0.84, 88), Math.min(slot.height * 0.78, 96));
      art.position.set(slot.width / 2, slot.height / 2 + 6);
      wrap.addChild(art);
    }

    const t = new Text({
      text: `${slot.label}${slot.optional ? this.resolveText('[tag:string:paperCraft:slotOptionalSuffix]') : ''}`,
      style: { fontFamily: 'sans-serif', fontSize: 11, fill: 0xf1d99c },
    });
    t.anchor.set(0.5, 0);
    t.position.set(slot.width / 2, 5);
    wrap.addChild(t);

    wrap.on('pointertap', () => {
      if (!this.selectedPart) {
        // 空手点击已放置的槽位 = 取下该部件，便于反复试摆 / 清空可选槽。
        if (this.placed.has(slot.id)) {
          this.placed.delete(slot.id);
          this.rebuild();
        }
        return;
      }
      if (!slot.accepts.includes(this.selectedPart.id)) {
        this.feedback.text = this.slotRejectsText(slot.label, this.selectedPart.label);
        return;
      }
      this.placed.set(slot.id, this.selectedPart);
      this.selectedPart = null;
      this.rebuild();
    });
    return wrap;
  }

  private buildPalette(): void {
    const cols = 2;
    const rows = Math.max(1, Math.ceil(this.order.parts.length / cols));
    // 背板高度随部件数自适应，避免部件溢出固定高度的面板（此前 15 个部件会漏到面板外）。
    const bgH = 46 + rows * 74 + 10;
    this.paletteContentH = bgH;

    const bg = new Graphics();
    drawPanelBase(bg, 0, 0, 250, bgH, SKINS.panelAlt);
    this.paletteLayer.addChild(bg);

    const title = new Text({
      text: this.resolveText('[tag:string:paperCraft:paletteTitle]'),
      style: { fontFamily: 'sans-serif', fontSize: 17, fill: 0xf8e7c0, fontWeight: '700' },
    });
    title.position.set(14, 12);
    this.paletteLayer.addChild(title);

    this.order.parts.forEach((part, i) => {
      const x = 14 + (i % cols) * 112;
      const y = 46 + Math.floor(i / cols) * 74;
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
      // 放好后清空选择，使"空手点已放槽位即取下"的手势一致可用。
      this.selectedPart = null;
    } else if (slot) {
      this.feedback.text = this.slotRejectsText(slot.label, this.drag.part.label);
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
      text: this.resolveText('[tag:string:paperCraft:paperTitle]'),
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
      text: this.resolveText(this.order.finishQuestion ?? '[tag:string:paperCraft:finishTitleDefault]'),
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
    const finish = this.makeSmallButton(this.resolveText('[tag:string:paperCraft:submit]'), 86, true, () => void this.finish());
    finish.position.set(this.renderer.screenWidth - 190, 18);
    this.uiLayer.addChild(finish);
    const close = this.makeSmallButton(this.resolveText('[tag:string:paperCraft:exit]'), 74, false, () => this.abort());
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
    if (this.finishing) return;
    const missing = this.order.slots.filter((slot) => !slot.optional && !this.placed.has(slot.id));
    if (missing.length > 0) {
      this.feedback.text = fillToken(
        this.resolveText('[tag:string:paperCraft:missingParts]'),
        '{parts}',
        missing.map((s) => s.label).join('、'),
      );
      return;
    }
    // finishing 贯穿"交活→动作→载入下一张→重建"全程，finally 复位：
    // 结算动作抛错不再永久废掉「交活」按钮，同时保留对重入竞态的防护。
    this.finishing = true;
    try {
      const result = this.calculateResult();
      this.onResult(result);
      const actions =
        result.level === 'success'
          ? this.order.onSuccessActions
          : result.level === 'warn'
            ? this.order.onWarnActions
            : this.order.onBadActions;
      try {
        // 经播放通道执行：动作期间锁小游戏输入，批结束后恢复 Minigame 状态（B13）
        await this.actionGate.run(actions);
      } catch (e) {
        console.warn('paperCraft: 交活结算动作执行失败', e);
      }
      if (this.closing || this.destroyed) return;
      if (this.orderIndex < this.instance.orders.length - 1) {
        await this.enterOrder(this.orderIndex + 1);
      } else {
        this.abort();
      }
    } finally {
      this.finishing = false;
    }
  }

  private calculateResult(): PaperCraftResult {
    const tags = new Set<string>();
    let score = 0;
    const paper = this.selectedPaper;
    const finish = this.selectedFinish;
    if (paper) {
      score += paper.score ?? 0;
      // correctPaper 作为叠加奖惩：选对纸 +12，选错 -6。仅在订单声明了正确纸色时生效，
      // 因此即便每种纸都填了显式 score，"正确纸色"仍有实际作用（不再是死字段）。
      if (this.order.correctPaper) {
        score += paper.id === this.order.correctPaper ? 12 : -6;
      }
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

  private slotRejectsText(slotLabel: string, partLabel: string): string {
    return fillTemplate(this.resolveText('[tag:string:paperCraft:slotRejects]'), {
      '{slot}': slotLabel,
      '{part}': partLabel,
    });
  }

  private updateFeedback(): void {
    // 不再实时回显分数/档位/忌讳标签——那会把"是否懂规矩忌讳"的考查降成照着提示反复试。
    // 改为常驻显示该订单的目标提示（targetHint），多订单时附带进度。成败反馈交给交活后的动作。
    const total = this.instance.orders.length;
    const progress = total > 1
      ? fillTemplate(this.resolveText('[tag:string:paperCraft:progressPrefix]'), {
          '{i}': String(this.orderIndex + 1),
          '{n}': String(total),
        })
      : '';
    const hint = this.order.targetHint?.trim()
      ? this.resolveText(this.order.targetHint)
      : this.resolveText('[tag:string:paperCraft:targetHintDefault]');
    this.feedback.text = `${progress}${hint}`;
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

  // 纸色 / 收尾选项是携带分值与忌讳 tag 的规则数值，一律来自订单数据；
  // 缺失在 load() 即报错，这里不再保留代码内兜底默认。
  private getPaperOptions(): PaperCraftPaperOption[] {
    return this.order.paperOptions ?? [];
  }

  private getFinishOptions(): PaperCraftFinishOption[] {
    return this.order.finishOptions ?? [];
  }

  private parseColor(raw: string, fallback: number): number {
    const s = String(raw ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(s)) return Number.parseInt(s, 16);
    return fallback;
  }
}
