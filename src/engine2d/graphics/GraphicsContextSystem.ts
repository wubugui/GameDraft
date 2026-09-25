/**
 * GraphicsContext 的几何缓存(脏了才重新三角化)与合批判定。移植自 PixiJS v8.17(MIT):
 * scene/graphics/shared/GraphicsContextSystem 中与 GPU 无关的部分(`GpuGraphicsContext`、`updateGpuContext`、
 * `defaultOptions.bezierSmoothness`)。
 *
 * 与 Pixi 的差别:Pixi 按渲染器 uid 把缓存存在 `context._gpuData[renderer.uid]`;几何与渲染器无关,
 * 这里每个 context 只存一份(`context._gpuContext`)。
 */
import { returnBatchableGraphics, type BatchableGraphics, type GraphicsGeometryData } from './BatchableGraphics';
import type { GraphicsContext } from './GraphicsContext';
import { buildContextBatches } from './utils/buildContextBatches';

export class GpuGraphicsContext {
  /** Pixi 的判定:context 顶点数组(x,y 扁平)长度 < 400(即 < 200 个顶点)才并进合批;否则 Pixi 单独画 */
  isBatchable = false;
  context: GraphicsContext | null = null;
  batches: BatchableGraphics[] = [];
  geometryData: GraphicsGeometryData = { vertices: [], uvs: [], indices: [] };

  reset(): void {
    if (this.batches) {
      this.batches.forEach((batch) => returnBatchableGraphics(batch));
    }
    this.isBatchable = false;
    this.context = null;
    this.batches.length = 0;
    this.geometryData.indices.length = 0;
    this.geometryData.vertices.length = 0;
    this.geometryData.uvs.length = 0;
  }

  destroy(): void {
    this.reset();
    this.batches = null as unknown as BatchableGraphics[];
    this.geometryData = null as unknown as GraphicsGeometryData;
  }
}

export class GraphicsContextSystem {
  /** 贝塞尔 / 二次曲线细分的缺省平滑度(Pixi 可经渲染器 init 选项 bezierSmoothness 改) */
  static defaultOptions = {
    bezierSmoothness: 0.5,
  };

  /** 取 context 的几何缓存;context 脏了(或还没建过)就重新三角化(照 Pixi `updateGpuContext`) */
  static updateGpuContext(context: GraphicsContext): GpuGraphicsContext {
    const hasContext = !!context._gpuContext;
    const gpuContext = context._gpuContext || GraphicsContextSystem._initContext(context);
    if (context.dirty || !hasContext) {
      if (hasContext) {
        gpuContext.reset();
      }
      buildContextBatches(context, gpuContext);
      const batchMode = context.batchMode;
      if (context.customShader || batchMode === 'no-batch') {
        gpuContext.isBatchable = false;
      } else if (batchMode === 'auto') {
        gpuContext.isBatchable = gpuContext.geometryData.vertices.length < 400;
      } else {
        gpuContext.isBatchable = true;
      }
      context.dirty = false;
    }
    return gpuContext;
  }

  static getGpuContext(context: GraphicsContext): GpuGraphicsContext {
    return context._gpuContext || GraphicsContextSystem._initContext(context);
  }

  private static _initContext(context: GraphicsContext): GpuGraphicsContext {
    const gpuContext = new GpuGraphicsContext();
    gpuContext.context = context;
    context._gpuContext = gpuContext;
    return gpuContext;
  }
}
