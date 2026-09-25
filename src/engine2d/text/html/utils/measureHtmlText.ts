/**
 * 用真实 DOM 排版测 HTML 文字的尺寸。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/measureHtmlText.mjs`。
 */
import { HTMLTextRenderData } from '../HTMLTextRenderData';
import type { HTMLTextStyle } from '../HTMLTextStyle';

let tempHTMLTextRenderData: HTMLTextRenderData | undefined;

export function measureHtmlText(
  text: string,
  style: HTMLTextStyle,
  fontStyleCSS?: string,
  htmlTextRenderData?: HTMLTextRenderData,
): { width: number; height: number } {
  htmlTextRenderData ||= tempHTMLTextRenderData ||= new HTMLTextRenderData();
  const { domElement, styleElement, svgRoot } = htmlTextRenderData;
  domElement.innerHTML = `<style>${style.cssStyle};</style><div style='padding:0'>${text}</div>`;
  domElement.setAttribute('style', 'transform-origin: top left; display: inline-block');
  if (fontStyleCSS) {
    styleElement.textContent = fontStyleCSS;
  }
  document.body.appendChild(svgRoot);
  let contentWidth = domElement.scrollWidth;
  let contentHeight = domElement.scrollHeight;
  svgRoot.remove();
  if (style.dropShadow) {
    const { distance, angle, blur } = style.dropShadow;
    const shadowOffsetX = Math.abs(Math.round(Math.cos(angle) * distance));
    const shadowOffsetY = Math.abs(Math.round(Math.sin(angle) * distance));
    contentWidth += shadowOffsetX + blur;
    contentHeight += shadowOffsetY + blur;
  }
  const doublePadding = style.padding * 2;
  return {
    width: contentWidth - doublePadding,
    height: contentHeight - doublePadding,
  };
}
