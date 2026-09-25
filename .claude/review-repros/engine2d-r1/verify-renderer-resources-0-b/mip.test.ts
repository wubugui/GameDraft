import { expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

it('autoGenerateMipmaps set after load (HUD pattern)', () => {
  const rhi = new NullRhiDevice();
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const ct = vi.spyOn(rhi, 'createTexture');
  const src = new TextureSource({ resource: new Uint8Array(588 * 612 * 4), width: 588, height: 612, label: 'sheet' } as never);
  src.autoGenerateMipmaps = true;
  src.scaleMode = 'linear';
  src.update();
  const tex = new Texture({ source: src });
  const sp = new Sprite(tex); sp.scale.set(0.25);
  const root = new Container(); root.addChild(sp);
  renderer.render({ container: root });
  const d = ct.mock.calls.map((c) => c[1] as RhiTextureDesc).find((x) => x.label === 'sheet');
  console.log('desc', JSON.stringify({ w: d?.width, mip: d?.mipLevels }), 'mipLevelCount', src.mipLevelCount, 'style', src.style.minFilter, src.style.mipmapFilter);
  console.log(rhi.log.filter((l) => /mip/i.test(l)));
  expect(d?.mipLevels ?? 1).toBe(1);
  renderer.destroy();
});
