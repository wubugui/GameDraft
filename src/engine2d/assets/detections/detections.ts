/**
 * 图片格式探测(移植自 PixiJS v8.17(MIT):`assets/detections/parsers/detectAvif`、`detectWebp`、
 * `detectDefaults` 与 `detections/utils/testImageFormat`)。
 *
 * `Assets.init` 用它们得出"本环境能解的格式"列表,作为 resolver 的 format 偏好:只影响
 * 一个别名有多个候选地址(`x.{webp,png}`)时挑哪个;单地址资源不受影响。
 * Pixi 另有 mp4 / ogv / webm 的探测,engine2d 不装载视频,不移植。
 */
import type { FormatDetectionParser } from '../types';

/** 试解一张 data: 图:有 Image 用 <img>,否则 fetch + createImageBitmap(同 Pixi) */
export async function testImageFormat(imageData: string): Promise<boolean> {
  if ('Image' in globalThis) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        resolve(true);
      };
      image.onerror = () => {
        resolve(false);
      };
      image.src = imageData;
    });
  }
  if ('createImageBitmap' in globalThis && 'fetch' in globalThis) {
    try {
      const blob = await (await fetch(imageData)).blob();
      await createImageBitmap(blob);
    } catch (_e) {
      return false;
    }
    return true;
  }
  return false;
}

export const detectAvif: FormatDetectionParser = {
  extension: {
    type: 'detection-parser',
    priority: 1,
  },
  test: async () => testImageFormat(
    // eslint-disable-next-line max-len
    'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=',
  ),
  add: async (formats) => [...formats, 'avif'],
  remove: async (formats) => formats.filter((f) => f !== 'avif'),
};

export const detectWebp: FormatDetectionParser = {
  extension: {
    type: 'detection-parser',
    priority: 0,
  },
  test: async () => testImageFormat('data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='),
  add: async (formats) => [...formats, 'webp'],
  remove: async (formats) => formats.filter((f) => f !== 'webp'),
};

const imageFormats = ['png', 'jpg', 'jpeg'];

export const detectDefaults: FormatDetectionParser = {
  extension: {
    type: 'detection-parser',
    priority: -1,
  },
  test: () => Promise.resolve(true),
  add: async (formats) => [...formats, ...imageFormats],
  remove: async (formats) => formats.filter((f) => !imageFormats.includes(f)),
};
