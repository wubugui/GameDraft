/**
 * GraphicsContext 指令 → 整块几何 + 区段表。移植自 PixiJS v8.17(MIT):scene/graphics/shared/utils/buildContextBatches。
 * 顶点、uv、索引的写入顺序与 Pixi 逐行相同(单测拿 Pixi 的同名函数逐数比对)。
 */
import { Matrix } from '../../math/Matrix';
import { Rectangle } from '../../math/Rectangle';
import type { ShapePrimitive } from '../../math/shapes/ShapePrimitive';
import { Texture } from '../../textures/Texture';
import type { Topology } from '../../shader/Geometry';
import { getBatchableGraphics, type BatchableGraphics, type GraphicsGeometryData } from '../BatchableGraphics';
import { buildCircle, buildEllipse, buildRoundedRectangle } from '../buildCommands/buildCircle';
import { buildLine } from '../buildCommands/buildLine';
import { buildPixelLine } from '../buildCommands/buildPixelLine';
import { buildPolygon } from '../buildCommands/buildPolygon';
import { buildRectangle } from '../buildCommands/buildRectangle';
import { buildTriangle } from '../buildCommands/buildTriangle';
import type { ShapeBuildCommand } from '../buildCommands/ShapeBuildCommand';
import type { ConvertedFillStyle, ConvertedStrokeStyle } from '../FillTypes';
import type { GraphicsContext, TextureInstruction } from '../GraphicsContext';
import type { ShapePath, ShapePrimitiveWithHoles } from '../path/ShapePath';
import { buildSimpleUvs, buildUvs, transformVertices } from './buildUvs';
import { generateTextureMatrix } from './generateTextureFillMatrix';
import { triangulateWithHoles } from './triangulateWithHoles';

/** 形状类别 → 构建器(Pixi 里经 extensions 注册,这里直接列出) */
export const shapeBuilders: Record<string, ShapeBuildCommand> = {
  rectangle: buildRectangle as unknown as ShapeBuildCommand,
  polygon: buildPolygon as unknown as ShapeBuildCommand,
  triangle: buildTriangle as unknown as ShapeBuildCommand,
  circle: buildCircle as unknown as ShapeBuildCommand,
  ellipse: buildEllipse as unknown as ShapeBuildCommand,
  roundedRectangle: buildRoundedRectangle as unknown as ShapeBuildCommand,
};

const tempRect = new Rectangle();
const tempTextureMatrix = new Matrix();

/** 构建结果的容器(Pixi 的 GpuGraphicsContext 里的 batches + geometryData) */
export interface GraphicsBuildTarget {
  batches: BatchableGraphics[];
  geometryData: GraphicsGeometryData;
}

export function buildContextBatches(context: GraphicsContext, gpuContext: GraphicsBuildTarget): void {
  const { geometryData, batches } = gpuContext;
  batches.length = 0;
  geometryData.indices.length = 0;
  geometryData.vertices.length = 0;
  geometryData.uvs.length = 0;
  for (let i = 0; i < context.instructions.length; i++) {
    const instruction = context.instructions[i];
    if (instruction.action === 'texture') {
      addTextureToGeometryData(instruction.data, batches, geometryData);
    } else if (instruction.action === 'fill' || instruction.action === 'stroke') {
      const isStroke = instruction.action === 'stroke';
      const shapePath = instruction.data.path.shapePath;
      const style = instruction.data.style;
      const hole = instruction.data.hole;
      if (isStroke && hole) {
        addShapePathToGeometryData(hole.shapePath, style, true, batches, geometryData);
      }
      if (hole) {
        shapePath.shapePrimitives[shapePath.shapePrimitives.length - 1].holes = hole.shapePath.shapePrimitives;
      }
      addShapePathToGeometryData(shapePath, style, isStroke, batches, geometryData);
    }
  }
}

