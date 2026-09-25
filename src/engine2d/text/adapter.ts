/**
 * 文字模块的 DOM 适配层(照 PixiJS v8.17 `DOMAdapter` / `BrowserAdapter` 的文字相关子集;MIT)。
 *
 * 文字排版 / 位图生成要用画布、2D 上下文、Image;这些都经由这里取,node 单测可 `setTextDOMAdapter` 换成假实现。
 * 缺省实现与 Pixi 的 BrowserAdapter 逐字相同。
 */

/** 能取 2D 上下文的画布(HTMLCanvasElement / OffscreenCanvas) */
export type ICanvas = HTMLCanvasElement | OffscreenCanvas;

/** 2D 上下文(Pixi 的 `ICanvasRenderingContext2D`):Chrome < 94 的字距属性叫 `textLetterSpacing` */
export type ICanvasRenderingContext2D = (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) & {
  letterSpacing?: string;
  textLetterSpacing?: string;
};

/** 画布 + 它的 2D 上下文(Pixi `CanvasAndContext`) */
export interface CanvasAndContext {
  canvas: ICanvas;
  context: ICanvasRenderingContext2D;
}

export interface TextDOMAdapter {
  createCanvas(width?: number, height?: number): ICanvas;
  createImage(): HTMLImageElement;
  /** 返回 2D 上下文的构造函数(只用它的 prototype 判断浏览器是否支持原生字距) */
  getCanvasRenderingContext2D(): { prototype: object };
  getNavigator(): { userAgent: string };
  fetch(url: RequestInfo, options?: RequestInit): Promise<Response>;
}

/** Pixi `BrowserAdapter` 的文字相关部分 */
export const BrowserTextAdapter: TextDOMAdapter = {
  createCanvas: (width?: number, height?: number): ICanvas => {
    const canvas = document.createElement('canvas');
    canvas.width = width as number;
    canvas.height = height as number;
    return canvas;
  },
  createImage: () => new Image(),
  getCanvasRenderingContext2D: () => CanvasRenderingContext2D,
  getNavigator: () => navigator,
  fetch: (url, options) => fetch(url, options),
};

let current: TextDOMAdapter = BrowserTextAdapter;

/** 同 Pixi `DOMAdapter.get()` / `DOMAdapter.set()` */
export const TextDOM = {
  get(): TextDOMAdapter {
    return current;
  },
  set(adapter: TextDOMAdapter): void {
    current = adapter;
  },
};

export function setTextDOMAdapter(adapter: TextDOMAdapter): void {
  current = adapter;
}

/** 取画布的 2D 上下文(联合类型上直接调 getContext 过不了类型检查,集中在这里转一次) */
export function getContext2D(canvas: ICanvas, settings?: CanvasRenderingContext2DSettings): ICanvasRenderingContext2D {
  return (canvas as HTMLCanvasElement).getContext('2d', settings) as ICanvasRenderingContext2D;
}
