/**
 * 场景前景层覆盖图接进三支实体遮挡滤镜(DepthOcclusionFilter / EntityLightingFilter / CharacterShadingFilter)的
 * WGSL 守门(不需要 GPU)。master 在 GLSL 里加了 uHasFgCoverage + uFgCoverage + fgSample,判据改成
 *   occluded = fgKind > 1.5 ? false : fgKind > 0.5 ? fgDepth < 脚点深度 + upright - 1e-4 : sceneDepth + uTolerance < spriteDepth
 * 游戏只跑 WGSL,这里钉住 WGSL 那份:
 * - 判据的三支与 master 的 GLSL 逐式相同(去掉 uniform 结构体前缀后逐字比),DepthOcclusion 的调试色用同一个 occluded;
 *   深度遮挡 / 实体光照两支只剩 WGSL(没有 GL 程序),角色着色那支的 GLSL 程序还在、判据照比;
 * - 共用取样段 fgSample 拼进来恰好一次、开关从各自的参数结构体传进去;
 * - uFgCoverage / uFgCoverageSampler 是组 1 的绑定,初值 = 永不销毁的占位 + 它的共享采样器;
 * - setForegroundCoverage 交来 / 收回:纹理、采样器(samplerOf)、开关三样一起换;
 * - 片元阶段绑定数在 WebGPU 默认上限内(16 取样纹理 / 16 采样器 / 12 uniform 缓冲)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BufferImageSource, DOMAdapter, Texture, TextureSource, UniformGroup, type Filter } from '../engine2d';
import { samplerOf } from './legacy/gpuSampler';
import { DepthOcclusionFilter } from './DepthOcclusionFilter';
import { EntityLightingFilter } from './EntityLightingFilter';
import { CharacterShadingFilter, type CharShadingSceneResources } from './CharacterShadingFilter';
import { resolveLightEnv } from './lightEnv';
import type { SceneDepthConfig } from '../data/types';

type Binding = { group: number; binding: number; name: string; isUniform: boolean; type: string };

function src(w: number, h: number, format: 'rgba8unorm' | 'rgba16float' | 'r8unorm' = 'rgba8unorm',
  scaleMode: 'nearest' | 'linear' = 'nearest'): TextureSource {
  const ch = format === 'r8unorm' ? 1 : 4;
  const resource = format === 'rgba16float' ? new Uint16Array(w * h * ch) : new Uint8Array(w * h * ch);
  return new BufferImageSource({ resource, width: w, height: h, format, scaleMode });
}

const CFG: SceneDepthConfig = {
  depth_map: 'raw_depth_rg.png', collision_map: 'collision.png',
  M: { R: [[1, 0, 0], [0, Math.SQRT1_2, -Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]], ppu: 100, cx: 100, cy: 75 },
  depth_mapping: { invert: false, scale: 2, offset: -1 },
  shader: { depth_per_sy: 0.01 },
  depth_tolerance: 0.05, floor_offset: 0,
};

function sceneResources(): CharShadingSceneResources {
  return {
    atlasL1: src(4, 1, 'rgba16float'), atlasL2: src(9, 1, 'rgba16float'), atlasBin: src(64, 1, 'rgba16float'),
    valid: src(4, 1, 'r8unorm'), volRad: src(8, 3, 'rgba16float'), volEmit: src(8, 3, 'rgba16float'),
    workW: 200, workH: 150, worldToWorkX: 0.5, worldToWorkY: 0.5,
    cal: { ppu: 100, cx: 100, cy: 75, theta: Math.PI / 4 },
    vol: { nx: 4, ny: 3, nz: 2, tilesX: 2, tilesY: 1, qMin: [-1, -1, -1], qMax: [1, 1, 1] },
    mCol: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, -1]), wMin: [-1, -1, -1], wScale: [1, 1, 1], pn: [3, 3, 3],
    probeT: 4, shK: 9, binOb: 8, ambSH: new Float32Array(27), lightsQ: new Float32Array(192), lightsE: new Float32Array(192),
    lightCount: 0, skyao: null,
  };
}

interface Case {
  label: string;
  make: () => Filter & { setForegroundCoverage(src: TextureSource | null): void };
  /** 自有 uniform 组的资源键 / WGSL 里访问它的前缀 */
  group: string;
  prefix: string;
  /** 脚点深度在两种语言里的写法(去掉前缀后) */
  foot: string;
  /** JS 声明里 uHasFgCoverage 的前一个 / 后一个成员(= master 的位置) */
  prev: string;
  next: string;
}

