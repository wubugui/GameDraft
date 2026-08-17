import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from '../UITheme';
import { SKINS } from '../PanelSkin';
import { buildRichContent, buildRichDoc, RICH_DARK, type RichBlock, type RichContentOptions } from '../RichContent';
import { createRule } from './UIDecor';
import { UIListRow } from './UIListRow';
import { UIFocus, type FocusItem } from './UIFocus';
import { UIWindow } from './UIWindow';
import { UIScrollView } from './UIScrollView';
import type { Renderer } from '../../rendering/Renderer';
import type { ActionDef, IArchiveDataProvider } from '../../data/types';
import type { AssetManager } from '../../core/AssetManager';
import { createStyledText } from '../../core/styledText';

/**
 * 档案册通用视图：左列表 + 右正文，全站四本册子（见闻录 / 杂书匣 / 人物簿 / 怪话册）
 * 共用一套实现。
 *
 * 合并前这四个文件逐行重复 52%~76%（DocumentBoxUI 与 LoreBookUI 76% 相同），
 * 各自手写同一套遮罩、滚轮偏移、未读星、`triggerFirstViewIfNeeded + markRead + 显示正文`。
 * 差异只有三处，全部收成配置：**分组表头**（怪话册按类分组）、**灰槽**（未收集条目
 * 不可点）、**正文怎么拼**（来源/按语/印象各不同）。
 *
 * 观感口径（tmp/ui_mockups_2026-08-03 的规矩本 06 / 行囊 04）：
 * 左栏是一叠行牌（选中整条铺琥珀 + 金描边、未读一颗红点），两栏之间一条极淡竖线，
 * 右栏是「琥珀大标题 → 渐隐横线 → 纸灰白正文」。**正文首行不再重复标题**——
 * 标题由这里统一渲染，各册的 `buildDetail()` 只出正文。
 *
 * ## 右栏为什么**不是**一张米白纸页（2026-08-17 撤销批3a 的"商业档案观感"）
 *
 * 曾经这里嵌了一块 `SKINS.paperPage`（米白旧纸 + 墨字），实测数据：面板内容区的底是
 * **(9,8,6)**、相对亮度 0.0024，而那张纸是 (220,203,170)、亮度 0.608——**亮 248 倍**，
 * 两者之间的对比度 12.6:1。也就是说，在一款整屏都活在明度最低那 5% 里的夜戏游戏里，
 * 这块 UI 自己成了全屏最亮的光源，比主菜单标题、比三把火、比场景里任何一盏灯都亮。
 * 三条后果，条条踩在这游戏的立身之本上：
 *
 * 1. **它是一盏灯**。暗近黑 + 旧木 + 琥珀这套配色的分量全在"暗"上；开一块亮面板等于
 *    在志怪夜戏中间打开日光灯，气氛一刀两断。
 * 2. **它烧掉暗适应**。恐怖游戏刻意把玩家的眼睛养在暗适应状态里，场景的辐射度还原
 *    也是照着这个前提烘的；看完一屏亮纸再退回场景，那些幽微的层次要好几秒才看得见——
 *    等于用 UI 主动破坏自家美术最贵的那部分。
 * 3. **它是第五种材质、第二套色板**。全站语汇是"木牌 + 暗底 + 琥珀"，纸页只出现在册子
 *    与成书两处，读起来像从另一个游戏贴过来的；且它逼出一整套 `paperInk`
 *    （五档灰 + 六个语义色 + 词条色）要与暗底那套**永远同步维护**。
 *
 * 现在右栏回到规矩本那条已定稿的版式：**两栏＝一本摊开的书的两页**，中间一条极淡竖线，
 * 右栏没有自己的底。要"纸"的意思，靠的是纸纹材质与暖色，不是靠把明度拉到顶。
 */

