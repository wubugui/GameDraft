import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { UITheme } from '../UITheme';
import { createPanel, SKINS, type PanelSkin } from '../PanelSkin';
import { createKeyCap, createRule, createTitleRow } from './UIDecor';
import { markPointerConsumed } from '../uiPointerCoords';
import type { Renderer } from '../../rendering/Renderer';
import { createStyledText } from '../../core/styledText';

/**
 * 面板窗体：全站弹出式 UI 的统一外壳。
 *
 * 此前 21 个面板各自手搭「遮罩 + 面板底 + 标题 Text + 角落一句『按 X 关闭』」，
 * 尺寸写死 8 套、只有 HUD 响应 resize、全项目没有一个关闭按钮。这里收口成一处。
 *
 * **职责边界**：只管窗体外壳（遮罩/底框/标题栏/关闭键/居中/缩放响应/开关动效）。
 * 内容一律挂 `body`，坐标以内容区左上角为原点——调用方不再需要知道 `px`/`py`。
 * 皮肤仍走 `PanelSkin`（那是唯一做对的一层，不动它）。
 */

/**
 * 尺寸预设，替代此前散落的 700×520 / 650×500 / 820×560 / 500 / 400。
 *
 * **2026-08-03 整体放大了一档**：设计稿里的面板占屏约 85%×88%，而旧的 lg
 * (700×520 / 1024×768) 只占 68%×68%——面板缩在屏幕中间一小块，行距被迫压扁、
 * 底下空掉一大片，跟稿子那种"内容填满牌子"的气质差得最远的就是这一条。
 * 实际显示宽高还会被 `layout()` 按当前画布夹一次，小屏不会溢出。
 */
export const WINDOW_SIZES = {
  sm: { width: 480, height: 390 },
  md: { width: 760, height: 570 },
  lg: { width: 850, height: 630 },
  xl: { width: 900, height: 660 },
} as const;

/**
 * 面板与画布边缘至少留出的空隙（**按屏宽取比例**，小屏不贴边、大屏不至于只留一条缝）。
 * 分辨率自适应就靠这个 + 下面那对占屏下限：全套尺寸都是屏幕的函数，不是写死的像素。
 */
function screenMargin(sw: number): number {
  return Math.max(20, Math.round(sw * 0.022));
}

/**
 * 面板**占屏下限**。各面板自己按内容算宽高（那是对的，内容驱动），但算出来往往偏小——
 * 行囊只占过 72%×53%，一块 UI 缩在屏幕中间像个对话框。这里给一个地板：
 *
 * - **宽下限给得足**（0.84）：加宽只会让文字每行装更多字、栏位更从容，不会制造空白。
 * - **高下限给得克制**（0.62）：条目少的面板（活计只有三四条）一旦拔高，下半屏就是死区——
 *   审查把这个列为最刺眼的问题。高度还是让内容说话，地板只兜住"别缩成小方块"。
 *
 * 上限仍是「屏幕 - 边距」，所以永远不会撑满、也永远不会溢出。
 */
const MIN_W_PCT = 0.84;
const MIN_H_PCT = 0.62;

export type WindowSize = keyof typeof WINDOW_SIZES;

export interface UIWindowOptions {
  /** 尺寸预设名，或显式给宽高 */
  size: WindowSize | { width: number; height: number };
  /** 标题栏文字（留空则不画标题栏，内容区从顶端开始） */
  title?: string;
  /**
   * 标题对齐。缺省 'center'（设计稿里行囊/规矩本/暂停都是居中带两翼横线）；
   * 传 'left' 得到活计面板那种压左上角的大标题 + 下方一条通栏横线。
   */
  titleAlign?: 'center' | 'left';
  /** 标题栏右侧的次要文字，如「已记 3 / 15」「铜钱: 37」 */
  subtitle?: string;
  /** 副标题色，缺省 section 灰。承载数值时可传主题色（如铺子的铜钱用 goldDim，与价格同色系） */
  subtitleColor?: number;
  /** 皮肤，缺省 SKINS.panel */
  skin?: PanelSkin;
  /** 关闭提示文字，如「按 B 关闭」；留空则只有 ✕ 按钮 */
  closeHint?: string;
  /**
   * 是否画 ✕（缺省 true）。
   *
   * **必选类面板必须传 false**：像 `ActionChoiceUI` 的 `allowCancel:false` 那种
   * "这一条必须选一个"的场景，恒在的 ✕ 等于给必选项开后门；此外贴边不居中、
   * 不铺遮罩的条状面板也用不上它。
   */
  showClose?: boolean;
  /** 点 ✕ / 点关闭提示时调用 */
  onClose: () => void;
  /** 遮罩不透明度，缺省取主题 overlay */
  dimAlpha?: number;
  /** 交互音钩子（hover/press）；不给就静默 */
  onSound?: (name: 'hover' | 'press' | 'cancel') => void;
}

