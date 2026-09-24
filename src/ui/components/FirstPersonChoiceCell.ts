import { Container, Graphics, Rectangle } from 'pixi.js';
import { UITheme } from '../UITheme';
import { createStyledText } from '../../core/styledText';
import { FIRST_PERSON, FIRST_PERSON_TEXT_SHADOW } from '../../rendering/firstPersonDialogue';

export interface FirstPersonChoiceCell {
  /** 整项的显示对象（左上角 = 序号左上角），自带命中区 */
  view: Container;
  /** 序号 + 缝 + 选项字的总宽（排版用，不含命中区外扩） */
  width: number;
  /** 选中 / 悬停 / 键盘焦点共用的唯一画法 */
  setHighlight: (on: boolean) => void;
}

/**
 * 第一人称版式（`layout: 'firstPerson'`）里的一个选项：小号序号 + 选项字，**不要木框**；
 * 选中时字转金、底下一道金线。常规对话框与动作选项条共用这一件，横排与折行由
 * `layoutFirstPersonChoices` 定。
 *
 * 高亮只有这一种画法（与木钮那套「点亮一档」同一语汇：转金 + 金描边色的线），
 * 鼠标悬停与键盘焦点共用，不另发明第二套。
 */
export function buildFirstPersonChoiceCell(opts: {
  /** 序号列的字（`1` / `[规] 2` 这类） */
  label: string;
  text: string;
  /** 未选中时的字色（普通 / 规矩 / 禁用由宿主按既有配色给） */
  fill: number;
  enabled: boolean;
}): FirstPersonChoiceCell {
  const view = new Container();
  const num = createStyledText({
    text: opts.label,
    style: {
      fontSize: FIRST_PERSON.choiceNumberFontSize,
      fill: FIRST_PERSON.numberFill,
      fontFamily: UITheme.fonts.ui,
      dropShadow: { ...FIRST_PERSON_TEXT_SHADOW },
    },
  });
  const body = createStyledText({
    text: opts.text,
    style: {
      fontSize: FIRST_PERSON.fontSize,
      fill: opts.fill,
      fontFamily: UITheme.fonts.ui,
      dropShadow: { ...FIRST_PERSON_TEXT_SHADOW },
    },
  });
  const textX = Math.ceil(num.width) + FIRST_PERSON.choiceNumberGap;
  body.x = textX;
  body.y = 0;
  // 序号与选项字竖向居中对齐（小字压在大字中线上，不贴顶）
  num.y = Math.round((body.height - num.height) / 2) + 1;
  num.eventMode = 'none';
  body.eventMode = 'none';

  const underline = new Graphics();
  underline.rect(textX - 4, FIRST_PERSON.underlineY, Math.ceil(body.width) + 8, FIRST_PERSON.underlineHeight);
  underline.fill({ color: UITheme.colors.borderSelected });
  underline.visible = false;
  underline.eventMode = 'none';

  view.addChild(num, body, underline);
  const width = textX + Math.ceil(body.width);
  // 子件全是 eventMode:'none'：容器必须自带命中区（见 pixi-v8-traps），外扩一圈免得点在字缝里落空
  view.eventMode = 'static';
  view.cursor = opts.enabled ? 'pointer' : 'default';
  view.hitArea = new Rectangle(-8, -6, width + 16, FIRST_PERSON.choiceRowHeight + 6);

  const setHighlight = (on: boolean): void => {
    const lit = on && opts.enabled;
    underline.visible = lit;
    body.style.fill = lit ? UITheme.colors.title : opts.fill;
    num.style.fill = lit ? UITheme.colors.borderSelected : FIRST_PERSON.numberFill;
  };
  return { view, width, setHighlight };
}
