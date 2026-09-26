/**
 * 管线预建(空后端,不需要 GPU):预建的键必须与真画时逐项相同——预建过的组合真画时不再建新管线;
 * 没预建的混合照常现建;pipelinesReady 等到全部已建管线就绪。
 * 目标一旦用过模板遮罩就一直带模板(照 Pixi),此后的 draw 要的是带深度模板的管线:预建必须连这一路一起建,
 * 否则第一次对话(DialogueUI 给正文挂遮罩)之后预建全部落空(审查 R2-2)。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Buffer, BufferUsage } from '../shader/Buffer';
import { Geometry } from '../shader/Geometry';
import { GpuProgram } from '../shader/GpuProgram';
import { Shader } from '../shader/Shader';
import { Mesh } from '../mesh/Mesh';
import { Container } from '../scene/Container';
import { RenderTexture } from '../textures/RenderTexture';
import { Graphics } from '../graphics/Graphics';
import { WebGPURenderer } from './WebGPURenderer';

const WGSL = /* wgsl */ `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> @builtin(position) vec4<f32> {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return vec4<f32>((m * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
}
@fragment fn mainFragment() -> @location(0) vec4<f32> { return localUniforms.uColor; }
`;

function makeGeometry(): Geometry {
  return new Geometry({
    attributes: { aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, 4, 0, 0, 4]), usage: BufferUsage.VERTEX }), format: 'float32x2' } },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2]), usage: BufferUsage.INDEX }),
  });
}

function setup(antialias = false) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8, antialias });
  const created = vi.spyOn(rhi, 'createRenderPipeline');
  const program = new GpuProgram({ name: 'prewarm-test', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
  return { rhi, renderer, created, program };
}

describe('管线预建', () => {
  it('预建过的组合,真画时命中缓存、不再建管线;没预建的混合照常现建', async () => {
    const { renderer, created, program } = setup();
    // 预建用的几何是另一份对象,只看布局
    renderer.prewarmPipelines([{ program, geometry: makeGeometry(), blendModes: ['add'] }]);
    // 缺省目标格式 = 画布(空后端 bgra8unorm)+ 离屏 bgra8unorm,去重后一种;不带模板 + 带模板(停用)两份
    expect(created).toHaveBeenCalledTimes(2);
    expect(await renderer.pipelinesReady(1000)).toBe(true);

    const mesh = new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) });
    mesh.blendMode = 'add';
    // 网格挂在根下:渲染根自己的混合模式不生效(照 Pixi),要画出 add 得是子节点
    const root = new Container();
    root.addChild(mesh);
    const rt = RenderTexture.create({ width: 8, height: 8 });
    renderer.render({ container: root, target: rt });
    expect(created).toHaveBeenCalledTimes(2);

    mesh.blendMode = 'screen';
    renderer.render({ container: root, target: rt });
    expect(created).toHaveBeenCalledTimes(3);
    renderer.destroy();
  });

  it.each([false, true])('画布挂过模板遮罩之后,预建过的组合仍命中缓存(R2-2,antialias=%s)', async (antialias) => {
    const { renderer, created, program } = setup(antialias);
    renderer.prewarmPipelines([{ program, geometry: makeGeometry(), blendModes: ['add'] }]);
    const afterPrewarm = created.mock.calls.length;
    expect(await renderer.pipelinesReady(1000)).toBe(true);

    // 一帧带图形遮罩的 UI(DialogueUI:bodyText.mask = bodyMask):画布从此一直带模板
    const stage = new Container();
    const ui = new Container();
    const body = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    const mask = new Graphics().rect(0, 0, 2, 2).fill(0xffffff);
    ui.addChild(body, mask);
    body.mask = mask;
    stage.addChild(ui);
    renderer.render({ container: stage });
    stage.removeChild(ui);
    renderer.render({ container: stage });
    expect(created.mock.calls.length).toBeGreaterThan(afterPrewarm);

    // 之后第一次在画布上画预建过的程序:不许再建管线
    const before = created.mock.calls.length;
    const mesh = new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) });
    mesh.blendMode = 'add';
    stage.addChild(mesh);
    renderer.render({ container: stage });
    expect(created.mock.calls.length).toBe(before);
    renderer.destroy();
  });

  it('设备丢失恢复后按原样重建预建的管线,揭幕闸照常等它们,真画时不再现建(R3,同 master GlProgramWarmup.syncContext)', async () => {
    const { rhi, renderer, created, program } = setup();
    renderer.prewarmPipelines([{ program, geometry: makeGeometry(), blendModes: ['add'] }]);
    const perPrewarm = created.mock.calls.length;
    expect(perPrewarm).toBeGreaterThan(0);
    await rhi.loseDevice('测试', { restore: true });
    // 恢复时就在新设备上重建了同样多的管线
    expect(created.mock.calls.length).toBe(perPrewarm * 2);
    expect(await renderer.pipelinesReady(1000)).toBe(true);
    const before = created.mock.calls.length;
    const mesh = new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) });
    mesh.blendMode = 'add';
    const root = new Container();
    root.addChild(mesh);
    renderer.render({ container: root, target: RenderTexture.create({ width: 8, height: 8 }) });
    expect(created.mock.calls.length).toBe(before);
    renderer.destroy();
  });

  it('坏程序只告警、不抛(开局预建不许打断启动)', () => {
    const { renderer } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = new GpuProgram({ name: 'bad', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
    // 几何缺了程序要的属性:布局建不起来
    const empty = new Geometry({ attributes: {} });
    expect(() => renderer.prewarmPipelines([{ program: bad, geometry: empty, blendModes: ['normal'] }])).not.toThrow();
    warn.mockRestore();
    renderer.destroy();
  });
});
