/**
 * 前景层覆盖图的 WGSL 静默出错点守门(游戏只跑 WGSL;这几条错了**不报错、只是画面不对**):
 *
 * - FgMaskU 字节布局:JS 端 UniformGroup 按声明顺序、vec2 数组按 8 字节跨度紧排(`createUboLayout`),
 *   WGSL 端 uBase 声明成 `array<vec4<f32>, 16>`(16 字节跨度、16 对齐)再按奇偶拆——两边偏移 / 大小必须逐项相同,
 *   uBase 不在第一个就整体错位(接地深度全乱,前景面判据悄悄失效);
 * - 覆盖图程序的每个绑定都有资源、每张纹理的「名 + Sampler」= 该纹理自己的 style(id 图必须最近邻);
 * - 打包后按 WGSL 的读法(fgBaseAt / fgSurfaceDepth)读回来的接地采样与前景面深度 = CPU 那份(foregroundSurfaceDepth);
 * - 空后端(NullRhiDevice)上真走一遍 renderUv → renderCoverage:绑定齐、画进 rgba16float 的覆盖图、交给使用方。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BufferImageSource, Container, Texture, TextureSource, UniformGroup, WGSL_ALIGN_SIZE_DATA, WebGPURenderer, type Shader, type TextureStyle,
} from '../../engine2d';
import { packUbo } from '../../engine2d/shader/uboLayout';
import { NullRhiDevice } from '../rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../rhi';
import { FG_COVERAGE_WGSL, SwayBackground, type BackgroundSwayInput } from '../backgroundSway';
import { samplerOf } from '../legacy/gpuSampler';
import { resolveSceneWind } from '../../utils/sceneWind';
import {
  FG_BASE_SAMPLES, foregroundBaseSamples, foregroundSurfaceDepth, type ForegroundBaseSamples, type ForegroundDepthModel,
} from './foregroundLayerDefs';
import { FG_OCCLUSION_WGSL, fgCoverageBindingsWgsl } from './foregroundMaskWgsl';
import { FG_COVERAGE_DILATE_PX, SceneForegroundLayers, type ForegroundMask } from './SceneForegroundLayers';

type StructsAndGroups = { groups: Array<{ group: number; binding: number; name: string; isUniform: boolean; type: string }> };

/** WGSL 结构成员(一行一个,`名: 类型,`) */
function wgslStructMembers(src: string, name: string): Array<[string, string]> {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src);
  expect(m, `找不到 WGSL 结构 ${name}`).toBeTruthy();
  return m![1].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const mm = /^(\w+)\s*:\s*(.+?),?$/.exec(l);
    expect(mm, `结构 ${name} 的成员行解析不了:${l}`).toBeTruthy();
    return [mm![1], mm![2]];
  });
}

/** WGSL uniform 地址空间的对齐 / 大小(数组步长必须是 16 的倍数) */
function wgslAlignSize(type: string): { align: number; size: number } {
  const arr = /^array<(.+),\s*(\d+)>$/.exec(type);
  if (arr) {
    const el = wgslAlignSize(arr[1]);
    const stride = Math.ceil(el.size / el.align) * el.align;
    expect(stride % 16, `uniform 数组 ${type} 的步长必须是 16 的倍数`).toBe(0);
    return { align: Math.max(el.align, 16), size: stride * Number(arr[2]) };
  }
  const d = (WGSL_ALIGN_SIZE_DATA as Record<string, { align: number; size: number }>)[type];
  expect(d, `未知 WGSL 类型 ${type}`).toBeTruthy();
  return d;
}

function wgslLayout(members: Array<[string, string]>): { offsets: Record<string, [number, number]>; size: number } {
  let off = 0;
  let maxAlign = 1;
  const offsets: Record<string, [number, number]> = {};
  for (const [n, t] of members) {
    const { align, size } = wgslAlignSize(t);
    off = Math.ceil(off / align) * align;
    offsets[n] = [off, size];
    off += size;
    maxAlign = Math.max(maxAlign, align);
  }
  return { offsets, size: Math.ceil(off / maxAlign) * maxAlign };
}