/**
 * 窗体件的固定尺寸。**导出**是因为调用方要按标题栏高度/✕ 命中区反推自己的内容起点，
 * 不导出的话每个面板都得拿 `spacing` 拼一个"约等于"的数字出来，改一处就全歪。
 */
export const WINDOW_CHROME = {
  /** 标题栏高（含标题下那条横线的位置）。display 档 44px 的标题 + 上下呼吸 */
  titleBarHeight: 76,
  /** ✕ 的方形命中区边长 */
  closeHit: 36,
  /** 内容区四周内边距 */
  padding: UITheme.spacing.xl,
} as const;

const TITLE_BAR_H = WINDOW_CHROME.titleBarHeight;
const CLOSE_HIT = WINDOW_CHROME.closeHit;

/**
 * 没有具体按键可框的关闭提示（如「[返回书架]」「[ 点击或按任意键关闭 ]」）。
 *
 * 画成一枚小框按钮而不是一行裸文字：设计稿里面板底部的出口一律是**有框的**，
 * 一行角落灰字正是这轮要清掉的旧写法。文案里的方括号是本项目"这里可点"的约定，
 * 既然框已经把可点表达出来了，就把括号去掉，免得框里再套一层括号。
 * 接口与 `createKeyCap` 对齐（都带 totalWidth），调用方不必分支。
 */
/** 关闭提示的命中盒外扩量：贴着 1px 描边点不中，往外让一档 */
const HINT_HIT_PAD = UITheme.spacing.xs;

function plainHint(text: string): Container & { totalWidth: number } {
  const c = new Container() as Container & { totalWidth: number };
  const label = text.replace(/^\s*\[\s*|\s*\]\s*$/g, '');
  const t = createStyledText({
    text: label,
    style: { fontSize: UITheme.fontSize.body, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui },
  });
  const padX = UITheme.spacing.md;
  const w = t.width + padX * 2;
  const h = t.height + 6;

  const box = new Graphics();
  box.rect(0, 0, w, h);
  box.stroke({ color: UITheme.colors.hairline, width: 1, alpha: 0.55 });
  box.eventMode = 'none';
  c.addChild(box);

  t.position.set(padX, 3);
  t.eventMode = 'none';
  c.addChild(t);
  c.totalWidth = w;
  // 与 createKeyCap 同理：自带命中盒，否则挂了 pointerdown 也点不中（详见 UIDecor.createKeyCap）
  c.hitArea = new Rectangle(-HINT_HIT_PAD, -HINT_HIT_PAD, w + HINT_HIT_PAD * 2, h + HINT_HIT_PAD * 2);
  return c;
}

export class UIWindow {
  /** 整个窗体（含遮罩），调用方挂到 renderer.uiLayer */
  readonly container: Container;
  /** 内容容器：原点 = 内容区左上角。调用方只往这里加东西 */
  readonly body: Container;
  /** 内容区可用宽高（已扣掉内边距与标题栏） */
  bodyWidth = 0;
  bodyHeight = 0;

  private renderer: Renderer;
  private opts: UIWindowOptions;
  private chrome: Container;
  /**
   * 压在 body **之上**的那层窗体件：✕ 与底部关闭提示。
   *
   * 它们此前和底框一起挂在 `chrome`（body 之下），于是内容一铺满 `bodyHeight`
   * 就把出口盖住了——地图那种整块内容的面板必然中招，每个调用方都得自己再发现一次。
   * 出口必须恒在最上层。
   */
  private overlay: Container;
  private unsubscribeResize: () => void;
  private destroyed = false;
  /**
   * 底部关闭键帽**伸进内容区**的高度，由 `buildCloseHint` 量出实际行高后回填。
   *
   * 键帽画在 `overlay`（body 之上）且位置是从面板下沿往上量的，而 `bodyHeight` 原来只扣
   * 一个 `pad`(20)——键帽实际吃掉的是 `木条15 + sm8 + 行高~29 = 52`，也就是有 ~32px
   * 压在内容上。对话记录滚到底时最后一行正好被这条压住（制作人截图），册子长正文同病。
   * 此前只有规矩本自己发现了这件事、在面板里硬编码 `HINT_RESERVE = 34` 各修各的——
   * 那是窗体的账，收回窗体自己算。
   */
  private closeHintReserve = 0;

