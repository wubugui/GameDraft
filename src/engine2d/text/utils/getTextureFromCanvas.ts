/**
 * 由画好文字的池化画布得到纹理。对应 PixiJS v8.17(MIT)`scene/text/utils/getPo2TextureFromSource.mjs`:
 * 纹理 = 整张画布(画布本身已按 2 的幂取整),`frame` = 内容区 `width / resolution × height / resolution`,
 * 源分辨率 = 文字分辨率,alpha 语义 `premultiply-alpha-on-upload` —— UV 与 Pixi 的 2 的幂池纹理完全相同。
 *
 * 与 Pixi 的差别(不影响像素):Pixi 从 TexturePool 取一张 GPU 纹理、当场上传后把画布还池;engine2d 的上传在
 * 渲染时才做,所以画布要跟着纹理留住,直到纹理被还回(`releaseTextureCanvas`)。同一张池化画布始终配同一个
 * CanvasSource,GPU 纹理随画布复用,不会每次重生成都重建。
 */
import { Rectangle } from '../../math/Rectangle';
import { Texture } from '../../textures/Texture';
import { CanvasSource } from '../../textures/TextureSource';
import { TextureStyle } from '../../textures/TextureStyle';
import type { ICanvas } from '../adapter';

const textureByCanvas = new WeakMap<object, Texture<CanvasSource>>();

/** 文字纹理缺省采样(= Pixi 每次 `new TextureStyle()` 的参数:linear + clamp) */
export const defaultTextTextureStyle = new TextureStyle();

export function getTextureFromCanvas(
  canvas: ICanvas,
  width: number,
  height: number,
  resolution: number,
  autoGenerateMipmaps = false,
): Texture<CanvasSource> {
  let texture = textureByCanvas.get(canvas);
  if (!texture || texture.destroyed || !texture.source || texture.source.destroyed) {
    // 先按分辨率 1 建(像素尺寸 = 画布尺寸,不会触发画布 resize 清空),再改分辨率
    const source = new CanvasSource({ resource: canvas, resolution: 1, autoGenerateMipmaps, label: 'text' });
    texture = new Texture<CanvasSource>({ source, frame: new Rectangle(0, 0, width / resolution, height / resolution), label: 'text' });
    textureByCanvas.set(canvas, texture);
  }
  const source = texture.source;
  source.resolution = resolution;
  // Pixi 还池时把采样样式重置为池缺省(linear + clamp);调用方需要别的样式时在返回后再设
  source.style = defaultTextTextureStyle;
  source.alphaMode = 'premultiply-alpha-on-upload';
  source.autoGenerateMipmaps = autoGenerateMipmaps;
  texture.frame.x = 0;
  texture.frame.y = 0;
  texture.frame.width = width / resolution;
  texture.frame.height = height / resolution;
  source.update();
  texture.updateUvs();
  return texture;
}

/** 纹理是不是某张池化画布的文字纹理;是则返回那张画布 */
export function getTextureCanvas(texture: Texture): ICanvas | null {
  const resource = texture.source?.resource as ICanvas | null | undefined;
  if (!resource || textureByCanvas.get(resource) !== texture) return null;
  return resource;
}
