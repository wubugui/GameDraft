/**
 * 渲染器尺寸与 Pixi 对齐(空后端):`width` / `height` 是逻辑尺寸(CSS 像素),画布像素在 `canvas.width`;
 * `resize` 给 0 沿用当前值(隐藏的挂载点量出 0 时画布不缩没);逻辑尺寸按整像素回算。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from './WebGPURenderer';

function make(resolution: number, autoDensity = false) {
  const canvas = { width: 0, height: 0, style: {} as Record<string, string> } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi: new NullRhiDevice(), canvas, width: 100, height: 50, resolution, autoDensity });
  return { renderer, canvas };
}

describe('渲染器尺寸(照 Pixi)', () => {
  it('width / height 是逻辑尺寸,画布是像素尺寸', () => {
    const { renderer, canvas } = make(2);
    expect([renderer.width, renderer.height]).toEqual([100, 50]);
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    expect([renderer.screen.width, renderer.screen.height]).toEqual([100, 50]);
    renderer.destroy();
  });

  it('resize(0, …) 沿用当前尺寸,不把画布缩成 0', () => {
    const { renderer, canvas } = make(1);
    renderer.resize(0, 0);
    expect([renderer.width, renderer.height, canvas.width, canvas.height]).toEqual([100, 50, 100, 50]);
    renderer.resize(0, 80);
    expect([renderer.width, renderer.height, canvas.height]).toEqual([100, 80, 80]);
    renderer.destroy();
  });

  it('非整数分辨率:逻辑尺寸按整像素回算,autoDensity 的 CSS 尺寸同值', () => {
    const { renderer, canvas } = make(1.5, true);
    renderer.resize(1001, 333);
    expect([canvas.width, canvas.height]).toEqual([1502, 500]);
    expect(renderer.width).toBeCloseTo(1502 / 1.5, 10);
    expect(renderer.height).toBeCloseTo(500 / 1.5, 10);
    expect((canvas.style as unknown as Record<string, string>).width).toBe(`${1502 / 1.5}px`);
    renderer.destroy();
  });
});
