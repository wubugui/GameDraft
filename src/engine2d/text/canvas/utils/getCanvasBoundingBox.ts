/**
 * 画布上非透明像素的包围盒(style.trim 用)。
 * 移植自 PixiJS v8.17(MIT)`utils/canvas/getCanvasBoundingBox.mjs`。
 */
import { Rectangle } from '../../../math/Rectangle';
import { getContext2D, TextDOM, type ICanvas, type ICanvasRenderingContext2D } from '../../adapter';
import { nextPow2 } from '../CanvasPool';

let _internalCanvas: ICanvas | null = null;
let _internalContext: ICanvasRenderingContext2D | null = null;

function ensureInternalCanvas(width: number, height: number): void {
  if (!_internalCanvas) {
    _internalCanvas = TextDOM.get().createCanvas(256, 128);
    _internalContext = getContext2D(_internalCanvas, { willReadFrequently: true });
    _internalContext.globalCompositeOperation = 'copy';
    _internalContext.globalAlpha = 1;
  }
  if (_internalCanvas.width < width || _internalCanvas.height < height) {
    _internalCanvas.width = nextPow2(width);
    _internalCanvas.height = nextPow2(height);
  }
}

function checkRow(data: Uint8ClampedArray, width: number, y: number): boolean {
  for (let x = 0, index = 4 * y * width; x < width; ++x, index += 4) {
    if (data[index + 3] !== 0) return false;
  }
  return true;
}

function checkColumn(data: Uint8ClampedArray, width: number, x: number, top: number, bottom: number): boolean {
  const stride = 4 * width;
  for (let y = top, index = top * stride + 4 * x; y <= bottom; ++y, index += stride) {
    if (data[index + 3] !== 0) return false;
  }
  return true;
}

export interface GetCanvasBoundingBoxOptions {
  canvas: ICanvas;
  width?: number;
  height?: number;
  resolution?: number;
  output?: Rectangle;
}

export function getCanvasBoundingBox(options: GetCanvasBoundingBoxOptions): Rectangle;
export function getCanvasBoundingBox(canvas: ICanvas, resolution?: number): Rectangle;
export function getCanvasBoundingBox(...args: [GetCanvasBoundingBoxOptions] | [ICanvas, number?]): Rectangle {
  let options = args[0] as GetCanvasBoundingBoxOptions;
  if (!options.canvas) {
    options = { canvas: args[0] as ICanvas, resolution: args[1] as number | undefined };
  }
  const { canvas } = options;
  const resolution = Math.min(options.resolution ?? 1, 1);
  const width = options.width ?? canvas.width;
  const height = options.height ?? canvas.height;
  let output = options.output;
  ensureInternalCanvas(width, height);
  if (!_internalContext) {
    throw new TypeError('Failed to get canvas 2D context');
  }
  _internalContext.drawImage(canvas as CanvasImageSource, 0, 0, width, height, 0, 0, width * resolution, height * resolution);
  const imageData = _internalContext.getImageData(0, 0, width, height);
  const data = imageData.data;
  let left = 0;
  let top = 0;
  let right = width - 1;
  let bottom = height - 1;
  while (top < height && checkRow(data, width, top)) ++top;
  if (top === height) return Rectangle.EMPTY;
  while (checkRow(data, width, bottom)) --bottom;
  while (checkColumn(data, width, left, top, bottom)) ++left;
  while (checkColumn(data, width, right, top, bottom)) --right;
  ++right;
  ++bottom;
  _internalContext.globalCompositeOperation = 'source-over';
  _internalContext.strokeRect(left, top, right - left, bottom - top);
  _internalContext.globalCompositeOperation = 'copy';
  output ??= new Rectangle();
  output.set(left / resolution, top / resolution, (right - left) / resolution, (bottom - top) / resolution);
  return output;
}
