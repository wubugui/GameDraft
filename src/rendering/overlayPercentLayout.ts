/**
 * 过场叠图的百分比布局(呼吸图 `CutsceneRenderer.showBreathingLayer` 用;呼吸工作台摆预览 / 出片也调它,两边同一个算式):
 * 中心 = 屏幕的 (xPercent, yPercent)%,宽 = 屏宽的 widthPercent%,高按图的宽高比。百分比先夹到合法范围。
 */
export interface PercentLayerRect {
  cx: number;
  cy: number;
  dispW: number;
  dispH: number;
}

export function percentLayerRect(
  screenW: number,
  screenH: number,
  texW: number,
  texH: number,
  xPercent: number,
  yPercent: number,
  widthPercent: number,
): PercentLayerRect {
  const xp = Math.max(0, Math.min(100, xPercent));
  const yp = Math.max(0, Math.min(100, yPercent));
  const wPct = Math.max(0.01, Math.min(100, widthPercent));
  const dispW = screenW * (wPct / 100);
  const dispH = dispW * (Math.max(1, texH) / Math.max(1, texW));
  return { cx: screenW * (xp / 100), cy: screenH * (yp / 100), dispW, dispH };
}