function jsLayout(g: UniformGroup): { offsets: Record<string, [number, number]>; size: number } {
  const offsets: Record<string, [number, number]> = {};
  for (const e of g.layout.elements) offsets[e.name] = [e.offset, e.byteSize];
  return { offsets, size: g.layout.size };
}

function dataTex(w: number, h: number, scaleMode: 'nearest' | 'linear'): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(w * h * 4), width: w, height: h, format: 'rgba8unorm', scaleMode }),
  });
}

function buildSway(composite = false) {
  const plateTex = dataTex(4, 2, 'linear'), matteTex = dataTex(4, 2, 'linear'), idsTex = dataTex(4, 2, 'linear'), painting = dataTex(4, 2, 'linear');
  idsTex.source.scaleMode = 'nearest';   // 与 loadBackgroundSwayInput 同
  const inp = {
    urls: [], plateTex, matteTex, idsTex,
    meta: { version: 3, margin: 48, instances: [{ id: 1, kind: 'plant', root: [100, 180], height: 200, persp: 1, reach: 150, bbox: [60, 40, 200, 185] }] },
    sceneSize: [400, 200], paintSize: [800, 400],
    jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
    sceneToWorldXZ: null, scaleAt: null, ids: null, matte: null, rigid: null, litPlate: null,
  } as unknown as BackgroundSwayInput;
  return { sb: new SwayBackground(painting, inp, { composite }), matteTex, idsTex };
}

/** 接地折线逐列取不同的 y 与深度(让 fgBaseAt 的奇偶拆、插值都真的被用到) */
const MODEL: ForegroundDepthModel = { uprightPerY: 0.0023, groundAt: (x, y) => 0.9 - 0.0011 * y + 0.0002 * x };
const lineBase = (): ForegroundBaseSamples => foregroundBaseSamples(
  { baseX: 0, baseY: 0, baseLine: [[20, 170], [140, 186], [300, 160]], bbox: [60, 40, 200, 185] }, MODEL, [400, 200],
)!;

const shaderOf = (m: ForegroundMask): Shader => (m.mesh as unknown as { shader: Shader }).shader;
const groupOf = (m: ForegroundMask): UniformGroup => (shaderOf(m).resources as Record<string, unknown>).fgMaskU as UniformGroup;

/** 把参数组按运行时的打包函数写成字节,再按 WGSL 的布局读 */
function packed(g: UniformGroup): { f32: Float32Array; at: (name: string) => number } {
  const buf = new ArrayBuffer(g.layout.size);
  const f32 = new Float32Array(buf);
  packUbo(g.layout, g.uniforms, f32, new Int32Array(buf), new Uint32Array(buf), 0);
  const wl = wgslLayout(wgslStructMembers(FG_COVERAGE_WGSL, 'FgMaskU'));
  return { f32, at: (name) => wl.offsets[name][0] / 4 };
}

/** WGSL fgBaseAt 的逐句移植:uBase 是 vec4 数组,第 i 个 vec2 = [i/2] 的 xy(偶)/ zw(奇) */
function fgBaseAtFromBytes(p: ReturnType<typeof packed>, i: number): [number, number] {
  const o = p.at('uBase') + Math.floor(i / 2) * 4 + ((i & 1) === 0 ? 0 : 2);
  return [p.f32[o], p.f32[o + 1]];
}

/** WGSL fgSurfaceDepth 的逐句移植(读打包后的字节) */
function fgSurfaceDepthFromBytes(p: ReturnType<typeof packed>, px: number, py: number): number {
  const bx0 = p.f32[p.at('uBaseX')], bx1 = p.f32[p.at('uBaseX') + 1];
  const t = Math.min(Math.max((px - bx0) / Math.max(bx1 - bx0, 1e-3), 0), 1) * (FG_BASE_SAMPLES - 1);
  const i = Math.min(Math.floor(t), FG_BASE_SAMPLES - 2);
  const a = fgBaseAtFromBytes(p, i), b = fgBaseAtFromBytes(p, i + 1);
  const f = t - i;
  const by = a[0] + (b[0] - a[0]) * f, bd = a[1] + (b[1] - a[1]) * f;
  return bd + p.f32[p.at('uUpright')] * (py - by);
}

