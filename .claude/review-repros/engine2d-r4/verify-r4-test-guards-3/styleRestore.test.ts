import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

// Fake WebGL2 context: constants -> distinct numbers, methods -> recorded no-ops.
class FakeGL1 {}
class FakeGL2 extends FakeGL1 {}
(globalThis as any).WebGLRenderingContext ??= FakeGL1;
(globalThis as any).WebGL2RenderingContext ??= FakeGL2;
function fakeGl() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const consts = new Map<string, number>();
  const gl: any = new Proxy(Object.create((globalThis as any).WebGL2RenderingContext.prototype), {
    get(_t, p: string | symbol) {
      if (typeof p !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(p)) { if (!consts.has(p)) consts.set(p, 0x1000 + consts.size); return consts.get(p); }
      if (p === 'getParameter') return () => 16;
      if (p === 'createTexture') return () => ({});
      return (...args: unknown[]) => { calls.push({ fn: p, args }); return undefined; };
    },
  });
  const lits: Record<number,string> = {9728:'NEAREST',9729:'LINEAR',10497:'REPEAT',33071:'CLAMP_TO_EDGE',33648:'MIRRORED_REPEAT'};
  const name = (v: number) => lits[v] ?? [...consts].find(([, n]) => n === v)?.[0];
  return { gl, calls, name };
}

function pixiGlSystem(gl: any) {
  const renderer: any = {
    uid: 777,
    gc: { now: 0, addResourceHash() {} },
    context: { extensions: {}, supports: { nonPowOf2wrapping: true, nonPowOf2mipmaps: true }, webGLVersion: 2 },
  };
  const sys = new (PIXI as any).GlTextureSystem(renderer);
  return sys;
}

describe('style changed after first use without update(), then context/device restore', () => {
  it('master (Pixi WebGL GlTextureSystem): restored GL texture gets CURRENT fields (nearest/repeat)', () => {
    const { gl, calls, name } = fakeGl();
    const sys = pixiGlSystem(gl);
    sys.contextChange(gl);
    const src = new PIXI.BufferImageSource({ resource: new Uint8Array(64), width: 4, height: 4, format: 'rgba8unorm' } as any);
    sys.bind({ source: src } as any, 0); // first use: linear/clamp
    const magAt = (from: number) => calls.slice(from).filter((c) => c.fn === 'texParameteri' && name(c.args[1] as number) === 'TEXTURE_MAG_FILTER').map((c) => name(c.args[2] as number));
    const wrapAt = (from: number) => calls.slice(from).filter((c) => c.fn === 'texParameteri' && name(c.args[1] as number) === 'TEXTURE_WRAP_S').map((c) => name(c.args[2] as number));
    expect(magAt(0).at(-1)).toBe('LINEAR');
    src.scaleMode = 'nearest';
    src.addressMode = 'repeat';
    // simulate webglcontextrestored -> runners.contextChange
    const mark = calls.length;
    sys.contextChange(gl);
    sys.bind({ source: src } as any, 0);
    console.log('master after restore mag=', magAt(mark), 'wrapS=', wrapAt(mark));
    expect(magAt(mark).at(-1)).toBe('NEAREST');
    expect(wrapAt(mark).at(-1)).toBe('REPEAT');
  });

  it('branch (engine2d on WebGPU): after device restore still linear/clamp (cached key fields)', async () => {
    const source = new BufferImageSource({ resource: new Uint8Array(64), width: 4, height: 4, format: 'rgba8unorm', label: 'src' });
    const root = new Container();
    root.addChild(new Sprite(new Texture({ source })));
    const rhi = new NullRhiDevice({ swapchainSize: [16, 16] });
    const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
    const r = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    r.render({ container: root, target: RenderTexture.create({ width: 16, height: 16 }) });
    source.scaleMode = 'nearest';
    source.addressMode = 'repeat';
    await rhi.loseDevice('test');
    const createSampler = vi.spyOn(rhi, 'createSampler');
    r.render({ container: root, target: RenderTexture.create({ width: 16, height: 16 }) });
    const descs = createSampler.mock.calls.map((c) => c[1] as { label?: string; magFilter?: string; addressModeU?: string });
    const mine = descs.filter((d) => d.label?.includes(source.style._key));
    console.log('branch after restore', mine.map((d) => [d.magFilter, d.addressModeU]));
    expect(mine).toHaveLength(1);
    expect(mine[0].magFilter).toBe('linear');
    expect(mine[0].addressModeU).toBe('clamp-to-edge');
  });

  it('master GC unload + re-bind re-applies current fields; branch GC unload keeps cached', () => {
    const { gl, calls, name } = fakeGl();
    const sys = pixiGlSystem(gl);
    sys.contextChange(gl);
    const src = new PIXI.BufferImageSource({ resource: new Uint8Array(64), width: 4, height: 4, format: 'rgba8unorm' } as any);
    sys.bind({ source: src } as any, 0);
    src.scaleMode = 'nearest';
    src.unload();
    const mark = calls.length;
    sys.bind({ source: src } as any, 1);
    const mag = calls.slice(mark).filter((c) => c.fn === 'texParameteri' && name(c.args[1] as number) === 'TEXTURE_MAG_FILTER').map((c) => name(c.args[2] as number));
    console.log('master after GC reupload mag=', mag);
    expect(mag).toEqual(['NEAREST']);
  });
});
