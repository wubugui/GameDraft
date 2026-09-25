/**
 * 实体受光三件(EntityShadow 的 cast / contact 网格程序、DepthOcclusionFilter、EntityLightingFilter)的 WGSL
 * 静默出错点守门(不需要 GPU)。WebGPU 下这几条错了**不报错、只是画面不对**,而像素对照
 * (tools/render_parity/cases/40_entity.ts)要真浏览器才跑得起来:
 *
 * - uniform 组:Pixi 按 JS 对象的声明顺序、WGSL 对齐规则排偏移 ⇒ WGSL struct 的成员名 / 类型 / 顺序必须与 JS 逐项相同
 *   (往 JS 里加一个 uniform 忘了加进 WGSL,后面的成员全体错位);
 * - resources 的每个键都要在 WGSL 里有同名绑定(没有的被 Pixi 塞进第 99 组,WebGPU 下整个 draw 作废);
 * - WGSL 声明的每个绑定都要有资源;
 * - 每张纹理的「纹理名 + Sampler」就是该纹理自己的 style(WebGL 用纹理自带采样状态,两边才一致),
 *   运行时换图集时采样器跟着换。
 * 绑定表用 engine2d 解析 WGSL 的结果(`gpuProgram.structsAndGroups`,按变量名绑定,与渲染核心同一口径)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { samplerOf } from './legacy/gpuSampler';
import { BufferImageSource, Container, DOMAdapter, Texture, TextureSource, UniformGroup, type Shader } from '../engine2d';
import { PlanarEntityShadow } from './EntityShadow';
import type { ShadowSceneContext, ShadowSource } from './entityShadowTypes';
import { DepthOcclusionFilter } from './DepthOcclusionFilter';
import { EntityLightingFilter } from './EntityLightingFilter';
import type { ResolvedLightEnv } from './lightEnv';
import type { SceneDepthConfig } from '../data/types';

type StructsAndGroups = {
  groups: Array<{ group: number; binding: number; name: string; isUniform: boolean; type: string }>;
  structs: Array<{ name: string; members: Record<string, string> }>;
};

function checkShader(shader: Shader, label: string): void {
  const sg = shader.gpuProgram!.structsAndGroups as StructsAndGroups;
  // 1) 每个资源键都落在 WGSL 声明的绑定上(没有第 99 组)
  expect(Object.keys(shader.resources).filter((k) => !sg.groups.some((g) => g.name === k)), `${label}: 有资源键在 WGSL 里没有同名绑定`).toEqual([]);
  // 2) WGSL 声明的每个自有绑定都有资源(第 0 组滤镜 / 第 0、1 组网格由 Pixi 补)
  const autoGroups = new Set(shader.gpuProgram!.autoAssignGlobalUniforms ? [0, 1] : [0]);
  for (const g of sg.groups) {
    if (autoGroups.has(g.group)) continue;
    expect((shader.resources as Record<string, unknown>)[g.name], `${label}: WGSL 绑定 ${g.name} 没有资源`).toBeTruthy();
  }
  const resources = shader.resources as Record<string, unknown>;
  // 3) uniform 组:WGSL struct 与 JS 声明逐项同名同类型同顺序
  for (const g of sg.groups.filter((x) => x.isUniform && !autoGroups.has(x.group))) {
    const ug = resources[g.name];
    expect(ug, `${label}: ${g.name}`).toBeInstanceOf(UniformGroup);
    const structures = (ug as UniformGroup).uniformStructures as Record<string, { type: string }>;
    const js = Object.entries(structures).map(([k, v]) => `${k}: ${v.type}`);
    const struct = sg.structs.find((s) => s.name === g.type);
    expect(struct, `${label}: 找不到 struct ${g.type}`).toBeTruthy();
    const wgsl = Object.entries(struct!.members).map(([k, v]) => `${k}: ${v}`);
    expect(wgsl, `${label}: ${g.type} 与 JS uniforms 的声明顺序 / 类型`).toEqual(js);
  }
  // 4) 自有纹理的采样器 = 该纹理自己的 style
  for (const g of sg.groups.filter((x) => x.type.startsWith('texture_2d') && !autoGroups.has(x.group))) {
    const tex = resources[g.name];
    expect(tex, `${label}: ${g.name}`).toBeInstanceOf(TextureSource);
    expect(resources[`${g.name}Sampler`], `${label}: ${g.name}Sampler 不是 ${g.name} 对应的共享采样器(samplerOf)`).toBe(samplerOf(tex as TextureSource));
  }
}

function dataTex(w: number, h: number, scaleMode: 'nearest' | 'linear'): Texture {
  return new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(w * h * 4), width: w, height: h, format: 'rgba8unorm', scaleMode }),
  });
}

const ENV: ResolvedLightEnv = {
  key: { azimuthDeg: 125, elevationDeg: 45, color: [1, 0.95, 0.85], intensity: 1 },
  ambient: { color: [0.5, 0.55, 0.7], intensity: 1 },
  shadow: {
    mode: 'planar', enabled: true, darkness: 0.6, softness: 0, length: 0.9, contact: 0, contactSize: 1,
    softSamples: 1, softRadius: 0, billboard: 'light',
  },
  toneStrength: 0.45,
  toneEnabled: true,
  ao: { contact: 0.45, form: 0.25 },
};

function sceneCtx(): ShadowSceneContext {
  return {
    depthTexture: dataTex(8, 6, 'linear'), collisionTexture: dataTex(4, 4, 'nearest'),
    sceneW: 160, sceneH: 120, worldToPixelX: 2, worldToPixelY: 2, invert: 0, scale: 2.6, offset: -1.3, floorOffset: 0,
    groundTexture: dataTex(10, 8, 'nearest').source, groundMin: -1.3, groundMax: 1.3, tolerance: 0.05, occlusionBlendFactor: 0.28,
    ppu: 100, cx: 160, cy: 120,
    r00: 1, r01: 0, r02: 0, r10: 0, r11: Math.SQRT1_2, r12: -Math.SQRT1_2, r20: 0, r21: Math.SQRT1_2, r22: Math.SQRT1_2,
    colXMin: -1.6, colZMin: -1.8, colCellSize: 0.1, colGridW: 32, colGridH: 36,
  };
}

const CFG: SceneDepthConfig = {
  depth_map: 'raw_depth_rg.png', collision_map: 'collision.png',
  M: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ppu: 100, cx: 160, cy: 120 },
  depth_mapping: { invert: false, scale: 2.6, offset: -1.3 }, shader: { depth_per_sy: 0.01 },
  depth_tolerance: 0.05, floor_offset: 0,
};

describe('实体受光三件的 WGSL 与 JS 资源对齐', () => {
  // GlProgram 构造时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  type Shaders = { castShader: Shader; contactShader: Shader };

  it.each([['无场景上下文(anim_preview)', null], ['有场景上下文', sceneCtx()]] as const)('阴影两个网格程序:%s', (_label, ctx) => {
    const shadow = new PlanarEntityShadow(new Container(), ctx);
    const { castShader, contactShader } = shadow as unknown as Shaders;
    checkShader(castShader, 'cast');
    checkShader(contactShader, 'contact');
    shadow.destroy();
  });

  it('cast 换图集时采样器跟着换', () => {
    const shadow = new PlanarEntityShadow(new Container(), null);
    const atlas = dataTex(48, 40, 'nearest');
    const src: ShadowSource = {
      getFootX: () => 72, getFootY: () => 84, getWorldWidth: () => 24, getWorldHeight: () => 40,
      getTexture: () => atlas, getFacing: () => 1, isVisible: () => true,
    };
    shadow.update(src, ENV);
    const cast = (shadow as unknown as Shaders).castShader;
    expect((cast.resources as Record<string, unknown>).uTexture).toBe(atlas.source);
    checkShader(cast, 'cast(换图集后)');
    shadow.destroy();
  });

  it('深度遮挡滤镜', () => {
    checkShader(DepthOcclusionFilter.createForEntity(dataTex(8, 6, 'nearest'), CFG), '深度遮挡');
  });

  it.each([
    ['无深度(anim_preview)', false],
    ['有深度', true],
  ] as const)('实体光照滤镜:%s', (_label, depth) => {
    const f = EntityLightingFilter.createForEntity({
      depthTexture: depth ? dataTex(8, 6, 'nearest') : null,
      cfg: depth ? CFG : null,
      probeSource: dataTex(4, 3, 'linear').source,
      lightEnv: ENV,
      sampleLiftWorld: 16,
    });
    checkShader(f, '实体光照');
  });
});
