/**
 * 设备丢失后接着画(D6),对照 master 的 Pixi WebGL:webglcontextrestored → runners.contextChange,
 * GlTextureSystem / GlBufferSystem / GlShaderSystem / RenderTargetSystem 等丢掉旧 GL 对象(`_managedTextures.removeAll(true)`
 * 之类),下次用到时从 CPU 源重建重传;没有 CPU 资源的纹理(RenderTexture)重建成空的——画过的内容丢了,同 WebGL。
 * engine2d 在 RHI 的 onRestored 里做同样的事:纹理 / 采样器、缓冲、着色器 / 管线、渲染目标(模板 / MSAA)、
 * 每套规划状态的合批顶点 / 索引 / uniform 缓冲全部丢掉,下一次 render 按需重建。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '@luma.gl/core';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { LumaRhiDevice } from '../../rendering/rhi/backends/luma/LumaRhiDevice';
import { createFakeLuma, type FakeLuma } from '../../rendering/rhi/backends/testing/fakeLumaDevice';
import type { RhiDevice, RhiTextureDesc } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Graphics } from '../graphics/Graphics';
import { Mesh } from '../mesh/Mesh';
import { PlaneGeometry } from '../mesh/MeshGeometry';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource } from '../textures/TextureSource';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import { WebGPURenderer } from './WebGPURenderer';

function watchDiagnostics(rhi: RhiDevice) {
  const diags: { severity: string; message: string }[] = [];
  rhi.onDiagnostic((e, severity) => diags.push({ severity, message: e.message }));
  const errors = () => diags.filter((d) => d.severity === 'error' && !d.message.includes('图形设备丢失'));
  return { diags, errors };
}

/** 各类 GPU 缓存都用上的一幕:CPU 源的精灵、不合批网格(自带缓冲)、模板遮罩、滤镜、之前烘好的渲染纹理 */
function buildScene() {
  const photo = new BufferImageSource({ resource: new Uint8Array(8 * 8 * 4).fill(200), width: 8, height: 8, format: 'rgba8unorm', label: 'photo' });
  const baked = RenderTexture.create({ width: 8, height: 8 });
  baked.source.label = 'baked';
  const root = new Container();
  root.addChild(new Sprite(new Texture({ source: photo })));
  const mesh = new Mesh({ geometry: new PlaneGeometry({ width: 16, height: 16, verticesX: 11, verticesY: 11 }), texture: new Texture({ source: photo }) });
  root.addChild(mesh);
  const masked = new Container();
  const mask = new Graphics().rect(0, 0, 8, 8).fill(0xffffff);
  masked.addChild(new Sprite(new Texture({ source: baked.source })));
  masked.mask = mask;
  root.addChild(masked, mask);
  const filtered = new Container();
  filtered.addChild(new Sprite(Texture.WHITE));
  filtered.filters = [new AlphaFilter({ alpha: 0.5 })];
  root.addChild(filtered);
  return { root, photo, baked };
}

function nullSetup() {
  const rhi = new NullRhiDevice({ swapchainSize: [32, 32] });
  const canvas = { width: 32, height: 32, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 32, height: 32 });
  return { rhi, renderer, ...watchDiagnostics(rhi) };
}

