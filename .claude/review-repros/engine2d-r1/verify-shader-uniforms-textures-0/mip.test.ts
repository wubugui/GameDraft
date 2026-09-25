import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { BufferImageSource as PixiBufferImageSource, GlTextureSystem } from 'pixi.js';

// Mirrors the HUD flame sheet: 588x612, set autoGenerateMipmaps + linear + update() before first use.
const W = 588, H = 612;

describe('HUD flame sheet mip chain: engine2d vs Pixi WebGL', () => {
  it('Pixi GlTextureSystem: computes mipLevelCount, sets trilinear min filter, calls generateMipmap', () => {
    const calls: string[] = [];
    const consts: Record<string, number> = {
      TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, LINEAR: 0x2601, NEAREST: 0x2600,
      LINEAR_MIPMAP_LINEAR: 0x2703, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701, NEAREST_MIPMAP_LINEAR: 0x2702,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072, CLAMP_TO_EDGE: 0x812f, REPEAT: 0x2901, MIRRORED_REPEAT: 0x8370,
      TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d, TEXTURE0: 0x84c0, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      TEXTURE_CUBE_MAP: 0x8513, TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_3D: 0x806f,
    };
    const gl = new Proxy(consts as any, {
      get(t, k: string) {
        if (k in t) return t[k];
        if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return 0x10000 + k.length; // any other constant
        return (...args: unknown[]) => { calls.push(`${k}(${args.map((a) => (typeof a === 'object' && a ? 'obj' : String(a))).join(',')})`); return {}; };
      },
    });
    const renderer: any = {
      uid: 1,
      gc: { now: 0, addResourceHash() {} },
      context: { supports: { nonPowOf2mipmaps: true, nonPowOf2wrapping: true }, extensions: {}, webGLVersion: 2 },
    };
    (globalThis as any).WebGLRenderingContext ??= class {};
    const sys = new GlTextureSystem(renderer);
    sys.contextChange(gl);
    calls.length = 0;
    const src = new PixiBufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H, format: 'rgba8unorm' });
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    sys.bind({ source: src } as any, 0);
    console.log('pixi mipLevelCount', src.mipLevelCount);
    console.log('pixi gl calls', calls.join('\n'));
    expect(src.mipLevelCount).toBe(Math.floor(Math.log2(Math.max(W, H))) + 1); // 10
    expect(calls).toContain(`texParameteri(${0x0de1},${0x2801},${0x2703})`); // MIN_FILTER = LINEAR_MIPMAP_LINEAR
    expect(calls).toContain(`texParameteri(${0x0de1},${0x813d},9)`); // MAX_LEVEL = 9
    expect(calls.some((c) => c.startsWith('generateMipmap('))).toBe(true);
  });

  it('engine2d: same source -> single-level RHI texture, no mip generation', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const src = new BufferImageSource({ resource: new Uint8Array(W * H * 4), width: W, height: H, format: 'rgba8unorm', label: 'flame-sheet' });
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const sp = new Sprite(new Texture({ source: src }));
    sp.scale.set(0.25);
    const root = new Container();
    root.addChild(sp);
    rhi.log.length = 0;
    renderer.render({ container: root, target: RenderTexture.create({ width: 8, height: 8 }) });
    const descs = createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((d) => d.label === 'flame-sheet');
    console.log('engine2d desc', JSON.stringify(descs), 'mipLevelCount', src.mipLevelCount);
    console.log('engine2d log', rhi.log.join('\n'));
    expect(descs.length).toBe(1);
    expect((descs[0] as any).mipLevels ?? (descs[0] as any).mipLevelCount ?? 1).toBe(1);
    expect(src.mipLevelCount).toBe(1);
    expect(src.listenerCount('updateMipmaps')).toBe(0);
    expect(rhi.log.some((l) => /mip/i.test(l))).toBe(false);
    renderer.destroy();
  });
});
