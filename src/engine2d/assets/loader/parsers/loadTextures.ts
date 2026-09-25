/**
 * 图片纹理装载器(移植自 PixiJS v8.17(MIT):`assets/loader/parsers/textures/loadTextures`
 * + `textures/utils/createTexture`,逐行对应)。
 *
 * ⚠ 纹理的 alpha 语义直接决定像素,这里每个参数都必须与 Pixi 8.17 相同:
 * 1. 解码:`fetch(url)` → `blob()` → `createImageBitmap(blob)`**不带选项**(浏览器缺省在解码期预乘 rgb×a);
 *    **唯一例外**是 `data.alphaMode === 'premultiplied-alpha'`:用 `{ premultiplyAlpha: 'none' }` 保留原始字节
 *    (语义"数据已预乘、别再动",名字反直觉,但这是"alpha 当数据用"的唯一原样通道——法线图集就走它)。
 *    缺省在 Worker 里做(`config.preferWorkers`),参数与主线程路径完全一样;没有 createImageBitmap 时退回 <img>。
 * 2. 源:`new ImageSource({ resource, alphaMode: 'premultiply-alpha-on-upload', resolution, ...data })`,
 *    `resolution` = `data.resolution || 从 url 解析(@2x → 2,否则 1)`;`data` 里的键(alphaMode 等)覆盖缺省。
 * 3. 纹理:`source.label = url`、`label = url`;直接 destroy 被 Assets 管着的纹理 / 源会告警并从缓存摘掉。
 */
import { DOMAdapter } from '../../../environment/adapter';
import { ImageSource, type TextureSourceOptions } from '../../../textures/TextureSource';
import { Texture } from '../../../textures/Texture';
import { Cache } from '../../cache/Cache';
import { getResolutionOfUrl } from '../../resolver/Resolver';
import { checkDataUrl, checkExtension } from '../../utils/helpers';
import { warn } from '../../utils/warn';
import { WorkerManager } from '../workers/WorkerManager';
import { LoaderParserPriority, type LoaderParser, type ResolvedAsset } from '../../types';
import type { Loader } from '../Loader';

const validImageExtensions = ['.jpeg', '.jpg', '.png', '.webp', '.avif'];
const validImageMIMEs = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/** 纹理装载器的可调项(`Assets.setPreferences` 按键名改) */
export interface LoadTextureConfig {
  /** 在 Worker 里 fetch + 解码(缺省 true) */
  preferWorkers: boolean;
  /** 用 createImageBitmap 解码(缺省 true;false 或环境没有时走 <img>) */
  preferCreateImageBitmap: boolean;
  /** 走 <img> 时的 crossOrigin(缺省 'anonymous') */
  crossOrigin: HTMLImageElement['crossOrigin'];
}

/** 主线程路径:fetch → blob → createImageBitmap(选项规则见文件头) */
export async function loadImageBitmap(url: string, asset?: ResolvedAsset<TextureSourceOptions>): Promise<ImageBitmap> {
  const response = await DOMAdapter.get().fetch(url);
  if (!response.ok) {
    throw new Error(`[loadImageBitmap] Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const imageBlob = await response.blob();
  return asset?.data?.alphaMode === 'premultiplied-alpha'
    ? createImageBitmap(imageBlob, { premultiplyAlpha: 'none' })
    : createImageBitmap(imageBlob);
}

/** 由源建一张被 Assets 管着的纹理(同 Pixi `createTexture`) */
export function createTexture(source: ImageSource, loader: Loader, url: string): Texture {
  source.label = url;
  (source as ImageSource & { _sourceOrigin?: string })._sourceOrigin = url;
  const texture = new Texture({
    source,
    label: url,
  });
  const unload = (): void => {
    delete loader.promiseCache[url];
    if (Cache.has(url)) {
      Cache.remove(url);
    }
  };
  texture.source.once('destroy', () => {
    if (loader.promiseCache[url]) {
      warn('[Assets] A TextureSource managed by Assets was destroyed instead of unloaded! Use Assets.unload() instead of destroying the TextureSource.');
      unload();
    }
  });
  texture.once('destroy', () => {
    if (!source.destroyed) {
      warn('[Assets] A Texture managed by Assets was destroyed instead of unloaded! Use Assets.unload() instead of destroying the Texture.');
      unload();
    }
  });
  return texture;
}

export const loadTextures: LoaderParser<Texture, TextureSourceOptions, LoadTextureConfig> = {
  name: 'loadTextures',
  id: 'texture',
  extension: {
    type: 'load-parser',
    priority: LoaderParserPriority.High,
    name: 'loadTextures',
  },
  config: {
    preferWorkers: true,
    preferCreateImageBitmap: true,
    crossOrigin: 'anonymous',
  },
  test(url: string): boolean {
    return checkDataUrl(url, validImageMIMEs) || checkExtension(url, validImageExtensions);
  },
  async load(url: string, asset?: ResolvedAsset<TextureSourceOptions>, loader?: Loader): Promise<Texture> {
    const config = this.config as LoadTextureConfig;
    let src: ImageBitmap | HTMLImageElement | null = null;
    // 与 Pixi 相同:按"全局上有没有 createImageBitmap"判(类型上它恒存在,实际环境里可能没有)
    if ((globalThis as { createImageBitmap?: unknown }).createImageBitmap && config.preferCreateImageBitmap) {
      if (config.preferWorkers && (await WorkerManager.isImageBitmapSupported())) {
        src = await WorkerManager.loadImageBitmap(url, asset);
      } else {
        src = await loadImageBitmap(url, asset);
      }
    } else {
      src = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = DOMAdapter.get().createImage();
        img.crossOrigin = config.crossOrigin;
        img.src = url;
        if (img.complete) {
          resolve(img);
        } else {
          img.onload = () => {
            resolve(img);
          };
          img.onerror = reject;
        }
      });
    }
    const base = new ImageSource({
      resource: src,
      alphaMode: 'premultiply-alpha-on-upload',
      resolution: asset?.data?.resolution || getResolutionOfUrl(url),
      ...asset?.data,
    } as ConstructorParameters<typeof ImageSource>[0]);
    return createTexture(base, loader as Loader, url);
  },
  unload(texture: Texture): void {
    texture.destroy(true);
  },
};