const CASES: Case[] = [
  {
    label: '深度遮挡', make: () => DepthOcclusionFilter.createForEntity(new Texture({ source: src(8, 6) }), CFG),
    group: 'depthUniforms', prefix: 'u', foot: 'uFootDepthQ', prev: 'uFootBias', next: '',
  },
  {
    label: '实体光照', make: () => EntityLightingFilter.createForEntity({
      depthTexture: new Texture({ source: src(8, 6) }), cfg: CFG, probeSource: null,
      lightEnv: resolveLightEnv(undefined, undefined), sampleLiftWorld: 0,
    }),
    group: 'lightUniforms', prefix: 'u', foot: 'uFootDepthQ', prev: 'uFootBias', next: 'uKeyColor',
  },
  {
    label: '角色着色', make: () => CharacterShadingFilter.createForEntity({
      depthTexture: new Texture({ source: src(40, 30, 'rgba8unorm', 'linear') }), cfg: CFG, scene: sceneResources(),
    }),
    group: 'shadeUniforms', prefix: 'shadeUniforms', foot: 'uFootQ.z', prev: 'uFootBias', next: 'uDebug',
  },
];

const bindingsOf = (f: Filter): Binding[] => f.gpuProgram!.structsAndGroups.groups as Binding[];
const wgslOf = (f: Filter): string => f.gpuProgram!.source;
const res = (f: Filter): Record<string, unknown> => f.resources as Record<string, unknown>;
const fgOn = (f: Filter, group: string): unknown => (res(f)[group] as UniformGroup).uniforms['uHasFgCoverage'];
/** 去注释、压空白 */
const norm = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');

