/**
 * 给 HTMLText 的 SVG 内嵌已载入字体的 @font-face。
 * 移植自 PixiJS v8.17(MIT)`scene/text-html/utils/getFontCss.mjs`。
 *
 * Pixi 从 Assets 缓存里按 `${fontFamily}-and-url` 查字体条目;engine2d 由资源模块经 `setHtmlTextFontLookup`
 * 注册同样的查询(没注册 = 没有经 Assets 载入的字体,返回空串,与 Pixi 缓存里没有该键时相同)。
 */
import { loadFontCSS } from './loadFontCSS';

export interface FontFaceCacheEntry {
  entries: Array<{ url: string; faces: Array<{ weight: string; style: string }> }>;
}

let fontLookup: (key: string) => FontFaceCacheEntry | undefined = () => undefined;

/** 资源模块注册:按 `${fontFamily}-and-url` 查已载入字体 */
export function setHtmlTextFontLookup(lookup: (key: string) => FontFaceCacheEntry | undefined): void {
  fontLookup = lookup;
}

export const FontStylePromiseCache = new Map<string, Promise<string>>();

export async function getFontCss(fontFamilies: string[]): Promise<string> {
  const fontPromises = fontFamilies
    .filter((fontFamily) => fontLookup(`${fontFamily}-and-url`) !== undefined)
    .map((fontFamily) => {
      if (!FontStylePromiseCache.has(fontFamily)) {
        const { entries } = fontLookup(`${fontFamily}-and-url`)!;
        const promises: Promise<string>[] = [];
        entries.forEach((entry) => {
          const url = entry.url;
          const faces = entry.faces;
          const out = faces.map((face) => ({ weight: face.weight, style: face.style }));
          promises.push(
            ...out.map((style) => loadFontCSS({ fontWeight: style.weight, fontStyle: style.style, fontFamily }, url)),
          );
        });
        FontStylePromiseCache.set(
          fontFamily,
          Promise.all(promises).then((css) => css.join('\n')),
        );
      }
      return FontStylePromiseCache.get(fontFamily)!;
    });
  return (await Promise.all(fontPromises)).join('\n');
}
