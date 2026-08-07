import { Assets, Texture } from 'pixi.js';
import { mediaUrlForRoot } from '../core/projectPaths';

/**
 * UI 皮肤素材的装载层。
 *
 * 全站 UI 的「物质感」只依赖两张图：一张九宫格做旧木框、一张可平铺的纸纹细节图。
 * 两张都在 `Game` 启动时预载一次，之后由 `PanelSkin` 同步取用。
 *
 * **必须容忍未加载**：`uiTexture()` 在加载完成前（以及 jsdom 测试里）返回 null，
 * 调用方一律要有纯色降级路径——面板可以没质感，但绝不能因为一张图没到就画不出来。
 */

const SOURCES = {
  /** 九宫格木框：黑心已抠透明，内沿自带一条暗金细线 */
  frameWood: 'ui/frame_wood.png',
  /** 纸/布纹细节图：已归一到均值 ~236 的亮灰，供按面板色乘算 tint */
  paper: 'ui/paper_tile.png',
} as const;

export type UITextureKey = keyof typeof SOURCES;

/**
 * 木框素材导出时的边条宽度（纹理像素）。
 * `createWoodFrame` 拿它换算超采样倍率：想要 16px 的边就把九宫格按 32/16 倍放大后再缩回去，
 * 于是 2x 屏上木纹依然实。**换素材必须同步改这个值**（出图脚本在 tmp/ui_assets_2026-08-03/process.py）。
 */
export const FRAME_BORDER_PX = 32;

const cache = new Map<UITextureKey, Texture>();

/** 预载全部 UI 皮肤素材。单张失败只降级该张，不阻断启动。 */
export async function preloadUITextures(): Promise<void> {
  const keys = Object.keys(SOURCES) as UITextureKey[];
  await Promise.all(keys.map(async (key) => {
    if (cache.has(key)) return;
    try {
      const tex = await Assets.load<Texture>(mediaUrlForRoot('images', SOURCES[key]));
      // 纸纹要在面板里平铺：Graphics 的纹理填充直接读 source 的寻址模式，
      // 不设就会拿边缘像素拉伸（表现为面板中央一片死平）。
      if (key === 'paper') tex.source.addressMode = 'repeat';
      cache.set(key, tex);
    } catch (err) {
      console.warn(`[UITextures] ${key} 加载失败，本次降级为纯色底`, err);
    }
  }));
}

export function uiTexture(key: UITextureKey): Texture | null {
  return cache.get(key) ?? null;
}

/** 仅供测试/热重载复位。 */
export function _resetUITexturesForTest(): void {
  cache.clear();
}
