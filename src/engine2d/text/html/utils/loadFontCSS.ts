/**
 * 拼内嵌字体的 @font-face。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/loadFontCSS.mjs`。
 */
import { loadFontAsBase64 } from './loadFontAsBase64';

export interface FontCSSStyleOptions {
  fontFamily: string | string[];
  fontWeight: string;
  fontStyle: string;
}

export async function loadFontCSS(style: FontCSSStyleOptions, url: string): Promise<string> {
  const dataSrc = await loadFontAsBase64(url);
  return `@font-face {
        font-family: "${style.fontFamily}";
        font-weight: ${style.fontWeight};
        font-style: ${style.fontStyle};
        src: url('${dataSrc}');
    }`;
}