/** 一行条目。`enabled:false` 即灰槽——列出来但点不动（怪话册的未收集格）。 */
export interface ArchiveRow {
  /** 已读标记与首阅动作的稳定键，如 `lore_xxx` */
  key: string;
  label: string;
  enabled: boolean;
  firstViewActions?: ActionDef[];
  /** 点开时现拼正文（rich content 标记字符串）。**不含标题**——标题走 `label` */
  buildDetail?: () => string;
  /**
   * 结构化正文（优先于 buildDetail）：五本册子把印象/例句/来源/批注拼成块结构，
   * 语义字段各有声部（标题/引文/弱化段），不再拍平成一种字号一种颜色（审查 P1 最实锤）。
   */
  buildDetailDoc?: () => RichBlock[];
}

/** 一个分组。`header` 留空即不分组（见闻录/杂书匣/人物簿都是单组）。 */
export interface ArchiveSection {
  header?: string;
  /** 表头是否用高亮色（怪话册用来标"这一类集齐了"） */
  headerAccent?: boolean;
  rows: ArchiveRow[];
}

export interface ArchiveBookViewOptions {
  title: string;
  /**
   * 标题右侧次要文字，如「已记 3 / 15」。**用回调不用常量**——收集进度会变，
   * 构造期算死的话复用实例时就永远停在初值。
   */
  subtitle?: () => string;
  closeHint?: string;
  /** 一条都没有时显示的话 */
  emptyText: string;
  /** 每次重绘现算（未读星、进度、集齐态都会变） */
  buildSections: () => ArchiveSection[];
  onClose: () => void;
}

/**
 * 线索通道（K7）：正文里 `[clue:id]` 词条的状态查询与采集入口。
 * **模块级单点注入**（Game 启动时给一次，与 textStyle 的色板注入同一先例）——
 * 六本册子 + 成书阅读器全走这一个口，不逐壳穿构造签名。未注入时词条按 fresh
 * 颜色渲染、点击无事发生（jsdom 测试/预览态安全）。
 */
export interface ClueAccess {
  isCollected(id: string): boolean;
  collect(id: string): void;
}

let clueAccess: ClueAccess | null = null;

export function setArchiveClueAccess(a: ClueAccess | null): void {
  clueAccess = a;
}

export function getArchiveClueAccess(): ClueAccess | null {
  return clueAccess;
}

/**
 * 左栏列宽。条目名走 body 档（20），列窄了「[传说] 城隍庙夜话」这类名字要折三行，
 * 一屏就只剩五六条——**宽一点反而更密**。右栏仍有 450+ 的正文宽度，不亏。
 */
const LIST_W = 248;
/** 行牌最小高度（文字换行时按实际高度撑开） */
const ROW_H = 36;
/** 行牌之间的缝 */
const ROW_GAP = UITheme.spacing.xs;
/** 分组表头占的总高：small 档一行（~20）+ 横线 + 到首行的呼吸 */
const HEADER_H = 36;
/** 未读红点半径与它占掉的左缩进 */
const DOT_R = 3.5;
const DOT_COL_W = 16;
/**
 * 右栏正文行距。册子是**拿来读几秒到几十秒**的整段文字，body 档 20px 配 22 的行距
 * 等于 1.1 倍，中文方块字在这个行距下会连成一堵墙。1.6 倍才是长文该有的呼吸。
 */
const DETAIL_LINE_H = 32;
/**
 * 正文栏离中缝的内白。
 *
 * 曾经这里是"米白纸页"的页边距（批3a 的商业档案观感），已撤——**这个游戏没有亮面板**，
 * 理由见 {@link ArchiveBookView} 顶部的注释。留下的是它带来的那条纪律：
 * 中缝位置 / 滚动视口宽 / 排版换行宽**必须同出一源**。旧版三者互相不认账
 * （换行宽比视口还宽 12px），长行末字被切在栏外——歪歌册截图里「只有」「脑壳」两处。
 */
export const PAGE_PAD = UITheme.spacing.xl;

