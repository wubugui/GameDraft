/**
 * engine2d 文字模块(照 PixiJS v8.17 移植):Text / HTMLText / TextStyle / HTMLTextStyle / CanvasTextMetrics 等。
 * 公共入口(src/engine2d/index.ts)从这里挑游戏用到的导出。
 */
export {
  TextStyle,
  type TextStyleOptions,
  type TextDropShadow,
  type TextStyleAlign,
  type TextStyleFill,
  type TextStyleFontStyle,
  type TextStyleFontVariant,
  type TextStyleFontWeight,
  type TextStyleLineJoin,
  type TextStyleTextBaseline,
  type TextStyleWhiteSpace,
} from './TextStyle';
export {
  type FillInput,
  type StrokeInput,
  type FillStyle,
  type StrokeStyle,
  type ConvertedFillStyle,
  type ConvertedStrokeStyle,
  type TextureSpace,
  type LineCap,
  type LineJoin,
  type FillGradientLike,
  type FillPatternLike,
} from './fill';
export { AbstractText, ensureTextOptions, type TextOptions, type TextString } from './AbstractText';
export { Text, type CanvasTextOptions } from './Text';
export { CanvasTextMetrics, type FontMetrics } from './canvas/CanvasTextMetrics';
export { CanvasTextGenerator, CanvasTextGeneratorClass } from './canvas/CanvasTextGenerator';
export { CanvasPool, CanvasPoolClass } from './canvas/CanvasPool';
export { parseTaggedText, getPlainText, hasTagStyles, hasTagMarkup, type TextStyleRun } from './canvas/utils/parseTaggedText';
export { CanvasTextSystem, canvasTextSystem, type TextFilterHook } from './CanvasTextSystem';
export { HTMLText, type HTMLTextOptions } from './html/HTMLText';
export { HTMLTextStyle, type HTMLTextStyleOptions } from './html/HTMLTextStyle';
export { HTMLTextSystem, htmlTextSystem } from './html/HTMLTextSystem';
export { setHtmlTextFontLookup } from './html/utils/getFontCss';
export {
  TextDOM,
  setTextDOMAdapter,
  BrowserTextAdapter,
  type TextDOMAdapter,
  type ICanvas,
  type ICanvasRenderingContext2D,
  type CanvasAndContext,
} from './adapter';
