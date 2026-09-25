/**
 * 渲染核心几处语义与 Pixi 8.17 对照(空后端,不需要 GPU):
 * - D9 滤镜区域:setActive(false) 的子树与 Pixi 里 visible=false 的一样不计入;
 * - D16 不合批的缺省网格:纹理矩阵总绑 textureMatrix.mapCoord(trim 满帧纹理 isSimple 却非单位阵);
 * - D17 反向遮罩弹出后恢复 MASK_ACTIVE(照 StencilMaskPipe.execute);inverse 存在容器的 _maskOptions 上;
 * - D19 渲染根自己的混合模式不生效(照 Pixi:根不经 updateColorBlendVisibility,按 normal 画);
 * - D21 几何属性没给格式时按着色器参数类型推,跨度按同一 Buffer 上全部属性算(照 ensureAttributes);
 * - D25 带 shader 却没有 gpuProgram 的网格:告警并跳过绘制(照 GpuMeshAdapter),不拿缺省网格程序顶替。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Graphics } from '../graphics/Graphics';
import { Mesh } from '../mesh/Mesh';
import { PlaneGeometry } from '../mesh/MeshGeometry';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource } from '../textures/TextureSource';
import { Rectangle } from '../math/Rectangle';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import { Buffer, BufferUsage } from '../shader/Buffer';
import { Geometry } from '../shader/Geometry';
import { GpuProgram } from '../shader/GpuProgram';
import { GlProgram } from '../shader/GlProgram';
import { Shader } from '../shader/Shader';
import { FrameBuilder } from './FrameBuilder';
import { WebGPURenderer } from './WebGPURenderer';

function setup(size = 64) {
  const rhi = new NullRhiDevice();
  const canvas = { width: size, height: size, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: size, height: size });
  return { rhi, renderer };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = (r: WebGPURenderer): any => (r as any).states[0];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D9 滤镜区域不计未激活子树', () => {
  function filterTextureSizes(hide: 'none' | 'visible' | 'active', moveAfterHide = false): string[] {
    const { rhi, renderer } = setup(128);
    const root = new Container();
    const layer = new Container();
    root.addChild(layer);
    const a = new Sprite(Texture.WHITE);
    a.width = 4;
    a.height = 4;
    const npc = new Container();
    npc.position.set(40, 40);
    const b = new Sprite(Texture.WHITE);
    b.width = 4;
    b.height = 4;
    npc.addChild(b);
    layer.addChild(a, npc);
    renderer.render({ container: root });
    if (hide === 'visible') npc.visible = false;
    else if (hide === 'active') npc.setActive(false);
    if (moveAfterHide) npc.position.set(100, 100);
    const f = new AlphaFilter({ alpha: 0.5 });
    f.padding = 0;
    layer.filters = [f];
    const spy = vi.spyOn(rhi, 'createTexture');
    renderer.render({ container: root });
    const sizes = spy.mock.calls.map((c) => c[1] as RhiTextureDesc).map((d) => `${d.width}x${d.height}`);
    renderer.destroy();
    return sizes;
  }

  function pixiFastBounds(hide: boolean): number[] {
    const root = new PIXI.Container({ isRenderGroup: true });
    const layer = new PIXI.Container();
    root.addChild(layer);
    const a = new PIXI.Sprite(PIXI.Texture.WHITE);
    a.width = 4;
    a.height = 4;
    const npc = new PIXI.Container();
    npc.position.set(40, 40);
    const b = new PIXI.Sprite(PIXI.Texture.WHITE);
    b.width = 4;
    b.height = 4;
    npc.addChild(b);
    layer.addChild(a, npc);
    if (hide) npc.visible = false;
    PIXI.updateRenderGroupTransforms(root.renderGroup, true);
    const bb = layer.getFastGlobalBounds(true);
    return [bb.minX, bb.minY, bb.maxX, bb.maxY];
  }

  it('setActive(false) 与 visible=false 的滤镜纹理一样大(Pixi 的快速包围盒只剩 4×4)', () => {
    expect(pixiFastBounds(true)).toEqual([0, 0, 4, 4]);
    const viaVisible = filterTextureSizes('visible');
    expect(viaVisible).toEqual(['4x4']);
    expect(filterTextureSizes('active')).toEqual(viaVisible);
    // 隐藏后再挪:不读未激活子树留下的旧 groupTransform
    expect(filterTextureSizes('active', true)).toEqual(viaVisible);
    // 对照:不隐藏时包含 npc
    expect(pixiFastBounds(false)).toEqual([0, 0, 44, 44]);
    expect(filterTextureSizes('none')).toEqual(['64x64']);
  });
});

describe('D16 不合批缺省网格的纹理矩阵', () => {
  it('trim 满帧纹理(isSimple 但 mapCoord 非单位阵)绑 mapCoord,与 Pixi GlMeshAdaptor 相同', () => {
    const src = new BufferImageSource({ resource: new Uint8Array(16 * 16 * 4), width: 16, height: 16 });
    const tex = new Texture({ source: src, frame: new Rectangle(0, 0, 16, 16), orig: new Rectangle(0, 0, 20, 20), trim: new Rectangle(2, 2, 16, 16) });
    const psrc = new PIXI.BufferImageSource({ resource: new Uint8Array(16 * 16 * 4), width: 16, height: 16 });
    const ptex = new PIXI.Texture({
      source: psrc,
      frame: new PIXI.Rectangle(0, 0, 16, 16),
      orig: new PIXI.Rectangle(0, 0, 20, 20),
      trim: new PIXI.Rectangle(2, 2, 16, 16),
    });
    const ptm = ptex.textureMatrix;
    expect(tex.textureMatrix.isSimple).toBe(true);
    expect(ptm.isSimple).toBe(true);

    const captured: Array<{ a: number; d: number; tx: number; ty: number }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = FrameBuilder.prototype as any;
    const orig = proto.writeUbo;
    vi.spyOn(proto, 'writeUbo').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const [layout, values] = args as [unknown, Record<string, unknown>];
      if ('uTextureMatrix' in values) captured.push(values.uTextureMatrix as { a: number; d: number; tx: number; ty: number });
      return orig.call(this, layout, values);
    });
    const { renderer } = setup(8);
    const geometry = new PlaneGeometry({ width: 16, height: 16, verticesX: 11, verticesY: 11 });
    const mesh = new Mesh({ geometry, texture: tex });
    expect(mesh.batched).toBe(false); // 121 个顶点,不合批
    renderer.render({ container: mesh, target: RenderTexture.create({ width: 8, height: 8 }) });
    expect(captured).toHaveLength(1);
    const m = captured[0];
    expect([m.a, m.d, m.tx, m.ty]).toEqual([ptm.mapCoord.a, ptm.mapCoord.d, ptm.mapCoord.tx, ptm.mapCoord.ty]);
    expect(m.a).toBeCloseTo(1.25);
    renderer.destroy();
  });
});

describe('D17 反向遮罩', () => {
  function drawModes(build: (root: Container) => void): string[] {
    const { renderer } = setup(64);
    const root = new Container();
    build(root);
    renderer.render({ container: root, target: RenderTexture.create({ width: 64, height: 64 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmds = internals(renderer).builder.commands as any[];
    const out = cmds.filter((c) => c.t === 'draw').map((d) => `${d.pipeline.stencil}/${d.stencilRef}`);
    renderer.destroy();
    return out;
  }

  /** 用 Pixi 真的 StencilMaskPipe.push / pop 生成指令并执行,记录 setStencilMode */
  function pixiModes(nested: boolean): string[] {
    const log: string[] = [];
    const name = (m: number): string => Object.entries(PIXI.STENCIL_MODES).find(([, v]) => v === m)![0];
    const renderer = {
      renderPipes: { batch: { break() {} }, blendMode: { setBlendMode() {} } },
      renderTarget: { renderTarget: { uid: 1 }, ensureDepthStencil() {}, clear() {} },
      stencil: { setStencilMode(m: number, ref: number) { log.push(`${name(m)}/${ref}`); } },
      colorMask: { setMask() {} },
    };
    const pipe = new PIXI.StencilMaskPipe(renderer as never);
    const instructions: Array<{ renderPipeId: string }> = [];
    const iset = { add: (i: { renderPipeId: string }) => instructions.push(i) };
    const mkMask = () => ({ mask: { includeInBuild: false, collectRenderables() {}, groupTransform: {}, parent: null, measurable: false } });
    const outer = mkMask();
    const inner = mkMask();
    const cOuter = { _maskOptions: { inverse: false } };
    const cInner = { _maskOptions: { inverse: true } };
    if (nested) pipe.push(outer as never, cOuter as never, iset as never);
    pipe.push(inner as never, cInner as never, iset as never);
    pipe.pop(inner as never, cInner as never, iset as never);
    if (nested) pipe.pop(outer as never, cOuter as never, iset as never);
    for (const inst of instructions) if (inst.renderPipeId === 'stencilMask') pipe.execute(inst as never);
    return log;
  }

  it('顶层反向遮罩弹出后,后面的兄弟按 active/0 画(Pixi MASK_ACTIVE/0),不再被模板挡掉', () => {
    const modes = drawModes((root) => {
      const g = new Graphics().rect(0, 0, 16, 16).fill(0xffffff);
      root.addChild(g);
      const masked = new Sprite(Texture.WHITE);
      masked.width = 32;
      masked.height = 32;
      masked.setMask({ mask: g, inverse: true });
      root.addChild(masked);
      const after = new Sprite(Texture.WHITE);
      after.position.set(40, 40);
      root.addChild(after);
    });
    const p = pixiModes(false);
    expect(p[p.length - 1]).toBe('MASK_ACTIVE/0');
    expect(modes).toEqual(['add/0', 'inverse/1', 'remove/1', 'active/0']);
  });

  it('正常外层里的反向内层:弹出内层后回到 active/1(Pixi MASK_ACTIVE/1)', () => {
    const modes = drawModes((root) => {
      const og = new Graphics().rect(0, 0, 32, 32).fill(0xffffff);
      const ig = new Graphics().rect(0, 0, 8, 8).fill(0xffffff);
      root.addChild(og, ig);
      const outer = new Container();
      outer.mask = og;
      root.addChild(outer);
      const inner = new Sprite(Texture.WHITE);
      inner.width = 32;
      inner.height = 32;
      inner.setMask({ mask: ig, inverse: true });
      outer.addChild(inner);
      const sib = new Sprite(Texture.WHITE);
      sib.position.set(1, 1);
      outer.addChild(sib);
    });
    const p = pixiModes(true);
    // Pixi:内层 popMaskBegin(RENDERING_MASK_REMOVE/2)之后的 popMaskEnd 是 MASK_ACTIVE/1
    expect(p[p.indexOf('RENDERING_MASK_REMOVE/2') + 1]).toBe('MASK_ACTIVE/1');
    // engine2d:内层弹出后画的兄弟 sib 是 active/1
    const sibDraw = modes[modes.indexOf('remove/2') + 1];
    expect(sibDraw).toBe('active/1');
  });

  it('inverse 挂在容器上(照 Pixi _maskOptions):先设 inverse 后给遮罩、换遮罩都保留;setMask 不给 mask 不清遮罩', () => {
    const g1 = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    const g2 = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    const c = new Container();
    c.setMask({ inverse: true });
    c.mask = g1;
    c.mask = g2;
    expect(c._maskOptions.inverse).toBe(true);
    c.setMask({ mask: null });
    expect(c.mask).toBe(g2);

    const pc = new PIXI.Container();
    const pg1 = new PIXI.Graphics();
    const pg2 = new PIXI.Graphics();
    pc.setMask({ inverse: true });
    pc.mask = pg1;
    pc.mask = pg2;
    expect((pc as unknown as { _maskOptions: { inverse: boolean } })._maskOptions.inverse).toBe(true);
    pc.setMask({ mask: null });
    expect(pc.mask).toBe(pg2);
  });
});

