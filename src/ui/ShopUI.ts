import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { UIWindow, WINDOW_CHROME } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { UIButton } from './components/UIButton';
import { createIcon, createRule, drawSelectedRow } from './components/UIDecor';
import { UIFocus, type FocusItem } from './components/UIFocus';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { IInventoryDataProvider, ShopDef } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';
import { TEXT_URLS } from '../core/projectPaths';
import { createStyledText } from '../core/styledText';

/**
 * 铺子面板。窗体/滚动/按钮三件套全部走组件层——此前这里自己算居中坐标、
 * 自己拿 Text 当按钮（没有 press 态）、货多了直接把面板撑出屏幕（无滚动）。
 *
 * 观感与行囊同一套语汇（对齐 `tmp/ui_mockups_2026-08-03` 设计稿）：
 * 居中大标题 + 右上角带铜钱图标的余额 · 行悬停 = 琥珀铺光 + 金描边（不是换个深色）
 * · 价格走 goldDim · 底部一条通栏细线压着「离开」。
 *
 * **键盘/手柄导航**（`UIFocus`）：可交互项就两类——每行的「购买」与底部的「离开」，
 * 分成 `rows` / `footer` 两组，上下键先在货品列里走、走到头才跳到「离开」。
 * 买不起的行传 `disabled`，方向键直接跳过它（那枚钮本来也点不动）。
 * 焦点高亮**复用本来就有的画法**：行还是 `drawSelectedRow` 的琥珀铺光，
 * 钮还是 `UIButton.setSelected` 的活跃态，不另发明一种焦点框。
 */

/** 铺子名是数据驱动的（「南边来的货郎」6 字），display 档标题很占宽——面板要给得起 */
const PANEL_W = 600;
/**
 * 一行的步进（行体 = ROW_H - ROW_GAP）。
 * 货名走 title 档（约 42 高），行体必须留得下它 + 上下呼吸，否则字顶满行、整列糊成一片。
 */
const ROW_H = 54;
const ROW_GAP = 6;
/** 「购买/不足」按钮列宽 */
const BUY_W = 96;
/** 价格列宽（价格右对齐贴在按钮左侧，各行数位才对得齐） */
const PRICE_W = 88;
/** 列表最高到这儿，再多就滚。**取 ROW_H 的整数倍**：否则视口下沿恒切出半行 */
const LIST_MAX_H = ROW_H * 7;
/** 底部「离开」按钮区（含它上面那条通栏细线的呼吸位） */
const FOOTER_H = 64;
/** 标题栏那条横线与第一行之间的呼吸位（**必须一并算进窗高**，否则列表凭空少一口气就开始滚） */
const LIST_TOP = UITheme.spacing.sm;
const LEAVE_BTN_W = 152;
/** 出口按钮：bodyLarge 的字约 35 高，32 的钮装不下（原值让「离开」顶满上下边框） */
const LEAVE_BTN_H = 44;
/**
 * 余额读数占的一条带（body 顶部，右对齐压在价格列上方）。
 *
 * **不能像行囊那样塞进标题栏右上角**：行囊的标题恒是「包袱」两个字，而铺子的标题是
 * 数据驱动的店名——「南边来的货郎」六个字在 display 档就有 285px 宽，居中之后右边根本
 * 不剩位置，铜钱图标会直接压在「郎」上（取景图 inv2_shop_v2_longname）。店名长度没有上限，
 * 靠加宽面板或缩字号都只是把翻车点往后挪一个字。
 *
 * 摆到列表上方反而更对：余额右沿与价格列右沿对齐，它就成了那一列钱的表头——
 * 「我有多少」正压着「要多少」。
 */
const COIN_BAND_H = 28;
/**
 * UIWindow 的标题栏高 + 底部内边距，用于「按货品条数反推窗高」。
 * 真正排版一律回读 `win.bodyWidth/bodyHeight`，故此常量只影响窗体总高、不会让内容错位。
 *
 * ⚠ **从 `WINDOW_CHROME` 现取，不许写死**：原来硬编码 64（标题还是小字条那会儿的值），
 * 标题涨到 display 档后实际是 76+20=96，窗子比内容矮 32px ——五条货的铺子被迫滚动、
 * 视口下沿恒切出半行（取景图 inv2_shop_v0）。
 */
