/**
 * 粒子 WGSL 的静默出错点守门(不需要 GPU):WebGPU 下这几条错了**不报错、只是画面不对 / 那一批不画**,
 * 而像素对照(tools/render_parity/cases/90_vfx.ts)要真浏览器才跑得起来。
 *
 * - uniform 组:引擎按 JS 声明顺序、WGSL 对齐规则排缓冲(`UniformGroup.layout`,照 Pixi `createUboElementsWGSL`)⇒ WGSL 结构里每个成员的**字节偏移**
 *   必须与给同名 JS 成员算的偏移相同(光柱的 `uBeamAlong` 在 WGSL 里是同一块内存的 vec4 数组,见 vfxBeamWgsl.ts,
 *   所以这里比偏移与大小,不比类型串);
 * - resources 的每个键都要在 WGSL 里有同名绑定(没有的被塞进第 99 组,WebGPU 下整个 draw 作废);
 * - WGSL 声明的每个自有绑定都要有资源;采样器 = samplerOf(同名纹理);
 * - 光柱结构的成员名 == 打包数值表的键(少一个 = 那一项在 GPU 上恒 0)。
 * 用的是运行时真实的建 shader 路径(VfxRenderer / VfxBeamView / 照明系统的 createCustomLitShader)。
 */
import {
  Container, DOMAdapter, Texture, TextureSource, UniformGroup, WGSL_ALIGN_SIZE_DATA, type Shader,
} from '../../engine2d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CharacterLightingSystem } from '../../core/CharacterLightingSystem';
import type { VfxEmitterRuntime, VfxInstanceSim } from '../../systems/vfx/vfxSim';
import { createSceneLitUniforms } from '../CharacterLitSprite';
import { samplerOf } from '../legacy/gpuSampler';
import { createBeamUniformValues } from './vfxBeamGlsl';
import { BEAM_WGSL_UNIFORMS } from './vfxBeamWgsl';
import { VfxBeamView } from './VfxBeamView';
import { VfxRenderer, type VfxRenderDeps, type VfxSpriteSheet } from './VfxRenderer';

type StructsAndGroups = {
  groups: Array<{ group: number; binding: number; name: string; isUniform: boolean; type: string }>;
};

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

/** WGSL uniform 地址空间的对齐 / 大小(只覆盖本项目用到的类型) */
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

/** WGSL 结构的逐成员偏移与总大小 */
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

/** 运行时给 JS uniform 组算的布局(WebGPU 缓冲就是按它写的;照 Pixi createUboElementsWGSL) */
function pixiLayout(g: UniformGroup): { offsets: Record<string, [number, number]>; size: number } {
  const { elements, size } = g.layout;
  const offsets: Record<string, [number, number]> = {};
  for (const e of elements) offsets[e.name] = [e.offset, e.byteSize];
  return { offsets, size };
}

function expectSameLayout(g: UniformGroup, src: string, struct: string, label: string): void {
  const js = pixiLayout(g);
  const wg = wgslLayout(wgslStructMembers(src, struct));
  expect(Object.keys(wg.offsets), `${label}: ${struct} 成员名 / 顺序与 JS 声明`).toEqual(Object.keys(js.offsets));
  expect(wg.offsets, `${label}: ${struct} 成员偏移 / 大小`).toEqual(js.offsets);
  // Pixi 把缓冲补到 16 的倍数;WGSL 结构按自身对齐收尾,只要不超过缓冲就行
  expect(wg.size, `${label}: ${struct} 总大小`).toBeLessThanOrEqual(js.size);
}

