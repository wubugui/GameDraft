/**
 * 带标签文字(`<tag>…</tag>` + `style.tagStyles`)拆成样式段。
 * 移植自 PixiJS v8.17(MIT)`scene/text/canvas/utils/parseTaggedText.mjs`。
 */
import type { TextStyle, TextStyleOptions } from '../../TextStyle';

/** 一段同样式的文字 */
export interface TextStyleRun {
  text: string;
  style: TextStyle;
}

export function hasTagStyles(style: TextStyle): boolean {
  return !!style.tagStyles && Object.keys(style.tagStyles).length > 0;
}

export function hasTagMarkup(text: string): boolean {
  return text.includes('<');
}

function createMergedStyle(baseStyle: TextStyle, overrides: TextStyleOptions): TextStyle {
  return baseStyle.clone().assign(overrides);
}

export function parseTaggedText(text: string, style: TextStyle): TextStyleRun[] {
  const runs: TextStyleRun[] = [];
  const tagStyles = style.tagStyles as Record<string, TextStyleOptions>;
  if (!hasTagStyles(style) || !hasTagMarkup(text)) {
    runs.push({ text, style });
    return runs;
  }
  const styleStack: TextStyle[] = [style];
  const tagStack: string[] = [];
  let currentText = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '<') {
      const closeIndex = text.indexOf('>', i);
      if (closeIndex === -1) {
        currentText += char;
        i++;
        continue;
      }
      const tagContent = text.slice(i + 1, closeIndex);
      if (tagContent.startsWith('/')) {
        const closingTagName = tagContent.slice(1).trim();
        if (tagStack.length > 0 && tagStack[tagStack.length - 1] === closingTagName) {
          if (currentText.length > 0) {
            runs.push({ text: currentText, style: styleStack[styleStack.length - 1] });
            currentText = '';
          }
          styleStack.pop();
          tagStack.pop();
          i = closeIndex + 1;
          continue;
        } else {
          currentText += text.slice(i, closeIndex + 1);
          i = closeIndex + 1;
          continue;
        }
      } else {
        const tagName = tagContent.trim();
        if (tagStyles[tagName]) {
          if (currentText.length > 0) {
            runs.push({ text: currentText, style: styleStack[styleStack.length - 1] });
            currentText = '';
          }
          const currentStyle = styleStack[styleStack.length - 1];
          const mergedStyle = createMergedStyle(currentStyle, tagStyles[tagName]);
          styleStack.push(mergedStyle);
          tagStack.push(tagName);
          i = closeIndex + 1;
          continue;
        } else {
          currentText += text.slice(i, closeIndex + 1);
          i = closeIndex + 1;
          continue;
        }
      }
    } else {
      currentText += char;
      i++;
    }
  }
  if (currentText.length > 0) {
    runs.push({ text: currentText, style: styleStack[styleStack.length - 1] });
  }
  return runs;
}

/** 去掉标签后的纯文字 */
export function getPlainText(text: string, style: TextStyle): string {
  if (!hasTagStyles(style) || !hasTagMarkup(text)) return text;
  const runs = parseTaggedText(text, style);
  return runs.map((run) => run.text).join('');
}
