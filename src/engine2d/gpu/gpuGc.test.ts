/**
 * 空闲 GPU 资源回收(空后端,不需要 GPU),对照 Pixi 8.17 的 GCSystem(master 走它的缺省:gcActive、60 s 未用、每 30 s 查一次):
 * - 纹理:`autoGarbageCollect` 的源(ImageSource、FillGradient 的画布源)60 s 没用过就 `unload()`,下次用时从 CPU 资源重传;
 *   渲染纹理 / 画布源 / 池纹理不收;一直在画的不收。
 * - 缓冲:Buffer 缺省 `autoGarbageCollect`,几何销毁后没人再用的缓冲 60 s 后放掉;Geometry.destroy 总会销毁索引缓冲(同 Pixi)。
 * - 选项:gcActive / gcMaxUnusedTime / gcFrequency,以及 Pixi 已弃用但仍认的 textureGCActive / textureGCMaxIdle。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import type { RhiBuffer, RhiTexture } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Graphics } from '../graphics/Graphics';
import { FillGradient } from '../graphics/fill/FillGradient';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource, ImageSource } from '../textures/TextureSource';
import { Buffer, BufferUsage } from '../shader/Buffer';
import { Geometry } from '../shader/Geometry';
import { Mesh } from '../mesh/Mesh';
import { MeshGeometry } from '../mesh/MeshGeometry';
import { Shader } from '../shader/Shader';
import { WebGPURenderer } from './WebGPURenderer';
import { GCSystem } from './GCSystem';
import type { RendererOptions } from './Renderer';

const fakeCtx: any = new Proxy({}, {
  get: (_t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}),
  set: () => true,
});
const fakeCanvas = (width: number, height: number): any => ({ width, height, getContext: () => fakeCtx });

const radial = (FG: any): any => new FG({
  type: 'radial', center: { x: 0.5, y: 0.42 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
  colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 1, color: 'rgba(0,0,0,0.55)' }], textureSpace: 'local',
});
const linear = (FG: any): any => new FG({
  type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
  colorStops: [{ offset: 0, color: 'rgba(200,150,50,0.72)' }, { offset: 1, color: 'rgba(100,70,20,0.72)' }], textureSpace: 'local',
});

const WGSL = /* wgsl */ `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> };
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 };
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VSOut { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOut {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return VSOut(vec4((m * vec3(aPosition, 1.0)).xy, 0.0, 1.0), aUV);
}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> { return vec4(uv, 0.0, 1.0); }
`;

let now = 0;
const origCreateCanvas = FillGradient.createCanvas;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  FillGradient.createCanvas = fakeCanvas;
});
afterEach(() => {
  vi.restoreAllMocks();
  FillGradient.createCanvas = origCreateCanvas;
});

function setup(options: Partial<RendererOptions> = {}) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64, ...options });
  const textures: RhiTexture[] = [];
  const buffers: RhiBuffer[] = [];
  const createTexture = rhi.createTexture.bind(rhi);
  const createBuffer = rhi.createBuffer.bind(rhi);
  vi.spyOn(rhi, 'createTexture').mockImplementation((s, d) => { const t = createTexture(s, d); textures.push(t); return t; });
  vi.spyOn(rhi, 'createBuffer').mockImplementation((s, d) => { const b = createBuffer(s, d); buffers.push(b); return b; });
  const rt = RenderTexture.create({ width: 64, height: 64 });
  /** 画一帧(画进离屏纹理)并把时钟往前拨 */
  const frame = (container: Container, advance = 1000) => {
    renderer.render({ container, target: rt });
    now += advance;
  };
  /** 空转 ms 毫秒(每秒画一帧空场景) */
  const idle = (ms: number, keep?: Container) => {
    const c = keep ?? new Container();
    for (let t = 0; t < ms; t += 1000) frame(c);
  };
  return { rhi, renderer, textures, buffers, rt, frame, idle };
}

/** 源是否还有 GPU 纹理(GpuTextures 是渲染器私有的,测试直接看) */
function gpuHas(renderer: WebGPURenderer, source: unknown): boolean {
  return (renderer as unknown as { textures: { has(s: unknown): boolean } }).textures.has(source);
}

function gradientPanel(fg: any): Container {
  const c = new Container();
  const g = new Graphics();
  g.rect(0, 0, 40, 30).fill(fg);
  c.addChild(g);
  return c;
}

