/**
 * GpuTextures(空后端,不需要 GPU),对照 Pixi 8.17 的 GpuTextureSystem / GlTextureSystem:
 * - mip:`autoGenerateMipmaps` 的源按 `floor(log2(max(pw, ph))) + 1` 建满级纹理(写回 mipLevelCount),每次上传后、
 *   源发 updateMipmaps 时生成;其余纹理单级、不生成(HUD 三团火的 1/4 缩放靠它抗闪)。
 * - 监听:源的 GPU 纹理被重建(unload / resize / 回收)多少次,源上都只挂一份监听(Pixi 的 GCManagedHash 只加一次)。
 * - 视频:HTMLVideoElement 的 `width` 是 HTML 属性(缺省 0),按固有尺寸(videoWidth)判断,照常上传。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { RhiTextureUsage, type RhiTextureDesc } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource, ImageSource } from '../textures/TextureSource';
import { Rectangle } from '../math/Rectangle';
import { Buffer, BufferUsage } from '../shader/Buffer';
import { TextureStyle } from '../textures/TextureStyle';
import { GpuBuffers } from './GpuBuffers';
import { GpuTextures } from './GpuTextures';
import { WebGPURenderer } from './WebGPURenderer';

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const createTexture = vi.spyOn(rhi, 'createTexture');
  const descs = () => createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc);
  const rt = RenderTexture.create({ width: 64, height: 64 });
  const draw = (source: any, scale = 0.25) => {
    const root = new Container();
    const s = new Sprite(new Texture({ source }));
    s.scale.set(scale);
    root.addChild(s);
    renderer.render({ container: root, target: rt });
  };
  const mipGens = () => rhi.log.filter((l) => l.startsWith('generate mips'));
  return { rhi, renderer, descs, draw, mipGens };
}

/** HUD.loadFlameSheet 的顺序:autoGenerateMipmaps → scaleMode='linear' → update(),然后才第一次画 */
function flameSheet(): BufferImageSource {
  const src = new BufferImageSource({ resource: new Uint8Array(588 * 612 * 4), width: 588, height: 612, format: 'rgba8unorm', label: 'flame-sheet' });
  src.autoGenerateMipmaps = true;
  src.scaleMode = 'linear';
  src.update();
  return src;
}

