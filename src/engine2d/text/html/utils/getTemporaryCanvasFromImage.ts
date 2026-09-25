/**
 * 把 SVG 图画到池化画布上。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/getTemporaryCanvasFromImage.mjs`,
 * 画布尺寸按 master 的 WebGL 路径取(R2-5):那里 SVG 图直接当池纹理的资源,纹理 = `getPo2TextureFromSource`
 * 按 `(图宽 / resolution) | 0` 向池要的尺寸,即 nextPow2(图的像素尺寸)。Pixi 的 WebGPU 路径把已是像素的图宽
 * 再乘一遍 resolution,HiDPI 下纹理每边大一倍(显存 ×4,长字幕更早撞上设备纹理上限);UV / frame 两种取法都一致。
 * 取整与 TexturePool 相同,个别分辨率下画布可能比图窄一两像素(截掉的只是 uvSafeOffset 的留白,同 WebGL 按池纹理尺寸上传)。
 */
import type { CanvasAndContext } from '../../adapter';
import { CanvasPool } from '../../canvas/CanvasPool';

export function getTemporaryCanvasFromImage(image: HTMLImageElement, resolution: number): CanvasAndContext {
  const canvasAndContext = CanvasPool.getOptimalCanvasAndContext(
    (image.width / resolution) | 0,
    (image.height / resolution) | 0,
    resolution,
  );
  const { context } = canvasAndContext;
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  return canvasAndContext;
}