describe('GC 缺省选项与 Pixi 8.17 一致', () => {
  it('gcActive / gcMaxUnusedTime / gcFrequency 与 PIXI.GCSystem.defaultOptions 相同', () => {
    expect(GCSystem.defaultOptions).toEqual((PIXI as any).GCSystem.defaultOptions);
    const { renderer } = setup();
    expect(renderer.gc.enabled).toBe(true);
    expect(renderer.gc.maxUnusedTime).toBe(60000);
    renderer.destroy();
  });

  it('FillGradient 的纹理源与 Pixi 一样可被回收(Pixi 用 autoGarbageCollect 的 ImageSource 包画布)', () => {
    const pixi = linear(PIXI.FillGradient);
    const origAdapter = PIXI.DOMAdapter.get();
    PIXI.DOMAdapter.set({ ...origAdapter, createCanvas: fakeCanvas } as any);
    try {
      pixi.buildGradient();
    } finally {
      PIXI.DOMAdapter.set(origAdapter);
    }
    const ours = linear(FillGradient);
    ours.buildGradient();
    expect(ours.texture.source.autoGarbageCollect).toBe(pixi.texture.source.autoGarbageCollect);
    expect(ours.texture.source.autoGarbageCollect).toBe(true);
    const oursRadial = radial(FillGradient);
    oursRadial.buildGradient();
    expect(oursRadial.texture.source.autoGarbageCollect).toBe(true);
  });

  it('Buffer 缺省 autoGarbageCollect(同 Pixi Buffer)', () => {
    const pixi = new PIXI.Buffer({ data: new Float32Array(4), usage: PIXI.BufferUsage.VERTEX });
    const ours = new Buffer({ data: new Float32Array(4), usage: BufferUsage.VERTEX });
    expect(ours.autoGarbageCollect).toBe(pixi.autoGarbageCollect);
    expect(ours.autoGarbageCollect).toBe(true);
  });
});

describe('纹理回收', () => {
  it('丢掉的渐变面板:60 s 没用过、下一次 GC 检查时放掉 GPU 纹理(PanelSkin / drawSelectedRow 的用法)', () => {
    const { renderer, textures, frame, idle } = setup();
    const sources: any[] = [];
    for (let i = 0; i < 10; i++) {
      const fg = radial(FillGradient);
      const c = gradientPanel(fg);
      frame(c);
      sources.push(fg.texture.source);
      c.destroy({ children: true });
    }
    const gradTextures = textures.filter((t) => t.width === 256 && t.height === 256);
    expect(gradTextures).toHaveLength(10);
    // 59 s 内不收
    idle(50_000);
    expect(sources.every((s) => gpuHas(renderer, s))).toBe(true);
    // 60 s + 下一次 30 s 检查之后全部放掉
    idle(60_000);
    expect(sources.some((s) => gpuHas(renderer, s))).toBe(false);
    expect(gradTextures.every((t) => t.destroyed)).toBe(true);
    // 不再挂着监听(源可以被 JS 回收)
    expect(sources.every((s) => s.listenerCount('unload') === 0 && s.listenerCount('destroy') === 0)).toBe(true);
    renderer.destroy();
  });

  it('一直在画的渐变不收;回收后的源再画时从画布重传', () => {
    const { renderer, rhi, frame, idle } = setup();
    const keptFg = linear(FillGradient);
    const kept = gradientPanel(keptFg);
    idle(200_000, kept);
    const keptSource = keptFg.texture.source;
    expect(gpuHas(renderer, keptSource)).toBe(true);

    const fg = linear(FillGradient);
    const panel = gradientPanel(fg);
    frame(panel);
    const src = fg.texture.source;
    const first = renderer.gpuTextureOf(src);
    idle(120_000);
    expect(gpuHas(renderer, src)).toBe(false);
    expect(first.destroyed).toBe(true);
    const uploads = vi.spyOn(rhi, 'uploadImage');
    frame(panel);
    expect(gpuHas(renderer, src)).toBe(true);
    expect(renderer.gpuTextureOf(src)).not.toBe(first);
    expect(uploads).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('只收 autoGarbageCollect 的源:渲染纹理 / 像素数组源 / 纹理池不收,ImageSource 收', () => {
    const { renderer, frame, idle } = setup();
    const rtTarget = RenderTexture.create({ width: 8, height: 8 });
    const bufSrc = new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4), width: 4, height: 4 });
    const imgSrc = new ImageSource({ resource: { width: 4, height: 4 } as unknown as ImageBitmap });
    const c = new Container();
    c.addChild(new Sprite(new Texture({ source: bufSrc })));
    c.addChild(new Sprite(new Texture({ source: imgSrc })));
    c.addChild(new Sprite(rtTarget));
    frame(c);
    renderer.render({ container: new Container(), target: rtTarget });
    idle(200_000);
    expect(gpuHas(renderer, rtTarget.source)).toBe(true);
    expect(gpuHas(renderer, bufSrc)).toBe(true);
    expect(gpuHas(renderer, imgSrc)).toBe(false);
    renderer.destroy();
  });

  it('gcActive: false 关掉回收;Pixi 弃用名 textureGCActive: false 同样关掉', () => {
    for (const opts of [{ gcActive: false }, { textureGCActive: false }] as Partial<RendererOptions>[]) {
      const { renderer, frame, idle } = setup(opts);
      const fg = linear(FillGradient);
      const c = gradientPanel(fg);
      frame(c);
      idle(300_000);
      expect(gpuHas(renderer, fg.texture.source)).toBe(true);
      expect(renderer.gc.enabled).toBe(false);
      renderer.destroy();
    }
  });

  it('gcMaxUnusedTime / gcFrequency 可调;textureGCMaxIdle(帧数)按 Pixi 换算成毫秒', () => {
    const { renderer, frame, idle } = setup({ gcMaxUnusedTime: 5000, gcFrequency: 2000 });
    const fg = linear(FillGradient);
    frame(gradientPanel(fg));
    idle(8000);
    expect(gpuHas(renderer, fg.texture.source)).toBe(false);
    renderer.destroy();
    const r2 = setup({ textureGCMaxIdle: 60 * 10 } as Partial<RendererOptions>);
    expect(r2.renderer.gc.maxUnusedTime).toBe(10_000);
    r2.renderer.destroy();
  });
});

