import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { Renderer } from '../../rendering/Renderer';
import { MinigameActionPlaybackGate } from '../minigameSession';
import { fillToken, fillTemplate } from '../../utils/fillTemplate';
import { createPanel, drawPanelBase, SKINS, WOOD_CHIP } from '../../ui/PanelSkin';
import { UITheme } from '../../ui/UITheme';
import {
  createIconBadge,
  createKeyCap,
  createProgressBar,
  createTitleRow,
  drawSelectedRow,
} from '../../ui/components/UIDecor';
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
import { createStyledText, setStyledText } from '../../core/styledText';

const DEFAULT_PART_IMAGE_ROOT = '/resources/runtime/images/minigames/paper_craft/parts/';

/**
 * UI 外壳一律走全站视觉系统（做旧木框 + 纸纹底 + 内金细线 + 拉字距琥珀标题 + 琥珀选中）：
 * 颜色只取 `UITheme.colors`、字号只取七档、间距只取六档，面板底框只经 `PanelSkin`。
 *
 * **玩法画面不在此列**：纸色色片（白纸/黄表/青纸/红纸）与部件贴图缺位时的纸色替身
 * 是内容本身，仍按数据上色——那几处裸色号是刻意保留的。
 */

/** 屏边距 */
const M = UITheme.spacing.lg;

/**
 * 工作台设计空间。槽位坐标由订单数据声明在 **560×410** 这套坐标系里（**不可改**），
 * 但槽位实占的只是 x 141~484 / y 84~398 这一块——按 560 宽画面板，左边会空出
 * 一条一百多像素的黑带，整块看着像没做完。所以面板只贴着内容画：
 *   x 100~520（左右各留出木条 15 + 呼吸位），y 0~440（底下多留 30 给木框，
 *   不让就把最底下的「腿脚」槽压在框上）。
 */
const WORK_W = 560;
const WORK_H = 440;
const WORK_PANEL_X = 100;
const WORK_PANEL_W = 420;
/**
 * 槽位从 y=84 起，上面这一带原本空着，正好摆完成度条。
 * 8px 高的条在这块近黑台面上零进度时只剩一道污痕——抬到 10 才读得出"这是一条进度"。
 */
const WORK_BAR_Y = 44;
const WORK_BAR_H = 10;
const WORK_BAR_W = 200;

/** 部件盘：三列（此前两列，15 个部件排成 8 行，面板高得留不下木框） */
const PALETTE_COLS = 3;
const ITEM_W = 100;
const ITEM_H = 72;
const ITEM_PITCH_X = 112;
const ITEM_PITCH_Y = 82;
const PALETTE_PAD = 18;
const PALETTE_W = PALETTE_PAD * 2 + (PALETTE_COLS - 1) * ITEM_PITCH_X + ITEM_W;

/** 按钮高度：容得下 body(20) 的中文 + 上下呼吸位 */
const BTN_H = 34;
/** 提示条：高度、最大宽度、左端图标徽章半径 */
const HINT_H = 44;
const HINT_MAX_W = 760;
const HINT_BADGE_R = 14;
/** 纸色色片半径 */
const SWATCH_R = 7;

type DragState = {
  part: PaperCraftPartDef;
  sprite: Container;
  dx: number;
  dy: number;
};