  constructor(renderer: Renderer, opts: UIWindowOptions) {
    this.renderer = renderer;
    this.opts = opts;
    this.container = new Container();
    this.chrome = new Container();
    this.body = new Container();
    this.overlay = new Container();
    this.container.addChild(this.chrome);
    this.container.addChild(this.body);
    this.container.addChild(this.overlay);

    // 此前只有 HUD 监听 resize，面板一旦打开就把居中坐标算死，改窗口大小必歪。
    //
    // ⚠ 必须订 `renderer.subscribeAfterResize`，**不能**用 `window.addEventListener('resize')`：
    // ① `#game-mount` 被 flex 侧栏挤压（F2 调试坞）走的是 Renderer 的 ResizeObserver，
    //    **根本不发 window resize 事件**；
    // ② 真·浏览器 resize 被 Pixi 的 ResizePlugin 推到 rAF 之后才真正 resize，
    //    同步跑的 window 监听此刻读到的 `screenWidth` 还是旧值，永远差一个事件。
    // 项目里 ClickContinuePrompt / CutsceneRenderer / ObjectExamineScene 等均用此信号。
    this.unsubscribeResize = renderer.subscribeAfterResize(() => this.layout());
    this.layout();
  }

  private get sizePx(): { width: number; height: number } {
    const s = this.opts.size;
    return typeof s === 'string' ? WINDOW_SIZES[s] : s;
  }

  /** 面板左上角在屏幕上的位置（内容区原点由 body.position 承载，调用方无需关心）。 */
  private layout(): void {
    if (this.destroyed) return;
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const raw = this.sizePx;
    // 尺寸 = clamp(调用方按内容算出来的值, 占屏下限, 屏幕 - 边距)。
    // 下限保证面板够大（不缩成小方块），上限保证不溢出也不撑满，两头都是屏幕的比例，
    // 所以换分辨率/换窗口大小自动跟着走，不用为每个尺寸各写一套。
    const m = screenMargin(sw);
    const w = Math.min(Math.max(raw.width, sw * MIN_W_PCT), sw - m * 2);
    const h = Math.min(Math.max(raw.height, sh * MIN_H_PCT), sh - m * 2);
    const px = Math.round((sw - w) / 2);
    const py = Math.round((sh - h) / 2);
    const pad = UITheme.spacing.xl;
    const hasTitle = !!this.opts.title;
    // 无标题时也要给 ✕ 留出行高，否则命中区落进内容区、被 body 抢走指针（body 渲染在 chrome 之上）
    const topInset = hasTitle ? TITLE_BAR_H : pad + CLOSE_HIT;

    this.bodyWidth = w - pad * 2;
    this.body.position.set(px + pad, py + topInset);

    // 先画窗体件：底部关闭键帽的实际行高只有建出来才知道，`closeHintReserve` 在那里回填。
    // drawChrome 不读 bodyHeight，顺序安全。
    this.drawChrome(px, py, w, h, hasTitle);
    this.bodyHeight = Math.max(1, h - topInset - pad - this.closeHintReserve);
  }

