/**
 * 形状构建器接口。移植自 PixiJS v8.17(MIT):scene/graphics/shared/buildCommands/ShapeBuildCommand。
 * `build` 把形状展开成轮廓点(扁平数组),`triangulate` 把轮廓点三角化写进顶点 / 索引数组。
 */
import type { ShapePrimitive } from '../../math/shapes/ShapePrimitive';

export interface ShapeBuildCommand<T extends ShapePrimitive = ShapePrimitive> {
  /** 对应的形状类别(Pixi 里是 extension.name) */
  readonly name: string;
  build(shape: T, points: number[]): boolean;
  triangulate(
    points: number[],
    vertices: number[],
    verticesStride: number,
    verticesOffset: number,
    indices: number[],
    indicesOffset: number,
  ): void;
}