export class ArchiveBookView {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private assetManager: AssetManager;
  private opts: ArchiveBookViewOptions;

  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private detail: UIScrollView | null = null;
  private detailKey: string | null = null;
  /** 本次布局实际用的左栏宽（窄画布下按内容区比例收一道，见 `build`） */
  private listW = LIST_W;
  /** 本次布局的正文栏宽（= 纸宽 - 两倍页边距）。视口与换行共用这一个值 */
  private detailW = 1;
  /**
   * 键盘/手柄焦点。册子只有左栏条目一组可交互（右栏是正文，窗体的 ✕ / 关闭提示归 `UIWindow`），
   * 所以不分多组；灰槽（未收集条目）以 `disabled` 登记，不吃焦点。
   */
  private focus = new UIFocus();
  private focusItems: FocusItem[] = [];
  /** 默认焦点只在首次打开时指定；点条目引起的重建靠 setItems 按 key 复位 */
  private focusInit = false;
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(
    renderer: Renderer,
    archiveData: IArchiveDataProvider,
    assetManager: AssetManager,
    opts: ArchiveBookViewOptions,
  ) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.assetManager = assetManager;
    this.opts = opts;
    this.onKeyBound = (e) => this.onKey(e);
  }

  open(): void {
    window.addEventListener('keydown', this.onKeyBound);
    this.build(true);
  }

  close(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    // 关场淡出：先把输入面摘干净（滚动区的 wheel/拖动、上面的 keydown），
    // 再让窗体带着视觉淡出自毁——尸体窗只是视觉，绝不吃输入。
    // 重建路径（build → teardown）保持瞬时 destroy，不走这里。
    this.list?.detachInput();
    this.detail?.detachInput();
    const win = this.win;
    this.list = null;
    this.detail = null;
    this.win = null;
    win?.fadeOutAndDestroy();
    this.focus.destroy();
    this.focusItems = [];
    // 复位默认焦点标志：四本册子的 view 实例是**跨开关复用**的（LoreBookUI 等在构造期建一次），
    // 不复位的话第二次打开会落到 setItems 的兜底首项，而不是上次读到的那一条。
    this.focusInit = false;
  }

  /** 供书架当子面板句柄用（真销毁走瞬时路径，不播关场动画） */
  destroy(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
    this.focus.destroy();
    this.focusItems = [];
    this.focusInit = false;
  }

  private teardown(): void {
    this.list?.destroy();
    this.detail?.destroy();
    this.win?.destroy();
    this.list = null;
    this.detail = null;
    this.win = null;
  }

  /**
   * 方向键挪焦点、回车/空格打开条目；**焦点优先、滚动兜底**——
   * 走到列表最后一条时 `focus.handleKey` 让回按键，才轮到 `UIScrollView` 继续滚。
   */
  private onKey(e: KeyboardEvent): void {
    if (!this.list) return;
    if (this.focus.handleKey(e.code)) {
      this.scrollFocusIntoView();
      e.preventDefault();
      return;
    }
    if (this.list.handleKey(e.code)) e.preventDefault();
  }

  /**
   * 焦点挪到视口外的行时把它滚进来。
   * 焦点矩形登记的是**内容坐标**（不含滚动位移），所以直接与 `scrollOffset` 比大小即可。
   */
  private scrollFocusIntoView(): void {
    const list = this.list;
    const cur = this.focus.current;
    if (!list || !cur) return;
    if (cur.y < list.scrollOffset) list.scrollOffset = cur.y;
    else if (cur.y + cur.h > list.scrollOffset + list.viewportHeight) {
      list.scrollOffset = cur.y + cur.h - list.viewportHeight;
    }
  }

  /**
   * @param animate 仅首次打开为 true。点条目触发的重绘必须走 `attach()`，
   * 否则每点一行都重放一遍开场动画；而**忘了挂载**会让整个面板直接从画面消失
   * （旧实现把挂载藏在 open() 里，重绘时新窗体无人挂——四本册子一点就废）。
   */
  private build(animate = false): void {
    const keepList = this.list?.scrollOffset ?? 0;
    const keepDetail = this.detailKey;
    this.teardown();

    const win = new UIWindow(this.renderer, {
      // 册子是**两栏阅读面板**：左边一列条目名（body 档）、右边整段正文（body 档 + 1.6 行距）。
      // md（760×570）是按旧的小字号定的，字号抬起来后左栏每两条就要折一行、右栏一屏只剩十来行。
      // lg（850×630）在 1024×768 上仍有充裕边距，却能多出 ~1.5 行条目与一整块正文宽度。
      size: 'lg',
      title: this.opts.title,
      subtitle: this.opts.subtitle?.(),
      closeHint: this.opts.closeHint,
      skin: SKINS.book,
      onClose: this.opts.onClose,
    });
    this.win = win;

    // 窄画布（F2 调试坞挤压 #game-mount）下左栏按内容区比例收一道，
    // 否则 248 的定宽会把右栏挤成负宽度。
    this.listW = Math.max(140, Math.min(LIST_W, Math.round(win.bodyWidth * 0.36)));
    const listW = this.listW;

    // 两栏之间一条极淡竖线（书脊位），与规矩本同一条：这是"一本摊开的书的两页"，
    // 不是"暗底面板里嵌了一张亮纸"。竖线之外不给右栏任何底——右栏就是这块面板本身。
    const dividerX = listW + UITheme.spacing.lg;
    const divider = new Graphics();
    divider.rect(dividerX, 0, 1, win.bodyHeight);
    divider.fill({ color: UITheme.colors.hairline, alpha: UITheme.alpha.hairline });
    divider.eventMode = 'none';
    win.body.addChild(divider);

    // 中缝 / 视口宽 / 换行宽同出一源（见 PAGE_PAD）；右沿留一档给滚动条的道
    const detailX = dividerX + PAGE_PAD;
    const detailW = Math.max(1, win.bodyWidth - detailX - UITheme.spacing.sm);
    this.detailW = detailW;

    // 滚轮分栏：鼠标在左栏滚列表、在右栏滚正文。
    // 边界**每次现读** win.body.x —— 窗口 resize 会重算居中位移，捕获成常量会让分栏判据错位。
    const splitX = (): number => (this.win?.body.x ?? 0) + listW;
    const list = new UIScrollView(this.renderer, {
      width: listW,
      height: win.bodyHeight,
      hitTest: (x) => x < splitX(),
    });
    list.container.position.set(0, 0);
    win.body.addChild(list.container);
    this.list = list;

    const detail = new UIScrollView(this.renderer, {
      width: detailW,
      height: win.bodyHeight,
      hitTest: (x) => x >= splitX(),
    });
    detail.container.position.set(detailX, 0);
    win.body.addChild(detail.container);
    this.detail = detail;

    this.focusItems = [];
    // 首开自动选中第一条可读条目（审查 P1：右栏 60% 首开全空）。**只展示不 markRead、
    // 不触发 firstViewActions**——那两样是"玩家主动点开"的语义，红点留给他自己消。
    if (!this.detailKey) {
      const first = this.opts.buildSections().flatMap(s => s.rows).find(r => r.enabled);
      if (first) this.detailKey = first.key;
    }
    this.fillList();
    list.scrollOffset = keepList;
    if (keepDetail ?? this.detailKey) this.showDetailByKey(keepDetail ?? this.detailKey!);

    // 点条目 → 重绘列表，`setItems` 按 key 把焦点放回原处（新一批显示对象另算）
    this.focus.setItems(this.focusItems);
    if (!this.focusInit) {
      // 默认焦点落**当前正在看的那一条**（主机 UI 的惯例是最常用那一项），
      // 没有正在看的（首次打开）才退到第一条可点条目
      const preferred = this.detailKey ?? this.focusItems.find(i => !i.disabled)?.id;
      if (preferred) this.focus.focusDefault(preferred);
      this.focusInit = true;
    }
    // setItems 按同 key 复位时不会重放 onFocus（currentId 没变），新一批行牌拿不到高亮 → 补一次
    this.focus.current?.onFocus(true);
    this.scrollFocusIntoView();

    if (animate) win.open();
    else win.attach();
  }

  private fillList(): void {
    const list = this.list;
    if (!list) return;
    const sections = this.opts.buildSections();
    const total = sections.reduce((n, s) => n + s.rows.length, 0);

    if (total === 0) {
      const empty = createStyledText({
        text: this.opts.emptyText,
        style: {
          fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true,
          wordWrapWidth: this.listW - UITheme.spacing.md,
        },
      });
      list.content.addChild(empty);
      list.refresh();
      return;
    }

    // 滚动条占掉右边 4px，行牌收窄一档，免得金描边被压在条底下
    const rowW = this.listW - UITheme.spacing.sm;
    let cy = 0;
    for (const sec of sections) {
      if (sec.header) {
        // 分组表头是**给条目分类的标签**，不是条目本身：拉字距 + 暖灰/金 + 一条横线
        // 已经说清"这是一组的开头"，字号再压过条目名就成了抢戏的中标题。
        const h = createStyledText({
          text: sec.header,
          style: {
            fontSize: UITheme.fontSize.small,
            fill: sec.headerAccent ? UITheme.colors.gold : UITheme.colors.hintMid,
            fontFamily: UITheme.fonts.display, fontWeight: 'bold',
            letterSpacing: UITheme.letterSpacing.title,
          },
        });
        h.y = cy;
        h.eventMode = 'none';
        list.content.addChild(h);
        const rule = createRule(rowW);
        rule.y = cy + h.height + UITheme.spacing.xs;
        list.content.addChild(rule);
        cy += HEADER_H;
      }
      for (const row of sec.rows) {
        cy = this.drawRow(row, cy, rowW);
      }
      // 组与组之间要能一眼看出断开：sm(8) 只比行间缝 xs(4) 多 4px，
      // 下一组的表头会贴在上一组末行上，分组等于白分。
      cy += UITheme.spacing.lg;
    }
    list.refresh();
  }

  /** 一条行牌（UIListRow 原语：tap 激活 + 拖滚让路 + 消费标记 + 焦点铺光全内建），返回下一行的 y。 */
  private drawRow(row: ArchiveRow, cy: number, rowW: number): number {
    const list = this.list;
    if (!list) return cy;
    const selected = this.detailKey === row.key;
    const unread = row.enabled && !this.archiveData.isRead(row.key);
    const textX = DOT_COL_W + UITheme.spacing.xs;

    const label = createStyledText({
      text: row.label,
      style: {
        fontSize: UITheme.fontSize.body,
        fill: !row.enabled
          ? UITheme.colors.disabled
          : (selected ? UITheme.colors.title : UITheme.colors.bodyMuted),
        fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true,
        wordWrapWidth: rowW - textX - UITheme.spacing.sm,
      },
    });
    // 上下留 md 而不是 sm：条目名抬到 body 档后，折成两行的长名字在 sm 留白下
    // 会顶到行牌的金描边上。单行行高由 ROW_H 兜底，整列节奏保持一致。
    const rowH = Math.max(ROW_H, label.height + UITheme.spacing.md);

    const listRow = new UIListRow({
      width: rowW,
      height: rowH,
      selected,
      disabled: !row.enabled,
      baseOverrides: row.enabled ? undefined : { fillAlpha: UITheme.alpha.rowBgLight },
      onTap: () => this.selectRow(row),
      // 悬停即移焦：鼠标与手柄共用同一个"当前项"
      onHover: () => this.focus.syncHover(row.key),
    });
    listRow.container.y = cy;
    list.content.addChild(listRow.container);

    if (unread) {
      const dot = new Graphics();
      dot.circle(DOT_COL_W / 2 + UITheme.spacing.xs, rowH / 2, DOT_R);
      dot.fill(UITheme.colors.redDot);
      dot.eventMode = 'none';
      listRow.container.addChild(dot);
    }

    label.x = textX;
    label.y = Math.round((rowH - label.height) / 2);
    label.eventMode = 'none';
    listRow.container.addChild(label);

    // 灰槽（怪话册未收集的条目）以 disabled 登记：列出来占位，但方向键不落上去
    this.focusItems.push({
      id: row.key,
      x: 0, y: cy, w: rowW, h: rowH,
      // 左栏条目自成一组（右栏是正文、窗体 ✕ 归 UIWindow），一组之内上下走
      group: 'rows',
      disabled: !row.enabled,
      onFocus: (on) => {
        listRow.setFocused(on);
        if (!label.destroyed && row.enabled && !selected) {
          label.style.fill = on ? UITheme.colors.title : UITheme.colors.bodyMuted;
        }
      },
      onActivate: () => this.selectRow(row),
    });

    return cy + rowH + ROW_GAP;
  }

  private selectRow(row: ArchiveRow): void {
    this.archiveData.triggerFirstViewIfNeeded(row.key, row.firstViewActions);
    this.archiveData.markRead(row.key);
    this.detailKey = row.key;
    // 未读红点要消失、选中态要挪位 → 重绘列表；build() 会保留滚动位置与当前正文
    this.build();
  }

  private showDetailByKey(key: string): void {
    for (const sec of this.opts.buildSections()) {
      const row = sec.rows.find(r => r.key === key);
      if (row) { this.renderDetail(row); return; }
    }
  }

  /** 右栏：琥珀大标题 → 一条渐隐横线 → 暖灰正文（run 级版式引擎，见 RichContent）。 */
  private renderDetail(row: ArchiveRow, keepScroll = false): void {
    const detail = this.detail;
    if (!detail) return;
    const prevScroll = detail.scrollOffset;
    detail.content.removeChildren().forEach(c => c.destroy({ children: true }));
    const w = this.detailWidth();
    let y = 0;

    const heading = createStyledText({
      text: row.label,
      style: {
        fontSize: UITheme.fontSize.title,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true, breakWords: true, wordWrapWidth: w,
      },
    });
    heading.eventMode = 'none';
    detail.content.addChild(heading);
    y += heading.height + UITheme.spacing.sm;

    const rule = createRule(w);
    rule.y = y;
    detail.content.addChild(rule);
    // 正文行距抬到 32 之后，标题横线与首行之间也得跟着让开一档，
    // 否则首行贴着横线、后面每行反而更松，读起来头重脚轻。
    y += UITheme.spacing.xl;

    const docBlocks = row.buildDetailDoc?.();
    const buildOpts: RichContentOptions = {
      width: w,
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.ui,
      lineHeight: DETAIL_LINE_H,
      palette: RICH_DARK,
      // 插图是现装的（没人预载过册子里的 `[img:…]`），到位后整段重排。
      // **两道守卫**：面板可能已经关了（this.detail 为 null），或玩家已翻到另一条
      // （detailKey 变了）——那就别把旧条目的正文画回去。
      // keepScroll=true：重排是插图到位引起的，读者读到哪就停在哪，不弹回顶（审查 P2）。
      onImageLoaded: () => {
        if (!this.detail || this.detailKey !== row.key) return;
        this.renderDetail(row, true);
      },
      // K7 线索词条：状态色 + 点击采集。采集后**延迟重画**换到暗金常驻——
      // 立刻重画会把"闪金"那 280ms 的采集动画连容器一起拆掉。
      linkStateResolver: (link) =>
        (link.kind === 'clue' && getArchiveClueAccess()?.isCollected(link.id) ? 'collected' : 'fresh'),
      onLinkTap: (link) => {
        const clues = getArchiveClueAccess();
        if (link.kind !== 'clue' || !clues) return;
        clues.collect(link.id);
        window.setTimeout(() => {
          if (this.detail && this.detailKey === row.key) this.renderDetail(row, true);
        }, 320);
      },
    };
    const { container } = docBlocks
      ? buildRichDoc(docBlocks, buildOpts, this.assetManager)
      : buildRichContent(row.buildDetail?.() ?? '', buildOpts, this.assetManager);
    container.y = y;
    detail.content.addChild(container);

    detail.refresh();
    detail.scrollOffset = keepScroll ? prevScroll : 0;
  }

  private detailWidth(): number {
    return this.detailW;
  }
}
