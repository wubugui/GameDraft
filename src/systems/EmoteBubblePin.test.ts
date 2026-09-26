import { describe, expect, it } from 'vitest';
import { pinBubbleInsideView } from './EmoteBubbleManager';

// 跑马梁「有人喊」：镜头约 800×600 世界单位，路边身影在画面右外侧
const view = { minX: 333, minY: 552, maxX: 1133, maxY: 1152 };
const m = 600 * 0.02;

describe('pinOnScreen 气泡贴边', () => {
  it('人在画面里：气泡原地不动', () => {
    expect(pinBubbleInsideView(700, 800, 120, 30, view)).toEqual({ x: 700, y: 800 });
  });
  it('人在画面右外侧：气泡贴右边、高度不变', () => {
    const at = pinBubbleInsideView(1218, 580, 120, 30, view);
    expect(at).toEqual({ x: 1133 - m - 120, y: 580 });
  });
  it('人在画面左上外：两个方向都推回来', () => {
    expect(pinBubbleInsideView(100, 300, 120, 30, view)).toEqual({ x: 333 + m, y: 552 + m });
  });
  it('人在画面下方外：贴底边', () => {
    expect(pinBubbleInsideView(700, 1400, 120, 30, view)).toEqual({ x: 700, y: 1152 - m - 30 });
  });
  it('气泡比画面还宽：靠左上，不越出左边', () => {
    expect(pinBubbleInsideView(2000, 800, 900, 30, view).x).toBe(333 + m);
  });
});
