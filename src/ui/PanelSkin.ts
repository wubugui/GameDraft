import { Graphics } from 'pixi.js';
import { UITheme } from './UITheme';

/**
 * 面板皮肤（民俗草根·极简）：全站 UI 面板底框的唯一绘制入口，替代各处复制的
 * `roundRect().fill(panelBg).stroke(panelBorder)` 四行式样。
 * 视觉语言刻意朴素——暖近黑底 + 一条素净的旧木/墨色边，小圆角近乎方正；
 * **不用**印章、金线、云纹角、颗粒纹理等装饰，贴合灰扑扑的草根气息。
 * 纯程序化，零运行时素材。
 */

export interface PanelSkin {
  fill: number;
  fillAlpha: number;
  radius: number;
  borderWidth: number;
  /** 边色（素净旧木/墨色）；省略则不描边 */
  border?: number;
}

/** 局部覆盖（如选项行按 enabled/disabled 改边色，或临时换底色），不必新增皮肤。 */
export interface PanelDrawOverrides {
  fill?: number;
  fillAlpha?: number;
  border?: number;
}

const C = UITheme.colors;
const A = UITheme.alpha;

/** 素净旧木边（大面板）与更暗的墨边（微件/选项行）。 */
const FRAME = 0x6b5a3e;
const FRAME_DIM = 0x574733;

/**
 * 皮肤注册表：面板按语义取皮肤。全部只有「暖底 + 一条素边」，无任何装饰件。
 */
export const SKINS = {
  dialogue: { fill: C.dialogueBg, fillAlpha: A.dialogueBg, radius: 4, borderWidth: 1.5, border: FRAME },
  panel: { fill: C.panelBg, fillAlpha: A.panelBg, radius: 4, borderWidth: 1.5, border: FRAME },
  panelAlt: { fill: C.panelBgAlt, fillAlpha: A.panelBg, radius: 4, borderWidth: 1.5, border: FRAME },
  menu: { fill: C.mainMenuBg, fillAlpha: 0.97, radius: 4, borderWidth: 1.5, border: FRAME },
  book: { fill: C.bookBg, fillAlpha: A.panelBg, radius: 4, borderWidth: 1.5, border: FRAME },
  detail: { fill: C.detailBg, fillAlpha: A.panelBg, radius: 4, borderWidth: 1, border: FRAME_DIM },
  encounter: { fill: C.encounterBg, fillAlpha: A.encounterBg, radius: 4, borderWidth: 1.5, border: 0x7a4a3a },
  chip: { fill: C.dialogueBg, fillAlpha: A.hudBg, radius: 4, borderWidth: 1, border: FRAME_DIM },
  toast: { fill: C.dialogueBg, fillAlpha: A.notifBg, radius: 4, borderWidth: 1, border: FRAME_DIM },
  row: { fill: C.rowBgDark, fillAlpha: A.rowHover, radius: 3, borderWidth: 1, border: C.borderSubtle },
  plain: { fill: C.panelBg, fillAlpha: A.panelBg, radius: 4, borderWidth: 1, border: C.panelBorder },
} satisfies Record<string, PanelSkin>;

export type SkinName = keyof typeof SKINS;

/**
 * 画面板底：暖底 + 一条素边。绘制到调用方已有的 Graphics 上，是旧四行式样的直接替换。
 */
export function drawPanelBase(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  skin: PanelSkin,
  o?: PanelDrawOverrides,
): void {
  const fill = o?.fill ?? skin.fill;
  const fillAlpha = o?.fillAlpha ?? skin.fillAlpha;
  g.roundRect(x, y, w, h, skin.radius);
  g.fill({ color: fill, alpha: fillAlpha });

  const border = o?.border ?? skin.border;
  if (border !== undefined) {
    g.roundRect(x, y, w, h, skin.radius);
    g.stroke({ color: border, width: skin.borderWidth });
  }
}
