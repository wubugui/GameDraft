import { Container, Graphics, Rectangle } from 'pixi.js';
import { UITheme, fadeIn } from '../UITheme';
import { createPanel, SKINS } from '../PanelSkin';
import { createTitleRow } from './UIDecor';
import { UIButton } from './UIButton';
import { UIFocus } from './UIFocus';
import { markPointerConsumed } from '../uiPointerCoords';
import { createStyledText } from '../../core/styledText';
import type { Renderer } from '../../rendering/Renderer';

/**
 * 确认对话框：全站不可逆操作（覆盖存档 / 读档 / 返回主菜单 / 丢弃 / 施放规矩）的唯一确认通道。
 *
 * 此前全项目没有确认框组件，五条不可逆路径全部一点即执行（审查 P1）。
 * 形态与面板同一套语言：小木框窗 + 拉字距标题 + 左右双钮；破坏性动作确认钮走 danger 变体。
 *
 * 模态纪律：
 * - 打开期间**捕获阶段吞掉全部键盘事件**——Esc/Enter/方向键归本框，I/Tab/M 等
 *   面板快捷键不许穿到 GameStateController（否则确认框底下面板会开开关关）。
 *   这是模态焦点栈的最小局部实现，框架级收敛见批3b。
 * - 罩层点击 = 取消（破坏性确认的安全默认）；默认焦点也落在「取消」上。
 * - Promise 必然 resolve（关闭路径唯一收口 finish），不存在悬挂。
 */
export interface ConfirmDialogOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 确认钮用 danger 变体（默认 true——本组件就是给破坏性操作用的） */
  danger?: boolean;
  /** 交互音钩子，透传给两枚按钮 */
  onSound?: (name: 'hover' | 'press') => void;
}

/** 同屏只许一个确认框：重入直接回 false（视同取消），不叠第二层模态。 */
let dialogActive = false;

/**
 * 模态在场判据。给 GameStateController 的按键压制钩子用（组装层接线）：
 * 确认框的捕获监听与 InputManager 的监听同挂 window、同相注册序竞争，
 * 光靠 stopImmediatePropagation 拦不住**先注册**的那个——Esc 会一帧连关框和底下面板
 * （2026-08-17 headless 实机验证抓获）。控制器见模态在场直接不处理按键。
 */
export function isConfirmDialogOpen(): boolean {
  return dialogActive;
}

export function openConfirmDialog(renderer: Renderer, opts: ConfirmDialogOptions): Promise<boolean> {
  if (dialogActive) return Promise.resolve(false);
  dialogActive = true;

  return new Promise<boolean>((resolve) => {
    const sw = renderer.screenWidth;
    const sh = renderer.screenHeight;
    const root = new Container();
    root.zIndex = UITheme.z.tooltip;

    const focus = new UIFocus();
    let finished = false;
    const finish = (result: boolean): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKeyCapture, true);
      focus.destroy();
      if (root.parent) root.parent.removeChild(root);
      root.destroy({ children: true });
      dialogActive = false;
      resolve(result);
    };

    // 罩层：压暗全屏 + 吞掉点击（点罩层 = 取消）
    const scrim = new Graphics();
    scrim.rect(0, 0, sw, sh);
    scrim.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    scrim.eventMode = 'static';
    scrim.hitArea = new Rectangle(0, 0, sw, sh);
    scrim.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      finish(false);
    });
    root.addChild(scrim);

    const pad = UITheme.spacing.xl;
    const panelW = Math.max(380, Math.min(Math.round(sw * 0.42), 520));
    const btnGap = UITheme.spacing.md;
    const btnW = Math.round((panelW - pad * 2 - btnGap) / 2);

    const title = createTitleRow(opts.title, { width: panelW - pad * 2, fontSize: UITheme.fontSize.title });
    const message = opts.message
      ? createStyledText({
          text: opts.message,
          style: {
            fontSize: UITheme.fontSize.body,
            fill: UITheme.colors.bodyMuted,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true, breakWords: true, wordWrapWidth: panelW - pad * 2,
            lineHeight: Math.round(UITheme.fontSize.body * 1.5),
          },
        })
      : null;

    const btnH = 56;
    let cy = pad + title.rowHeight + UITheme.spacing.lg;
    const msgH = message ? message.height + UITheme.spacing.lg : 0;
    const panelH = cy + msgH + btnH + pad;

    const panel = new Container();
    panel.addChild(createPanel(0, 0, panelW, panelH, SKINS.dialogue));
    title.position.set(pad, pad);
    panel.addChild(title);
    if (message) {
      message.position.set(pad, cy);
      panel.addChild(message);
    }
    const btnY = cy + msgH;

    // 取消在左、确认在右；默认焦点落「取消」（破坏性确认的安全默认，主机 UI 惯例）
    const cancelBtn = new UIButton({
      label: opts.cancelLabel, width: btnW, height: btnH, variant: 'secondary',
      onPress: () => finish(false), onSound: opts.onSound,
    });
    cancelBtn.container.position.set(pad, btnY);
    panel.addChild(cancelBtn.container);

    const confirmBtn = new UIButton({
      label: opts.confirmLabel, width: btnW, height: btnH,
      variant: opts.danger === false ? 'primary' : 'danger',
      onPress: () => finish(true), onSound: opts.onSound,
    });
    confirmBtn.container.position.set(pad + btnW + btnGap, btnY);
    panel.addChild(confirmBtn.container);

    panel.position.set(Math.round((sw - panelW) / 2), Math.round((sh - panelH) / 2));
    root.addChild(panel);

    focus.setItems([
      {
        id: 'cancel', x: pad, y: btnY, w: btnW, h: btnH, group: 'actions',
        onFocus: (f, via) => cancelBtn.setSelected(f && via === 'key'), onActivate: () => finish(false),
      },
      {
        id: 'confirm', x: pad + btnW + btnGap, y: btnY, w: btnW, h: btnH, group: 'actions',
        onFocus: (f, via) => confirmBtn.setSelected(f && via === 'key'), onActivate: () => finish(true),
      },
    ]);
    focus.focusDefault('cancel');

    const onKeyCapture = (e: KeyboardEvent): void => {
      // 模态期间键盘全归本框：先吞传播（面板快捷键/推进监听都不许收到）
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        finish(false);
        return;
      }
      if (focus.handleKey(e.code)) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyCapture, true);

    renderer.uiLayer.addChild(root);
    fadeIn(panel);
  });
}
