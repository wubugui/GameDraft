import { describe, expect, it } from 'vitest';
import { percentLayerRect } from './overlayPercentLayout';

describe('percentLayerRect(呼吸图叠图的百分比布局,CutsceneRenderer.showBreathingLayer 与呼吸工作台共用)', () => {
  it('中心 = 屏幕百分比、宽 = 屏宽百分比、高按图的宽高比', () => {
    expect(percentLayerRect(1600, 900, 1664, 928, 50, 48, 82)).toEqual({
      cx: 800, cy: 900 * 0.48, dispW: 1600 * 0.82, dispH: 1600 * 0.82 * (928 / 1664),
    });
    expect(percentLayerRect(320, 180, 320, 180, 50, 50, 100)).toEqual({ cx: 160, cy: 90, dispW: 320, dispH: 180 });
  });

  it('百分比先夹到合法范围;图尺寸按至少 1 算', () => {
    expect(percentLayerRect(100, 50, 10, 5, -5, 140, 0)).toEqual({ cx: 0, cy: 50, dispW: 0.01, dispH: 0.005 });
    expect(percentLayerRect(100, 50, 0, 0, 50, 50, 300)).toEqual({ cx: 50, cy: 25, dispW: 100, dispH: 100 });
  });
});
