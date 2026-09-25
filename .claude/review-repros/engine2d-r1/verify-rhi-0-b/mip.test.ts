import { expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

it('autoGenerateMipmaps source -> texture mip levels', () => {
  const rhi = new NullRhiDevice();
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const ct = vi.spyOn(rhi, 'createTexture');
  const src = new TextureSource({ resource: new Uint8Array(588 * 612 * 4), width: 588, height: 612, label: 'flames' } as never);
  (src as any).uploadMethodId = 'buffer';
  src.autoGenerateMipmaps = true;
  src.scaleMode = 'linear';
  src.update();
  const root = new Container();
  const sp = new Sprite(new Texture({ source: src }));
  sp.scale.set(0.25);
  root.addChild(sp);
  renderer.render({ container: root });
  const d = ct.mock.calls.map((c) => c[1] as RhiTextureDesc).find((x) => x.label === 'flames');
  console.log('desc', d?.width, d?.height, 'mipLevels=', d?.mipLevels, 'srcMipLevelCount=', src.mipLevelCount);
  console.log('mip-related log', rhi.log.filter((l) => /mip/i.test(l)));
  expect(d).toBeDefined(); expect(d!.width).toBe(588); expect(d!.mipLevels ?? 1).toBe(1); expect(src.mipLevelCount).toBe(1);
});
