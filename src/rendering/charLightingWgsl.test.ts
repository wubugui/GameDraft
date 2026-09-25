/**
 * 角色受光两个程序(CharacterLitSprite 的 sprite 网格程序、CharacterShadingFilter)的 WGSL 静默出错点守门
 * (不需要 GPU)。WebGPU 下这几条错了**不报错、只是画面不对**,而像素对照
 * (tools/render_parity/cases/80_char_lighting.ts)要真浏览器才跑得起来:
 *
 * - uniform 组:Pixi 按 JS 对象的声明顺序、WGSL 对齐规则排偏移 ⇒ WGSL struct 的成员名 / 类型 / 数组长度 / 顺序
 *   必须与 JS 逐项相同(sceneShade / frameShade / charLights / entityShade / shadeUniforms 各一份);
 * - resources 的每个键都要在 WGSL 里有同名绑定(没有的被 Pixi 塞进第 99 组,WebGPU 下整个 draw 作废);
 * - WGSL 声明的每个绑定都要有资源;
 * - 「纹理名 + Sampler」就是该纹理自己的 style,**换纹理时跟着换**:纹理销毁会连带销毁它的 style,
 *   BindGroup 见到任何一个资源销毁就整个作废(WebGL 下也一样 —— 有了 WGSL 程序,采样器与纹理同住一组)。
 * 绑定与组号用 Pixi 自己解析 WGSL 的结果(`gpuProgram.structsAndGroups`);struct 成员自己解析
 * (Pixi 的成员正则切不开 `array<vec3<f32>, 9>`)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { samplerOf } from './legacy/gpuSampler';
import { BufferImageSource, DOMAdapter, Texture, TextureSource, UniformGroup, type Shader } from '../engine2d';
import {
  createCharLightUniforms, createFrameLitUniforms, createLitShader, createSceneLitUniforms,
  LIT_SHADER_SCENE_TEXTURE_SLOTS, setLitShaderTexture, type LitSceneStatics,
} from './CharacterLitSprite';
import { CharacterShadingFilter, type CharShadingSceneResources } from './CharacterShadingFilter';
import type { SceneDepthConfig } from '../data/types';

type StructsAndGroups = {
  groups: Array<{ group: number; binding: number; name: string; isUniform: boolean; type: string }>;
};

/** WGSL 源里某个 struct 的成员,规范成「名: 类型」/「名: 类型[长度]」(与 JS 侧同一写法) */
function wgslStructMembers(src: string, name: string): string[] {
  const body = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src)?.[1];
  expect(body, `找不到 struct ${name}`).toBeTruthy();
  return [...body!.matchAll(/(\w+)\s*:\s*(array<([\w<>]+),\s*(\d+)>|[\w<>]+)\s*,/g)]
    .map((m) => (m[3] ? `${m[1]}: ${m[3]}[${m[4]}]` : `${m[1]}: ${m[2]}`));
}

function jsMembers(ug: UniformGroup): string[] {
  return Object.entries(ug.uniformStructures as Record<string, { type: string; size?: number }>)
    .map(([k, v]) => ((v.size ?? 1) > 1 ? `${k}: ${v.type}[${v.size}]` : `${k}: ${v.type}`));
}

