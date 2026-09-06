import { Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { createBadge, drawFocusRing, drawHoverRow } from './components/UIDecor';
import { markPointerConsumed } from './uiPointerCoords';
import { UIWindow, WINDOW_CHROME } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { UIFocus, type FocusItem, type FocusVia } from './components/UIFocus';
import { openConfirmDialog } from './components/UIConfirmDialog';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { IZoneDataProvider, IRulesDataProvider, ZoneRuleSlot, RuleLayerKey } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';

interface ResolvedRuleSlot {
  slot: ZoneRuleSlot;
  ruleName: string;
  enabled: boolean;
  progressText?: string;
}

/**
 * 面板宽。420 是按更小的字定的：标题走 UIWindow 的居中 `display`(44)，「使用规矩」四个字
 * 加字距就有 ~190px，占掉将近一半面板宽，两翼横线只剩两截短渣，规矩名也没地方铺。
 * 放到 520：标题回到"占三分之一"的正常观感，行里也放得下十来个字的规矩名。
 */
const PANEL_W = 520;
/** 行高：与规矩本列表同一套语汇，`bodyLarge`(25) 的规矩名要 40+ 才不贴边 */
const ROW_H = 48;
const ROW_GAP = 5;
/** 行首圆徽章（承载「第几条」）的半径与左边距 */
const BADGE_R = 13;
const BADGE_X = 24;
/** 槽位多了就滚，不再把面板撑高（行高抬了一档，可视条数保持 8 条） */
const LIST_MAX_H = 384;
/** 底部「按 Esc 关闭」键帽行在内容区里占掉的高度 */
const HINT_H = 34;
/**
 * UIWindow 在内容区之外吃掉的竖向空间，用于按槽位数反推窗高（排版仍回读 win.bodyWidth/bodyHeight）。
 *
 * ⚠ 原来写死 64，比真值小 32：带标题的 UIWindow 是 `titleBarHeight`(76) + 底部 `padding`(20)，
 * 于是列表视口比算出来的 listH 矮 32px，**最后一行永远被切掉**；底部关闭键帽又画在 overlay 层，
 * 正好压在倒数第二行上。这里改成从 WINDOW_CHROME 取真值，并额外留出键帽行。
 */
const WINDOW_CHROME_H = WINDOW_CHROME.titleBarHeight + WINDOW_CHROME.padding + HINT_H;

export class RuleUseUI {
  private renderer: Renderer;
  private closeRequester: (() => void) | null = null;
  private eventBus: EventBus;
  private zoneData: IZoneDataProvider;
  private rulesData: IRulesDataProvider;
  private strings: StringsProvider;

  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private _isOpen: boolean = false;
  private resolveDisplay: ((s: string) => string) | null = null;
  private onKeyBound: (e: KeyboardEvent) => void;
  /**
   * 键盘 / 手柄焦点。本面板只有**槽位列表**一组：可用的规矩行吃焦点，
   * 还在攒碎片的行 `disabled`（它本来就点不动，焦点也不该停上去）。
   *
   * 高亮**复用行自己的悬停画法**（`drawSelectedRow` 铺琥珀 + 收掉底下那层常态底），
   * 不另发明一种焦点框。✕ 与底部「按 Esc 关闭」由 UIWindow 自己画，面板拿不到句柄。
   */
  private focus = new UIFocus();

  constructor(
    renderer: Renderer,
    eventBus: EventBus,
    zoneData: IZoneDataProvider,
    rulesData: IRulesDataProvider,
    strings: StringsProvider,
  ) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.zoneData = zoneData;
    this.rulesData = rulesData;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  get isOpen(): boolean { return this._isOpen; }

  /**
   * 本区当前有没有能摆上台面的规矩槽（含收集中的灰条）。
   * 给 GameStateController 注册时的 openGuard 用：HUD 亮着 [G] 而这里为空时，
   * 守卫在拒绝的同时发提示——「按了没反应」是审查点名的死键体验（P1）。
   */
  hasUsableSlots(): boolean {
    return this.resolveSlots().length > 0;
  }

  open(): void {
    if (this._isOpen) return;
    const slots = this.resolveSlots();
    if (slots.length === 0) return;

    this._isOpen = true;
    this.build(slots);
    // 本面板此前**没有任何键盘入口**（只能用鼠标点）。方向键/回车走 UIFocus，
    // 与活计/规矩本两块面板同一范式；Esc 仍归全局关闭通道，这里不碰。
    window.addEventListener('keydown', this.onKeyBound);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    // 关场淡出（绕开 build/destroy 共用的瞬时 destroyUI）：先摘滚动区输入面，
    // 再让窗体带视觉淡出自毁——逻辑态已同步落定，尸体窗只是视觉。
    this.list?.detachInput();
    const win = this.win;
    this.list = null;
    this.win = null;
    win?.fadeOutAndDestroy();
    this.focus.destroy();
  }

  private resolveSlots(): ResolvedRuleSlot[] {
    const rawSlots = this.zoneData.getCurrentRuleSlots();
    const result: ResolvedRuleSlot[] = [];

    for (const slot of rawSlots) {
      const ruleDef = this.rulesData.getRuleDef(slot.ruleId);
      if (!ruleDef) continue;

      const req = slot.requiredLayers;
      const layersOk =
        !req?.length
          ? this.rulesData.hasRule(slot.ruleId)
          : req.every((L: RuleLayerKey) => this.rulesData.hasLayer(slot.ruleId, L));

      if (layersOk) {
        result.push({ slot, ruleName: this.r(ruleDef.name), enabled: true });
      } else if (!ruleDef.narrativeStates && this.rulesData.isDiscovered(slot.ruleId)) {
        const progress = this.rulesData.getFragmentProgress(slot.ruleId);
        const displayName = this.r(ruleDef.incompleteName ?? this.strings.get('ruleUse', 'unknown'));
        const depth = this.rulesData.getRuleDepth(slot.ruleId);
        const progressText = req?.length
          ? `${depth.unlocked}/${depth.total}`
          : `${progress.collected}/${progress.total}`;
        result.push({
          slot,
          ruleName: displayName,
          enabled: false,
          progressText,
        });
      }
    }
    return result;
  }

  private build(slots: ResolvedRuleSlot[]): void {
    this.destroyUI();

    const maxListH = Math.max(
      ROW_H,
      Math.min(LIST_MAX_H, this.renderer.screenHeight - WINDOW_CHROME_H - UITheme.spacing.xxl * 2),
    );
    const listH = Math.min(Math.max(slots.length * ROW_H, ROW_H), maxListH);

    const win = new UIWindow(this.renderer, {
      size: { width: PANEL_W, height: listH + WINDOW_CHROME_H },
      title: this.strings.get('ruleUse', 'title'),
      closeHint: this.strings.get('ruleUse', 'closeHint'),
      onClose: () => this.requestClose(),
    });
    this.win = win;

    // 视口高度必须把底部键帽那一条让出来：键帽挂在 UIWindow 的 overlay 层（恒在内容之上），
    // 视口铺满 bodyHeight 时它会压住最后一行。
    const list = new UIScrollView(this.renderer, {
      width: win.bodyWidth,
      height: Math.max(ROW_H, win.bodyHeight - HINT_H),
    });
    list.container.position.set(0, 0);
    win.body.addChild(list.container);
    this.list = list;

    // 右侧留出滚动条的道
    const rowW = win.bodyWidth - UITheme.spacing.sm;
    const rowBodyH = ROW_H - ROW_GAP;
    // 焦点项与画面同批攒出来。列表容器就贴在内容区原点（0,0），行的滚动区内坐标
    // 直接就是面板坐标，不必再加偏移。
    const focusItems: FocusItem[] = [];

    slots.forEach((s, i) => {
      const ry = i * ROW_H;

      const rowBg = new Graphics();
      drawPanelBase(rowBg, 0, ry, rowW, rowBodyH, SKINS.row, {
        fill: s.enabled ? UITheme.colors.rowBgDark : UITheme.colors.rowBgInactive,
        border: s.enabled ? UITheme.colors.borderActive : UITheme.colors.borderSubtle,
      });
      list.content.addChild(rowBg);

      // 悬停（极淡暖底）与导航光标（空心金框）两张，见 UIFocus 类注释的三态表。
      // 用规矩没有"选中"这一态——点一下就直接用掉了——所以只有这两张。
      // **必须紧跟 rowBg 加进去**：排在徽章/文字之后会把它们盖掉。
      let hoverBg: Graphics | null = null;
      let ringBg: Graphics | null = null;
      if (s.enabled) {
        hoverBg = new Graphics();
        drawHoverRow(hoverBg, 0, ry, rowW, rowBodyH);
        hoverBg.visible = false;
        hoverBg.eventMode = 'none';
        list.content.addChild(hoverBg);
        ringBg = new Graphics();
        drawFocusRing(ringBg, 0, ry, rowW, rowBodyH);
        ringBg.visible = false;
        ringBg.eventMode = 'none';
        list.content.addChild(ringBg);
      }

      // 行首圆徽章：可用的走琥珀、还在攒碎片的走灰，与规矩本列表同一套语汇
      const badge = createBadge(
        `${i + 1}`,
        s.enabled ? UITheme.colors.questMain : UITheme.colors.questCompleted,
        BADGE_R,
      );
      badge.position.set(BADGE_X, ry + rowBodyH / 2);
      badge.eventMode = 'none';
      list.content.addChild(badge);

      const text = createStyledText({
        text: s.ruleName,
        style: {
          // 规矩名是这一行的主角，与规矩本列表同档（bodyLarge）。
          fontSize: UITheme.fontSize.bodyLarge,
          fill: s.enabled ? UITheme.colors.body : UITheme.colors.disabled,
          fontFamily: UITheme.fonts.ui, fontWeight: 'bold', letterSpacing: UITheme.letterSpacing.hint,
          wordWrap: true, breakWords: true,
          // 右侧有碎片读数时多让一截，否则长规矩名会折到读数底下
          wordWrapWidth:
            rowW - BADGE_X - BADGE_R - UITheme.spacing.md
            - (s.progressText ? UITheme.spacing.xxl * 2 : UITheme.spacing.xl),
        },
      });
      text.x = BADGE_X + BADGE_R + UITheme.spacing.md;
      text.y = ry + Math.round((rowBodyH - text.height) / 2);
      // The whole-row target owns input; foreground labels must not intercept it.
      text.eventMode = 'none';

      // 攒碎片的进度压右侧，不再挤在规矩名后面的括号里
      if (s.progressText) {
        const prog = createStyledText({
          text: s.progressText,
          style: {
            // 「1/2」是纯**计数角标**：玩家扫一眼知道"还没攒齐"就够了。
            // 它是这块面板里最该小的一处，micro。
            fontSize: UITheme.fontSize.micro, fill: UITheme.colors.hintMid,
            fontFamily: UITheme.fonts.ui,
          },
        });
        prog.x = rowW - UITheme.spacing.md - prog.width;
        prog.y = ry + Math.round((rowBodyH - prog.height) / 2);
        prog.eventMode = 'none';
        list.content.addChild(prog);
      }

      const id = `slot:${i}`;
      if (s.enabled && hoverBg) {
        const hover = hoverBg;
        const ring = ringBg;
        /** 点亮/收回 = 行原本的悬停画法，焦点与指针共用这一套，不另发明焦点框 */
        /** on=该亮，via 决定亮哪一张；底板恒留着（两张新画法都是叠加，不再顶掉底板） */
        const light = (on: boolean, via: FocusVia = 'pointer'): void => {
          hover.visible = on && via === 'pointer';
          if (ring) ring.visible = on && via === 'key';
        };
        // 整行命中：Pixi 是逐子元素命中测试，命中区必须自己是一块 Graphics，
        // 且**不能**拿会被隐藏的 rowBg 当靶子（旧实现 hover 时把靶子 visible=false）
        const hit = new Graphics();
        hit.rect(0, ry, rowW, rowBodyH);
        hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        // 指针悬停即移焦：鼠标与手柄共用同一个"当前项"（移开鼠标再按方向键要从这里接着走）
        hit.on('pointerover', () => this.focus.syncHover(id));
        // 亮/灭统一由 onFocus 画：移开即 clearHover，hover 那层随之熄掉
        hit.on('pointerout', () => this.focus.clearHover(id));
        hit.on('pointerdown', (e) => {
          markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
          this.selectSlot(s);
        });
        list.content.addChild(hit);

        focusItems.push({
          id,
          x: 0, y: ry, w: rowW, h: rowBodyH,
          group: 'list',
          onFocus: (f, via) => {
            light(f, via);
            // 只在按键模式滚：鼠标划过时滚列表会把指针下的行抽走
            if (f && via === 'key') this.revealRow(i);
          },
          onActivate: () => this.selectSlot(s),
        });
      } else {
        // 还在攒碎片的槽位本来就点不动，焦点也不该停上去（UIFocus 自己把 disabled 滤掉）
        focusItems.push({
          id,
          x: 0, y: ry, w: rowW, h: rowBodyH,
          group: 'list',
          disabled: true,
          onFocus: () => {},
        });
      }

      list.content.addChild(text);
    });

    list.refresh();

    this.focus.setItems(focusItems);
    // **默认焦点不放左上角**：本面板没有"当前选中"这回事，落在第一条**能用**的规矩上
    // （前几条恰好都在攒碎片时，焦点不该白白停在一条点不动的行上）。
    const firstUsable = focusItems.find(f => !f.disabled);
    if (firstUsable) this.focus.focusDefault(firstUsable.id);
    this.focus.repaint();

    win.open();
  }

  /** 焦点落到视口外的行时把它滚进来。只动 `scrollOffset`。 */
  private revealRow(index: number): void {
    const list = this.list;
    if (!list) return;
    const top = index * ROW_H;
    const bottom = top + ROW_H - ROW_GAP;
    if (top < list.scrollOffset) list.scrollOffset = top;
    else if (bottom > list.scrollOffset + list.viewportHeight) {
      list.scrollOffset = bottom - list.viewportHeight;
    }
  }

  /**
   * 键盘 / 手柄：**焦点优先，滚动兜底**。
   *
   * 方向键先交给 `UIFocus` 挪焦点（焦点出视口自动滚进来），挪不动才把按键让回给
   * 滚动区当纯滚动用；回车/空格 = 用这条规矩（与点行同一条路径 `selectSlot`）。
   * 两级都没吃下的按键**一律不吞**，否则会抢走全局快捷键（Esc 关面板等）。
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

  /**
   * ✕ /「按 Esc 关闭」的关闭入口。
   *
   * **不能直接 this.close()**：本面板是 GameStateController 注册面板，自关会绕过弹栈恢复，
   * 状态滞留 UIOverlay = 不可恢复软锁（R11）。
   *
   * 由 `Game` 注入 `stateController.closePanel('ruleUse')`——精确寻址、弹栈、恢复状态。
   * 早期版本靠「补发一次 Escape」实现，已被审查证伪：F2 调试坞开着时 Escape 分支抢在
   * handleEscape 之前，点 ✕ 会**去关调试坞**；状态一旦漂离 UIOverlay，它要么变死按钮，
   * 要么在 Exploring 下**弹出暂停菜单压在本面板上**、把 overlayReturnStack 叠歪。
   */
  private requestClose(): void {
    this.closeRequester?.();
  }

  /** 由 Game 注入关闭通道（构造签名不变；与 setResolveDisplay 同一注入范式）。 */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  private selectSlot(slot: ResolvedRuleSlot): void {
    // 施放不可撤销（审查 P2：一点即施放无确认）：先过确认框，确认了才发 apply。
    void openConfirmDialog(this.renderer, {
      title: this.strings.get('confirm', 'castTitle'),
      message: this.strings.get('confirm', 'castBody', { name: slot.ruleName }),
      confirmLabel: this.strings.get('confirm', 'ok'),
      cancelLabel: this.strings.get('confirm', 'cancel'),
      // 施放是「确认动作」不是破坏性删除，确认钮走 primary 不走 danger 红
      danger: false,
    }).then((ok) => {
      if (!ok) return;
      // 不在此处 close()：直接自关会绕过 GameStateController 的弹栈恢复，状态滞留 UIOverlay
      // 造成软锁（R11）。关面板统一由 ruleUse:apply 的处理方（EventBridge）走 closePanel 通道。
      this.eventBus.emit('ruleUse:apply', {
        ruleId: slot.slot.ruleId,
        actions: slot.slot.resultActions,
        resultText: slot.slot.resultText,
      });
    });
  }

  private destroyUI(): void {
    this.list?.destroy();
    this.win?.destroy();
    this.list = null;
    this.win = null;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    this.destroyUI();
    this.focus.destroy();
  }
}
