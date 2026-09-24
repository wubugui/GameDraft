import { UITheme } from './UITheme';
import { WOOD_CHIP } from './PanelSkin';

/**
 * HUD 贴屏幕下沿的那一条——右下角入口条 + 正中的提示带——的几何。**HUD 与对白框共读这一份**。
 *
 * 对白框的木框平时整个压住这一条，所以两边从来不用互相知道；「只画选项」（无台词的选项节点，
 * 见 DialogueUI.choicesOnly）时没有框了，选项摞必须落在这一条**之上**，否则第二个选项压着
 * 入口钮、键帽字从底下露出来（2026-09-21 真跑实测）。尺寸只在这里定一次，免得两边各写一份漂开。
 */

/** 入口钮图标边长 */
export const ENTRY_ICON = 22;
/** 入口钮高：图标 + 键帽字行 + 上下木边 + 缝 */
export const ENTRY_BTN_H = ENTRY_ICON + UITheme.fontSize.micro + WOOD_CHIP * 2 + UITheme.spacing.xs * 2;
/** 入口条离屏幕右 / 下沿的净空 */
export const ENTRY_MARGIN = UITheme.spacing.xl;

/**
 * 底部提示带高度：键帽（{@link createKeyCap} 的方框 = 字高 + 4）+ 上下木边 + 各 2px 呼吸。
 * 提示带是**配角中的配角**（键位说明），高度跟着键帽走，不另外撑一条厚带子。
 */
export const HINT_BAR_H = UITheme.fontSize.small + UITheme.spacing.xs + WOOD_CHIP * 2 + UITheme.spacing.xs;
/** 提示带离屏幕下沿的净空 */
export const HINT_BAR_BOTTOM = UITheme.spacing.xxl;
/** 规矩提示与区域提示同时在时叠成两行，两行之间的缝 */
export const HINT_BAR_ROW_GAP = UITheme.spacing.sm;

/**
 * 这一条的**上沿距屏幕下沿**的距离：入口条与提示带（按最多两行算）里更高的那个。
 * 贴屏底放东西（如只画选项时的选项摞）要落在它之上。
 */
export const HUD_BOTTOM_BAND_TOP = Math.max(
  ENTRY_BTN_H + ENTRY_MARGIN,
  HINT_BAR_BOTTOM + HINT_BAR_H * 2 + HINT_BAR_ROW_GAP,
);
