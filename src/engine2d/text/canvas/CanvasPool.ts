/**
 * 画布池:按 2 的幂尺寸复用画布 + 2D 上下文。
 * 移植自 PixiJS v8.17(MIT)`rendering/renderers/shared/texture/CanvasPool.mjs`。
 */
import { getContext2D, TextDOM, type CanvasAndContext } from '../adapter';

export function nextPow2(v: number): number {
  v += v === 0 ? 1 : 0;
  --v;
  v |= v >>> 1;
  v |= v >>> 2;
  v |= v >>> 4;
  v |= v >>> 8;
  v |= v >>> 16;
  return v + 1;
}

export class CanvasPoolClass {
  canvasOptions: Record<string, unknown>;
  enableFullScreen: boolean;
  private _canvasPool: Record<number, CanvasAndContext[]>;

  constructor(canvasOptions?: Record<string, unknown>) {
    this._canvasPool = Object.create(null);
    this.canvasOptions = canvasOptions || {};
    this.enableFullScreen = false;
  }

  private _createCanvasAndContext(pixelWidth: number, pixelHeight: number): CanvasAndContext {
    const canvas = TextDOM.get().createCanvas();
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = getContext2D(canvas);
    return { canvas, context };
  }

  /** 取一张不小于所需尺寸(按 2 的幂取整)的画布 */
  getOptimalCanvasAndContext(minWidth: number, minHeight: number, resolution = 1): CanvasAndContext {
    minWidth = Math.ceil(minWidth * resolution - 1e-6);
    minHeight = Math.ceil(minHeight * resolution - 1e-6);
    minWidth = nextPow2(minWidth);
    minHeight = nextPow2(minHeight);
    const key = (minWidth << 17) + (minHeight << 1);
    if (!this._canvasPool[key]) {
      this._canvasPool[key] = [];
    }
    let canvasAndContext = this._canvasPool[key].pop();
    if (!canvasAndContext) {
      canvasAndContext = this._createCanvasAndContext(minWidth, minHeight);
    }
    return canvasAndContext;
  }

  /** 还回池里(清空画布、重置变换) */
  returnCanvasAndContext(canvasAndContext: CanvasAndContext): void {
    const canvas = canvasAndContext.canvas;
    const { width, height } = canvas;
    const key = (width << 17) + (height << 1);
    canvasAndContext.context.resetTransform();
    canvasAndContext.context.clearRect(0, 0, width, height);
    this._canvasPool[key].push(canvasAndContext);
  }

  clear(): void {
    this._canvasPool = {};
  }
}

export const CanvasPool = new CanvasPoolClass();
