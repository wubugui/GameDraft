/**
 * 逻辑视口 → 显示盒的等比换算（信箱 / 柱箱）。
 *
 * 游戏在固定的逻辑分辨率下渲染（`game_config.viewport`，1024×768），显示时**只允许等比缩放**：
 * 宿主给多大的区域，就在里面放一个最大的同比例盒，余下的是黑边。
 *
 * 2026-09-06 之前这一步不存在：canvas 100%×100% 铺满 `#game-mount`，而 `#game-mount` 又被
 * F2 调试坞的 flex 规则横向撑满窗口——4:3 的画在 1280×720 的 exe 窗口里被拉成 16:9
 * （横向 ×1.25），编辑器预览窗恰好是 1024×768 所以从没露馅。
 *
 * 纯函数，`viewportFit.test.ts` 钉死几组尺寸。
 */

export interface ContainBox {
  /** 显示盒宽（CSS px，整数，向下取整以免溢出可用区） */
  width: number;
  height: number;
  /** 显示盒相对逻辑视口的缩放；0 = 参数不合法 */
  scale: number;
}

/** 把 `vw×vh` 的逻辑视口等比放进 `availW×availH`：返回最大的同比例盒。 */
export function containBox(availW: number, availH: number, vw: number, vh: number): ContainBox {
  if (!(availW > 0 && availH > 0 && vw > 0 && vh > 0)) return { width: 0, height: 0, scale: 0 };
  const scale = Math.min(availW / vw, availH / vh);
  return {
    width: Math.max(1, Math.floor(vw * scale)),
    height: Math.max(1, Math.floor(vh * scale)),
    scale,
  };
}