function checkShader(shader: Shader, label: string): void {
  const prog = shader.gpuProgram!;
  expect(prog, `${label}: 没有 gpuProgram`).toBeTruthy();
  const src = prog.fragment!.source;
  const sg = prog.structsAndGroups as StructsAndGroups;
  // 1) 每个资源键都落在 WGSL 声明的绑定上(没有第 99 组)
  expect(Object.keys(shader.resources).filter((k) => !sg.groups.some((g) => g.name === k)), `${label}: 有资源键在 WGSL 里没有同名绑定`).toEqual([]);
  // 2) WGSL 声明的每个自有绑定都有资源(组 0 / 1 由网格管线补)
  const res = shader.resources as Record<string, unknown>;
  for (const g of sg.groups) {
    if (g.group < 2) continue;
    const r = (shader.resources as Record<string, unknown>)[g.name];
    expect(r, `${label}: WGSL 绑定 ${g.name} 没有资源`).toBeTruthy();
    // 3) 采样器 = 与同名纹理采样参数相同的共享采样器(samplerOf,不挂在纹理生命期上)
    if (g.type === 'sampler') {
      const tex = res[g.name.replace(/Sampler$/, '')];
      expect(tex, `${label}: 采样器 ${g.name} 没有同名纹理`).toBeInstanceOf(TextureSource);
      expect(r, `${label}: 采样器 ${g.name} 不是 samplerOf(纹理)`).toBe(samplerOf(tex as TextureSource));
    }
    // 4) uniform 组:WGSL 结构偏移与 Pixi 的 JS 布局逐项相同
    if (g.isUniform) {
      expect(r, `${label}: ${g.name}`).toBeInstanceOf(UniformGroup);
      expectSameLayout(r as UniformGroup, src, g.type, label);
    }
  }
  // 5) 自有绑定全在组 2,且绑定号连续(WebGL 按组号 / 绑定号升序分纹理单元)
  const own = sg.groups.filter((g) => g.group >= 2);
  expect(new Set(own.map((g) => g.group)), `${label}: 自有资源只许在组 2`).toEqual(new Set([2]));
  expect(own.map((g) => g.binding).sort((a, b) => a - b)).toEqual(own.map((_, i) => i));
}

/** 采样器之外的纹理按绑定号排出来的顺序(= WebGL 纹理单元顺序) */
function textureOrder(shader: Shader): string[] {
  const sg = shader.gpuProgram!.structsAndGroups as StructsAndGroups;
  return sg.groups.filter((g) => g.group >= 2 && g.type.startsWith('texture')).sort((a, b) => a.binding - b.binding).map((g) => g.name);
}