  private drawChrome(px: number, py: number, w: number, h: number, hasTitle: boolean): void {
    this.chrome.removeChildren().forEach(c => c.destroy({ children: true }));
    this.overlay.removeChildren().forEach(c => c.destroy({ children: true }));
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const pad = UITheme.spacing.xl;

    const dim = new Graphics();
    dim.rect(0, 0, sw, sh);
    dim.fill({ color: UITheme.colors.overlay, alpha: this.opts.dimAlpha ?? UITheme.alpha.overlay });
    this.chrome.addChild(dim);

    this.chrome.addChild(createPanel(px, py, w, h, this.opts.skin ?? SKINS.panel));

    if (hasTitle) {
      // 标题走 createTitleRow：居中 + 拉字距 + 两翼渐隐横线，是这套观感的招牌。
      // 需要左对齐（活计面板那种大标题压左上角）的调用方传 titleAlign:'left'。
      const align = this.opts.titleAlign ?? 'center';
      const titleRow = createTitleRow(this.opts.title!, {
        width: w - pad * 2,
        align,
        // 设计稿里面板标题是很大的一块（「行囊」「活计」「暂停」），不是小字条。
        // 居中标题用 display 档，左对齐大标题再抬一档。
        fontSize: align === 'left' ? UITheme.fontSize.hero * 0.6 : UITheme.fontSize.display,
      });
      titleRow.position.set(px + pad, py + UITheme.spacing.md);
      this.chrome.addChild(titleRow);

      if (this.opts.subtitle) {
        const sub = createStyledText({
          text: this.opts.subtitle,
          style: {
            fontSize: UITheme.fontSize.small,
            fill: this.opts.subtitleColor ?? UITheme.colors.hintMid,
            fontFamily: UITheme.fonts.ui,
          },
        });
        // **右对齐**（给 ✕ 留出宽度），不跟在标题后面：标题不折行，长标题会把副标题
        // 一路推到 ✕ 底下甚至推出面板——铺子名一变长就会撞上。
        const closeReserve = this.opts.showClose === false ? 0 : CLOSE_HIT + UITheme.spacing.sm;
        sub.x = px + w - pad - closeReserve - sub.width;
        sub.y = py + UITheme.spacing.md + 6;
        this.chrome.addChild(sub);
      }

      // 居中标题自带两翼横线，不必再来一条通栏分隔；左对齐时 createTitleRow 已在下方挂了一条
      if (align === 'center') {
        const rule = createRule(w - pad * 2);
        rule.position.set(px + pad, py + TITLE_BAR_H - UITheme.spacing.sm);
        this.chrome.addChild(rule);
      }
    }

    if (this.opts.showClose !== false) {
      // ✕ 与关闭提示挂 overlay（body 之上），内容铺满时不会被盖住
      this.overlay.addChild(this.buildCloseButton(px + w - pad - CLOSE_HIT / 2, py + UITheme.spacing.lg + 2));
    }

    this.closeHintReserve = 0;
    if (this.opts.closeHint) {
      this.overlay.addChild(this.buildCloseHint(px, py, w, h, pad));
    }
  }

  /**
   * 底部居中的关闭提示，形如设计稿的「[I] 关闭」：按键包在方框里、说明跟在右边。
   *
   * 文案沿用调用方给的「按 I 关闭」这类字串（strings 里配好的），这里拆成
   * 键名 + 说明；拆不出来就整句当说明画，不因为一句没按套路的文案就漏掉出口。
   * **必须真的可点**——旧四个面板这行都是带 pointerdown 的按钮，别退化成死文字。
   */
  private buildCloseHint(px: number, py: number, w: number, h: number, pad: number): Container {
    const raw = this.opts.closeHint!;
    // strings 里的关闭提示统一是「按 <键名> 关闭」（键名可能是 Tab / Esc 这种多字符），
    // 所以键名必须**贪婪**匹配并靠空格分界。写成 `(\S+?)` 会只吃一个字符，
    // 「按 Tab 关闭」会被拆成键帽「T」+ 说明「ab 关闭」。
    const m = /^按\s+(\S+)\s+(.+)$/.exec(raw);
    // 匹配不上的（如「[ 点击或按任意键关闭 ]」本就没有具体按键）退成纯文字，
    // 别硬塞进键帽方框——一个装着整句话的方框比不画还糟。
    const row = m ? createKeyCap(m[1], m[2]) : plainHint(raw);

    // 竖向必须**从面板下沿往上量**：原来写死 `py + h - pad + xs`，键帽下半截会压在
    // 木条上甚至越到面板外（木框有 15px 实体厚度，不是一条线）。按木条厚度让开。
    const skin = this.opts.skin ?? SKINS.panel;
    const bottomInset = (skin.wood ?? 0) + UITheme.spacing.sm;
    const rowTop = Math.round(py + h - bottomInset - row.height);
    row.position.set(px + Math.round((w - row.totalWidth) / 2), rowTop);
    // 键帽压进内容区多少，就从 bodyHeight 里扣多少（再让开一档，末行别贴着键帽）
    this.closeHintReserve = Math.max(0, py + h - pad - rowTop + UITheme.spacing.sm);
    // 命中盒由 createKeyCap / plainHint 自带（见 UIDecor 里的说明）：这两个件的方框与文字
    // 都是 eventMode:'none'，没有 hitArea 的普通 Container 在 Pixi v8 里一律判不中。
    row.eventMode = 'static';
    row.cursor = 'pointer';
    row.on('pointerover', () => { row.alpha = 0.75; this.opts.onSound?.('hover'); });
    row.on('pointerout', () => { row.alpha = 1; });
    row.on('pointerdown', (e: { nativeEvent?: unknown }) => {
      markPointerConsumed(e.nativeEvent);
      this.opts.onSound?.('cancel');
      this.opts.onClose();
    });
    return row;
  }