describe('覆盖图程序 · WGSL 绑定与参数组布局', () => {
  it('每个 WGSL 绑定都有资源、资源键都有绑定;采样器 = 各自纹理的 style(id 图最近邻)', () => {
    const { sb, matteTex, idsTex } = buildSway();
    const m = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 200, h: 100 }, FG_COVERAGE_DILATE_PX, lineBase(), 0.002)!;
    const sh = shaderOf(m);
    expect(sh.gpuProgram, '覆盖图网格没有 WGSL 程序(引擎只跑 WebGPU:整层前景静默失效)').toBeTruthy();
    const sg = sh.gpuProgram!.structsAndGroups as StructsAndGroups;
    const res = sh.resources as Record<string, unknown>;
    expect(sh.gpuProgram!.autoAssignGlobalUniforms && sh.gpuProgram!.autoAssignLocalUniforms).toBe(true);
    const own = sg.groups.filter((g) => g.group === 2);
    expect(own.map((g) => g.name).sort()).toEqual(Object.keys(res).sort());
    for (const g of own) expect(res[g.name], `WGSL 绑定 ${g.name} 没有资源`).toBeTruthy();
    expect(res.uUvMap).toBe(sb.uvMap.source);
    expect(res.uIds).toBe(idsTex.source);
    expect(res.uMatte).toBe(matteTex.source);
    for (const g of own.filter((x) => x.type.startsWith('texture_2d'))) {
      expect(res[g.name]).toBeInstanceOf(TextureSource);
      expect(res[`${g.name}Sampler`], `${g.name}Sampler 必须是 samplerOf(${g.name})`).toBe(samplerOf(res[g.name] as TextureSource));
    }
    const ids = res.uIdsSampler as TextureStyle;
    expect([ids.minFilter, ids.magFilter]).toEqual(['nearest', 'nearest']);
    // 片元阶段的绑定数在 WebGPU 缺省上限内(16 纹理 / 16 采样器 / 12 uniform 缓冲)
    const all = sg.groups;
    expect(all.filter((g) => g.type.startsWith('texture_')).length).toBeLessThanOrEqual(16);
    expect(all.filter((g) => g.type === 'sampler').length).toBeLessThanOrEqual(16);
    expect(all.filter((g) => g.isUniform).length).toBeLessThanOrEqual(12);
    sb.destroy();
  });

  it('FgMaskU 字节布局 = JS 参数组的打包布局(uBase 排第一、偏移 0;其余逐项同偏移同大小)', () => {
    const { sb } = buildSway();
    const m = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 200, h: 100 }, 4, lineBase(), 0.002)!;
    const g = groupOf(m);
    expect(g).toBeInstanceOf(UniformGroup);
    const js = jsLayout(g);
    const members = wgslStructMembers(FG_COVERAGE_WGSL, 'FgMaskU');
    const wg = wgslLayout(members);
    expect(Object.keys(wg.offsets), 'FgMaskU 成员名 / 顺序与 JS 声明').toEqual(Object.keys(js.offsets));
    expect(wg.offsets, 'FgMaskU 成员偏移 / 大小').toEqual(js.offsets);
    expect(wg.size).toBeLessThanOrEqual(js.size);
    // 数组在两种布局里都从 16 对齐的偏移开始
    expect(js.offsets.uBase[0] % 16).toBe(0);
    expect(js.offsets.uBase[1]).toBe(FG_BASE_SAMPLES * 8);
    expect(members[0]).toEqual(['uBase', `array<vec4<f32>, ${FG_BASE_SAMPLES / 2}>`]);
    sb.destroy();
  });

  it('fgBaseAt(WGSL 独有的拆包,孪生守门不比它)逐句钉住:第 i 个 vec2 = uBase[i / 2] 的 xy(偶)/ zw(奇)', () => {
    const body = /fn fgBaseAt\(i: i32\) -> vec2<f32> \{([\s\S]*?)\n\}/.exec(FG_COVERAGE_WGSL)?.[1] ?? '';
    expect(body.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual([
      'let v = fgMaskU.uBase[i / 2];',
      'if ((i & 1) == 0) { return v.xy; }',
      'return v.zw;',
    ]);
    // fgSurfaceDepth 取的是 i 与 i + 1(i ≤ FG_BASE_SAMPLES − 2,不越界)
    expect(FG_COVERAGE_WGSL).toContain(`let i = min(i32(floor(t)), ${FG_BASE_SAMPLES - 2});`);
    expect(FG_COVERAGE_WGSL).toContain('let b = mix(fgBaseAt(i), fgBaseAt(i + 1), t - f32(i));');
  });

  it('打包后按 WGSL 的读法读回:接地采样逐点相同,前景面深度 = foregroundSurfaceDepth(接地 y / 深度按 x 插值)', () => {
    const { sb } = buildSway();
    const base = lineBase();
    const m = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 200, h: 100 }, 4, base, MODEL.uprightPerY)!;
    const p = packed(groupOf(m));
    for (let i = 0; i < FG_BASE_SAMPLES; i++) {
      const [y, d] = fgBaseAtFromBytes(p, i);
      expect(y).toBeCloseTo(base.data[i * 2], 4);
      expect(d).toBeCloseTo(base.data[i * 2 + 1], 6);
    }
    // 采样点上:与 CPU 的直立面同式
    const step = (base.x1 - base.x0) / (FG_BASE_SAMPLES - 1);
    for (const k of [0, 5, 16, 31]) {
      const x = base.x0 + step * k, y = 120;
      const want = foregroundSurfaceDepth(base.data[k * 2], base.data[k * 2 + 1], MODEL.uprightPerY, y);
      expect(fgSurfaceDepthFromBytes(p, x, y)).toBeCloseTo(want, 5);
    }
    // 两个采样点之间:线性插值
    const x = base.x0 + step * 7.25, y = 90;
    const by = base.data[14] + (base.data[16] - base.data[14]) * 0.25;
    const bd = base.data[15] + (base.data[17] - base.data[15]) * 0.25;
    expect(fgSurfaceDepthFromBytes(p, x, y)).toBeCloseTo(bd + MODEL.uprightPerY * (y - by), 5);
    sb.destroy();
  });

  it('setBase 原地换参数:打包出来的 uBase / uBaseX / uUpright 跟着变,其余不动', () => {
    const { sb } = buildSway();
    const m = sb.createForegroundMask([10, 20, 30, 40], 7, { w: 200, h: 100 }, 4, lineBase(), 0.002)!;
    const g = groupOf(m);
    const before = packed(g);
    const nb: ForegroundBaseSamples = { ...lineBase(), x0: 12, x1: 377 };
    nb.data = nb.data.map((v, i) => (i % 2 ? v + 0.25 : v - 3));
    m.setBase(nb, 0.0041);
    expect(groupOf(m)).toBe(g);
    const after = packed(g);
    expect(after.f32[after.at('uUpright')]).toBeCloseTo(0.0041, 7);
    expect([after.f32[after.at('uBaseX')], after.f32[after.at('uBaseX') + 1]]).toEqual([12, 377]);
    for (let i = 0; i < FG_BASE_SAMPLES; i++) {
      const [y, d] = fgBaseAtFromBytes(after, i);
      expect(y).toBeCloseTo(nb.data[i * 2], 4);
      expect(d).toBeCloseTo(nb.data[i * 2 + 1], 6);
    }
    expect(after.f32[after.at('uFgInst')]).toBe(7);
    expect(before.f32[before.at('uFgInst')]).toBe(7);
    expect([after.f32[after.at('uSceneSize')], after.f32[after.at('uSceneSize') + 1]]).toEqual([400, 200]);
    sb.destroy();
  });

  it('使用方共用段:fgSample 读模块作用域的 uFgCoverage / uFgCoverageSampler(宿主按给定组号 / 绑定号声明)', () => {
    expect(fgCoverageBindingsWgsl(1, 3)).toBe(
      '@group(1) @binding(3) var uFgCoverage: texture_2d<f32>;\n@group(1) @binding(4) var uFgCoverageSampler: sampler;\n',
    );
    expect(FG_OCCLUSION_WGSL).toMatch(/fn fgSample\(uv: vec2<f32>, hasCoverage: f32, outDepth: ptr<function, f32>\) -> f32/);
    expect(FG_OCCLUSION_WGSL).toContain('textureSampleLevel(uFgCoverage, uFgCoverageSampler, uv, 0.0)');
  });
});

