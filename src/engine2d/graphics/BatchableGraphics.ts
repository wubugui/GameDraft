/**
 * Graphics 的一个可合批区段。移植自 PixiJS v8.17(MIT):scene/graphics/shared/BatchableGraphics。
 *
 * 一个 context 的几何(顶点 / uv / 索引)是一整块数组,每条 fill / stroke 指令的每个图元对应其中一段
 * (`attributeOffset/attributeSize` 顶点、`indexOffset/indexSize` 索引)。**索引是整块几何里的绝对顶点号**,
 * 与 Pixi 相同:打包时按 Pixi DefaultBatcher.packIndex 的做法 `indices[i] - attributeOffset + 本批起始顶点`。
 *
 * `renderable` 为挂着它的 Graphics(渲染时用它的 groupTransform / groupColor / groupAlpha / groupBlendMode);
 * 为 null 时是 context 层的原始区段(局部坐标、不乘节点颜色)。
 */
import { Matrix } from '../math/Matrix';
import { multiplyHexColors, type Container } from '../scene/Container';
import type { BlendMode } from '../core/blendModes';
import type { BatchableElement } from '../core/contracts';
import type { Topology } from '../shader/Geometry';
import type { Texture } from '../textures/Texture';

/** 一个 context 三角化后的整块几何(Pixi 里就是普通 JS 数组) */
export interface GraphicsGeometryData {
  vertices: number[];
  uvs: number[];
  indices: number[];
}

const identityMatrix = new Matrix();

export class BatchableGraphics implements BatchableElement {
  packAsQuad = false;
  readonly batcherName = 'default';
  topology: Topology = 'triangle-list';
  /** false = context 层区段(不跟随节点变换 / 颜色 / 混合) */
  applyTransform = true;
  roundPixels = 0;
  indexOffset = 0;
  indexSize = 0;
  attributeOffset = 0;
  attributeSize = 0;
  /** 0xRRGGBB */
  baseColor = 0xffffff;
  alpha = 1;
  texture!: Texture;
  geometryData!: GraphicsGeometryData;
  renderable: Container | null = null;

  get uvs(): number[] {
    return this.geometryData.uvs;
  }

  get positions(): number[] {
    return this.geometryData.vertices;
  }

  get indices(): number[] {
    return this.geometryData.indices;
  }

  get blendMode(): BlendMode {
    if (this.renderable && this.applyTransform) {
      return this.renderable.groupBlendMode;
    }
    return 'normal';
  }

  /** 0xAABBGGRR(照 Pixi:`multiplyHexColors(bgr, groupColor) + ((alpha·groupAlpha·255) << 24)`,结果可能是负的 int32) */
  get color(): number {
    const rgb = this.baseColor;
    const bgr = (rgb >> 16) | (rgb & 0xff00) | ((rgb & 0xff) << 16);
    const renderable = this.renderable;
    if (renderable) {
      return multiplyHexColors(bgr, renderable.groupColor) + ((this.alpha * renderable.groupAlpha * 255) << 24);
    }
    return bgr + ((this.alpha * 255) << 24);
  }

  get transform(): Matrix {
    return this.renderable?.groupTransform || identityMatrix;
  }

  copyTo(gpuBuffer: BatchableGraphics): void {
    gpuBuffer.indexOffset = this.indexOffset;
    gpuBuffer.indexSize = this.indexSize;
    gpuBuffer.attributeOffset = this.attributeOffset;
    gpuBuffer.attributeSize = this.attributeSize;
    gpuBuffer.baseColor = this.baseColor;
    gpuBuffer.alpha = this.alpha;
    gpuBuffer.texture = this.texture;
    gpuBuffer.geometryData = this.geometryData;
    gpuBuffer.topology = this.topology;
  }

  reset(): void {
    this.applyTransform = true;
    this.renderable = null;
    this.topology = 'triangle-list';
  }

  destroy(): void {
    this.renderable = null;
    this.texture = null as unknown as Texture;
    this.geometryData = null as unknown as GraphicsGeometryData;
  }
}

const batchPool: BatchableGraphics[] = [];

/** 从池里取一个区段(照 Pixi `BigPool.get(BatchableGraphics)`;每帧重画的图形不反复分配) */
export function getBatchableGraphics(): BatchableGraphics {
  return batchPool.pop() ?? new BatchableGraphics();
}

/** 还回池里(照 Pixi `BigPool.return`:先 reset;另外断开纹理 / 几何引用,免得池子攥着它们) */
export function returnBatchableGraphics(batch: BatchableGraphics): void {
  batch.reset();
  batch.texture = null as unknown as Texture;
  batch.geometryData = null as unknown as GraphicsGeometryData;
  batchPool.push(batch);
}