  /** ✕ 纯程序化绘制（无图标素材，且与「民俗草根·极简」方向一致）。 */
  private buildCloseButton(cx: number, cy: number): Container {
    const c = new Container();
    const hit = new Graphics();
    hit.rect(-CLOSE_HIT / 2, -CLOSE_HIT / 2, CLOSE_HIT, CLOSE_HIT);
    hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    c.addChild(hit);

    const glyph = new Graphics();
    const r = 5;
    glyph.moveTo(-r, -r); glyph.lineTo(r, r);
    glyph.moveTo(r, -r); glyph.lineTo(-r, r);
    // 收进暖色系：原来那枚亮白粗 ✕ 是整块面板上唯一的纯白，抢眼且不合调性
    glyph.stroke({ color: UITheme.colors.hairline, width: 1.2 });
    glyph.alpha = 0.7;
    c.addChild(glyph);

    c.position.set(cx, cy);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointerover', () => { glyph.tint = UITheme.colors.title; glyph.alpha = 1; this.opts.onSound?.('hover'); });
    c.on('pointerout', () => { glyph.tint = 0xffffff; glyph.alpha = 0.7; });
    c.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      this.opts.onSound?.('cancel');
      this.opts.onClose();
    });
    return c;
  }

  /**
   * 只挂进渲染树，不播动画。**内容重绘导致窗体重建时必须走这个**——
   * 走 open() 会让每次点一行都重放一遍开场淡入上浮。
   */
  attach(): void {
    this.renderer.uiLayer.addChild(this.container);
  }

  /** 首次打开：挂载 + 淡入上浮，比原来的纯 alpha 淡入多一点"面板落下来"的手感。 */
  open(): void {
    this.attach();
    const dur = UITheme.motion.normal;
    const start = performance.now();
    const baseY = this.container.y;
    this.container.alpha = 0;
    const tick = (): void => {
      if (this.destroyed || this.container.destroyed) return;
      const raw = Math.min((performance.now() - start) / dur, 1);
      const t = UITheme.motion.easeOut(raw);
      this.container.alpha = t;
      this.container.y = baseY + (1 - t) * 8;
      if (raw < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeResize();
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }

  /**
   * 真正关闭面板时用：淡出下沉（开场动画的倒放）后再销毁。**内容重绘的重建路径别用**
   * ——那条必须瞬时（attach 语义）。调用方要先把自己的输入面摘干净
   * （UIScrollView.detachInput / 面板自己的 window 监听），尸体窗只是视觉，绝不吃输入。
   * 审查批5：面板有开无关，关场"啪"一下拆走是全站手感最糙的一处。
   */
  fadeOutAndDestroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeResize();
    this.container.eventMode = 'none';
    this.container.interactiveChildren = false;
    const dur = UITheme.motion.normal;
    const start = performance.now();
    const baseY = this.container.y;
    const finish = (): void => {
      if (this.container.destroyed) return;
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
    };
    const tick = (): void => {
      if (this.container.destroyed) return;
      const raw = Math.min((performance.now() - start) / dur, 1);
      const t = UITheme.motion.easeOut(raw);
      this.container.alpha = 1 - t;
      this.container.y = baseY + t * 8;
      if (raw < 1) requestAnimationFrame(tick);
      else finish();
    };
    requestAnimationFrame(tick);
  }
}