/** 一枚选项按钮的展示描述（纸色带色片，收尾不带） */
interface OptionButtonSpec {
  label: string;
  tint?: string;
  active: boolean;
  pick: () => void;
}

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
  private feedback = createStyledText({
    text: '',
    style: {
      fontFamily: UITheme.fonts.ui,
      fontSize: UITheme.fontSize.body,
      fill: UITheme.colors.bodyMuted,
      wordWrap: true,
      wordWrapWidth: 640,
      align: 'center',
    },
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
  private paletteContentH = 441;
  /** 提示条左端徽章与条宽：`setFeedback` 改文字后要靠它们把「徽章 + 文字」重新居中。 */
  private hintBadge: Container | null = null;
  private hintBandW = 0;
  /** 顶部 chrome（标题/说明/提示条/选择条）与底栏之间那段留给工作台+部件盘 */
  private contentTop = 0;
  private contentBottom = 0;
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
      // 小游戏结算动作批的来源 = 该小游戏实例（`minigame` 是合法 wrapper owner 类型），
      // 批里开的对话即归属它的状态机。
      (acts) => this.actionExecutor.executeBatchFromOwner(acts, 'minigame', this.instance?.id),
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
    // 徽章随整棵树一起销毁，句柄同步清掉，免得留一个指向已销毁 Pixi 对象的引用。
    this.hintBadge = null;
    this.hintBandW = 0;
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
    // 底幕只铺色不描边：沿着视口四边画一圈线在全屏接管态里不表达任何东西，
    // 只在画面最底下留一道贴边的横杠（实拍抓到），是 debug 期的残留。
    this.bg.fill({ color: UITheme.colors.mainMenuBg, alpha: UITheme.alpha.panelBg });

    if (this.backgroundSprite) {
      const tex = this.backgroundSprite.texture;
      const scale = Math.max(sw / tex.width, sh / tex.height);
      this.backgroundSprite.scale.set(scale);
      this.backgroundSprite.position.set((sw - tex.width * scale) / 2, (sh - tex.height * scale) / 2);
      this.backgroundSprite.alpha = 0.35;
    }

    // 顶部 chrome 与底栏由 buildTopChrome 量出来，中间这段是内容区。
    const gap = UITheme.spacing.xl;
    const maxScale = 1.4;
    const top = this.contentTop > 0 ? this.contentTop : M;
    const bottom = this.contentBottom > top ? this.contentBottom : sh - M;
    const regionH = Math.max(160, bottom - top);
    const innerW = Math.max(240, sw - M * 2 - gap);

    // 两块面板各自"统一缩放"(等比不拉伸)：先各自吃满内容区高度，横向放不下时**一起**
    // 按同一系数收——按固定宽度比例分栏会让其中一块凭空缩水（旧写法给部件盘钉死 0.34）。
    let workScale = Math.min(regionH / WORK_H, maxScale);
    let palScale = Math.min(regionH / this.paletteContentH, maxScale);
    const needed = WORK_PANEL_W * workScale + gap + PALETTE_W * palScale;
    if (needed > innerW) {
      const k = innerW / needed;
      workScale *= k;
      palScale *= k;
    }

    const workW = WORK_PANEL_W * workScale;
    const workH = WORK_H * workScale;
    const palW = PALETTE_W * palScale;
    const palH = this.paletteContentH * palScale;

    const totalW = workW + gap + palW;
    const startX = Math.max(M, (sw - totalW) / 2);
    const midY = top + regionH / 2;

    // 工作层的原点仍是 560×410 那套槽位坐标系，面板从 WORK_PANEL_X 起——整层左移一格，
    // 使面板外沿而不是坐标原点对齐到 startX。
    this.workLayer.scale.set(workScale);
    this.workLayer.position.set(startX - WORK_PANEL_X * workScale, midY - workH / 2);
    this.paletteLayer.scale.set(palScale);
    this.paletteLayer.position.set(startX + workW + gap, midY - palH / 2);
  }

  private buildSlots(): void {
    this.workLayer.addChild(createPanel(WORK_PANEL_X, 0, WORK_PANEL_W, WORK_H, SKINS.panel));
    this.workLayer.addChild(this.buildCompletionBar());

    for (const slot of this.order.slots) {
      this.workLayer.addChild(this.makeSlot(slot));
    }
  }

  /**
   * 完成度条：必填槽已摆件数 / 必填槽总数，摆在工作台顶栏那条空带里。
   *
   * 只是把"抬眼就能数出来"的现状读成一条方正琥珀条——分数、忌讳、成败一个字不透，
   * 那些仍旧只由交活后的动作说（见 `updateFeedback` 的注释）。
   */
  private buildCompletionBar(): Container {
    const c = new Container();
    const required = this.order.slots.filter((s) => !s.optional);
    const done = required.filter((s) => this.placed.has(s.id)).length;
    const total = Math.max(1, required.length);

    const count = createStyledText({
      text: `${done} / ${required.length}`,
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.micro,
        fill: UITheme.colors.descText,
      },
    });
    count.anchor.set(0, 0.5);
    count.eventMode = 'none';

    // 条 + 读数整组在面板顶栏居中——拉成通栏一条会读成"分隔线"而不是"进度"。
    const groupW = WORK_BAR_W + UITheme.spacing.md + Math.ceil(count.width);
    const x0 = WORK_PANEL_X + Math.round((WORK_PANEL_W - groupW) / 2);
    const bar = createProgressBar(WORK_BAR_W, WORK_BAR_H, done / total);
    bar.position.set(x0, WORK_BAR_Y);
    count.position.set(x0 + WORK_BAR_W + UITheme.spacing.md, WORK_BAR_Y + WORK_BAR_H / 2);

    c.addChild(bar, count);
    c.eventMode = 'none';
    return c;
  }

  private makeSlot(slot: PaperCraftSlotDef): Container {
    const wrap = new Container();
    wrap.position.set(slot.x, slot.y);
    wrap.eventMode = 'static';
    wrap.cursor = 'pointer';
    wrap.hitArea = new Rectangle(0, 0, slot.width, slot.height);

    // 槽位＝物品格：比台面抬一档的垫位 + 一条细线。必填走内金线（读得出"这儿得放东西"），
    // 可空的退到暗木线。**底必须抬**：slot 皮肤的原底（rowBgInactive@0.7）与工作台底几乎同色，
    // 实拍下只剩一圈金线浮在纯黑上，整个纸人读成一张线框图、还被右边填满格子的部件盘压过去。
    // 必填槽抬到 rowHover 那一档：几块暖底摆在一起，纸人的轮廓才由"面"而不是"线"读出来。
    // 可空槽刻意留在暗一档 —— 连同暗木线一起，一眼分得出"这格可以空着"。
    const g = new Graphics();
    drawPanelBase(g, 0, 0, slot.width, slot.height, SKINS.slot, {
      fill: slot.optional ? UITheme.colors.rowBgDark : UITheme.colors.rowHover,
      fillAlpha: slot.optional ? UITheme.alpha.rowBg : UITheme.alpha.rowHover,
      border: slot.optional ? UITheme.colors.borderActive : UITheme.colors.hairline,
    });
    wrap.addChild(g);

    const placed = this.placed.get(slot.id);

    // 槽名先画、部件后画：摆上之后让纸件盖过标签，同时把标签压到最暗一档。
    // 标签的职责是"这儿该放什么"，件一摆上就该退场——不退就正压在纸人的胳膊上。
    const t = createStyledText({
      text: `${this.resolveText(slot.label)}${slot.optional ? this.resolveText('[tag:string:paperCraft:slotOptionalSuffix]') : ''}`,
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.micro,
        fill: placed ? UITheme.colors.hintMid : UITheme.colors.bodyMuted,
      },
    });
    t.anchor.set(0.5, 0);
    t.position.set(slot.width / 2, 5);
    t.eventMode = 'none';
    wrap.addChild(t);

    if (placed) {
      const art = this.makePartVisual(placed, Math.min(slot.width * 0.84, 88), Math.min(slot.height * 0.78, 96));
      art.position.set(slot.width / 2, slot.height / 2 + 6);
      wrap.addChild(art);
    }

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
        this.setFeedback(this.slotRejectsText(slot.label, this.selectedPart.label), true);
        return;
      }
      this.placed.set(slot.id, this.selectedPart);
      this.selectedPart = null;
      this.rebuild();
    });
    return wrap;
  }

  private buildPalette(): void {
    const rows = Math.max(1, Math.ceil(this.order.parts.length / PALETTE_COLS));

    const title = createTitleRow(this.resolveText('[tag:string:paperCraft:paletteTitle]'), {
      width: PALETTE_W - PALETTE_PAD * 2,
      align: 'center',
      fontSize: UITheme.fontSize.title,
    });
    const itemsY = PALETTE_PAD + title.rowHeight + UITheme.spacing.md;
    // 背板高度随部件数自适应，避免部件溢出固定高度的面板。
    const bgH = itemsY + (rows - 1) * ITEM_PITCH_Y + ITEM_H + PALETTE_PAD;
    this.paletteContentH = bgH;

    this.paletteLayer.addChild(createPanel(0, 0, PALETTE_W, bgH, SKINS.panelAlt));
    title.position.set(PALETTE_PAD, PALETTE_PAD);
    this.paletteLayer.addChild(title);

    this.order.parts.forEach((part, i) => {
      const item = this.makePaletteItem(part);
      item.position.set(
        PALETTE_PAD + (i % PALETTE_COLS) * ITEM_PITCH_X,
        itemsY + Math.floor(i / PALETTE_COLS) * ITEM_PITCH_Y,
      );
      this.paletteLayer.addChild(item);
    });
  }

  private makePaletteItem(part: PaperCraftPartDef): Container {
    const wrap = new Container();
    wrap.eventMode = 'static';
    wrap.cursor = 'grab';
    wrap.hitArea = new Rectangle(0, 0, ITEM_W, ITEM_H);

    // 选中＝琥珀点亮一档 + 金描边 + 外圈柔光（与行囊物品格同一套说法），不是换个深色。
    const selected = this.selectedPart?.id === part.id;
    const bg = new Graphics();
    drawPanelBase(
      bg, 0, 0, ITEM_W, ITEM_H, SKINS.slot,
      selected ? { border: UITheme.colors.borderSelected } : undefined,
    );
    if (selected) {
      drawSelectedRow(bg, 1, 1, ITEM_W - 2, ITEM_H - 2);
      bg.roundRect(-2, -2, ITEM_W + 4, ITEM_H + 4, SKINS.slot.radius + 2);
      bg.stroke({ color: UITheme.colors.borderSelected, width: 1, alpha: 0.25 });
    }
    wrap.addChild(bg);

    const art = this.makePartVisual(part, 44, 36);
    art.position.set(ITEM_W / 2, 24);
    wrap.addChild(art);
    const label = createStyledText({
      text: this.resolveText(part.label),
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.small,
        fill: selected ? UITheme.colors.title : UITheme.colors.bodyMuted,
        wordWrap: true,
        wordWrapWidth: ITEM_W - 10,
        align: 'center',
      },
    });
    label.anchor.set(0.5, 0);
    label.position.set(ITEM_W / 2, 44);
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
      this.setFeedback(this.slotRejectsText(slot.label, this.drag.part.label), true);
    }
    this.drag.sprite.destroy({ children: true });
    this.drag = null;
    this.root.off('pointermove', this.onDragMove, this);
    this.root.off('pointerup', this.onDragEnd, this);
    this.root.off('pointerupoutside', this.onDragEnd, this);
    this.rebuild();
  }

  /**
   * 屏幕层外壳：大标题 → 说明 → 提示条 → 纸色/收尾选择条 →（内容区）→ 底栏。
   *
   * ⚠ 左上角是常驻 HUD（铜钱牌）的地盘——旧版把纸色标题与第一枚按钮压在那儿，
   * 「纸色」二字直接被钱袋盖住。所以第一行只放居中的标题，工具条整体往下让。
   */
  private buildTopChrome(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const innerW = Math.max(320, sw - M * 2);
    let y = M;

    const title = createTitleRow(this.resolveText(this.order.title), {
      width: innerW,
      align: 'center',
      fontSize: UITheme.fontSize.display,
      letterSpacing: UITheme.letterSpacing.display,
    });
    title.position.set(M, y);
    this.uiLayer.addChild(title);
    y += title.rowHeight + UITheme.spacing.sm;

    const desc = createStyledText({
      text: this.resolveText(this.order.description ?? '[tag:string:paperCraft:orderDescDefault]'),
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.descText,
        wordWrap: true,
        wordWrapWidth: innerW - UITheme.spacing.xxl * 2,
        align: 'center',
      },
    });
    desc.anchor.set(0.5, 0);
    desc.position.set(sw / 2, y);
    desc.eventMode = 'none';
    this.uiLayer.addChild(desc);
    y += desc.height + UITheme.spacing.md;

    y = this.buildHintBand(y, innerW) + UITheme.spacing.md;
    y = this.buildSelectorTray(y, innerW) + UITheme.spacing.lg;
    this.contentTop = y;

    // 底栏：居中键位提示（可直接点）+ 右侧「交活」。左侧留白给 HUD 不冲突。
    const footerTop = sh - M - BTN_H;
    this.contentBottom = footerTop - UITheme.spacing.md;

    const submit = this.makeButton(
      this.resolveText('[tag:string:paperCraft:submit]'),
      true,
      () => void this.finish(),
    );
    submit.position.set(sw - M - submit.totalWidth, footerTop);
    this.uiLayer.addChild(submit);

    const cap = createKeyCap('Esc', this.resolveText('[tag:string:paperCraft:exit]'));
    const capH = cap.height;
    cap.position.set(Math.round((sw - cap.totalWidth) / 2), Math.round(footerTop + (BTN_H - capH) / 2));
    cap.eventMode = 'static';
    cap.cursor = 'pointer';
    cap.hitArea = new Rectangle(0, 0, cap.totalWidth, capH);
    cap.on('pointertap', () => this.abort());
    this.uiLayer.addChild(cap);
  }

  /**
   * 提示条：图标徽章 + 居中的目标提示 / 即时反馈。
   *
   * **条本身宽高固定**——"这槽放不下那件"这类反馈是直接改文字、不重建界面的，
   * 随文字缩放的条会当场对不上。条里的「徽章 + 文字」则作为一组一起居中
   * （`layoutHintRow`，改文字时同步重排）：徽章钉死在最左、文字自己居中，
   * 中间会空出一大截、右边又贴不到头，实拍下这份不对称一眼就看得见。
   */
  private buildHintBand(y: number, innerW: number): number {
    // 提示牌比通栏窄：通栏一条压在下面那条工具托盘正上方是两根一样长的横杠，读着堵。
    const bandW = Math.min(innerW, HINT_MAX_W);
    const band = createPanel(0, 0, bandW, HINT_H, SKINS.toast);
    band.position.set(Math.round((this.renderer.screenWidth - bandW) / 2), y);
    this.uiLayer.addChild(band);

    this.hintBandW = bandW;
    this.hintBadge = createIconBadge('scroll', HINT_BADGE_R);
    const reserved = this.hintBadge ? HINT_BADGE_R * 2 + UITheme.spacing.md : 0;
    if (this.hintBadge) band.addChild(this.hintBadge);

    this.feedback.anchor.set(0.5);
    // 换行宽度按"整组还能居中"来算：两侧各留一个 xl 的呼吸位，再扣掉徽章占的那一段。
    this.feedback.style.wordWrapWidth = Math.max(120, bandW - UITheme.spacing.xl * 2 - reserved);
    this.feedback.eventMode = 'none';
    band.addChild(this.feedback);
    this.layoutHintRow();

    return y + HINT_H;
  }

  /** 把「徽章 + 文字」当一组横向居中于提示条。建条时与每次改文字后都要调。 */
  private layoutHintRow(): void {
    const bandW = this.hintBandW;
    if (bandW <= 0) return;
    const lead = this.hintBadge ? HINT_BADGE_R * 2 + UITheme.spacing.md : 0;
    const textW = Math.min(this.feedback.width, bandW - UITheme.spacing.xl * 2 - lead);
    const x0 = Math.round((bandW - (lead + textW)) / 2);
    if (this.hintBadge) this.hintBadge.position.set(x0 + HINT_BADGE_R, HINT_H / 2);
    this.feedback.position.set(x0 + lead + textW / 2, HINT_H / 2);
  }

  /**
   * 纸色 / 收尾选择条：一条木边小托盘装两组按钮。
   * 选项由数据声明、长度不可控，所以一行放不下就换行，托盘高度跟着走。
   */
  private buildSelectorTray(y: number, innerW: number): number {
    const groups: (Container & { totalWidth: number })[] = [
      this.buildOptionGroup(
        this.resolveText('[tag:string:paperCraft:paperTitle]'),
        this.getPaperOptions().map((opt) => ({
          label: opt.label,
          tint: opt.tint,
          active: opt.id === this.selectedPaper?.id,
          pick: () => {
            this.selectedPaper = opt;
            this.rebuild();
          },
        })),
      ),
      this.buildOptionGroup(
        this.resolveText(this.order.finishQuestion ?? '[tag:string:paperCraft:finishTitleDefault]'),
        this.getFinishOptions().map((opt) => ({
          label: opt.label,
          active: opt.id === this.selectedFinish?.id,
          pick: () => {
            this.selectedFinish = opt;
            this.rebuild();
          },
        })),
      ),
    ];

    const padX = UITheme.spacing.lg;
    const padY = UITheme.spacing.md;
    const groupGap = UITheme.spacing.xxl;
    const rowGap = UITheme.spacing.sm;
    const avail = innerW - padX * 2;

    const rows: (Container & { totalWidth: number })[][] = [];
    let cur: (Container & { totalWidth: number })[] = [];
    let curW = 0;
    for (const g of groups) {
      const add = cur.length === 0 ? g.totalWidth : groupGap + g.totalWidth;
      if (cur.length > 0 && curW + add > avail) {
        rows.push(cur);
        cur = [g];
        curW = g.totalWidth;
      } else {
        cur.push(g);
        curW += add;
      }
    }
    if (cur.length > 0) rows.push(cur);

    const trayH = padY * 2 + rows.length * BTN_H + (rows.length - 1) * rowGap;
    // 托盘**贴着内容宽度**而不是通栏：这一摞 chrome 里标题、提示条、下面两块面板都是居中收口的，
    // 只有托盘拉满两边，于是左右各露出一大截空木条，读起来像"这条没做完"。
    // 量出最宽的一行，两边各留一个 padX，再整条居中——通栏只在选项真排到那么宽时才发生。
    const rowWidths = rows.map((r) => r.reduce((s, g) => s + g.totalWidth, 0) + (r.length - 1) * groupGap);
    const trayW = Math.min(innerW, Math.max(...rowWidths, 0) + padX * 2);
    const tray = createPanel(0, 0, trayW, trayH, SKINS.chip);
    tray.position.set(Math.round((this.renderer.screenWidth - trayW) / 2), y);
    this.uiLayer.addChild(tray);

    let ry = padY;
    for (const row of rows) {
      // 每行整体居中：靠左排会在托盘右端留一截空木条，看着像少画了东西。
      const rowW = row.reduce((s, g) => s + g.totalWidth, 0) + (row.length - 1) * groupGap;
      let rx = Math.max(padX, Math.round((trayW - rowW) / 2));
      for (const g of row) {
        g.position.set(rx, ry);
        tray.addChild(g);
        rx += g.totalWidth + groupGap;
      }
      ry += BTN_H + rowGap;
    }
    return y + trayH;
  }

  /** 一组「小标 + 若干按钮」，横排，自量总宽供托盘排版。 */
  private buildOptionGroup(label: string, opts: OptionButtonSpec[]): Container & { totalWidth: number } {
    const c = new Container() as Container & { totalWidth: number };
    const t = createStyledText({
      text: label,
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.hintMid,
      },
    });
    t.position.set(0, Math.round((BTN_H - t.height) / 2));
    t.eventMode = 'none';
    c.addChild(t);

    let x = Math.round(t.width) + UITheme.spacing.md;
    for (const o of opts) {
      const b = this.makeButton(this.resolveText(o.label), o.active, o.pick, o.tint);
      b.position.set(x, 0);
      c.addChild(b);
      x += b.totalWidth + UITheme.spacing.sm;
    }
    c.totalWidth = Math.max(0, x - UITheme.spacing.sm);
    return c;
  }

  /** 按钮：细木边近方正按钮；选中态铺一层琥珀暖光并把字提到标题金。 */
  private makeButton(
    label: string,
    active: boolean,
    cb: () => void,
    swatchTint?: string,
  ): Container & { totalWidth: number } {
    const t = createStyledText({
      text: label,
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.body,
        fill: active ? UITheme.colors.title : UITheme.colors.bodyMuted,
      },
    });
    const swatchW = swatchTint === undefined ? 0 : SWATCH_R * 2 + UITheme.spacing.sm;
    const w = Math.round(t.width) + swatchW + UITheme.spacing.lg * 2;

    const wrap = createPanel(0, 0, w, BTN_H, SKINS.choice) as Container & { totalWidth: number };
    if (active) {
      const hl = new Graphics();
      drawSelectedRow(hl, WOOD_CHIP, WOOD_CHIP, w - WOOD_CHIP * 2, BTN_H - WOOD_CHIP * 2);
      hl.eventMode = 'none';
      wrap.addChild(hl);
    }

    let cx = UITheme.spacing.lg;
    if (swatchTint !== undefined) {
      // 色片就是纸色本身（白纸 / 黄表 / 青纸 / 红纸）——玩法画面，按订单数据上色，
      // 不套主题令牌；只在外面加一圈内金细线让它读起来像"这套 UI 里的一枚色片"。
      const swatch = new Graphics();
      swatch.circle(cx + SWATCH_R, BTN_H / 2, SWATCH_R);
      swatch.fill({ color: this.parseColor(swatchTint, 0xf4ecd8) });
      swatch.circle(cx + SWATCH_R, BTN_H / 2, SWATCH_R);
      swatch.stroke({ color: UITheme.colors.hairline, width: 1, alpha: 0.7 });
      swatch.eventMode = 'none';
      wrap.addChild(swatch);
      cx += SWATCH_R * 2 + UITheme.spacing.sm;
    }

    t.position.set(cx, Math.round((BTN_H - t.height) / 2));
    t.eventMode = 'none';
    wrap.addChild(t);

    wrap.eventMode = 'static';
    wrap.cursor = 'pointer';
    wrap.hitArea = new Rectangle(0, 0, w, BTN_H);
    wrap.on('pointertap', cb);
    wrap.totalWidth = w;
    return wrap;
  }

  private async finish(): Promise<void> {
    if (this.finishing) return;
    const missing = this.order.slots.filter((slot) => !slot.optional && !this.placed.has(slot.id));
    if (missing.length > 0) {
      this.setFeedback(
        fillToken(
          this.resolveText('[tag:string:paperCraft:missingParts]'),
          '{parts}',
          missing.map((s) => this.resolveText(s.label)).join('、'),
        ),
        true,
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
      '{slot}': this.resolveText(slotLabel),
      '{part}': this.resolveText(partLabel),
    });
  }

  /**
   * 写提示条。`warn` 只改字色（常驻提示走正文暖灰、"放不上/还缺"走琥珀橙），
   * **不碰时机也不碰内容**——什么时候说什么话仍旧由原来那几处决定。
   */
  private setFeedback(text: string, warn = false): void {
    this.feedback.style.fill = warn ? UITheme.colors.orange : UITheme.colors.bodyMuted;
    setStyledText(this.feedback, text);
    // 文字宽度变了，「徽章 + 文字」这一组要重新居中（条本身不动）。
    this.layoutHintRow();
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
    this.setFeedback(`${progress}${hint}`);
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
    // 贴图缺位时的替身＝一张纸片，是玩法画面（部件本身）不是 UI 外壳：
    // 纸色/竹篾色按材质走，不套主题令牌。
    const g = new Graphics();
    g.roundRect(-maxW / 2, -maxH / 2, maxW, maxH, 8);
    g.fill({ color: 0xe9ddc3, alpha: 0.95 });
    g.stroke({ color: 0x5e4630, width: 2 });
    const t = createStyledText({
      text: this.resolveText(part.label),
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.micro,
        fill: 0x2b2118,
        wordWrap: true,
        wordWrapWidth: maxW - 8,
        align: 'center',
      },
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
