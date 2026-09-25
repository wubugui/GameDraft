/**
 * 场景光照两级(`SceneLightingPass` 烘焙 / `LitBackground` 显示)的 WGSL 与 JS 资源对齐守门(不需要 GPU)。
 *
 * WebGPU 下这几条错了**不报错、只是画面不对 / 那一 pass 什么都没画**,而像素对照
 * (tools/render_parity/cases/70_scene_lighting.ts)要真浏览器才跑得起来:
 * - resources 的每个键都要在 WGSL 里有同名绑定(没有的被 Pixi 塞进第 99 组,WebGPU 下整个 draw 作废);
 * - WGSL 声明的每个绑定都要有资源;
 * - uniform 组:Pixi 按 JS 声明顺序、WGSL 对齐规则排偏移 ⇒ struct 成员名 / 类型 / 数组长度 / 顺序与 JS 逐项相同;
 * - 第 2 组的绑定号顺序 = resources 对象的键顺序(WebGL 按组号、绑定号升序分配纹理单元,顺序不变 GL 侧才逐字节不变);
 * - 每张 WGSL 里采样的纹理都有 `<名>Sampler`,且它就是 `samplerOf(那张纹理)`(按采样参数共享、永不销毁的那份,
 *   见 legacy/gpuSampler.ts)—— 运行时换纹理(setSurfaceMask / setSway)忘了换采样器,换上的纹理参数不同时
 *   采样器就是错的(本测试换上的纹理故意用 nearest,与初始的 linear 不同)。
 * 用的是 Pixi 自己解析 WGSL 的结果(`gpuProgram.structsAndGroups`),与运行时同一口径;
 * 数组成员 Pixi 的正则抽不全(`array<vec4<f32>, 24>` 只抽到半截),这里自己按源码解析 struct。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BufferImageSource, DOMAdapter, Shader, Texture, UniformGroup, type TextureSource } from 'pixi.js';

import { defaultSceneLighting } from '../../data/sceneLightingDefault';
import { samplerOf } from '../legacy/gpuSampler';
import { LitBackground } from './LitBackground';
import { SceneLightingPass, type SceneLightingGeometry } from './SceneLightingPass';

type StructsAndGroups = {
  groups: Array<{ group: number; binding: number; name: string; isUniform: boolean; type: string }>;
};

/** WGSL 源码里 `struct Name { a: T, b: array<T, N>, }` → [名, 元素类型, 长度] */
function wgslStruct(src: string, name: string): [string, string, number][] {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`WGSL 里找不到 struct ${name}`);
  return m[1].split(/,\s*\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const mm = /^(\w+)\s*:\s*(.+?),?$/.exec(line);
    if (!mm) throw new Error(`解析不了 struct 成员:${line}`);
    const arr = /^array<(.+),\s*(\d+)>$/.exec(mm[2]);
    return arr ? [mm[1], arr[1], Number(arr[2])] : [mm[1], mm[2], 1];
  });
}

