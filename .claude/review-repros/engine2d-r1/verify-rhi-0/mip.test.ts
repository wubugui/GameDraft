import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';

// Pixi (master path): GlTextureSystem with a recording fake gl
import { GlTextureSystem } from 'pixi.js';
import { BufferImageSource as PixiBufferImageSource } from 'pixi.js';

const W = 12 * 49, H = 6 * 102; // flame atlas size (4x)

function fakeGl(calls: string[]) {
  let n = 1000;
  const consts = new Map<string, number>();
  return new Proxy({} as any, {
    get(_t, p: string) {
      if (typeof p !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(p)) { if (!consts.has(p)) consts.set(p, n++); return consts.get(p); }
      return (...args: unknown[]) => {
        calls.push(`${p}(${args.map((a) => (typeof a === 'number' ? [...consts].find(([, v]) => v === a)?.[0] ?? a : typeof a)).join(',')})`);
        if (p === 'createTexture' || p === 'createSampler') return {};
        if (p === 'getParameter') return 16;
        return undefined;
      };
    },
  });
}

describe('mipmaps for autoGenerateMipmaps sources (HUD flame atlas)', () => {
  it('master (Pixi GlTextureSystem): allocates full mip chain + generateMipmap', () => {
    const calls: string[] = [];
    const renderer: any = {
      uid: 1,
      gc: { now: 0, addResourceHash() {}, addCollection() {} },
      context: { webGLVersion: 2, supports: { nonPowOf2mipmaps: true, nonPowOf2wrapping: true }, extensions: {} },
    };
    (globalThis as any).WebGLRenderingContext ??= class {};
    const sys = new GlTextureSystem(renderer);
    sys.contextChange(fakeGl(calls));
    calls.length = 0;
    const src = new PixiBufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H });
    // HUD.loadFlameSheet: set after load, before first bind
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    sys.initSource(src);
    console.log('pixi mipLevelCount', src.mipLevelCount);
    console.log(calls.join(' | '));
    expect(src.mipLevelCount).toBe(Math.floor(Math.log2(Math.max(W, H))) + 1);
    expect(calls.some((c) => c.startsWith('generateMipmap'))).toBe(true);
  });

  it('branch (engine2d on RHI): texture created with 1 mip level, no mip generation', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const src = new BufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H, label: 'flame-atlas' });
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const root = new Container();
    const sp = new Sprite(new Texture({ source: src, frame: new Rectangle(0, 0, 49, 102) }));
    sp.scale.set(0.25);
    root.addChild(sp);
    renderer.render({ container: root });
    const desc = createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).find((d) => d.label === 'flame-atlas');
    console.log('engine2d desc', JSON.stringify(desc), 'src.mipLevelCount', src.mipLevelCount);
    console.log('log mip-related', rhi.log.filter((l) => /mip/i.test(l)));
    expect(desc).toBeDefined();
    expect(desc!.mipLevels ?? 1).toBe(1); // divergence: Pixi = 10
    expect(src.mipLevelCount).toBe(1);
    renderer.destroy();
  });
});
