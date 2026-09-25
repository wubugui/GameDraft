/**
 * HTMLText 生成位图用的 DOM 节点组(svg > foreignObject > style + div,以及一张 Image)。
 * 移植自 PixiJS v8.17(MIT)`scene/text-html/HTMLTextRenderData.mjs`。
 */
import { TextDOM } from '../adapter';

export const nssvg = 'http://www.w3.org/2000/svg';
export const nsxhtml = 'http://www.w3.org/1999/xhtml';

export class HTMLTextRenderData {
  svgRoot: SVGSVGElement;
  foreignObject: SVGForeignObjectElement;
  domElement: HTMLElement;
  styleElement: HTMLElement;
  image: HTMLImageElement;

  constructor() {
    this.svgRoot = document.createElementNS(nssvg, 'svg');
    this.foreignObject = document.createElementNS(nssvg, 'foreignObject');
    this.domElement = document.createElementNS(nsxhtml, 'div') as HTMLElement;
    this.styleElement = document.createElementNS(nsxhtml, 'style') as HTMLElement;
    const { foreignObject, svgRoot, styleElement, domElement } = this;
    foreignObject.setAttribute('width', '10000');
    foreignObject.setAttribute('height', '10000');
    foreignObject.style.overflow = 'hidden';
    svgRoot.appendChild(foreignObject);
    foreignObject.appendChild(styleElement);
    foreignObject.appendChild(domElement);
    this.image = TextDOM.get().createImage();
  }

  destroy(): void {
    this.svgRoot.remove();
    this.foreignObject.remove();
    this.styleElement.remove();
    this.domElement.remove();
    this.image.src = '';
    this.image.remove();
    this.svgRoot = null as unknown as SVGSVGElement;
    this.foreignObject = null as unknown as SVGForeignObjectElement;
    this.styleElement = null as unknown as HTMLElement;
    this.domElement = null as unknown as HTMLElement;
    this.image = null as unknown as HTMLImageElement;
  }
}