const WINDOW_CHROME_H = WINDOW_CHROME.titleBarHeight + UITheme.spacing.xl;

/**
 * 价格列右沿在 body 坐标里的位置。行、余额读数两处都按它右对齐，
 * 各行数位与表头才在同一条竖线上（分散手算必然走偏）。
 */
function priceRightEdge(bodyW: number): number {
  return bodyW - BUY_W - UITheme.spacing.sm * 3;
}

export class ShopUI {
  private renderer: Renderer;
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private inventoryData: IInventoryDataProvider;
  private strings: StringsProvider;
  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private _isOpen = false;
  private currentShop: ShopDef | null = null;
  private shopDefs: Map<string, ShopDef> = new Map();
  private resolveDisplay: ((s: string) => string) | null = null;
  /** 键盘/手柄焦点。面板级长驻（每次 build 整批换 items），不随窗体重建而新建 */
  private focus = new UIFocus();
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(renderer: Renderer, eventBus: EventBus, inventoryData: IInventoryDataProvider, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.inventoryData = inventoryData;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  async loadDefs(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<ShopDef[]>(TEXT_URLS.shops);
      for (const s of list) this.shopDefs.set(s.id, s);
    } catch { /* no shops yet */ }
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void { /* ShopUI requires openShop(shopId) */ }

  openShop(shopId: string): void {
    const def = this.shopDefs.get(shopId);
    if (!def) {
      console.warn(`ShopUI: unknown shop "${shopId}"`);
      return;
    }
    this.currentShop = def;
    if (!this._isOpen) {
      this._isOpen = true;
      // 键盘导航只在开着时监听（与 RulesPanel/QuestPanel 同一范式）
      window.addEventListener('keydown', this.onKeyBound);
    }
    this.eventBus.emit('shop:opened', { shopId });
    this.build(true);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.currentShop = null;
    window.removeEventListener('keydown', this.onKeyBound);
    this.focus.destroy();
    this.destroyUI();
    this.eventBus.emit('shop:closed', {});
  }

  /**
   * 键盘：**焦点优先、滚动兜底**。
   *
   * `UIFocus` 吃掉方向键的前提是"那个方向真有下一项"，走到列表尽头它会把按键让回来——
   * 此时才交给 `UIScrollView.handleKey`（PageUp/PageDown 也落在这一档）。
   * 顺序反过来的话滚动区会把方向键全吞掉，焦点一步也挪不动。
   * Esc 不在这里：铺子经 `stateController` 的统一关闭通道走（见 GameStateController.handleEscape）。
   */
  private onKey(e: KeyboardEvent): void {
    if (!this._isOpen) return;
    if (this.focus.handleKey(e.code)) {
      e.preventDefault();
      return;
    }
    const list = this.list;
    if (!list) return;
    const before = list.scrollOffset;
    if (!list.handleKey(e.code)) return;
    if (list.scrollOffset !== before) e.preventDefault();
  }

  /** hover 音沿用旧行为（买/离开都会响）；关闭不在此发音——`shop:closed` 已有关铺子音，重复会同帧双响。 */
  private sound = (name: 'hover' | 'press' | 'cancel'): void => {
    if (name === 'hover') this.eventBus.emit('ui:hover', {});
  };

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  /**
   * @param animate 仅首次打开为 true。买完重绘必须走 `attach()`，否则每买一件都重放开场动画；
   * 而**忘了挂载**会让整个铺子从画面消失。
   */
  private build(animate = false): void {
    const keepScroll = this.list?.scrollOffset ?? 0;
    this.destroyUI();
    if (!this.currentShop) return;

    const items = this.currentShop.items;
    const coins = this.inventoryData.getCoins();

    const maxListH = Math.max(
      ROW_H,
      Math.min(
        LIST_MAX_H,
        this.renderer.screenHeight - WINDOW_CHROME_H - FOOTER_H - LIST_TOP - COIN_BAND_H - UITheme.spacing.xxl * 2,
      ),
    );
    const listH = Math.min(Math.max(items.length * ROW_H, ROW_H), maxListH);

    const win = new UIWindow(this.renderer, {
      size: { width: PANEL_W, height: listH + LIST_TOP + COIN_BAND_H + FOOTER_H + WINDOW_CHROME_H },
      title: this.r(this.currentShop.name),
      // 余额不走 UIWindow 的 subtitle：设计稿里它是「铜钱图标 + 读数」，见 buildCoinRow
      dimAlpha: UITheme.alpha.overlayLight,
      onClose: () => this.close(),
      onSound: this.sound,
    });
    this.win = win;

    this.buildCoinRow(win, coins);

    const listTop = COIN_BAND_H + LIST_TOP;
    const listViewH = Math.max(ROW_H, win.bodyHeight - FOOTER_H - listTop);
    const list = new UIScrollView(this.renderer, { width: win.bodyWidth, height: listViewH });
    list.container.position.set(0, listTop);
    win.body.addChild(list.container);
    this.list = list;

    const rowFocus = this.fillRows(items, coins, win.bodyWidth, listTop);
    list.scrollOffset = keepScroll;

    // 列表与底部按钮之间一条通栏细线（与行囊底部同一处理）
    const rule = createRule(win.bodyWidth);
    rule.position.set(0, listTop + listViewH + UITheme.spacing.md);
    win.body.addChild(rule);

    // 「[离开]」——文案带方括号即"可点"的视觉约定，改走 UIButton 后仍是同一个关闭入口
    const leave = new UIButton({
      label: this.strings.get('shop', 'leave'),
      width: LEAVE_BTN_W,
      height: LEAVE_BTN_H,
      variant: 'secondary',
      onPress: () => this.close(),
      onSound: this.sound,
    });
    const leaveX = Math.round((win.bodyWidth - LEAVE_BTN_W) / 2);
    leave.container.position.set(leaveX, win.bodyHeight - LEAVE_BTN_H);
    leave.container.on('pointerover', () => this.focus.syncHover('leave'));
    win.body.addChild(leave.container);

    // 焦点几何：「离开」必须落在**所有货品行的下方**，最后一行按 ↓ 才能跳到它。
    // 货多到要滚时行的（未滚动）y 会超过面板下沿，所以这里取两者较大值——
    // 只影响导航的空间关系，钮的实际位置仍是上面那行 `position.set`。
    const leaveItem: FocusItem = {
      id: 'leave',
      x: leaveX,
      y: Math.max(win.bodyHeight - LEAVE_BTN_H, listTop + items.length * ROW_H + UITheme.spacing.md),
      w: LEAVE_BTN_W,
      h: LEAVE_BTN_H,
      group: 'footer',
      onFocus: (f) => leave.setSelected(f),
      onActivate: () => this.close(),
    };
    this.focus.setItems([...rowFocus, leaveItem]);
    // 默认焦点 = **第一件买得起的货**（不是左上角、也不是「离开」）：开铺子就是来买东西的。
    // 一件也买不起时 rowFocus 全 disabled、被 setItems 滤掉，焦点自然落到「离开」。
    if (animate) this.focus.focusDefault((rowFocus.find(f => !f.disabled) ?? leaveItem).id);
    // 重建后补画一次高亮：UIFocus 复位到**同一个 id** 时走的是"已经在这儿了"的早退分支，
    // 不会再喊 onFocus——而这批显示对象是刚 new 出来的，不补就是暗的（买完一件后焦点凭空消失）。
    this.focus.current?.onFocus(true);

    if (animate) win.open();
    else win.attach();
  }

  /**
   * 余额：木刻铜钱图标 + 「铜钱: N」，压在列表正上方、**右沿与价格列对齐**（见 COIN_BAND_H）。
   *
   * 走 body 而不是 chrome 是因为 chrome 每次 resize 会整体重建，外部塞的东西会被清掉。
   * 图标素材没到位时 `createIcon` 返回 null——此时只画文字，位置照样成立。
   */
  private buildCoinRow(win: UIWindow, coins: number): void {
    const row = new Container();

    const label = createStyledText({
      text: `${this.strings.get('shop', 'coins')} ${coins}`,
      style: {
        fontSize: UITheme.fontSize.body,
        // 与价格列同色系：一眼看出「这个数管着那一列买不买得起」
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.ui,
      },
    });
    label.eventMode = 'none';

    // 图标与读数同取标题金（与行囊右上角同一处理），一眼认出是同一套面板。
    // 尺寸跟着它标的那行字走（body + 2），不是跟着 title 档——原来 28 的图标压着 20 的读数，
    // 一枚配角图标比它说明的数字还大。
    const iconSize = UITheme.fontSize.body + 2;
    const icon = createIcon('coin', iconSize);
    let x = 0;
    if (icon) {
      icon.position.set(0, Math.round((label.height - iconSize) / 2));
      row.addChild(icon);
      x = iconSize + UITheme.spacing.sm;
    }
    label.x = x;
    row.addChild(label);

    row.eventMode = 'none';
    row.position.set(
      Math.round(priceRightEdge(win.bodyWidth) - (x + label.width)),
      Math.round((COIN_BAND_H - label.height) / 2),
    );
    win.body.addChild(row);
  }

  /**
   * @param listTop 列表视口在 body 里的纵向起点；行的焦点矩形要按它换算到 body 坐标，
   * 否则「离开」与货品行不在同一个坐标系里，空间导航会算错上下关系。
   * @returns 每行一条焦点项（买不起的行 `disabled`），由 build 与「离开」合并后交给 UIFocus。
   */
  private fillRows(items: ShopDef['items'], coins: number, bodyW: number, listTop: number): FocusItem[] {
    const list = this.list;
    if (!list) return [];
    const focusItems: FocusItem[] = [];
    // 右侧留出滚动条的道
    const rowW = bodyW - UITheme.spacing.sm;
    const rowBodyH = ROW_H - ROW_GAP;
    const buyX = rowW - BUY_W - UITheme.spacing.sm;
    // 价格列右沿与余额读数共用一处算法：两者必须落在同一条竖线上
    const priceRight = priceRightEdge(bodyW);
    const priceX = priceRight - PRICE_W;

    items.forEach((item, i) => {
      const itemDef = this.inventoryData.getItemDef(item.itemId);
      const name = this.r(itemDef?.name ?? item.itemId);
      const price = item.price ?? itemDef?.buyPrice ?? 0;
      const canBuy = coins >= price;
      const ry = i * ROW_H;
      // 焦点 id 用**行序**而不是 itemId：同一件货可以在铺子里配两条（不同价），
      // 用 itemId 会撞成一个，买完重建后焦点会跳到另一条上。
      const id = `buy:${i}`;

      const rowBg = new Graphics();
      drawPanelBase(rowBg, 0, ry, rowW, rowBodyH, SKINS.row);
      list.content.addChild(rowBg);

      // 货名 = 这一行的主角，与行囊右栏的物品名同档（title）：两块面板说的是同一件东西，
      // 字号不一样会读成两套系统。原来的 bodyLarge 让它和「购买」按钮字一样大，
      // 一行里主角和配角平起平坐。
      const nameT = createStyledText({
        text: name,
        style: {
          fontSize: UITheme.fontSize.title,
          fill: canBuy ? UITheme.colors.bodyLight : UITheme.colors.disabled,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true,
          wordWrapWidth: priceX - UITheme.spacing.md * 2,
        },
      });
      nameT.x = UITheme.spacing.md;
      nameT.y = ry + Math.round((rowBodyH - nameT.height) / 2);
      list.content.addChild(nameT);

      // 价格：配角，扫一眼级别，留在 body 档（比货名低两档，但仍要一眼读得出数）。
      // **右对齐**贴住按钮左沿——左对齐时「1 文」和「128 文」的个位数错开，
      // 一列价格看不出贵贱；价格永远不折行，故不开 wordWrap。
      const priceT = createStyledText({
        text: `${price} ${this.strings.get('shop', 'unit')}`,
        style: {
          fontSize: UITheme.fontSize.body,
          fill: canBuy ? UITheme.colors.goldDim : UITheme.colors.disabled,
          fontFamily: UITheme.fonts.ui,
        },
      });
      priceT.x = priceRight - Math.round(priceT.width);
      priceT.y = ry + Math.round((rowBodyH - priceT.height) / 2);
      list.content.addChild(priceT);

      // 行悬停 = 琥珀铺光 + 金描边（设计稿里选中不是「换个深色」而是「点亮一档」）。
      // 命中带只铺到价格列右缘，把按钮那一格让给 UIButton 自己的三态；
      // **不接 pointerdown**：这里没有"选中行"这回事，接了就等于凭空多消费一次指针。
      //
      // 指针与焦点**共用同一套画法**、各拿一个开关：谁亮着行就亮着。分成两个 flag 是因为
      // 鼠标移开时焦点可能还停在这一行（手柄/鼠标共用同一个"当前项"），此时不能把行擦暗。
      let hovered = false;
      let focused = false;
      const paintRow = (): void => {
        const active = hovered || focused;
        rowBg.clear();
        if (active) drawSelectedRow(rowBg, 0, ry, rowW, rowBodyH);
        else drawPanelBase(rowBg, 0, ry, rowW, rowBodyH, SKINS.row);
        nameT.style.fill = canBuy
          ? (active ? UITheme.colors.title : UITheme.colors.bodyLight)
          : UITheme.colors.disabled;
      };

      const hoverHit = new Graphics();
      hoverHit.rect(0, ry, buyX - UITheme.spacing.sm, rowBodyH);
      hoverHit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
      hoverHit.eventMode = 'static';
      hoverHit.on('pointerover', () => {
        hovered = true;
        paintRow();
        // 悬停即移焦：鼠标和手柄共用"当前项"，移开鼠标再按方向键是从这一行继续走。
        // 买不起的行不在焦点集里，syncHover 自动 no-op（焦点留在原处，不被拽走）。
        this.focus.syncHover(id);
      });
      hoverHit.on('pointerout', () => {
        hovered = false;
        paintRow();
      });
      list.content.addChild(hoverHit);

      // 买不起时按钮 disabled：文案换「[不足]」、不可点——与旧实现同义，多了灰态与 press 态
      const buy = new UIButton({
        label: canBuy ? this.strings.get('shop', 'buy') : this.strings.get('shop', 'insufficient'),
        width: BUY_W,
        height: rowBodyH,
        // 每行都有一枚的重复控件：缺省 bodyLarge 时「[购买]」四个字几乎顶满 96 的钮宽，
        // 一列五枚亮黄按钮比货名还响。退到 body 档，主角让给货名。
        fontSize: UITheme.fontSize.body,
        variant: 'primary',
        disabled: !canBuy,
        onPress: () => this.doPurchase(item.itemId, price),
        onSound: this.sound,
      });
      buy.container.position.set(buyX, ry);
      buy.container.on('pointerover', () => this.focus.syncHover(id));
      list.content.addChild(buy.container);

      // 一行 = 一个焦点项：亮的是整行（琥珀铺光）+ 那枚钮（UIButton 的活跃态），
      // 回车即买。买不起的行 disabled——方向键跳过它，与那枚点不动的「[不足]」一致。
      focusItems.push({
        id,
        x: 0,
        y: listTop + ry,
        w: rowW,
        h: rowBodyH,
        group: 'rows',
        disabled: !canBuy,
        onFocus: (f) => {
          focused = f;
          paintRow();
          buy.setSelected(f);
          if (f) this.scrollRowIntoView(i);
        },
        onActivate: () => this.doPurchase(item.itemId, price),
      });
    });

    list.refresh();
    return focusItems;
  }

  /** 焦点挪到视口外的行时把它滚进来（否则"焦点恒可见"这条就断了）。 */
  private scrollRowIntoView(index: number): void {
    const list = this.list;
    if (!list) return;
    const top = index * ROW_H;
    const bottom = top + (ROW_H - ROW_GAP);
    if (top < list.scrollOffset) list.scrollOffset = top;
    else if (bottom > list.scrollOffset + list.viewportHeight) {
      list.scrollOffset = bottom - list.viewportHeight;
    }
  }

  private doPurchase(itemId: string, price: number): void {
    // 购买链路全同步（EventBus 同步派发 → shopPurchase handler 同步扣钱/加物品），
    // emit 返回时余额/背包已定，立即重建即可反映结果（含失败路径的余额不变）。
    this.eventBus.emit('shop:purchase', { itemId, price });
    this.build();
  }

  private destroyUI(): void {
    this.list?.destroy();
    this.win?.destroy();
    this.list = null;
    this.win = null;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    this.focus.destroy();
    this.destroyUI();
    this.shopDefs.clear();
  }
}