describe('缓冲回收', () => {
  const makeMesh = () => {
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({ gpu: { vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } }, resources: {} } as never);
    return { geometry, shader, mesh: new Mesh({ geometry, shader }) };
  };

  it('Geometry.destroy() 不带 true 也销毁索引缓冲(同 Pixi Geometry.destroy)', () => {
    const ours = new Geometry({ attributes: { aPosition: new Float32Array(6) }, indexBuffer: new Uint32Array([0, 1, 2]) });
    const pixi = new PIXI.Geometry({ attributes: { aPosition: new Float32Array(6) }, indexBuffer: new Uint32Array([0, 1, 2]) });
    const ourIndex = ours.indexBuffer!;
    const ourAttr = ours.buffers[0];
    const pixiIndex = pixi.indexBuffer;
    const pixiAttr = pixi.buffers[0];
    ours.destroy();
    pixi.destroy();
    expect(ourIndex.destroyed).toBe(true);
    expect((pixiIndex as any).destroyed).toBe(true);
    expect(ourAttr.destroyed).toBe((pixiAttr as any).destroyed ?? false);
  });

  it('mesh.destroy(); geometry.destroy() 之后顶点缓冲 60 s 没用就放掉(EntityShadow / LitSpriteQuad 的拆法)', () => {
    const { renderer, buffers, frame, idle } = setup();
    for (let i = 0; i < 5; i++) {
      const { geometry, shader, mesh } = makeMesh();
      const root = new Container();
      root.addChild(mesh);
      frame(root);
      mesh.destroy();
      geometry.destroy();
      shader.destroy();
      root.destroy();
    }
    const geo = () => buffers.filter((b) => /mesh/.test(b.label));
    expect(geo()).toHaveLength(15);
    // 索引缓冲随 geometry.destroy 立即放掉
    expect(geo().filter((b) => !b.destroyed)).toHaveLength(10);
    idle(120_000);
    expect(geo().filter((b) => !b.destroyed)).toHaveLength(0);
    renderer.destroy();
  });

  it('回收后的缓冲再用时按完整内容重建 / 重传;一直在用的不收', () => {
    const { rhi, renderer, buffers, frame, idle } = setup();
    const kept = makeMesh();
    const keptRoot = new Container();
    keptRoot.addChild(kept.mesh);
    idle(200_000, keptRoot);
    expect(buffers.filter((b) => /mesh/.test(b.label) && !b.destroyed)).toHaveLength(3);

    const { mesh } = makeMesh();
    const root = new Container();
    root.addChild(mesh);
    frame(root);
    const pos = mesh.geometry.getBuffer('aPosition');
    pos.update(8); // 最近一次只改了前 8 字节
    frame(root);
    idle(120_000);
    const before = buffers.length;
    const writes = vi.spyOn(rhi, 'writeBuffer');
    frame(root);
    expect(buffers.length - before).toBe(3);
    const posWrite = writes.mock.calls.find((c) => /positions/.test(c[0].label));
    expect(posWrite?.[1].byteLength).toBe(32);
    renderer.destroy();
  });
});
