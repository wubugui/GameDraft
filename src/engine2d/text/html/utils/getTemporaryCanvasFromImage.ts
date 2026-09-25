/**
 * 把 SVG 图画到池化画布上(WebGPU 路径)。移植自 PixiJS v8.17(MIT)
 * `scene/text-html/utils/getTemporaryCanvasFromImage.mjs`。
 */
import type { CanvasAndContext } from '../../adapter';
import { CanvasPool } from '../../canvas/CanvasPool';

export function getTemporaryCanvasFromImage(image: HTMLImageElement, resolution: number): CanvasAndContext {
  const canvasAndContext = CanvasPool.getOptimalCanvasAndContext(image.width, image.height, resolution);
  const { context } = canvasAndContext;
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return canvasAndContext;
}
