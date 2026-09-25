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
});
