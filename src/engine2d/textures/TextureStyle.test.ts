/**
 * TextureStyle 的采样键照 Pixi 8.17 的 `_resourceId`:GPU 缓存第一次见这个 style 时算好记下,之后改字段不生效,
 * `update()`(版本 `_updateId` 变)才重算——这是同一设备(同一渲染器、没丢过设备)内的语义。
 * 新缓存对照 master 的 WebGL(R4-6):WebGL 上下文恢复 / 新渲染器上 GL 纹理重建,GlTextureSystem._initSource →
 * applyStyleParams 读 style 字段现值;所以设备丢失恢复与新渲染器之后,第一次取采样器按字段现值算键。
 * 键记在各 GPU 缓存里,不在 style 上:两个渲染器同时在用时互不影响(各自的设备都没换代)。
 * GC 回收(unload)后重传同样按字段现值重算(R5,对照 master:unload 清掉 GL 纹理,下次绑定 _initSource →
 * applyStyleParams 读现值;这里拿 Pixi 真的 GlTextureSystem 并排比)。
 * 以前每取一次都现拼一个长字符串再查表,合批每个 draw 取 16 次,是渲染主线程最热的一处。
 */
import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from './Texture';
import { RenderTexture } from './RenderTexture';
import { BufferImageSource } from './TextureSource';
import { TextureStyle } from './TextureStyle';
import { WebGPURenderer } from '../gpu/WebGPURenderer';

