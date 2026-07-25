import type { TextureSource } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';

/**
 * 法线图集:sprite 剪影的鼓包法线,**离线产物,运行时只加载不生成**。
 *
 * 法线完全由图集 alpha 决定(确定性派生物),因此归产线:
 *   `./dev.sh bake-normals` → `tools/animation_pipeline/bake_normal_atlas.py`
 * 产出与源图同目录的 `<源图名>.normal.png`(RGBA8:rg=法线xy, b=|nz|, a=鼓包 profile)。
 *
 * 运行时契约:
 *  - 只做**同步缓存读取**(图在场景 manifest 里随图集一起预载,已在加载门内 await 完);
 *  - 取不到就返回 null,调用方交给 `setNormalTexture(null)` → shader 的 `uHasNrm=0`
 *    分支走平面法线常量(垂直 sprite quad、朝相机),画面降级但不报错;
 *  - **禁止在加载期现场烘焙**:那是 O(图集像素) 的 EDT+高斯,会把主线程焊死数秒
 *    (茶馆实测 9.6s,进度条卡在 98% 画不出来)。新增图集请跑 bake-normals。
 */

const NORMAL_SUFFIX = '.normal.png';

/** `foo.png` → `foo.normal.png`;与离线工具的 `normal_path_for` 同一约定。 */
export function normalAtlasUrlFor(imageUrl: string): string | null {
  const dot = imageUrl.lastIndexOf('.');
  const slash = imageUrl.lastIndexOf('/');
  if (dot <= slash + 1) return null; // 无扩展名 / 隐藏文件,不猜
  return imageUrl.slice(0, dot) + NORMAL_SUFFIX;
}

/**
 * 同步取已预载的法线图集纹理源;未预载或产线没烘过 → null(调用方走平面法线兜底)。
 * 不触发任何加载与计算。
 */
export function getNormalAtlasSource(
  assets: AssetManager,
  imageUrl: string | null | undefined,
): TextureSource | null {
  if (!imageUrl) return null;
  const normalUrl = normalAtlasUrlFor(imageUrl);
  if (!normalUrl) return null;
  return assets.getTexture(normalUrl)?.source ?? null;
}