function checkShader(shader: Shader, label: string): void {
  const prog = shader.gpuProgram!;
  const sg = prog.structsAndGroups as StructsAndGroups;
  const src = prog.fragment!.source;
  // 1) 每个资源键都落在 WGSL 声明的绑定上(没有第 99 组)
  expect(Object.keys(shader.resources).filter((k) => !sg.groups.some((g) => g.name === k)), `${label}: 有资源键在 WGSL 里没有同名绑定`).toEqual([]);
  // 2) WGSL 声明的每个自有绑定都有资源(第 0 组滤镜 / 第 0、1 组网格由 Pixi 补)
  const autoGroups = new Set(prog.autoAssignGlobalUniforms ? [0, 1] : [0]);
  for (const g of sg.groups) {
    if (autoGroups.has(g.group)) continue;
    expect((shader.resources as Record<string, unknown>)[g.name], `${label}: WGSL 绑定 ${g.name} 没有资源`).toBeTruthy();
  }
  const resources = shader.resources as Record<string, unknown>;
  // 3) uniform 组:WGSL struct 与 JS 声明逐项同名同类型同长度同顺序
  const uniformGroups = sg.groups.filter((x) => x.isUniform && !autoGroups.has(x.group));
  expect(uniformGroups.length, `${label}: 一个自有 uniform 组都没解析出来`).toBeGreaterThan(0);
  for (const g of uniformGroups) {
    const ug = resources[g.name];
    expect(ug, `${label}: ${g.name}`).toBeInstanceOf(UniformGroup);
    expect(wgslStructMembers(src, g.type), `${label}: ${g.type} 与 JS uniforms 的声明顺序 / 类型`).toEqual(jsMembers(ug as UniformGroup));
  }
  // 4) 声明了采样器的纹理:采样器 = 该纹理自己的 style
  const names = new Set(sg.groups.map((x) => x.name));
  for (const g of sg.groups.filter((x) => x.type.startsWith('texture_2d') && !autoGroups.has(x.group))) {
    const tex = resources[g.name];
    expect(tex, `${label}: ${g.name}`).toBeInstanceOf(TextureSource);
    if (names.has(`${g.name}Sampler`)) {
      expect(resources[`${g.name}Sampler`], `${label}: ${g.name}Sampler 不是 ${g.name} 对应的共享采样器(samplerOf)`).toBe(samplerOf(tex as TextureSource));
    }
  }
}

function src(w: number, h: number, format: 'rgba8unorm' | 'rgba16float' | 'r8unorm' = 'rgba8unorm',
  scaleMode: 'nearest' | 'linear' = 'nearest'): TextureSource {
  const ch = format === 'r8unorm' ? 1 : 4;
  const resource = format === 'rgba16float' ? new Uint16Array(w * h * ch) : new Uint8Array(w * h * ch);
  return new BufferImageSource({ resource, width: w, height: h, format, scaleMode });
}

const STATICS: LitSceneStatics = {
  worldToWorkX: 0.5, worldToWorkY: 0.5,
  cal: { ppu: 100, cx: 100, cy: 75, theta: Math.PI / 4 },
  vol: { nx: 4, ny: 3, nz: 2, tilesX: 2, tilesY: 1, qMin: [-1, -1, -1], qMax: [1, 1, 1] },
  mCol: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, -1]),
  wMin: [-1, -1, -1], wScale: [1, 1, 1], pn: [3, 3, 3], probeT: 4, shK: 9, binOb: 8,
  ambSH: new Float32Array(27), lightsQ: new Float32Array(192), lightsE: new Float32Array(192), lightCount: 0,
  groundMin: -1, groundMax: 1, sceneWorldW: 400, sceneWorldH: 300, workW: 200, workH: 150,
  skyao: { tex: src(4, 4, 'rgba16float'), n: [2, 2, 2], tiles: [2, 1], wMin: [0, 0, 0], wScale: [1, 1, 1], mCol: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
};

function sceneResources(): CharShadingSceneResources {
  return {
    atlasL1: src(4, 1, 'rgba16float'), atlasL2: src(9, 1, 'rgba16float'), atlasBin: src(64, 1, 'rgba16float'),
    valid: src(4, 1, 'r8unorm'), volRad: src(8, 3, 'rgba16float'), volEmit: src(8, 3, 'rgba16float'),
    workW: 200, workH: 150, worldToWorkX: 0.5, worldToWorkY: 0.5,
    cal: STATICS.cal, vol: STATICS.vol, mCol: STATICS.mCol, wMin: STATICS.wMin, wScale: STATICS.wScale, pn: STATICS.pn,
    probeT: 4, shK: 9, binOb: 8, ambSH: STATICS.ambSH, lightsQ: STATICS.lightsQ, lightsE: STATICS.lightsE, lightCount: 0,
    skyao: STATICS.skyao,
  };
}