describe('D19 渲染根自己的混合模式', () => {
  function batchBlends(root: Container): string[] {
    const { renderer } = setup(8);
    renderer.render({ container: root, target: RenderTexture.create({ width: 8, height: 8 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = internals(renderer).collector.instructions.filter((i: any) => i.t === 'batch').map((i: any) => i.blendMode);
    renderer.destroy();
    return out;
  }

  it('游离的根精灵 blendMode=add:Pixi 按 normal 画(根不经 updateColorBlendVisibility),engine2d 同', () => {
    const ps = new PIXI.Sprite(PIXI.Texture.WHITE);
    ps.blendMode = 'add';
    ps.enableRenderGroup();
    PIXI.updateRenderGroupTransforms(ps.renderGroup, true);
    expect(ps.groupBlendMode).toBe('normal');

    const s = new Sprite(Texture.WHITE);
    s.blendMode = 'add';
    expect(batchBlends(s)).toEqual(['normal']);
  });

  it('根的直接子节点仍按自己的混合模式(Pixi tempContainer 语义)', () => {
    const c = new Container();
    c.blendMode = 'add';
    const child = new Sprite(Texture.WHITE);
    child.blendMode = 'screen';
    c.addChild(child);
    expect(batchBlends(c)).toEqual(['screen']);
  });
});

const FMT_WGSL = /* wgsl */ `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VOut { @builtin(position) p: vec4<f32>, @location(0) c: vec4<f32> }
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aColor: vec4<f32>) -> VOut {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return VOut(vec4<f32>((m * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0), aColor);
}
@fragment fn mainFragment(v: VOut) -> @location(0) vec4<f32> { return v.c; }
`;

describe('D21 几何属性格式与跨度', () => {
  it('没给格式:按着色器 @location 类型推(vec4<f32> → float32x4,跨度 16),与 Pixi ensureAttributes 相同', () => {
    const { rhi, renderer } = setup(8);
    const created = vi.spyOn(rhi, 'createRenderPipeline');
    const program = new GpuProgram({ name: 'fmt', vertex: { source: FMT_WGSL, entryPoint: 'mainVertex' }, fragment: { source: FMT_WGSL, entryPoint: 'mainFragment' } });
    const geometry = new Geometry({
      attributes: {
        aPosition: new Float32Array([0, 0, 4, 0, 0, 4]),
        aColor: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      },
      indexBuffer: new Uint32Array([0, 1, 2]),
    });
    const mesh = new Mesh({ geometry, shader: new Shader({ gpuProgram: program, resources: {} }) });
    renderer.render({ container: mesh, target: RenderTexture.create({ width: 8, height: 8 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vb = (created.mock.calls[0][1] as any).vertexBuffers as Array<{ arrayStride?: number; stride?: number; attributes: Array<{ format: string }> }>;
    const summary = vb.map((b) => ({ stride: b.stride ?? b.arrayStride, formats: b.attributes.map((a) => a.format) }));

    const pprog = PIXI.GpuProgram.from({ vertex: { source: FMT_WGSL, entryPoint: 'mainVertex' }, fragment: { source: FMT_WGSL, entryPoint: 'mainFragment' } });
    const pgeo = new PIXI.Geometry({
      attributes: {
        aPosition: new Float32Array([0, 0, 4, 0, 0, 4]),
        aColor: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      },
      indexBuffer: new Uint32Array([0, 1, 2]),
    });
    PIXI.ensureAttributes(pgeo, pprog.attributeData);
    expect(summary).toEqual([
      { stride: pgeo.attributes.aPosition.stride, formats: [pgeo.attributes.aPosition.format] },
      { stride: pgeo.attributes.aColor.stride, formats: [pgeo.attributes.aColor.format] },
    ]);
    expect(summary[1]).toEqual({ stride: 16, formats: ['float32x4'] });
    renderer.destroy();
  });

  it('交错 Buffer 上着色器只用一部分属性:跨度按全部属性算(24),与 Pixi 相同', () => {
    const { renderer } = setup(8);
    const program = new GpuProgram({ name: 'fmt2', vertex: { source: FMT_WGSL, entryPoint: 'mainVertex' }, fragment: { source: FMT_WGSL, entryPoint: 'mainFragment' } });
    const inter = new Buffer({ data: new Float32Array(18), usage: BufferUsage.VERTEX });
    const g2 = new Geometry({
      attributes: {
        aPosition: { buffer: inter, format: 'float32x2', offset: 0 },
        aUnused: { buffer: inter, format: 'float32x2', offset: 8 },
        aColor: { buffer: inter, format: 'float32x2', offset: 16 },
      },
      indexBuffer: new Uint32Array([0, 1, 2]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layout = (renderer as any).pipelines.layout(g2, program);

    const pprog = PIXI.GpuProgram.from({ vertex: { source: FMT_WGSL, entryPoint: 'mainVertex' }, fragment: { source: FMT_WGSL, entryPoint: 'mainFragment' } });
    const pinter = new PIXI.Buffer({ data: new Float32Array(18), usage: PIXI.BufferUsage.VERTEX });
    const pg2 = new PIXI.Geometry({
      attributes: {
        aPosition: { buffer: pinter, format: 'float32x2', offset: 0 },
        aUnused: { buffer: pinter, format: 'float32x2', offset: 8 },
        aColor: { buffer: pinter, format: 'float32x2', offset: 16 },
      },
      indexBuffer: new Uint32Array([0, 1, 2]),
    });
    PIXI.ensureAttributes(pg2, pprog.attributeData);
    expect(layout.buffers).toHaveLength(1);
    expect(layout.buffers[0].stride).toBe(pg2.attributes.aPosition.stride);
    expect(layout.buffers[0].stride).toBe(24);
    renderer.destroy();
  });
});

describe('D25 没有 WGSL 程序的网格着色器', () => {
  it('告警并跳过这次绘制(照 GpuMeshAdapter),不拿缺省网格程序顶替', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rhi, renderer } = setup(8);
    const createShader = vi.spyOn(rhi, 'createShader');
    const glProgram = new GlProgram({ vertex: 'void main(){}', fragment: 'void main(){}' });
    const shader = new Shader({ glProgram, resources: {} });
    expect(shader.gpuProgram).toBeFalsy();
    const mesh = new Mesh({ geometry: new PlaneGeometry({ width: 4, height: 4 }), shader });
    renderer.render({ container: mesh, target: RenderTexture.create({ width: 8, height: 8 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draws = (internals(renderer).builder.commands as any[]).filter((c) => c.t === 'draw');
    expect(draws).toHaveLength(0);
    expect(createShader).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => c.some((a) => String(a).includes('no gpuProgram')))).toBe(true);
    renderer.destroy();
  });
});