function checkShader(shader: Shader, jsResources: Record<string, unknown>, label: string): void {
  const prog = shader.gpuProgram!;
  const sg = prog.structsAndGroups as StructsAndGroups;
  const src = prog.fragment!.source;
  // 1) 每个资源键都落在 WGSL 声明的绑定上(没有第 99 组)
  expect(Object.keys(shader.groups).map(Number).filter((g) => g >= 99), `${label}: 有资源键在 WGSL 里没有同名绑定`).toEqual([]);
  // 2) WGSL 声明的每个自有绑定都有资源(网格的第 0、1 组由 Pixi 补)
  const own = sg.groups.filter((g) => g.group >= 2);
  for (const g of own) {
    expect(shader.groups[g.group]?.resources[g.binding], `${label}: WGSL 绑定 ${g.name} 没有资源`).toBeTruthy();
  }
  // 3) 第 2 组绑定号顺序 = resources 键顺序
  const byBinding = own.filter((g) => g.group === 2).sort((a, b) => a.binding - b.binding).map((g) => g.name);
  expect(byBinding, `${label}: WGSL 第 2 组的绑定顺序与 resources 键顺序不同(WebGL 纹理单元会挪)`).toEqual(Object.keys(jsResources));
  // 4) uniform 组:struct 与 JS 声明逐项同名同类型同长度同顺序
  const resources = shader.resources as Record<string, unknown>;
  for (const g of own.filter((x) => x.isUniform)) {
    const ug = resources[g.name];
    expect(ug, `${label}: ${g.name}`).toBeInstanceOf(UniformGroup);
    const js = Object.entries((ug as UniformGroup).uniformStructures as Record<string, { type: string; size: number }>)
      .map(([k, v]) => [k, v.type, v.size ?? 1]);
    expect(wgslStruct(src, g.type), `${label}: ${g.type} 与 JS uniforms 的声明顺序 / 类型 / 数组长度`).toEqual(js);
  }
  // 5) WGSL 里直接采绑定纹理的地方都配的是 <名>Sampler(共享片段里纹理 / 采样器是形参,不在此列)
  const bound = new Set(own.map((g) => g.name));
  let sampled = 0;
  for (const m of src.matchAll(/textureSample(?:Level)?\((\w+),\s*(\w+),/g)) {
    if (!bound.has(m[1])) continue;
    expect(m[2], `${label}: ${m[1]} 的采样器名`).toBe(`${m[1]}Sampler`);
    sampled++;
  }
  expect(sampled, `${label}: 一处绑定纹理的采样都没抽到(正则失配)`).toBeGreaterThan(0);
}

/** 每个 <名>Sampler 资源都是 samplerOf(<名> 那张纹理)(与它同采样参数的共享采样器) */
function checkSamplersFollowTextures(shader: Shader, label: string): void {
  const r = shader.resources as Record<string, unknown>;
  const sg = shader.gpuProgram!.structsAndGroups as StructsAndGroups;
  let n = 0;
  for (const g of sg.groups) {
    if (!g.name.endsWith('Sampler')) continue;
    const texName = g.name.slice(0, -'Sampler'.length);
    expect(r[g.name], `${label}: ${g.name} 不是 samplerOf(${texName})(换纹理没换采样器 / 直接放了 style)`).toBe(samplerOf(r[texName] as TextureSource));
    n++;
  }
  expect(n).toBeGreaterThan(0);
}

/** 所有 GLSL 采样器都有同名 WGSL 纹理绑定(两边吃同一份 resources) */
function checkGlslSamplersInWgsl(shader: Shader, label: string): void {
  const gl = shader.glProgram!.fragment ?? '';
  const names = [...gl.matchAll(/uniform\s+sampler2D\s+(\w+)\s*;/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(0);
  const wgsl = new Set((shader.gpuProgram!.structsAndGroups as StructsAndGroups).groups.map((g) => g.name));
  for (const n of names) expect(wgsl.has(n), `${label}: GLSL 采样器 ${n} 在 WGSL 里没有同名绑定`).toBe(true);
}

describe('场景光照两级:WGSL 与 JS 资源对齐', () => {
  // GlProgram 构造时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); vi.restoreAllMocks(); });

  const tex = () => Texture.from({ resource: new Uint8Array(16), width: 2, height: 2 } as never);
  /** 换上去的纹理用 nearest:与初始的 linear 采样参数不同,换纹理漏换采样器才抓得到 */
  const texNearest = () => new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(16), width: 2, height: 2, scaleMode: 'nearest' }),
  });
  const geo = (): SceneLightingGeometry => ({
    normal: tex(), albedo: tex(), depth: tex(), depthSize: [2, 2], cal: [1, 1, 1], wuPerQUnit: 100,
    depthMapping: [0, 2, -1], mRows: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  });

  /** 拦下 Shader.from 的参数:resources 对象字面量的键顺序就是 GL 侧原来的纹理单元顺序 */
  function captureResources(make: () => void): Record<string, unknown> {
    const spy = vi.spyOn(Shader, 'from');
    try {
      make();
      expect(spy).toHaveBeenCalledTimes(1);
      return (spy.mock.calls[0][0] as { resources: Record<string, unknown> }).resources;
    } finally {
      spy.mockRestore();
    }
  }

  it('SceneLightingPass(烘焙)', () => {
    let pass!: SceneLightingPass;
    const js = captureResources(() => {
      pass = new SceneLightingPass(tex(), geo());
      pass.applyParams(defaultSceneLighting());
    });
    const shader = (pass as unknown as { shader: Shader }).shader;
    checkShader(shader, js, '烘焙');
    checkGlslSamplersInWgsl(shader, '烘焙');
    checkSamplersFollowTextures(shader, '烘焙 · 初始');
    pass.setSurfaceMask(texNearest());
    checkSamplersFollowTextures(shader, '烘焙 · 换上遮罩');
    pass.setSurfaceMask(null);
    checkSamplersFollowTextures(shader, '烘焙 · 摘掉遮罩');
    pass.destroy();
  });

  it('LitBackground(显示)', () => {
    let bg!: LitBackground;
    const g = geo();
    const js = captureResources(() => { bg = new LitBackground(tex(), g, [0, 1, 0], 4, 4); });
    const shader = (bg as unknown as { shader: Shader }).shader;
    checkShader(shader, js, '显示');
    checkGlslSamplersInWgsl(shader, '显示');
    checkSamplersFollowTextures(shader, '显示 · 初始');
    bg.setSway({ uvMap: texNearest(), radiancePlate: texNearest(), depthPlate: texNearest() });
    checkSamplersFollowTextures(shader, '显示 · 接上草木');
    bg.setSway(null);
    checkSamplersFollowTextures(shader, '显示 · 拆下草木');
    bg.destroy();
  });
});
