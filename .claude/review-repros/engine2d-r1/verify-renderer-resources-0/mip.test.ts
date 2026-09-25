import { describe, expect, it, vi } from 'vitest';
import { GlTextureSystem, TextureSource as PixiTextureSource, BufferImageSource as PixiBufferImageSource } from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc, RhiSamplerDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

// 588x612 = the HUD flame sheet size
const W = 588, H = 612;

function fakeGl(log: string[]) {
  let n = 1;
  const consts = new Map<string, number>();
  return new Proxy({} as Record<string, unknown>, {
    get(_t, p: string) {
      if (typeof p !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(p)) { if (!consts.has(p)) consts.set(p, 0x1000 + n++); return consts.get(p); }
      if (p === 'getExtension') return () => null;
      if (p === 'getParameter') return () => 16;
      return (...args: unknown[]) => {
        const named = args.map((a) => { for (const [k, v] of consts) if (v === a) return k; return typeof a === 'object' ? 'obj' : String(a); });
        log.push(`${p}(${named.join(',')})`);
        return {};
      };
    },
  });
}

describe('autoGenerateMipmaps parity (HUD flame sheet path)', () => {
  it('Pixi WebGL2: mip chain computed + generateMipmap + LINEAR_MIPMAP_LINEAR', () => {
    const log: string[] = [];
    const renderer = { uid: 1, gc: { now: 0, addCollection() {}, addResourceHash() {} , removeCollection() {} }, context: { supports: { nonPowOf2mipmaps: true, nonPowOf2wrapping: true }, extensions: {}, webGLVersion: 2 } } as never;
    let sys: InstanceType<typeof GlTextureSystem>;
    try { sys = new GlTextureSystem(renderer); } catch (e) { console.log('ctor err', e); throw e; }
    const gl = fakeGl(log);
    (sys as any)._gl = gl;
    (sys as any)._mapFormatToInternalFormat = new Proxy({}, { get: () => 1 });
    (sys as any)._mapFormatToType = new Proxy({}, { get: () => 1 });
    (sys as any)._mapFormatToFormat = new Proxy({}, { get: () => 1 });
    (sys as any)._mapViewDimensionToGlTarget = new Proxy({}, { get: () => (gl as any).TEXTURE_2D });
    const src = new PixiBufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H, format: 'rgba8unorm' });
    // same order as HUD.loadFlameSheet
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    sys.initSource(src);
    console.log('PIXI mipLevelCount', src.mipLevelCount);
    console.log('PIXI gl calls', log.filter((l) => /generateMipmap|texParameteri/.test(l)));
    expect(src.mipLevelCount).toBe(10);
    expect(log.some((l) => l.startsWith('generateMipmap('))).toBe(true);
    expect(log.some((l) => l.includes('TEXTURE_MIN_FILTER,9987'))).toBe(true);
  });

  it('engine2d: no mip chain', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const createSampler = vi.spyOn(rhi, 'createSampler');
    const src = new BufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H, format: 'rgba8unorm' } as never);
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const root = new Container();
    const sp = new Sprite(new Texture({ source: src }));
    sp.scale.set(0.26);
    root.addChild(sp);
    renderer.render({ container: root });
    const descs = createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((d) => d.width === W);
    const samplers = createSampler.mock.calls.map((c) => c[1] as RhiSamplerDesc);
    require('fs').writeFileSync('tmp/review/verify-renderer-resources-0/e2d.json', JSON.stringify({descs, mip: src.mipLevelCount, samplers, miplog: rhi.log.filter((l) => /mip/i.test(l))}, null, 1));
    console.log('E2D samplers', samplers);
    console.log('E2D log mip-ish', rhi.log.filter((l) => /mip/i.test(l)));
    expect(descs.length).toBe(1);
    expect(descs[0].mipLevels ?? 1).toBe(1);
    expect(src.mipLevelCount).toBe(1);
    renderer.destroy();
  });
});
