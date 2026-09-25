/**
 * engine2d 公共入口:与 Pixi v8 同名的导出(游戏迁移时把 `from 'pixi.js'` 换成这里)。
 * 只导出游戏实际用到的子集;子模块的实现细节不从这里导出。
 */
export { EventEmitter } from './utils/EventEmitter';
export { Point, type PointData, type PointLike } from './math/Point';
export { ObservablePoint } from './math/ObservablePoint';
export { Matrix } from './math/Matrix';
export { Rectangle } from './math/Rectangle';
export { groupD8 } from './math/groupD8';
export { Color, type ColorSource } from './color/Color';
export type { BlendMode } from './core/blendModes';

export { TextureStyle, type TextureStyleOptions, type SCALE_MODE, type WRAP_MODE } from './textures/TextureStyle';
export {
  TextureSource,
  ImageSource,
  CanvasSource,
  BufferImageSource,
  type TextureSourceOptions,
  type TEXTURE_FORMATS,
  type ALPHA_MODES,
} from './textures/TextureSource';
export { Texture, type TextureOptions, type UVs } from './textures/Texture';
export { RenderTexture } from './textures/RenderTexture';
export { TextureMatrix } from './textures/TextureMatrix';
export { TexturePool, TexturePoolClass } from './textures/TexturePool';

export { Bounds } from './scene/Bounds';
export { Container, type ContainerOptions, type DestroyOptions, type EventMode, type Cursor, type IHitArea } from './scene/Container';
export { ViewContainer } from './scene/ViewContainer';
export { Sprite, type SpriteOptions } from './sprite/Sprite';

export { Buffer, BufferUsage, BufferResource, type BufferOptions } from './shader/Buffer';
export { Geometry, type GeometryDescriptor, type Attribute, type VertexFormat, type Topology } from './shader/Geometry';
export { UniformGroup, type UniformData } from './shader/UniformGroup';
export { GpuProgram, type GpuProgramOptions } from './shader/GpuProgram';
export { GlProgram, type GlProgramOptions } from './shader/GlProgram';
export { Shader, RendererType } from './shader/Shader';
export { MeshGeometry, PlaneGeometry, type MeshGeometryOptions } from './mesh/MeshGeometry';
export { Mesh, MeshPlane, type MeshOptions } from './mesh/Mesh';
export { Filter, type FilterOptions, type FilterSystemLike, type FilterSystemLike as FilterSystem } from './filters/Filter';
export { AlphaFilter, type AlphaFilterOptions } from './filters/defaults/alpha/AlphaFilter';
export { ColorMatrixFilter, type ColorMatrix } from './filters/defaults/color-matrix/ColorMatrixFilter';
export { BlurFilter, type BlurFilterOptions } from './filters/defaults/blur/BlurFilter';
export { BlurFilterPass, type BlurFilterPassOptions } from './filters/defaults/blur/BlurFilterPass';
export { PassthroughFilter } from './filters/defaults/passthrough/PassthroughFilter';
export { NineSliceSprite, type NineSliceSpriteOptions } from './sprite/NineSliceSprite';
export { NineSliceGeometry, type NineSliceGeometryOptions } from './sprite/NineSliceGeometry';

export { Ticker, UPDATE_PRIORITY, type TickerCallback } from './ticker/Ticker';
export { Application, type ApplicationOptions, type ApplicationPlugin } from './app/Application';
export { Culler, type RectangleLike } from './culling/Culler';
export { Assets, AssetsClass } from './assets/Assets';
export { Cache } from './assets/cache/Cache';
export type { UnresolvedAsset, ResolvedAsset, LoadOptions, AssetInitOptions } from './assets/types';
export { DOMAdapter, BrowserAdapter, type Adapter, type ICanvas } from './environment/adapter';
export { createRenderer, type CreateRendererOptions } from './gpu/createRenderer';
export * from './events';

export { Graphics, type GraphicsOptions } from './graphics/Graphics';
export { GraphicsContext, type BatchMode } from './graphics/GraphicsContext';
export { GraphicsPath } from './graphics/path/GraphicsPath';
export { FillGradient, type GradientOptions, type LinearGradientOptions, type RadialGradientOptions } from './graphics/fill/FillGradient';
export { FillPattern } from './graphics/fill/FillPattern';
export type { FillInput, FillStyle, StrokeInput, StrokeStyle, StrokeAttributes } from './graphics/FillTypes';
export type { LineCap, LineJoin } from './graphics/const';
export { Circle } from './math/shapes/Circle';
export { Ellipse } from './math/shapes/Ellipse';
export { Polygon } from './math/shapes/Polygon';
export { RoundedRectangle } from './math/shapes/RoundedRectangle';
export { Triangle } from './math/shapes/Triangle';

export { Text, type CanvasTextOptions } from './text/Text';
export {
  TextStyle, type TextStyleOptions, type TextDropShadow, type TextStyleAlign, type TextStyleFontWeight,
  type TextStyleFontStyle, type TextStyleFontVariant, type TextStyleTextBaseline, type TextStyleWhiteSpace,
} from './text/TextStyle';
export { AbstractText, type TextOptions, type TextString } from './text/AbstractText';
export { CanvasTextMetrics, type FontMetrics } from './text/canvas/CanvasTextMetrics';
export { HTMLText, type HTMLTextOptions } from './text/html/HTMLText';
export { HTMLTextStyle, type HTMLTextStyleOptions } from './text/html/HTMLTextStyle';
export { RendererBase, type RendererOptions, type RenderOptions, type GenerateTextureOptions } from './gpu/Renderer';
export { WebGPURenderer, WebGPURenderer as Renderer } from './gpu/WebGPURenderer';
export type { RenderSurface } from './gpu/renderTargets';
