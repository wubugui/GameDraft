import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from '../UITheme';
import { drawPanelBase, SKINS } from '../PanelSkin';
import { drawSelectedRow } from './UIDecor';
import { markPointerConsumed } from '../uiPointerCoords';
import { createStyledText } from '../../core/styledText';

/**
 * 按钮：全站唯一的可点控件实现。
 *
 * 此前没有按钮组件——每个面板自己 `createStyledText()` + `on('pointerdown')`，
 * 32 个 UI 文件里只有 8 个写了 hover，press 态和交互音全项目为零，
 * 暂停菜单里「继续」和「返回主菜单」长得一模一样（无主次层级）。
 */

/**
 * `ghost` = **无底框变体**：平时不画底也不描边，只有悬停/选中才铺琥珀。
 * 设计稿的暂停菜单明确「菜单项没有独立按钮框」，就是一列居中文字 + 当前项一条光带；
 * 没有这一档的话调用方只能绕开 UIButton 自己画一套，层级语义就散了。
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface UIButtonOptions {
  label: string;
  width: number;
  height?: number;
  variant?: ButtonVariant;
  disabled?: boolean;
  /**
   * 常驻选中态（菜单的「当前项」）。与 hover 分开：键盘选中的那一项即使鼠标不在上面
   * 也要一直亮着，设计稿的主菜单/暂停菜单全靠这一条读出「我现在停在哪」。
   */
  selected?: boolean;
  /** 字号，缺省 bodyLarge。菜单项这类要抬到 title 档 */
  fontSize?: number;
  /** 字距，缺省 0。设计稿的菜单项是拉开字距的 */
  letterSpacing?: number;
  /** 字族，缺省正文族。菜单项走 display 族 */
  fontFamily?: string;
  onPress: () => void;
  /** 交互音钩子；不给就静默 */
  onSound?: (name: 'hover' | 'press') => void;
}

/**
 * 三级层级：主操作亮、次要操作素、破坏性操作偏红。
 *
 * **hover/press 的配色必须各自留在自己的色系里**——早期实现在 hover 时统一换成全局
 * `rowHover`/`borderActive`，结果三个 variant 悬停后底色描边逐字节相同，
 * danger 的红底一悬停就没了，层级语义只剩文字颜色在扛。
 */
interface VariantStyle {
  fill: number; fillHover: number; fillPress: number;
  border: number; borderHover: number;
  text: number;
}

const VARIANT_STYLE: Record<ButtonVariant, VariantStyle> = {
  // 悬停一律「点亮一档琥珀」——设计稿里按钮的活跃态是暖光而不是换个深色。
  primary: {
    fill: UITheme.colors.rowBg, fillHover: UITheme.colors.selectedFill, fillPress: UITheme.colors.selectedFillDim,
    border: UITheme.colors.borderActive, borderHover: UITheme.colors.borderSelected,
    text: UITheme.colors.title,
  },
  secondary: {
    fill: UITheme.colors.rowBgDark, fillHover: UITheme.colors.selectedFillDim, fillPress: UITheme.colors.rowBgInactive,
    border: UITheme.colors.borderMid, borderHover: UITheme.colors.borderSelected,
    text: UITheme.colors.buttonText,
  },
  danger: {
    fill: UITheme.colors.dangerBg, fillHover: UITheme.colors.encounterHover, fillPress: UITheme.colors.encounterRow,
    border: UITheme.colors.dangerBorder, borderHover: UITheme.colors.red,
    text: UITheme.colors.red,
  },
  // 无底框：`fillAlpha`/`border` 在 redraw 里被特判掉，这里的 fill 只在活跃态用得上
  ghost: {
    fill: UITheme.colors.selectedFillDim, fillHover: UITheme.colors.selectedFill, fillPress: UITheme.colors.selectedFillDim,
    border: UITheme.colors.borderSelected, borderHover: UITheme.colors.borderSelected,
    text: UITheme.colors.bodyMuted,
  },
};

export class UIButton {
  readonly container: Container;
  private bg: Graphics;
  private label: Text;
  private opts: UIButtonOptions;
  private hovered = false;
  private pressed = false;

