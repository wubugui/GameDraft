/**
 * 把 HTML 文字装进 SVG foreignObject 并序列化。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/getSVGUrl.mjs`。
 */
import type { HTMLTextRenderData } from '../HTMLTextRenderData';
import type { HTMLTextStyle } from '../HTMLTextStyle';

export function getSVGUrl(text: string, style: HTMLTextStyle, resolution: number, fontCSS: string, htmlTextData: HTMLTextRenderData): string {
  const { domElement, styleElement, svgRoot } = htmlTextData;
  domElement.innerHTML = `<style>${style.cssStyle}</style><div style='padding:0;'>${text}</div>`;
  domElement.setAttribute('style', `transform: scale(${resolution});transform-origin: top left; display: inline-block`);
  styleElement.textContent = fontCSS;
  const { width, height } = htmlTextData.image;
  svgRoot.setAttribute('width', width.toString());
  svgRoot.setAttribute('height', height.toString());
  return new XMLSerializer().serializeToString(svgRoot);
}
