/**
 * 滤镜池纹理超过设备纹理上限(R2-1,空后端,不需要 GPU):
 * - 不裁到视口(clipToViewport: false)的滤镜按整个内容取池纹理、向上取 2 的幂(同 Pixi FilterSystem / TexturePool,
 *   Pixi 没有任何上限检查);设备上限够(真设备向适配器要到的 16384)就照常画,同 master 的 WebGL;
 * - 超过上限这一帧失败(建纹理抛 unsupported,由游戏的渲染兜错截住),但借出的池纹理要还回池里:
 *   Pixi 在 WebGPU 上建出无效纹理也照常走到 filterPop 归还,池不会每帧多一张。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { TexturePool } from '../textures/TexturePool';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from './WebGPURenderer';

/** 画布 64×64,内容 9000×100(不裁到视口 → 池纹理 16384×128) */
function setup(maxTextureSize?: number) {
  const rhi = new NullRhiDevice({ maxTextureSize });
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const stage = new Container();
  const content = new Container();
  const sprite = new Sprite(Texture.WHITE);
  sprite.width = 9000;
  sprite.height = 100;
  content.addChild(sprite);
  content.filters = [new AlphaFilter({ alpha: 0.5, clipToViewport: false })];
  stage.addChild(content);
  return { rhi, renderer, stage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('滤镜池纹理与设备纹理上限(R2-1)', () => {
  it('Pixi 对同样的内容要 16384 宽的池纹理(不检查上限)', () => {
    const tex = PIXI.TexturePool.getOptimalTexture(9000, 100, 1, false);
    expect([tex.source.pixelWidth, tex.source.pixelHeight]).toEqual([16384, 128]);
    PIXI.TexturePool.returnTexture(tex);
  });

  it('设备上限 16384(向适配器要到的)时照常画', () => {
    const { rhi, renderer, stage } = setup(16384);
    const errors: string[] = [];
    rhi.onDiagnostic((e) => errors.push(e.message));
    expect(() => renderer.render({ container: stage })).not.toThrow();
    expect(errors).toEqual([]);
  });

  it('超过上限:每帧抛 unsupported,但借出的池纹理归还,连续失败不再新建池纹理', () => {
    const { renderer, stage } = setup(8192);
    const taken = vi.spyOn(TexturePool, 'getOptimalTexture');
    for (let i = 0; i < 3; i++) {
      expect(() => renderer.render({ container: stage })).toThrow(/16384×128 超过设备上限 8192/);
    }
    const big = taken.mock.results.map((r) => r.value as Texture).filter((t) => t.source.pixelWidth === 16384);
    expect(big).toHaveLength(3);
    // 每帧拿到的是同一张(上一帧已归还)
    expect(new Set(big).size).toBe(1);
  });
});
