/**
 * 多边形构建器。移植自 PixiJS v8.17(MIT):scene/graphics/shared/buildCommands/buildPolygon。
 */
import type { Polygon } from '../../math/shapes/Polygon';
import { triangulateWithHoles } from '../utils/triangulateWithHoles';
import type { ShapeBuildCommand } from './ShapeBuildCommand';

const emptyArray: number[] = [];

export const buildPolygon: ShapeBuildCommand<Polygon> = {
  name: 'polygon',

  build(shape, points) {
    for (let i = 0; i < shape.points.length; i++) {
      points[i] = shape.points[i];
    }
    return true;
  },

  triangulate(points, vertices, verticesStride, verticesOffset, indices, indicesOffset) {
    triangulateWithHoles(points, emptyArray, vertices, verticesStride, verticesOffset, indices, indicesOffset);
  },
};