  constructor(opts: UIButtonOptions) {
    this.opts = opts;
    this.container = new Container();
    this.bg = new Graphics();
    this.container.addChild(this.bg);

    const style = VARIANT_STYLE[opts.variant ?? 'secondary'];
    this.label = createStyledText({
      text: opts.label,
      style: {
        fontSize: opts.fontSize ?? UITheme.fontSize.bodyLarge,
        fill: opts.disabled ? UITheme.colors.disabled : style.text,
        fontFamily: opts.fontFamily ?? UITheme.fonts.ui,
        letterSpacing: opts.letterSpacing ?? 0,
      },
    });
    this.container.addChild(this.label);

    this.container.eventMode = opts.disabled ? 'none' : 'static';
    this.container.cursor = opts.disabled ? 'default' : 'pointer';
    this.container.on('pointerover', () => { this.hovered = true; this.redraw(); this.opts.onSound?.('hover'); });
    this.container.on('pointerout', () => { this.hovered = false; this.pressed = false; this.redraw(); });
    this.container.on('pointerdown', (e) => {
      // 必须标记已消费：否则同一原生事件会被 DialogueUI/EncounterUI 挂在 window 上的
      // 推进监听再吃一次（见 uiPointerCoords 的说明）。
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      this.pressed = true;
      this.redraw();
      this.opts.onSound?.('press');
    });
    this.container.on('pointerup', () => {
      const wasPressed = this.pressed;
      this.pressed = false;
      this.redraw();
      if (wasPressed && !this.opts.disabled) this.opts.onPress();
    });

    this.redraw();
  }

  get height(): number {
    // bodyLarge 25px 的按钮字 + 上下呼吸。40 是桌面软件的钮高，游戏按钮要照海报排
    return this.opts.height ?? 56;
  }

  /** 按下时文字下沉 1px + 底色沉一档；悬停抬一档。三态都取自本 variant 的色系。 */
  private redraw(): void {
    const w = this.opts.width;
    const h = this.height;
    const style = VARIANT_STYLE[this.opts.variant ?? 'secondary'];
    const disabled = !!this.opts.disabled;

    const active = this.hovered || !!this.opts.selected;
    const fill = disabled
      ? UITheme.colors.rowBgInactive
      : this.pressed ? style.fillPress : (active ? style.fillHover : style.fill);
    const border = disabled
      ? UITheme.colors.borderSubtle
      : (active || this.pressed) ? style.borderHover : style.border;

    this.bg.clear();
    // ghost：不活跃时整块不画（无底无边），活跃时才铺琥珀 + 金边
    if (this.opts.variant === 'ghost') {
      if (active || this.pressed) drawSelectedRow(this.bg, 0, 0, w, h);
    } else {
      drawPanelBase(this.bg, 0, 0, w, h, SKINS.row, { fill, border });
      // 设计稿的按钮是「雕在木牌上的槽」：细金外线 + 内缩一圈 hairline 的**双线框**，
      // 靠线分界而不是靠底色发亮（选中/悬停时琥珀铺光会盖上来，内线就不必再画）。
      if (!active && !this.pressed && !disabled) {
        this.bg.rect(3, 3, w - 6, h - 6);
        this.bg.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline });
      }
    }

    this.label.style.fill = disabled
      ? UITheme.colors.disabled
      : active ? UITheme.colors.title : style.text;
    this.label.x = Math.round((w - this.label.width) / 2);
    this.label.y = Math.round((h - this.label.height) / 2) + (this.pressed ? 1 : 0);
  }

  /** 切常驻选中态（菜单换当前项时调）。 */
  setSelected(selected: boolean): void {
    if (this.opts.selected === selected) return;
    this.opts.selected = selected;
    this.redraw();
  }

  setDisabled(disabled: boolean): void {
    this.opts.disabled = disabled;
    this.container.eventMode = disabled ? 'none' : 'static';
    this.container.cursor = disabled ? 'default' : 'pointer';
    this.label.style.fill = disabled
      ? UITheme.colors.disabled
      : VARIANT_STYLE[this.opts.variant ?? 'secondary'].text;
    this.redraw();
  }

  destroy(): void {
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