describe('覆盖图 · 空后端上真走一遍', () => {
  it('renderUv → renderCoverage:画进 1/4 原画的 rgba16float 覆盖图,绑定齐,渲完才交给使用方;拆除先广播 null', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const created = vi.spyOn(rhi, 'createTexture');
    const { sb } = buildSway();
    sb.update(resolveSceneWind({ direction: [-1, 0, 0], speed: 400 })!, 1 / 60);
    const got: Array<Texture | null> = [];
    const fg = new SceneForegroundLayers({
      layers: [{
        id: 'fg_tree', label: 'fg_tree', instId: 1, baseX: 100, baseY: 180, baseLine: null,
        rect: [0, 0, 1, 1], bbox: [60, 40, 200, 185],
      }],
      maskHost: sb, paintSize: [800, 400], sceneSize: [400, 200],
      displacementOf: (id) => sb.instanceDisplacement(id),
      depthModel: MODEL,
      onCoverage: (t) => got.push(t),
    });
    expect(fg.layerCount).toBe(1);
    const log0 = rhi.log.length;
    expect(sb.renderUv(renderer)).toBe(true);
    fg.markCoverageDirty();
    fg.updateDisplacement();
    fg.renderCoverage(renderer);
    const log = rhi.log.slice(log0);
    expect(log.filter((l) => l.startsWith('skip draw'))).toEqual([]);
    expect(log.filter((l) => l.startsWith('drawIndexed')).length).toBeGreaterThanOrEqual(2);   // 位移图 + 覆盖图
    const cov = (fg as unknown as { coverage: Texture }).coverage;
    expect(got).toEqual([cov]);
    expect(fg.coverageTexture).toBe(cov);
    const desc = created.mock.calls.map((c) => c[1] as RhiTextureDesc).find((d) => d.width === 200 && d.height === 100);
    expect(desc?.format).toBe('rgba16float');
    expect(cov.source.style.magFilter).toBe('linear');
    // 不脏就不重渲
    const n = rhi.log.length;
    fg.renderCoverage(renderer);
    expect(rhi.log.length).toBe(n);
    // F2 覆盖图叠加:半浮点 RT 当普通精灵画在世界上
    const world = new Container();
    fg.setCoverageView(true, world, [400, 200]);
    expect(fg.coverageViewOn).toBe(true);
    const n2 = rhi.log.length;
    expect(() => renderer.render({ container: world })).not.toThrow();
    expect(rhi.log.slice(n2).some((l) => l.startsWith('draw'))).toBe(true);
    fg.destroy();
    expect(got).toEqual([cov, null]);
    expect(cov.destroyed).toBe(true);
    // 拆除先拆了读它的叠加精灵:世界再画不会去绑已销毁的 RT(engine2d 绑到已销毁的源当帧抛)
    expect(world.children.length).toBe(0);
    expect(() => renderer.render({ container: world })).not.toThrow();
    sb.destroy();
    renderer.destroy();
  });
});
