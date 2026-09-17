/**
 * 读一张图的 RGBA 像素（燃烧系统的燃料网格要 alpha、涂层要 R）。
 *
 * - **不预乘**解码（`premultiplyAlpha: 'none'`，pixi-v8-traps「alpha 当数据用」那条）：燃料只看 alpha，
 *   涂层看 R——预乘会让半透明边缘的涂层值被 alpha 吃掉。
 * - 长边超过 `maxSide` 就先缩到 `maxSide` 再读：燃料网格长边最多 160 格、每格 4×4 采样，640 足够，
 *   整张 2048 的原画读进 CPU 是白花几十毫秒。
 * - 路径与游戏其它资源同一个解析（`resolveAssetPath`）；`data:` URL（工作台存进资产里的涂层）原样读。
 * 读不到（404 / 解码失败 / 没有 OffscreenCanvas）⇒ null，调用方说一句并跳过这个可燃物。
 */
import { resolveAssetPath } from '../../core/assetPath';
import type { BurnImageData } from '../../systems/burn/burnSim';

export async function loadBurnImageData(url: string, maxSide = 640): Promise<BurnImageData | null> {
  try {
    const src = url.startsWith('data:') ? url : resolveAssetPath(url);
    const res = await fetch(src);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type && !type.startsWith('image/') && !url.startsWith('data:')) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const long = Math.max(bmp.width, bmp.height, 1);
    const k = long > maxSide ? maxSide / long : 1;
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    if (typeof OffscreenCanvas === 'undefined') { bmp.close(); return null; }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) { bmp.close(); return null; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const img = ctx.getImageData(0, 0, w, h);
    return { w, h, data: img.data };
  } catch {
    return null;
  }
}
