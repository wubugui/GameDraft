/**
 * 运行环境适配器(移植自 PixiJS v8.17(MIT):`environment/adapter` + `environment-browser/BrowserAdapter`)。
 *
 * engine2d 里凡是要碰宿主环境的地方(建画布、取基址、fetch、解析 XML……)都经 `DOMAdapter.get()`,
 * 不直接摸 `document` / `window`;测试或特殊宿主用 `DOMAdapter.set()` 整个换掉。
 * 与 Pixi 相同:`get()` 缺省返回 {@link BrowserAdapter},`set()` 直接替换当前适配器(不合并)。
 */

/** 画布(Pixi 的 `ICanvas` 是结构子集;engine2d 只跑在浏览器里,直接用 DOM 画布类型) */
export type ICanvas = HTMLCanvasElement;

/** 图片元素(Pixi 的 `ImageLike`) */
export type ImageLike = HTMLImageElement;

export interface Adapter {
  /** 建一张画布(宽高不给 = 与 Pixi 相同,赋 `undefined` → 0,由使用方随后改尺寸) */
  createCanvas: (width?: number, height?: number) => ICanvas;
  /** 建一个图片元素(装载器在没有 `createImageBitmap` 的环境里用它解码) */
  createImage: () => ImageLike;
  /** 2D 上下文的**类**(不是实例;Pixi 用它的 prototype 做特性检测) */
  getCanvasRenderingContext2D: () => { prototype: CanvasRenderingContext2D };
  /** WebGL 上下文的**类**(engine2d 只有 WebGPU,不用它;保留以对齐 Pixi 接口,可返回 null) */
  getWebGLRenderingContext: () => typeof WebGLRenderingContext | null;
  /** `navigator` 的子集 */
  getNavigator: () => { userAgent: string; gpu: GPU | null };
  /** 相对 URL 的基址:`document.baseURI`,没有就 `window.location.href` */
  getBaseUrl: () => string;
  /** 字体集(没有就 null) */
  getFontFaceSet: () => FontFaceSet | null;
  fetch: (url: RequestInfo, options?: RequestInit) => Promise<Response>;
  parseXML: (xml: string) => Document;
}

/** 浏览器环境的适配器(逐项照 Pixi `BrowserAdapter`) */
export const BrowserAdapter: Adapter = {
  createCanvas: (width?: number, height?: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    // 与 Pixi 相同:不给宽高时照样赋值(undefined → 0)
    canvas.width = width as number;
    canvas.height = height as number;
    return canvas;
  },
  createImage: (): HTMLImageElement => new Image(),
  getCanvasRenderingContext2D: () => CanvasRenderingContext2D,
  getWebGLRenderingContext: () => WebGLRenderingContext,
  getNavigator: () => navigator as unknown as { userAgent: string; gpu: GPU | null },
  getBaseUrl: () => document.baseURI ?? window.location.href,
  getFontFaceSet: () => document.fonts,
  fetch: (url: RequestInfo, options?: RequestInit) => fetch(url, options),
  parseXML: (xml: string) => {
    const parser = new DOMParser();
    return parser.parseFromString(xml, 'text/xml');
  },
};

let currentAdapter: Adapter = BrowserAdapter;

/** 当前环境适配器的存取口(与 Pixi 的 `DOMAdapter` 同名同语义) */
export const DOMAdapter = {
  /** 当前适配器 */
  get(): Adapter {
    return currentAdapter;
  },
  /** 换适配器(整个替换) */
  set(adapter: Adapter): void {
    currentAdapter = adapter;
  },
};