const DEPTH_CFG: SceneDepthConfig = {
  depth_map: 'raw_depth_rg.png', collision_map: 'collision.png',
  M: { R: [[1, 0, 0], [0, Math.SQRT1_2, -Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]], ppu: 100, cx: 100, cy: 75 },
  depth_mapping: { invert: false, scale: 2, offset: -1 },
  shader: { depth_per_sy: 0.01 },
  depth_tolerance: 0.05, floor_offset: 0,
};

describe('角色受光 WGSL 与 JS 资源对齐', () => {
  // GlProgram 构造时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  function litShader(nrm: TextureSource | null): Shader {
    return createLitShader(createSceneLitUniforms(STATICS), createFrameLitUniforms(), createCharLightUniforms(), {
      colorTex: src(48, 40, 'rgba8unorm', 'linear'), nrm, ground: src(50, 40),
      atlasL1: src(4, 1, 'rgba16float'), atlasL2: src(9, 1, 'rgba16float'), atlasBin: src(64, 1, 'rgba16float'),
      valid: src(4, 1, 'r8unorm'), volRad: src(8, 3, 'rgba16float'), volEmit: src(8, 3, 'rgba16float'),
      skyao: STATICS.skyao!.tex,
    });
  }

  it('sprite 网格程序(有 / 无法线图集)', () => {
    checkShader(litShader(src(48, 40)), 'lit 网格(有法线)');
    checkShader(litShader(null), 'lit 网格(无法线)');
  });

  it('sprite 网格程序:换纹理 / 卸载退白图时采样器跟着换', () => {
    const sh = litShader(src(48, 40));
    const res = sh.resources as Record<string, unknown>;
    const g2 = src(20, 10);
    setLitShaderTexture(sh, 'uGround', g2);
    expect(res['uGroundSampler']).toBe(samplerOf(g2));
    const c2 = src(48, 40, 'rgba8unorm', 'linear');
    setLitShaderTexture(sh, 'uColorTex', c2);
    expect(res['uColorTexSampler']).toBe(samplerOf(c2));
    // 与 CharacterLightingSystem.parkLitShaders 同一条循环
    for (const k of LIT_SHADER_SCENE_TEXTURE_SLOTS) setLitShaderTexture(sh, k, null);
    expect(res['uGroundSampler']).toBe(samplerOf(Texture.WHITE.source));
    expect(res['uNrmSampler']).toBe(samplerOf(Texture.WHITE.source));
    expect((res['entityShade'] as UniformGroup).uniforms['uHasNrm']).toBe(0);
    checkShader(sh, 'lit 网格(退白图后)');
    // 没声明采样器的槽位(textureLoad 那几张)不许凭空挂上一个键
    expect('uPL1Sampler' in res).toBe(false);
  });

  it('烘焙着色滤镜(有 / 无深度)+ 换法线图集时采样器跟着换', () => {
    checkShader(CharacterShadingFilter.createForEntity({ depthTexture: null, cfg: null, scene: sceneResources() }), '滤镜(无深度)');
    const f = CharacterShadingFilter.createForEntity({
      depthTexture: new Texture({ source: src(40, 30, 'rgba8unorm', 'linear') }), cfg: DEPTH_CFG, scene: { ...sceneResources(), skyao: null },
    });
    checkShader(f, '滤镜(有深度、无 skyao)');
    const n2 = src(48, 40);
    f.setNormalTexture(n2);
    const res = f.resources as Record<string, unknown>;
    expect(res['uNrmSampler']).toBe(samplerOf(n2));
    f.setNormalTexture(null);
    expect(res['uNrmSampler']).toBe(samplerOf(Texture.WHITE.source));
    checkShader(f, '滤镜(换回白图后)');
  });
});