describe('三支实体遮挡滤镜 · 前景覆盖图(WGSL)', () => {
  // GlProgram 构造时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it.each(CASES)('$label:组 1 声明覆盖图 + 采样器,初值是占位与它的共享采样器,开关 0', (c) => {
    const f = c.make();
    const b = bindingsOf(f);
    const tex = b.find((x) => x.name === 'uFgCoverage');
    const smp = b.find((x) => x.name === 'uFgCoverageSampler');
    expect(tex, 'uFgCoverage 绑定').toMatchObject({ group: 1, type: 'texture_2d<f32>' });
    expect(smp, 'uFgCoverageSampler 绑定').toMatchObject({ group: 1, type: 'sampler' });
    // 组 1 内绑定号不重
    const nums = b.filter((x) => x.group === 1).map((x) => x.binding);
    expect(new Set(nums).size).toBe(nums.length);
    expect(res(f)['uFgCoverage']).toBe(Texture.EMPTY.source);
    expect(res(f)['uFgCoverageSampler']).toBe(samplerOf(Texture.EMPTY.source));
    expect(fgOn(f, c.group)).toBe(0);
  });

  it.each(CASES)('$label:uHasFgCoverage 在 JS 与 WGSL 结构体里是同一个位置(master 的声明位置)', (c) => {
    const f = c.make();
    const js = Object.keys((res(f)[c.group] as UniformGroup).uniformStructures);
    const i = js.indexOf('uHasFgCoverage');
    expect(js[i - 1]).toBe(c.prev);
    expect(js[i + 1] ?? '').toBe(c.next);
    const g = bindingsOf(f).find((x) => x.name === c.group)!;
    const struct = f.gpuProgram!.structsAndGroups.structs.find((s) => s.name === g.type)!;
    expect(Object.keys(struct.members)).toEqual(js);
    expect(struct.members['uHasFgCoverage']).toBe('f32');
  });

  it.each(CASES)('$label:setForegroundCoverage 交来 / 收回时纹理、采样器、开关一起换', (c) => {
    const f = c.make();
    const cov = src(16, 9, 'rgba16float', 'linear');
    const cov2 = src(16, 9, 'rgba16float', 'nearest');
    // 前提:两张图的采样参数不同,换没换采样器看得出来
    expect(samplerOf(cov)).not.toBe(samplerOf(cov2));
    f.setForegroundCoverage(cov);
    expect(res(f)['uFgCoverage']).toBe(cov);
    expect(res(f)['uFgCoverageSampler']).toBe(samplerOf(cov));
    expect(fgOn(f, c.group)).toBe(1);
    f.setForegroundCoverage(cov2);
    expect(res(f)['uFgCoverage']).toBe(cov2);
    expect(res(f)['uFgCoverageSampler']).toBe(samplerOf(cov2));
    expect(fgOn(f, c.group)).toBe(1);
    f.setForegroundCoverage(null);
    expect(res(f)['uFgCoverage']).toBe(Texture.EMPTY.source);
    expect(res(f)['uFgCoverageSampler']).toBe(samplerOf(Texture.EMPTY.source));
    expect(fgOn(f, c.group)).toBe(0);
  });

  it.each(CASES)('$label:WGSL 的遮挡判据三支(与 master 的 GLSL 逐式相同),fgSample 拼进来恰好一次、开关作参数', (c) => {
    const f = c.make();
    const w = norm(wgslOf(f));
    expect(w.match(/\bfn fgSample\(/g)?.length).toBe(1);
    expect(w).toContain(`var fgDepth: f32; let fgKind = fgSample(depthUV, ${c.prefix}.uHasFgCoverage, &fgDepth);`);
    const wm = /if \(fgKind > 1\.5\) \{ occluded = (.+?); \} else if \(fgKind > 0\.5\) \{ occluded = (.+?); \} else \{ occluded = (.+?); \}/.exec(w);
    expect(wm, 'WGSL 判据').toBeTruthy();
    const strip = (s: string) => s.replace(new RegExp(`\\b${c.prefix}\\.`, 'g'), '');
    const expected = ['false', `fgDepth < ${c.foot} + upright - 1e-4`, 'sceneDepth + uTolerance < spriteDepth'];
    expect(wm!.slice(1).map(strip)).toEqual(expected);
    // 角色着色滤镜的 GLSL 程序还在(随角色照明那边一起删):它那份判据照比;另两支只剩 WGSL
    if (c.label === '角色着色') {
      const gm = /float fgKind = fgSample\(depthUV, fgDepth\); occluded = fgKind > 1\.5 \? (.+?) : fgKind > 0\.5 \? (.+?) : (.+?);/
        .exec(norm(f.glProgram!.fragment));
      expect(gm, 'GLSL 判据').toBeTruthy();
      expect(gm!.slice(1)).toEqual(expected);
    } else {
      expect(f.glProgram).toBeNull();
    }
    // 深度图判据只剩判据里那一处(调试 / 正常渲染都读 occluded,不许再各算一遍)
    expect(w.match(/sceneDepth \+ \w+\.uTolerance < spriteDepth/g)?.length).toBe(1);
    // 取样在调试分支之前(调试色与正常渲染同一个 occluded)
    expect(w.indexOf('fgSample(depthUV')).toBeLessThan(w.indexOf(`if (${c.prefix}.uDebug > 0.5)`));
    expect(w).toContain(`if (${c.prefix}.uDebug > 0.5) { if (occluded) { return vec4<f32>(1.0, 0.0, 0.0, 0.7); }`);
  });

  it('共用取样段与 master 的 GLSL 逐式对应:开关 < 0.5 → 0;覆盖 R <= 0.5 → 0;B > 0.5 → 1、深度 = G / max(R, 1e-4);其余 → 2', () => {
    const w = norm(wgslOf(CASES[0].make()));
    expect(w).toContain('fn fgSample(uv: vec2<f32>, hasCoverage: f32, outDepth: ptr<function, f32>) -> f32 { *outDepth = 0.0; '
      + 'if (hasCoverage < 0.5) { return 0.0; } let s = textureSampleLevel(uFgCoverage, uFgCoverageSampler, uv, 0.0); '
      + 'if (s.r <= 0.5) { return 0.0; } if (s.b > 0.5) { *outDepth = s.g / max(s.r, 1e-4); return 1.0; } return 2.0; }');
  });

  it.each(CASES)('$label:片元阶段绑定数在 WebGPU 默认上限内', (c) => {
    // 整个模块的绑定都按片元可见算(上界;顶点阶段只读 gfu)
    const b = bindingsOf(c.make());
    const textures = b.filter((x) => x.type.startsWith('texture_')).length;
    const samplers = b.filter((x) => x.type === 'sampler').length;
    const ubos = b.filter((x) => x.isUniform).length;
    expect(textures).toBeLessThanOrEqual(16);
    expect(samplers).toBeLessThanOrEqual(16);
    expect(ubos).toBeLessThanOrEqual(12);
    expect(Math.max(...b.map((x) => x.group))).toBeLessThan(4);
    const expected: Record<string, [number, number, number]> = {
      深度遮挡: [3, 3, 2], 实体光照: [4, 4, 2], 角色着色: [11, 4, 2],
    };
    expect([textures, samplers, ubos]).toEqual(expected[c.label]);
  });
});
