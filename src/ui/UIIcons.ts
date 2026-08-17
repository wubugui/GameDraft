import { Assets, Texture } from 'pixi.js';
import { mediaUrlForRoot } from '../core/projectPaths';

/**
 * UI 图标库：民国木刻/水墨剪影，白色 + alpha，**运行时按主题色 tint**。
 *
 * 之所以统一成白剪影而不是各自上色：全站图标要跟着面板配色走（标题金、正文灰、
 * 禁用暗），一张白图 tint 出所有状态，改配色不用重出素材。
 *
 * 与 `UITextures` 分开是因为口径不同——那两张是皮肤底料，一定要在首个面板前到位；
 * 图标是点缀，晚到一帧只是这一帧没图标，不值得卡启动。
 */

const ICON_FILES = {
  coin: 'coin', pouch: 'pouch', talisman: 'talisman', book: 'book',
  scroll: 'scroll', map: 'map', gear: 'gear', hat: 'hat',
  key: 'key', umbrella: 'umbrella', lantern: 'lantern', censer: 'censer',
  rope: 'rope', incense: 'incense', bowl: 'bowl', boat: 'boat',
  // 2026-08-17 批产(tmp/ui_assets_2026-08-17_icons/):功能图标也走民俗物件——
  // ruler=戒尺(规矩) fan=说书折扇(对话录) mirror=照妖铜镜(检视)
  // hand=民国印刷指示手(指路/翻页,向右;向左用 scale.x=-1 镜像) thread=线团(线索) lock=广锁(锁定)
  ruler: 'ruler', fan: 'fan', mirror: 'mirror',
  hand: 'hand', thread: 'thread', lock: 'lock',
} as const;

export type UIIconName = keyof typeof ICON_FILES;

export const UI_ICON_NAMES = Object.keys(ICON_FILES) as UIIconName[];

const cache = new Map<UIIconName, Texture>();

/** 预载全部图标。单个失败只丢那一个（调用方拿到 null 时一律走"没图标"分支）。 */
export async function preloadUIIcons(): Promise<void> {
  await Promise.all(UI_ICON_NAMES.map(async (name) => {
    if (cache.has(name)) return;
    try {
      cache.set(name, await Assets.load<Texture>(mediaUrlForRoot('images', `ui/icons/${ICON_FILES[name]}.png`)));
    } catch (err) {
      console.warn(`[UIIcons] 图标 ${name} 加载失败`, err);
    }
  }));
}

export function uiIcon(name: UIIconName): Texture | null {
  return cache.get(name) ?? null;
}

/** 仅供测试/热重载复位。 */
export function _resetUIIconsForTest(): void {
  cache.clear();
}