describe('mipmap(autoGenerateMipmaps)', () => {
  it('建纹理时定满级数(同 Pixi GpuTextureSystem._initSource)、可作附件,上传后生成', () => {
    const { renderer, descs, draw, mipGens } = setup();
    const src = flameSheet();
    // Pixi 的算法(WebGL2 的 GlTextureSystem 按逻辑宽高、WebGPU 按像素宽高;分辨率 1 时相同)
    const pixiLevels = Math.floor(Math.log2(Math.max(src.pixelWidth, src.pixelHeight))) + 1;
    draw(src);
    const d = descs().find((x) => x.label === 'flame-sheet')!;
    expect(pixiLevels).toBe(10);
    expect(d.mipLevels).toBe(pixiLevels);
    expect(src.mipLevelCount).toBe(pixiLevels);
    expect(d.usage & RhiTextureUsage.RENDER_TARGET).toBeTruthy();
    expect(mipGens()).toEqual(['generate mips flame-sheet 10']);
    // 采样器带线性 mip 过滤(同 Pixi 的 LINEAR_MIPMAP_LINEAR)
    expect(src.style.mipmapFilter).toBe('linear');
    // 内容更新 → 重传后重新生成;没变的帧不生成
    draw(src);
    expect(mipGens()).toHaveLength(1);
    src.update();
    draw(src);
    expect(mipGens()).toHaveLength(2);
    // 手动 updateMipmaps(Pixi 的 onUpdateMipmaps)
    src.updateMipmaps();
    expect(mipGens()).toHaveLength(3);
    renderer.destroy();
  });

  it('Pixi 同样的源在 _initSource 后是同一级数', () => {
    const pixiSrc = new PIXI.BufferImageSource({ resource: new Uint8Array(588 * 612 * 4), width: 588, height: 612, format: 'rgba8unorm' });
    pixiSrc.autoGenerateMipmaps = true;
    const sys: any = Object.create((PIXI as any).GpuTextureSystem.prototype);
    let desc: any = null;
    sys._renderer = { uid: 1, gc: { now: 0, addResourceHash() {}, addCollection() {} } };
    sys._managedTextures = { add: () => false };
    sys._gpu = { device: { createTexture: (d: any) => { desc = d; return { width: d.size.width, height: d.size.height }; } } };
    sys._uploads = {};
    sys.onSourceUpdate = () => {};
    vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
    try {
      sys._initSource(pixiSrc);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(desc.mipLevelCount).toBe(10);
    const ours = flameSheet();
    const { renderer, descs, draw } = setup();
    draw(ours);
    expect(descs().find((x) => x.label === 'flame-sheet')!.mipLevels).toBe(desc.mipLevelCount);
    renderer.destroy();
  });

  it('generateTexture 带 autoGenerateMipmaps:画完即生成各级(同 Pixi GenerateTextureSystem 的 updateMipmaps)', () => {
    const { renderer, rhi, mipGens } = setup();
    const root = new Container();
    const s = new Sprite(Texture.WHITE);
    s.width = 64;
    s.height = 32;
    root.addChild(s);
    const tex = renderer.generateTexture({ target: root, textureSourceOptions: { autoGenerateMipmaps: true, label: 'gen' } as any });
    // Pixi:floor(log2(64)) + 1 = 7 级
    expect(tex.source.mipLevelCount).toBe(7);
    expect(mipGens()).toEqual(['generate mips gen 7']);
    // 生成在渲染之后(各级要从画好的 level 0 缩)
    const iGen = rhi.log.findIndex((l) => l.startsWith('generate mips'));
    const iDraw = rhi.log.findIndex((l) => l.startsWith('draw'));
    expect(iDraw).toBeGreaterThanOrEqual(0);
    expect(iDraw).toBeLessThan(iGen);
    // 缺省(不带 textureSourceOptions)不生成
    renderer.generateTexture(root);
    expect(mipGens()).toHaveLength(1);
    renderer.destroy();
  });

  it('没开 autoGenerateMipmaps 的纹理照旧单级、不生成', () => {
    const { renderer, descs, draw, mipGens } = setup();
    const src = new BufferImageSource({ resource: new Uint8Array(64 * 64 * 4), width: 64, height: 64, label: 'plain' });
    draw(src);
    const d = descs().find((x) => x.label === 'plain')!;
    expect(d.mipLevels ?? 1).toBe(1);
    expect(src.mipLevelCount).toBe(1);
    expect(mipGens()).toHaveLength(0);
    renderer.destroy();
  });
});

describe('源监听不随纹理重建叠加', () => {
  it('unload / 再画 5 轮、RenderTexture resize / 再画 5 轮:unload / destroy 监听始终各 1 份', () => {
    const { renderer, draw } = setup();
    const src = new ImageSource({ resource: { width: 4, height: 4 } as unknown as ImageBitmap });
    const counts: number[][] = [];
    for (let i = 0; i < 5; i++) {
      draw(src);
      counts.push([src.listenerCount('unload'), src.listenerCount('destroy')]);
      src.unload();
    }
    expect(counts).toEqual(Array(5).fill([1, 1]));
    // unload 之后纹理已放掉:不再挂监听(同 Pixi 的 GCManagedHash:放掉即摘)
    expect([src.listenerCount('unload'), src.listenerCount('destroy')]).toEqual([0, 0]);

    const rt = RenderTexture.create({ width: 8, height: 8 });
    const rtCounts: number[][] = [];
    for (let i = 0; i < 5; i++) {
      rt.source.resize(8 + i + 1, 8);
      renderer.render({ container: new Container(), target: rt });
      rtCounts.push([rt.source.listenerCount('unload'), rt.source.listenerCount('destroy')]);
    }
    expect(rtCounts).toEqual(Array(5).fill([1, 1]));
    renderer.destroy();
  });

  it('GpuBuffers:缓冲换了长度(重建)多次,destroy 监听仍只 1 份', () => {
    const rhi = new NullRhiDevice();
    const buffers = new GpuBuffers(rhi, rhi.createScope('t'));
    const b = new Buffer({ data: new Float32Array(4), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    for (let i = 0; i < 5; i++) {
      buffers.get(b);
      expect(b.listenerCount('destroy')).toBe(1);
      b.data = new Float32Array(8 + i * 4);
    }
    buffers.destroy();
  });
});

describe('视频源上传', () => {
  it('HTMLVideoElement(width 属性为 0、videoWidth 有值)照常上传(同 Pixi 按 resourceWidth)', () => {
    const { rhi, renderer, draw } = setup();
    const upload = vi.spyOn(rhi, 'uploadImage');
    const video = { width: 0, height: 0, videoWidth: 16, videoHeight: 16 } as unknown as HTMLVideoElement;
    const src = new ImageSource({ resource: video });
    expect(src.pixelWidth).toBe(16);
    draw(src, 1);
    expect(upload).toHaveBeenCalledTimes(1);
    // 还没解码出尺寸(videoWidth 0 / 图片 naturalWidth 0)的照旧跳过
    const pending = new ImageSource({ resource: { width: 0, height: 0, videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement, width: 4, height: 4 });
    draw(pending, 1);
    expect(upload).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });
});

describe('extract(对照 master 的 Pixi WebGL)', () => {
  // GPU 里的字节(预乘):半透明灰、不透明、全透明、低 alpha
  const GPU = new Uint8Array([64, 64, 64, 128, 200, 100, 50, 255, 0, 0, 0, 0, 10, 20, 30, 40]);

  function extractSetup() {
    const rhi = new NullRhiDevice();
    const canvas = { width: 4, height: 4, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 4, height: 4 });
    vi.spyOn(rhi, 'readTexture').mockImplementation(async () => ({ width: 4, height: 1, format: 'rgba8unorm', data: GPU }));
    return { renderer, rt: RenderTexture.create({ width: 4, height: 1 }) };
  }

  it('pixels 返回预乘字节,与 Pixi WebGL getPixels 逐字节相同', async () => {
    const { renderer, rt } = extractSetup();
    const ours = await renderer.extract.pixels(rt);
    const fakeGl: any = {
      FRAMEBUFFER: 1, RGBA: 2, UNSIGNED_BYTE: 3, bindFramebuffer() {},
      readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) { out.set(GPU); },
    };
    const sys: any = Object.create((PIXI as any).GlTextureSystem.prototype);
    sys._renderer = { gl: fakeGl, renderTarget: { getRenderTarget: () => ({}), getGpuRenderTarget: () => ({ resolveTargetFramebuffer: {} }) } };
    const pixi = sys.getPixels({ source: { resolution: 1 }, frame: new Rectangle(0, 0, 4, 1) });
    expect(Array.from(ours.pixels)).toEqual(Array.from(pixi.pixels));
    renderer.destroy();
  });

  it('base64:jpg → image/jpeg,缺省 png、质量 1(Pixi ExtractSystem 的 imageTypes / defaultImageOptions)', async () => {
    const { renderer, rt } = extractSetup();
    const calls: unknown[][] = [];
    const fakeCanvas: any = {
      getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
      toDataURL: (...a: unknown[]) => { calls.push(a); return 'data:'; },
    };
    vi.stubGlobal('document', { createElement: () => fakeCanvas });
    try {
      await renderer.extract.base64({ target: rt, format: 'jpg' });
      await renderer.extract.base64({ target: rt });
      await renderer.extract.base64({ target: rt, format: 'webp', quality: 0.5 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([['image/jpeg', 1], ['image/png', 1], ['image/webp', 0.5]]);
    renderer.destroy();
  });
});

describe('图像源上传的预乘(R2-4,对照 master 的 Pixi WebGL)', () => {
  const MODES = ['premultiply-alpha-on-upload', 'premultiplied-alpha', 'no-premultiply-alpha'] as const;

  /** 画一张以 resource 为资源的 ImageSource,返回交给 rhi.uploadImage 的 premultiplyAlpha */
  function uploadFlag(resource: object, alphaMode: (typeof MODES)[number]): boolean {
    const { rhi, draw } = setup();
    const up = vi.spyOn(rhi, 'uploadImage');
    draw(new ImageSource({ resource: resource as any, alphaMode }));
    expect(up).toHaveBeenCalledTimes(1);
    return !!up.mock.calls[0][2]?.premultiplyAlpha;
  }

  /**
   * master 的 ImageBitmap 纹理字节 = 位图解码时的 alpha 状态:Pixi 装载器只有 'premultiplied-alpha' 用
   * createImageBitmap(blob, { premultiplyAlpha: 'none' }) 解码,其余用缺省(解码期预乘);WebGL 对 ImageBitmap
   * 不看 UNPACK_PREMULTIPLY_ALPHA_WEBGL(游戏实测 no-premultiply-alpha 与缺省逐字节相同,见 AssetManager.loadTexture)
   */
  async function pixiDecodePremultiplied(alphaMode: string): Promise<boolean> {
    const decode = vi.fn(async (_blob: unknown, _opts?: ImageBitmapOptions) => ({ width: 4, height: 4 }));
    vi.stubGlobal('fetch', async () => ({ ok: true, blob: async () => ({}) }));
    vi.stubGlobal('createImageBitmap', decode);
    try {
      await PIXI.loadImageBitmap('x.png', { src: 'x.png', data: { alphaMode } } as any);
    } finally {
      vi.unstubAllGlobals();
    }
    return decode.mock.calls[0][1]?.premultiplyAlpha !== 'none';
  }

  it('ImageBitmap:纹理拿到的字节与位图解码状态一致(除 premultiplied-alpha 外都是预乘的)', async () => {
    class FakeImageBitmap {
      width = 4;
      height = 4;
    }
    const expected: boolean[] = [];
    for (const m of MODES) expected.push(await pixiDecodePremultiplied(m));
    expect(expected).toEqual([true, false, true]);
    vi.stubGlobal('ImageBitmap', FakeImageBitmap);
    try {
      expect(MODES.map((m) => uploadFlag(new FakeImageBitmap(), m))).toEqual(expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('其它图像源(<img> / 画布)照 UNPACK_PREMULTIPLY_ALPHA_WEBGL:只有 premultiply-alpha-on-upload 预乘', () => {
    const canvasLike = { width: 4, height: 4 };
    expect(MODES.map((m) => uploadFlag(canvasLike, m))).toEqual([true, false, false]);
  });
});

describe('采样器参数(R2-3,对照 Pixi GpuTextureSystem:整个 style 交给 device.createSampler)', () => {
  /** WebGPU 按 GPUSamplerDescriptor 的字段名从 style 上读:Pixi 那边实际生效的就是这些字段 */
  const SAMPLER_FIELDS = [
    'addressModeU', 'addressModeV', 'addressModeW', 'magFilter', 'minFilter', 'mipmapFilter',
    'lodMinClamp', 'lodMaxClamp', 'compare', 'maxAnisotropy',
  ] as const;
  const pixiSamplerFields = (s: PIXI.TextureStyle) => {
    const out: Record<string, unknown> = {};
    for (const k of SAMPLER_FIELDS) if ((s as any)[k] !== undefined) out[k] = (s as any)[k];
    return out;
  };

  it('各向异性 / LOD 夹取 / W 寻址照 style 传给 RHI 采样器', () => {
    const rhi = new NullRhiDevice();
    const createSampler = vi.spyOn(rhi, 'createSampler');
    const textures = new GpuTextures(rhi, rhi.rootScope, { now: 0 });
    const opts = { scaleMode: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, lodMinClamp: 0, lodMaxClamp: 2, addressModeW: 'repeat' } as const;
    textures.sampler(new TextureStyle(opts));
    textures.sampler(new TextureStyle({ scaleMode: 'nearest' }));
    const [aniso, plain] = createSampler.mock.calls.map((c) => {
      const { label: _label, ...rest } = c[1] as Record<string, unknown>;
      return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    });
    expect(aniso).toEqual(pixiSamplerFields(new PIXI.TextureStyle(opts)));
    expect(plain).toEqual(pixiSamplerFields(new PIXI.TextureStyle({ scaleMode: 'nearest' })));
  });
});