describe('设备丢失恢复后照常渲染(D6,对照 Pixi runners.contextChange)', () => {
  it('恢复后:各类资源按需重建,CPU 源重传,帧照常提交、没有「已销毁资源」报错', async () => {
    const { rhi, renderer, errors } = nullSetup();
    const { root, photo, baked } = buildScene();
    const bake = new Container();
    bake.addChild(new Sprite(Texture.WHITE));
    renderer.render({ container: bake, target: baked });
    renderer.render(root);
    expect(errors()).toEqual([]);
    const photoBefore = renderer.gpuTextureOf(photo);
    const bakedBefore = renderer.gpuTextureOf(baked.source);

    await rhi.loseDevice('GPU process crashed');
    expect(photoBefore.destroyed).toBe(true);

    const createTexture = vi.spyOn(rhi, 'createTexture');
    const writeTexture = vi.spyOn(rhi, 'writeTexture');
    const createBuffer = vi.spyOn(rhi, 'createBuffer');
    const createPipeline = vi.spyOn(rhi, 'createRenderPipeline');
    const framesBefore = rhi.lastFrameStats.frame;
    renderer.render(root);
    expect(errors()).toEqual([]);
    expect(rhi.lastFrameStats.frame).toBe(framesBefore + 1);
    expect(rhi.lastFrameStats.draws).toBeGreaterThan(0);

    const created = createTexture.mock.calls.map((c) => (c[1] as RhiTextureDesc).label);
    // CPU 源的纹理重建并重传(同 GlTextureSystem 的 contextChange → 下次 bind 时 initSource + upload)
    expect(created).toContain('photo');
    const photoAfter = renderer.gpuTextureOf(photo);
    expect(photoAfter).not.toBe(photoBefore);
    expect(photoAfter.destroyed).toBe(false);
    expect(writeTexture.mock.calls.some((c) => c[0] === photoAfter)).toBe(true);
    // 渲染纹理重建成空的(没有 CPU 资源可传,画过的内容丢了,同 WebGL 上下文丢失)
    expect(created).toContain('baked');
    const bakedAfter = renderer.gpuTextureOf(baked.source);
    expect(bakedAfter).not.toBe(bakedBefore);
    expect(writeTexture.mock.calls.some((c) => c[0] === bakedAfter)).toBe(false);
    // 缓冲(合批顶点 / 索引 / uniform + 网格自己的)与管线都在新设备上重建
    expect(createBuffer.mock.calls.length).toBeGreaterThan(3);
    expect(createPipeline).toHaveBeenCalled();

    // 之后的帧不再重建
    createTexture.mockClear();
    createBuffer.mockClear();
    createPipeline.mockClear();
    renderer.render(root);
    expect(createTexture).not.toHaveBeenCalled();
    expect(createBuffer).not.toHaveBeenCalled();
    expect(createPipeline).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
    renderer.destroy();
  });

  it('一帧渲染途中丢失:这一帧作废、不抛;恢复后照常', async () => {
    const { rhi, renderer, errors } = nullSetup();
    const { root } = buildScene();
    renderer.render(root);
    let restored: Promise<void> | null = null;
    root.onRender = () => {
      restored ??= rhi.loseDevice('TDR');
    };
    expect(() => renderer.render(root)).not.toThrow();
    root.onRender = null;
    await restored;
    const frame = rhi.lastFrameStats.frame;
    renderer.render(root);
    expect(rhi.lastFrameStats.frame).toBe(frame + 1);
    expect(errors()).toEqual([]);
    renderer.destroy();
  });

  it('反复丢失都能恢复;渲染器先销毁的,恢复时不再碰它', async () => {
    const { rhi, renderer, errors } = nullSetup();
    const { root } = buildScene();
    for (let i = 0; i < 3; i++) {
      renderer.render(root);
      await rhi.loseDevice(`第 ${i + 1} 次`);
    }
    renderer.render(root);
    expect(errors()).toEqual([]);
    const lost = rhi.loseDevice('销毁后');
    renderer.destroy();
    await lost;
    expect(errors()).toEqual([]);
  });

  it('真后端(假 luma 设备):丢失 → 同一画布上重建设备 → 下一帧画到新设备上', async () => {
    const fakes: FakeLuma[] = [createFakeLuma()];
    const rhi = new LumaRhiDevice(fakes[0].device as Device, {
      recreateDevice: async () => {
        await new Promise((r) => setTimeout(r, 0));
        const f = createFakeLuma();
        fakes.push(f);
        return f.device as Device;
      },
    });
    const { errors } = watchDiagnostics(rhi);
    const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    const root = new Container();
    root.addChild(new Sprite(Texture.WHITE));
    renderer.render(root);
    expect(fakes[0].log.some((c) => c[0] === 'draw' || c[0] === 'drawIndexed')).toBe(true);

    fakes[0].lose('GPU process crashed');
    await rhi.lost;
    renderer.render(root); // 恢复之前:这一帧作废
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(rhi.isLost).toBe(false);

    renderer.render(root);
    const log = fakes[1].log;
    expect(log.some((c) => c[0] === 'writeData')).toBe(true);
    expect(log.some((c) => c[0] === 'drawIndexed' || c[0] === 'draw')).toBe(true);
    expect(log.some((c) => c[0] === 'submit')).toBe(true);
    expect(errors()).toEqual([]);
    renderer.destroy();
  });
});
