/**
 * 滤镜全局 uniform `uOutputTexture.w`(R5,空后端):输出到画布时 = 画布像素高,离屏目标 = 0。
 * 着色器拿它把 `@builtin(position).y` 换成 master(WebGL)画布上 gl_FragCoord 的自下而上
 * (CharacterShadingFilter 的 RT gather 噪声种子);离屏目标上 master 的 gl_FragCoord 与本侧同向,不翻。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { FrameBuilder } from './FrameBuilder';
import { WebGPURenderer } from './WebGPURenderer';

function outputTextures(spy: { mock: { calls: unknown[][] } }): number[][] {
  return spy.mock.calls
    .map((c) => (c[1] as { uOutputTexture?: Float32Array }).uOutputTexture)
    .filter((v): v is Float32Array => !!v)
    .map((v) => Array.from(v));
}

describe('滤镜 uOutputTexture.w', () => {
  it('输出到画布 = 画布像素高;输出到渲染纹理 = 0', () => {
    const rhi = new NullRhiDevice({ swapchainSize: [32, 24] });
    const canvas = { width: 32, height: 24, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 32, height: 24 });
    const root = new Container();
    const s = new Sprite(Texture.WHITE);
    s.width = 10;
    s.height = 10;
    s.filters = [new AlphaFilter({ alpha: 0.5 })];
    root.addChild(s);
    const writeUbo = vi.spyOn(FrameBuilder.prototype as unknown as { writeUbo: (...a: unknown[]) => number }, 'writeUbo');

    renderer.render({ container: root });
    const onCanvas = outputTextures(writeUbo);
    expect(onCanvas.length).toBeGreaterThan(0);
    expect(onCanvas[onCanvas.length - 1][3]).toBe(24);

    writeUbo.mockClear();
    renderer.render({ container: root, target: RenderTexture.create({ width: 16, height: 16 }) });
    const offscreen = outputTextures(writeUbo);
    expect(offscreen.length).toBeGreaterThan(0);
    expect(offscreen.every((v) => v[3] === 0)).toBe(true);
    writeUbo.mockRestore();
    renderer.destroy();
  });
});
