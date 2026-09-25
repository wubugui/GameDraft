/**
 * engine2d 模块间契约。**只放接口,不放实现**;各模块(scene / graphics / text / mesh / gpu)照这里对接。
 *
 * engine2d = 建在 RHI(WebGPU)上的 2D 场景层,对外 API 对齐游戏用到的 PixiJS v8.17 子集
 * (迁移 = 把 `from 'pixi.js'` 换成 engine2d,上层逻辑不动)。内部是引擎式结构:
 *
 *   场景树 ──(每次 render:算本次世界量)──▶ 收集(RenderCollector)──▶ 指令表(合批 / 自定义绘制 / 滤镜 / 遮罩)
 *     ──▶ 规划(目标切换、uniform 快照、顶点打包)──▶ 上传 ──▶ 录进一张 RHI 命令表并提交
 *
 * 像素语义对齐 Pixi(master 的参考):顶点数据的打包公式、颜色 8 位量化、混合表、滤镜的纹理池与 uniform
 * 全部照 Pixi 的算法,保证与 master 的输出逐像素可比。坐标系像素、y 向下;渲染目标第 0 行 = 画面顶部。
 */
import type { Matrix } from '../math/Matrix';
import type { Texture } from '../textures/Texture';
import type { BlendMode } from './blendModes';
import type { Topology, Geometry } from '../shader/Geometry';
import type { Shader } from '../shader/Shader';
import type { Container, FilterEffect, MaskEffect } from '../scene/Container';

/**
 * 可合批的绘制元素(照 Pixi 的 BatchableSprite / BatchableMesh / BatchableGraphics)。
 * 顶点 = transform × 本地坐标,在 CPU 上算(公式与 Pixi DefaultBatcher 一字不差),颜色按 unorm8x4 打包。
 */
export interface BatchableElement {
  texture: Texture;
  /** 相对渲染根的变换(显示对象的 groupTransform) */
  transform: Matrix;
  /** 0xAABBGGRR(字节序 r,g,b,a;rgb 未预乘,着色器里乘 alpha) */
  color: number;
  /** 1 = 顶点在裁剪空间按目标像素取整 */
  roundPixels: number;
  blendMode: BlendMode;
  topology: Topology;
  /** true:用 `bounds` + 纹理 uvs 拼一个四边形;false:用 positions / uvs / indices */
  packAsQuad: boolean;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  positions?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  indices?: ArrayLike<number>;
  /** 在 positions / uvs 里的起始顶点与顶点数 */
  attributeOffset: number;
  attributeSize: number;
  /** 在 indices 里的起始与个数 */
  indexOffset: number;
  indexSize: number;
}

/** 自定义着色器绘制项(带 shader 的 Mesh):不合批,按自己的几何与着色器画 */
export interface CustomDrawable {
  readonly geometry: Geometry;
  readonly shader: Shader;
  /** 网格贴图(着色器里若声明了 uTexture / uSampler 且资源表没给,用它) */
  readonly texture: Texture;
  readonly groupTransform: Matrix;
  readonly groupColorAlpha: number;
  readonly groupBlendMode: BlendMode;
  readonly roundPixels: boolean;
}

/**
 * 不合批的图形(照 Pixi 的 GraphicsPipe 非合批分支 + GpuGraphicsAdaptor):context 的区段按**本地坐标**打包
 * (元素的 transform 为单位阵、颜色不乘节点),绘制时由 localUniforms 施加节点的变换 / 颜色 / 取整,
 * 混合模式取节点的 groupBlendMode。Pixi 对顶点数 ≥ 200 的图形走这条路,像素结果与合批路径有量化差,所以单独实现。
 */
export interface UnbatchedGraphics {
  readonly groupTransform: Matrix;
  readonly groupColorAlpha: number;
  readonly groupBlendMode: BlendMode;
  readonly _roundPixels: number;
  readonly isRenderable: boolean;
}

/** 收集器:场景遍历时把要画的东西按顺序交给它 */
export interface RenderCollector {
  /** 渲染器分辨率(文字等按它决定位图分辨率,照 Pixi 的 autoResolution) */
  readonly resolution: number;
  addBatchable(element: BatchableElement): void;
  addCustom(drawable: CustomDrawable): void;
  /** `node` 是图形节点本身,`elements` 是它 context 的区段(本地坐标、颜色不乘节点) */
  addUnbatched(node: UnbatchedGraphics, elements: readonly BatchableElement[]): void;
  pushFilter(container: Container, effect: FilterEffect): void;
  popFilter(): void;
  pushMask(container: Container, effect: MaskEffect): void;
  popMask(container: Container, effect: MaskEffect): void;
}