function addTextureToGeometryData(data: TextureInstruction['data'], batches: BatchableGraphics[], geometryData: GraphicsGeometryData): void {
  const points: number[] = [];
  const build = shapeBuilders.rectangle;
  const rect = tempRect;
  rect.x = data.dx;
  rect.y = data.dy;
  rect.width = data.dw;
  rect.height = data.dh;
  const matrix = data.transform;
  if (!build.build(rect, points)) {
    return;
  }
  const { vertices, uvs, indices } = geometryData;
  const indexOffset = indices.length;
  const vertOffset = vertices.length / 2;
  if (matrix) {
    transformVertices(points, matrix);
  }
  build.triangulate(points, vertices, 2, vertOffset, indices, indexOffset);
  const texture = data.image;
  const textureUvs = texture.uvs;
  uvs.push(
    textureUvs.x0,
    textureUvs.y0,
    textureUvs.x1,
    textureUvs.y1,
    textureUvs.x3,
    textureUvs.y3,
    textureUvs.x2,
    textureUvs.y2,
  );
  const graphicsBatch = getBatchableGraphics();
  graphicsBatch.indexOffset = indexOffset;
  graphicsBatch.indexSize = indices.length - indexOffset;
  graphicsBatch.attributeOffset = vertOffset;
  graphicsBatch.attributeSize = vertices.length / 2 - vertOffset;
  graphicsBatch.baseColor = data.style;
  graphicsBatch.alpha = data.alpha;
  graphicsBatch.texture = texture;
  graphicsBatch.geometryData = geometryData;
  batches.push(graphicsBatch);
}

function addShapePathToGeometryData(
  shapePath: ShapePath,
  style: ConvertedFillStyle | ConvertedStrokeStyle,
  isStroke: boolean,
  batches: BatchableGraphics[],
  geometryData: GraphicsGeometryData,
): void {
  const { vertices, uvs, indices } = geometryData;
  shapePath.shapePrimitives.forEach(({ shape, transform: matrix, holes }) => {
    const points: number[] = [];
    const build = shapeBuilders[shape.type];
    if (!build.build(shape, points)) {
      return;
    }
    const indexOffset = indices.length;
    const vertOffset = vertices.length / 2;
    let topology: Topology = 'triangle-list';
    if (matrix) {
      transformVertices(points, matrix);
    }
    if (!isStroke) {
      if (holes) {
        const holeIndices: number[] = [];
        const otherPoints = points.slice();
        const holeArrays = getHoleArrays(holes);
        holeArrays.forEach((holePoints) => {
          holeIndices.push(otherPoints.length / 2);
          otherPoints.push(...holePoints);
        });
        triangulateWithHoles(otherPoints, holeIndices, vertices, 2, vertOffset, indices, indexOffset);
      } else {
        build.triangulate(points, vertices, 2, vertOffset, indices, indexOffset);
      }
    } else {
      const close = (shape as { closePath?: boolean }).closePath ?? true;
      const lineStyle = style as ConvertedStrokeStyle;
      if (!lineStyle.pixelLine) {
        buildLine(points, lineStyle, false, close, vertices, indices);
      } else {
        buildPixelLine(points, close, vertices, indices);
        topology = 'line-list';
      }
    }
    const uvsOffset = uvs.length / 2;
    const texture = style.texture as Texture;
    if (texture !== Texture.WHITE) {
      const textureMatrix = generateTextureMatrix(tempTextureMatrix, style, shape, matrix);
      buildUvs(vertices, 2, vertOffset, uvs, uvsOffset, 2, vertices.length / 2 - vertOffset, textureMatrix);
    } else {
      buildSimpleUvs(uvs, uvsOffset, 2, vertices.length / 2 - vertOffset);
    }
    const graphicsBatch = getBatchableGraphics();
    graphicsBatch.indexOffset = indexOffset;
    graphicsBatch.indexSize = indices.length - indexOffset;
    graphicsBatch.attributeOffset = vertOffset;
    graphicsBatch.attributeSize = vertices.length / 2 - vertOffset;
    graphicsBatch.baseColor = style.color;
    graphicsBatch.alpha = style.alpha;
    graphicsBatch.texture = texture;
    graphicsBatch.geometryData = geometryData;
    graphicsBatch.topology = topology;
    batches.push(graphicsBatch);
  });
}

function getHoleArrays(holePrimitives: ShapePrimitiveWithHoles[]): number[][] {
  const holeArrays: number[][] = [];
  for (let k = 0; k < holePrimitives.length; k++) {
    const holePrimitive: ShapePrimitive = holePrimitives[k].shape;
    const holePoints: number[] = [];
    const holeBuilder = shapeBuilders[holePrimitive.type];
    if (holeBuilder.build(holePrimitive, holePoints)) {
      holeArrays.push(holePoints);
    }
  }
  return holeArrays;
}