describe('TextureStyle 采样键(对照 Pixi TextureStyle._resourceId)', () => {
  it('改字段不 update:版本不变;update 后才变;改回再 update 回到原来的键', () => {
    const pixi = new PIXI.TextureStyle();
    const ours = new TextureStyle();
    const p0 = pixi._resourceId;
    const v0 = ours._updateId;
    const o0 = ours._captureKey().key;

    pixi.addressMode = 'repeat';
    ours.addressMode = 'repeat';
    expect(pixi._resourceId).toBe(p0);
    expect(ours._updateId).toBe(v0);

    pixi.update();
    ours.update();
    expect(pixi._resourceId).not.toBe(p0);
    expect(ours._updateId).not.toBe(v0);
    expect(ours._captureKey().key).not.toBe(o0);

    pixi.addressMode = 'clamp-to-edge';
    ours.addressMode = 'clamp-to-edge';
    pixi.update();
    ours.update();
    expect(pixi._resourceId).toBe(p0);
    expect(ours._captureKey().key).toBe(o0);
  });

  it('渲染器按键取采样器:画过之后改 scaleMode 不 update 仍用原采样器,update 后换成最近邻', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    const createSampler = vi.spyOn(rhi, 'createSampler');
    const source = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4), width: 4, height: 4, format: 'rgba8unorm', label: 'src' });
    const rt = RenderTexture.create({ width: 16, height: 16 });
    const root = new Container();
    root.addChild(new Sprite(new Texture({ source })));
    const filters = () => createSampler.mock.calls.map((c) => (c[1] as { magFilter?: string }).magFilter);

    renderer.render({ container: root, target: rt });
    expect(filters()).not.toContain('nearest');

    source.scaleMode = 'nearest';
    renderer.render({ container: root, target: rt });
    expect(filters()).not.toContain('nearest');

    source.style.update();
    renderer.render({ container: root, target: rt });
    expect(filters()).toContain('nearest');
  });

  function usedSource() {
    const source = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4), width: 4, height: 4, format: 'rgba8unorm', label: 'src' });
    const root = new Container();
    root.addChild(new Sprite(new Texture({ source })));
    return { source, root };
  }
  const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
  const rt = () => RenderTexture.create({ width: 16, height: 16 });
  type SamplerDesc = { label?: string; magFilter?: string; addressModeU?: string };
  const samplerDescs = (spy: { mock: { calls: unknown[][] } }): SamplerDesc[] => spy.mock.calls.map((c) => c[1] as SamplerDesc);

  it('新渲染器(对照 master 新 GL 上下文):用过后改字段不 update,新渲染器按字段现值建采样器', () => {
    const { source, root } = usedSource();
    const rhi1 = new NullRhiDevice();
    const cs1 = vi.spyOn(rhi1, 'createSampler');
    const r1 = new WebGPURenderer({ rhi: rhi1, canvas, width: 16, height: 16 });
    r1.render({ container: root, target: rt() });

    // 同一渲染器里改字段不 update:仍是原采样器(Pixi 同)
    source.scaleMode = 'nearest';
    source.addressMode = 'repeat';
    r1.render({ container: root, target: rt() });
    expect(samplerDescs(cs1).some((d) => d.magFilter === 'nearest')).toBe(false);

    const rhi2 = new NullRhiDevice();
    const createSampler = vi.spyOn(rhi2, 'createSampler');
    const r2 = new WebGPURenderer({ rhi: rhi2, canvas, width: 16, height: 16 });
    r2.render({ container: root, target: rt() });
    // 键与参数一致:键里就是现值
    const key = source.style._captureKey().key;
    const mine = samplerDescs(createSampler).filter((d) => d.label?.includes(key));
    expect(mine).toHaveLength(1);
    expect(mine[0].magFilter).toBe('nearest');
    expect(mine[0].addressModeU).toBe('repeat');
  });

  it('两个渲染器同时在用(对照 Pixi WebGPU 按 _resourceId、master 各 GL 上下文各有一份 GL 纹理):轮流画不会让没换代的那个读到现值', () => {
    const { source, root } = usedSource();
    const rhi1 = new NullRhiDevice();
    const rhi2 = new NullRhiDevice();
    const r1 = new WebGPURenderer({ rhi: rhi1, canvas, width: 16, height: 16 });
    const r2 = new WebGPURenderer({ rhi: rhi2, canvas, width: 16, height: 16 });
    const cs1 = vi.spyOn(rhi1, 'createSampler');
    r1.render({ container: root, target: rt() });
    r2.render({ container: root, target: rt() });

    // 两边都用过之后改字段不 update:两边都还是线性
    source.scaleMode = 'nearest';
    r2.render({ container: root, target: rt() });
    r1.render({ container: root, target: rt() });
    expect(samplerDescs(cs1).map((d) => d.magFilter)).not.toContain('nearest');

    // update 后两边都换成最近邻
    source.style.update();
    r1.render({ container: root, target: rt() });
    expect(samplerDescs(cs1).map((d) => d.magFilter)).toContain('nearest');
    r1.destroy();
    r2.destroy();
  });

  it('GC 回收重传:与 master(Pixi WebGL GlTextureSystem)相同,按字段现值重建采样器', () => {
    // master:真 GlTextureSystem + 记录 texParameteri 的假 gl
    const calls: { fn: string; args: unknown[] }[] = [];
    const consts = new Map<string, number>();
    const fns = new Map<string, (...a: unknown[]) => unknown>();
    const gl = new Proxy({}, {
      get(_t, p: string | symbol) {
        if (typeof p !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(p)) {
          if (!consts.has(p)) consts.set(p, 100000 + consts.size);
          return consts.get(p);
        }
        if (!fns.has(p)) {
          fns.set(p, (...args: unknown[]) => {
            calls.push({ fn: p, args });
            return p === 'createTexture' || p === 'createSampler' ? {} : null;
          });
        }
        return fns.get(p);
      },
    });
    const constName = (v: unknown) => [...consts].find(([, n]) => n === v)?.[0];
    const g = globalThis as Record<string, unknown>;
    g.WebGLRenderingContext ??= class {};
    g.WebGL2RenderingContext ??= class {};
    const pixiRenderer = {
      uid: 7,
      gc: { now: 0, addResourceHash() {} },
      context: { extensions: {}, supports: { nonPowOf2wrapping: true, nonPowOf2mipmaps: true }, webGLVersion: 2 },
    };
    const sys = new (PIXI as unknown as { GlTextureSystem: new (r: unknown) => {
      contextChange(gl: unknown): void; bind(t: unknown, i: number): void;
    } }).GlTextureSystem(pixiRenderer);
    sys.contextChange(gl);
    const psrc = new PIXI.BufferImageSource({ resource: new Uint8Array(64), width: 4, height: 4, format: 'rgba8unorm' } as never);
    const ptex = new PIXI.Texture({ source: psrc });
    sys.bind(ptex, 0);
    psrc.scaleMode = 'nearest';
    psrc.addressMode = 'repeat';
    psrc.unload();
    calls.length = 0;
    sys.bind(ptex, 0);
    const params = calls.filter((c) => c.fn === 'texParameteri').map((c) => [constName(c.args[1]), c.args[2]]);
    expect(params).toContainEqual(['TEXTURE_MAG_FILTER', 9728]); // NEAREST
    expect(params).toContainEqual(['TEXTURE_WRAP_S', 10497]); // REPEAT

    // engine2d:同一串操作,重传后按现值(最近邻 / 重复)建采样器
    const { source, root } = usedSource();
    const rhi = new NullRhiDevice({ swapchainSize: [16, 16] });
    const r = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    const createSampler = vi.spyOn(rhi, 'createSampler');
    r.render({ container: root, target: rt() });
    source.scaleMode = 'nearest';
    source.addressMode = 'repeat';
    source.unload();
    createSampler.mockClear();
    r.render({ container: root, target: rt() });
    const after = samplerDescs(createSampler);
    expect(after.some((d) => d.magFilter === 'nearest' && d.addressModeU === 'repeat')).toBe(true);
    r.destroy();
  });

  it('设备丢失恢复(对照 master contextChange 后 GL 纹理重建):按字段现值建采样器', async () => {
    const { source, root } = usedSource();
    const rhi = new NullRhiDevice({ swapchainSize: [16, 16] });
    const r = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    const createSampler = vi.spyOn(rhi, 'createSampler');
    r.render({ container: root, target: rt() });

    source.scaleMode = 'nearest';
    source.addressMode = 'repeat';

    // 设备丢失恢复:换代,按现值重建
    await rhi.loseDevice('test');
    createSampler.mockClear();
    r.render({ container: root, target: rt() });
    const mine = samplerDescs(createSampler).filter((d) => d.label?.includes(source.style._captureKey().key));
    expect(mine).toHaveLength(1);
    expect(mine[0].magFilter).toBe('nearest');
    expect(mine[0].addressModeU).toBe('repeat');
    r.destroy();
  });
});
