/**
 * 由样式拼 CSS font 串。移植自 PixiJS v8.17(MIT)`scene/text/canvas/utils/fontStringFromTextStyle.mjs`。
 *
 * ⚠ 与 Pixi 相同:fontFamily 是数组时**就地**把每个名字 trim 并给非通用族名加引号(会改写调用方的数组)。
 */
import type { TextStyle } from '../../TextStyle';

const genericFontFamilies = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];

export function fontStringFromTextStyle(style: TextStyle): string {
  const fontSizeString = typeof style.fontSize === 'number' ? `${style.fontSize}px` : style.fontSize;
  let fontFamilies = style.fontFamily as string[];
  if (!Array.isArray(style.fontFamily)) {
    fontFamilies = style.fontFamily.split(',');
  }
  for (let i = fontFamilies.length - 1; i >= 0; i--) {
    let fontFamily = fontFamilies[i].trim();
    if (!/([\"\'])[^\'\"]+\1/.test(fontFamily) && !genericFontFamilies.includes(fontFamily)) {
      fontFamily = `"${fontFamily}"`;
    }
    fontFamilies[i] = fontFamily;
  }
  return `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${fontSizeString} ${fontFamilies.join(',')}`;
}
