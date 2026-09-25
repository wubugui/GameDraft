/**
 * 收集 HTMLText 用到的字体族(样式、内联 font-family、tagStyles)。
 * 移植自 PixiJS v8.17(MIT)`scene/text-html/utils/extractFontFamilies.mjs`。
 */
import type { HTMLTextStyle } from '../HTMLTextStyle';

export function extractFontFamilies(text: string, style: HTMLTextStyle): string[] {
  const fontFamily = style.fontFamily;
  const fontFamilies: string[] = [];
  const dedupe: Record<string, boolean> = {};
  const regex = /font-family:([^;"\s]+)/g;
  const matches = text.match(regex);
  function addFontFamily(fontFamily2: string): void {
    if (!dedupe[fontFamily2]) {
      fontFamilies.push(fontFamily2);
      dedupe[fontFamily2] = true;
    }
  }
  if (Array.isArray(fontFamily)) {
    for (let i = 0; i < fontFamily.length; i++) {
      addFontFamily(fontFamily[i]);
    }
  } else {
    addFontFamily(fontFamily);
  }
  if (matches) {
    matches.forEach((match) => {
      const fontFamily2 = match.split(':')[1].trim();
      addFontFamily(fontFamily2);
    });
  }
  for (const i in style.tagStyles) {
    const fontFamily2 = style.tagStyles[i].fontFamily as string;
    addFontFamily(fontFamily2);
  }
  return fontFamilies;
}
