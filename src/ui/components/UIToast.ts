import { Container, Graphics } from 'pixi.js';
import { UITheme } from '../UITheme';
import { createPanel, SKINS } from '../PanelSkin';
import { createIcon } from './UIDecor';
import type { UIIconName } from '../UIIcons';
import { createStyledText } from '../../core/styledText';

/**
 * toast 条的**唯一视觉实现**：小木框条 + 左侧圆形图标徽章 + 一行短字。
 *
 * 此前 NotificationUI（顶中事件播报）与 PickupNotification（右上入袋回执）各画一份，
 * 已经漂移出「有无最小宽 / 圆章细节 / 内边距」三处差异（审查 P2）。视觉收敛到这里；
 * **时序不收**——事件播报 4s、入袋回执 2s 是语义差异不是漂移，各家自己管生命周期。
 */
export interface ToastChipOptions {
  text: string;
  /** 文字与图标 tint 同色（类型色 / 拾取金） */
  color: number;
  icon?: UIIconName;
  /** 换行上限（整条宽含内边距） */
  maxWidth: number;
  /** 条宽下限；0 = 完全贴内容（右上回执贴边摆，不需要稳宽） */
  minWidth?: number;
}

export interface ToastChip {
  container: Container;
  width: number;
  height: number;
}

const PAD_X = UITheme.spacing.md;
/** 行高自带上下各半档留白，竖向内边距收到 xs，单行条高仍是 MIN_H */
const PAD_Y = UITheme.spacing.xs;
/** 条高下限：木边 5px + 圆形图标徽章（直径 20）留得下呼吸 */
const MIN_H = UITheme.spacing.xxl + UITheme.spacing.xs;
/** ⚠ 行距用 lineHeight 不用 leading（pixi-v8-traps：leading 量高矮半档、末行被裁） */
const LINE_H = Math.round(UITheme.fontSize.body * 1.3);
const BADGE_R = 10;
const BADGE_ICON = 12;

export function buildToastChip(opts: ToastChipOptions): ToastChip {
  const chip = new Container();

  // 图标素材没到位（createIcon → null）时圆章整枚省掉，文字左移贴回内边距，不留空洞。
  // ⚠ tint 走赋值不走入参：createIcon 的默认参数把 tint 推断成了字面量类型
  const icon = opts.icon ? createIcon(opts.icon, BADGE_ICON) : null;
  if (icon) icon.tint = opts.color;
  const textX = icon ? PAD_X + BADGE_R * 2 + UITheme.spacing.sm : PAD_X;

  const label = createStyledText({
    text: opts.text,
    style: {
      // toast 是一句话的事件播报，body 档；small 挂在屏幕顶上读着发虚（迁移前注释结论）
      fontSize: UITheme.fontSize.body,
      fill: opts.color,
      fontFamily: UITheme.fonts.ui,
      wordWrap: true,
      breakWords: true,
      lineHeight: LINE_H,
      wordWrapWidth: opts.maxWidth - textX - PAD_X,
    },
  });

  // 先量正文再定条宽/条高：一行放得下就按内容收窄，放不下才在上限处换行并把木条撑高
  const natural = Math.ceil(textX + label.width + PAD_X);
  const minW = opts.minWidth ?? 0;
  const boxW = Math.min(opts.maxWidth, Math.max(minW, natural));
  const boxH = Math.max(MIN_H, Math.ceil(label.height + PAD_Y * 2));
  // 撞到条宽下限时（极短的提示），圆章 + 文字整体居中，免得右半条空出一截
  const shiftX = Math.max(0, Math.round((boxW - natural) / 2));

  chip.addChild(createPanel(0, 0, boxW, boxH, SKINS.toast));

  if (icon) {
    const cx = shiftX + PAD_X + BADGE_R;
    const cy = Math.round(boxH / 2);
    const badge = new Graphics();
    badge.circle(cx, cy, BADGE_R);
    badge.fill({ color: UITheme.colors.rowBgInactive, alpha: 0.9 });
    badge.circle(cx, cy, BADGE_R);
    badge.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline * 2 });
    badge.eventMode = 'none';
    chip.addChild(badge);

    icon.position.set(cx - BADGE_ICON / 2, cy - BADGE_ICON / 2);
    chip.addChild(icon);
  }

  label.x = shiftX + textX;
  label.y = Math.round((boxH - label.height) / 2);
  chip.addChild(label);

  return { container: chip, width: boxW, height: boxH };
}