describe('粒子 WGSL 与 JS 资源对齐', () => {
  // GlProgram 构造时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  /** 真的照明系统,载荷按 loadScene 同名同形注入(只要 createCustomLitShader 建得出) */
  function lighting(): CharacterLightingSystem {
    const sys = new CharacterLightingSystem();
    const priv = sys as unknown as Record<string, unknown>;
    const t = () => new TextureSource({ width: 2, height: 2 });
    priv.resources = { atlasL1: t(), atlasL2: t(), atlasBin: t(), valid: t(), volRad: t(), volEmit: t(), skyao: { tex: t() } };
    priv.groundTex = t();
    priv.sceneLit = createSceneLitUniforms({
      worldToWorkX: 1, worldToWorkY: 1, cal: { ppu: 1, cx: 0, cy: 0, theta: 0 },
      vol: { nx: 1, ny: 1, nz: 1, tilesX: 1, tilesY: 1, qMin: [0, 0, 0], qMax: [1, 1, 1] },
      mCol: new Float32Array(9), wMin: [0, 0, 0], wScale: [1, 1, 1], pn: [1, 1, 1], probeT: 1, shK: 9, binOb: 8,
      ambSH: new Float32Array(27), lightsQ: new Float32Array(192), lightsE: new Float32Array(192), lightCount: 0,
      groundMin: 0, groundMax: 1, sceneWorldW: 1, sceneWorldH: 1, workW: 1, workH: 1,
    });
    return sys;
  }

  function emitter(id: string, ap: Record<string, unknown>, plate = false): VfxEmitterRuntime {
    return {
      def: { id, appearance: { image: 'x', sizeWu: 4, ...ap } }, p: { cap: 0 },
      plate: plate ? { P: { segments: 2 }, arr: {} } : null,
    } as unknown as VfxEmitterRuntime;
  }

  function views(canLight: boolean, tone: boolean, ems: VfxEmitterRuntime[]): Map<string, { shader: Shader; lit: boolean }> {
    const sys = lighting();
    const deps: VfxRenderDeps = {
      entityLayer: new Container(),
      createLitShader: (programs, colorTex, extra) => (canLight ? sys.createCustomLitShader(programs, colorTex, extra) : null),
      releaseLitShader: (sh) => sys.releaseEntityLitShader(sh),
      canLight: () => canLight,
      displayUniforms: sys.displayUniforms,
      getToneEnv: () => (tone ? { probe: Texture.WHITE.source, strength: 1, key: { color: [1, 1, 1], intensity: 1 }, ambient: { color: [1, 1, 1], intensity: 1 } } : null),
      getDepth: () => ({ tex: Texture.WHITE, cfg: { depth_mapping: { invert: false, scale: 1, offset: 0 }, depth_tolerance: 0.05 } as never }),
      getSceneSize: () => ({ w: 100, h: 100 }),
      perspective: () => 1,
    };
    const r = new VfxRenderer(deps);
    const sheet: VfxSpriteSheet = { texture: Texture.WHITE, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: 1, frameRate: 0 };
    const inst = {
      id: 'inst', emitters: ems, time: 0, effect: { bolts: [] }, beams: [],
      space: {
        kind: 'field', viewDir: [0, -0.7, 0.7], wuPerQ: 1, groundWorldAtScene: () => [0, 0, 0],
        toScene: (w: number[], o: { x: number; y: number }) => { o.x = w[0]; o.y = w[2]; },
        toQ: (w: number[], o: number[]) => { o[0] = w[0]; o[1] = w[1]; o[2] = w[2]; },
      },
    } as unknown as VfxInstanceSim;
    r.render([inst], new Map(ems.map((e) => [`inst/${e.def.id}`, sheet] as const)));
    return (r as unknown as { views: Map<string, { shader: Shader; lit: boolean }> }).views;
  }

  it('受光 billboard / 受光薄片(照明系统 createCustomLitShader 建的)', () => {
    const v = views(true, false, [emitter('b', {}), emitter('p', {}, true)]);
    const b = v.get('inst/b')!, p = v.get('inst/p')!;
    expect(b.lit && p.lit).toBe(true);
    checkShader(b.shader, '受光');
    checkShader(p.shader, '受光薄片');
    // 纹理单元顺序 = 移植前 resources 对象里的相对顺序
    expect(textureOrder(b.shader)).toEqual(
      ['uColorTex', 'uNrm', 'uGround', 'uPL1', 'uPL2', 'uPBin', 'uValid', 'uVolRad', 'uVolEmit', 'uSkyaoTex', 'uDepthMap']);
  });

  it('无光 / tone', () => {
    const v = views(false, true, [emitter('t', {}), emitter('u', { lit: false })]);
    for (const k of ['inst/t', 'inst/u']) {
      checkShader(v.get(k)!.shader, k);
      expect(textureOrder(v.get(k)!.shader)).toEqual(['uColorTex', 'uDepthMap', 'uProbe']);
    }
  });

  it('雷', () => {
    const v = views(false, false, [emitter('bolt', { bolt: { bolt: 'x' }, blend: 'add' })]);
    checkShader(v.get('inst/bolt')!.shader, '雷');
  });

  it('光柱:资源 / 布局;结构成员名 == 打包数值表的键', () => {
    const bv = new VfxBeamView('k', {} as never, null, null, new UniformGroup({ uDispEv: { value: 0, type: 'f32' } }));
    // charLights 用照明系统那组真的(光柱只读显示变换,但绑的是整组)
    (bv.mesh.shader!.resources as Record<string, unknown>).charLights = lighting().displayUniforms;
    checkShader(bv.mesh.shader!, '光柱');
    expect(textureOrder(bv.mesh.shader!)).toEqual(['uDepthMap', 'uBeamCookie']);
    const names = wgslStructMembers(BEAM_WGSL_UNIFORMS, 'VfxBeamUniforms').map(([n]) => n).sort();
    expect(names).toEqual(Object.keys(createBeamUniformValues()).sort());
    bv.destroy();
  });
});
