import type { Renderer } from '../rendering/Renderer';

/**
 * UI 层 window 级指针/滚轮事件的共享工具。
 *
 * 背景约束（代码上看不出来的）：
 * - 游戏画布可能被 CSS 缩放（#game-mount 被调试侧栏挤压时 rect ≠ 逻辑分辨率），
 *   所以 clientX/Y 不能直接与 renderer.screenWidth 体系的逻辑坐标比较，必须按 rect 比例换算。
 * - window 级监听会同时收到来自 DOM 面板（F2 调试 dock、触屏 HUD 按钮）的事件，
 *   只有 target 是游戏 canvas 的事件才应驱动 Pixi UI，否则会出现"点调试面板推进对话"一类穿透。
 */

/** clientX/Y → 画布逻辑坐标（按 canvas 实际显示矩形换算缩放）。 */
export function clientToCanvas(
  renderer: Renderer,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const canvas = renderer.app.canvas as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (renderer.screenWidth / Math.max(1, rect.width)),
    y: (clientY - rect.top) * (renderer.screenHeight / Math.max(1, rect.height)),
  };
}

/** 事件是否发生在游戏 canvas 上（否则来自 DOM 面板/按钮，Pixi UI 应忽略）。 */
export function isEventOnGameCanvas(renderer: Renderer, e: Event): boolean {
  return e.target === (renderer.app.canvas as HTMLCanvasElement);
}

/**
 * 组合入口：事件不来自游戏 canvas 时返回 null（调用方直接忽略，不 preventDefault），
 * 否则返回换算后的画布逻辑坐标。
 */
export function canvasPointFromEvent(
  renderer: Renderer,
  e: { clientX: number; clientY: number; target: EventTarget | null },
): { x: number; y: number } | null {
  if (e.target !== (renderer.app.canvas as HTMLCanvasElement)) return null;
  return clientToCanvas(renderer, e.clientX, e.clientY);
}

// ---------------------------------------------------------------------------
// 同一次原生指针事件的"已消费"标记。
// Pixi 的交互监听挂在 canvas 上，先于 window 冒泡触发：选项行 pointerdown 同步走完
// 选择逻辑后，同一个原生事件还会到达 DialogueUI/EncounterUI 挂在 window 上的推进监听，
// 把新一段打字机瞬间跳满。行内 handler 用 markPointerConsumed(nativeEvent) 标记，
// window 监听用 isPointerConsumed 判断后忽略。
// 只保留最近一次的引用做恒等比较：新事件对象永远不等于旧引用，无需显式清除；
// 且允许多个 window 监听对同一事件各自查询（不能查完就清）。
// ---------------------------------------------------------------------------

let lastConsumedPointerEvent: unknown = null;

/** 由 Pixi 行内 pointerdown handler 调用，传入 FederatedEvent.nativeEvent（可能是 PixiTouch，只做恒等比较，故收 unknown）。 */
export function markPointerConsumed(e: unknown): void {
  if (e) lastConsumedPointerEvent = e;
}

/** window 级 pointerdown 监听调用：同一原生事件已被 UI 控件消费则返回 true。 */
export function isPointerConsumed(e: Event): boolean {
  return lastConsumedPointerEvent === e;
}
