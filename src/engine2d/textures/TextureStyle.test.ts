/**
 * TextureStyle 的采样键照 Pixi 8.17 的 `_resourceId`:第一次取时算好缓存,之后改字段不生效,`update()` 才重算
 * (master 的 WebGL 同理:GlTextureSystem 只在源初始化与 style 发 change 时下发采样参数)。
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
  it('改字段不 update:键不变;update 后才变;改回再 update 回到原来的键', () => {
    const pixi = new PIXI.TextureStyle();
    const ours = new TextureStyle();
    const p0 = pixi._resourceId;
    const o0 = ours._key;
    // 同一个键反复取:同一个串(不再现拼)
    expect(ours._key).toBe(o0);

    pixi.addressMode = 'repeat';
    ours.addressMode = 'repeat';
    expect(pixi._resourceId).toBe(p0);
    expect(ours._key).toBe(o0);

    pixi.update();
    ours.update();
    expect(pixi._resourceId).not.toBe(p0);
    expect(ours._key).not.toBe(o0);

    pixi.addressMode = 'clamp-to-edge';
    ours.addressMode = 'clamp-to-edge';
    pixi.update();
    ours.update();
    expect(pixi._resourceId).toBe(p0);
    expect(ours._key).toBe(o0);
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

  it('采样器按算键当时的参数建:用过后改字段不 update,采样器表重建(新渲染器 / 设备丢失恢复)时旧键不配新参数', () => {
    const source = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4), width: 4, height: 4, format: 'rgba8unorm', label: 'src' });
    const root = new Container();
    root.addChild(new Sprite(new Texture({ source })));
    const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;

    const rhi1 = new NullRhiDevice();
    const r1 = new WebGPURenderer({ rhi: rhi1, canvas, width: 16, height: 16 });
    r1.render({ container: root, target: RenderTexture.create({ width: 16, height: 16 }) });
    const key = source.style._key;

    // 用过之后改字段、不 update:键不变(Pixi 同),采样器表重建后仍按这个键的参数(线性)建,不是字段现值(最近邻)
    source.scaleMode = 'nearest';
    source.addressMode = 'repeat';
    expect(source.style._key).toBe(key);
    const rhi2 = new NullRhiDevice();
    const createSampler = vi.spyOn(rhi2, 'createSampler');
    const r2 = new WebGPURenderer({ rhi: rhi2, canvas, width: 16, height: 16 });
    r2.render({ container: root, target: RenderTexture.create({ width: 16, height: 16 }) });
    const descs = createSampler.mock.calls.map((c) => c[1] as { label?: string; magFilter?: string; addressModeU?: string });
    const mine = descs.filter((d) => d.label?.includes(key));
    expect(mine).toHaveLength(1);
    expect(mine[0].magFilter).toBe('linear');
    expect(mine[0].addressModeU).toBe('clamp-to-edge');

    // update 之后才换
    source.style.update();
    r2.render({ container: root, target: RenderTexture.create({ width: 16, height: 16 }) });
    const after = createSampler.mock.calls.map((c) => c[1] as { magFilter?: string; addressModeU?: string });
    expect(after.some((d) => d.magFilter === 'nearest' && d.addressModeU === 'repeat')).toBe(true);
  });
});
