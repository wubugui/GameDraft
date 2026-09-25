/**
 * 燃烧着色 WGSL 的静默出错点守门(不需要 GPU):WebGPU 下这几条错了**不报错、只是画面不对**,
 * 而像素对照(tools/render_parity/cases/50_burn.ts)要真浏览器才跑得起来。
 *
 * - uniform 组:Pixi 按 JS 对象的声明顺序、WGSL 对齐规则排偏移 ⇒ WGSL struct 的成员名 / 类型 / 顺序必须与 JS 逐项相同;
 * - resources 的每个键都要在 WGSL 里有同名绑定(没有的被 Pixi 塞进第 99 组,WebGPU 下整个 draw 作废);
 * - WGSL 声明的每个绑定都要有资源(缺了建不出 bind group)。
 * 用的是 Pixi 自己解析 WGSL 的结果(`gpuProgram.structsAndGroups`),与运行时同一口径。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAdapter, RenderTexture, Texture, UniformGroup, type Renderer, type Shader } from 'pixi.js';
import { BurnFieldTexture, BurnGlowFilter, BurnMaterialFilter } from './BurnFilters';
import { BurnRenderer } from './BurnRenderer';
import { burnShadeParamsOf } from './burnShadeParams';

type StructsAndGroups = {
  groups: Array<{ group: number; binding: number; name: string; isUniform: boolean; type: string }>;
  structs: Array<{ name: string; members: Record<string, string> }>;
};

function checkShader(shader: Shader, label: string): void {
  const sg = shader.gpuProgram!.structsAndGroups as StructsAndGroups;
  // 1) 每个资源键都落在 WGSL 声明的绑定上(没有第 99 组)
  expect(Object.keys(shader.groups).map(Number).filter((g) => g >= 99), `${label}: 有资源键在 WGSL 里没有同名绑定`).toEqual([]);
  // 2) WGSL 声明的每个自有绑定都有资源(第 0 组滤镜 / 第 0、1 组网格由 Pixi 补)
  const autoGroups = new Set(shader.gpuProgram!.autoAssignGlobalUniforms ? [0, 1] : [0]);
  for (const g of sg.groups) {
    if (autoGroups.has(g.group)) continue;
    expect(shader.groups[g.group]?.resources[g.binding], `${label}: WGSL 绑定 ${g.name} 没有资源`).toBeTruthy();
  }
  // 3) uniform 组:WGSL struct 与 JS 声明逐项同名同类型同顺序
  const resources = shader.resources as Record<string, unknown>;
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
}

describe('燃烧着色 WGSL 与 JS 资源对齐', () => {
  // GlProgram 构造时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('两道燃烧滤镜', () => {
    const field = new BurnFieldTexture(4, 3);
    checkShader(new BurnMaterialFilter(field), '材质滤镜');
    checkShader(new BurnGlowFilter(field), '自发光滤镜');
  });

  it('图像空间两个 mesh 程序(纹理宿主)', () => {
    const br = new BurnRenderer();
    // 只要它把 mesh / 着色器建出来:渲染器的 render 什么都不做
    br.setPixiRenderer(() => ({ render: () => {} }) as unknown as Renderer);
    let handed: Texture | null = null;
    br.attach('k', {
      kind: 'texture',
      host: { burnBaseTexture: () => Texture.WHITE, setBurnTextures: (a) => { handed = a; } },
    }, 4, 3);
    br.setShade('k', burnShadeParamsOf(
      {
        flameSeconds: 1, emberSeconds: 1,
        look: {
          scorchSeconds: 1, ashFadeSeconds: 1, edgeNoise: 0, scorchColor: [1, 1, 1], charColor: [0, 0, 0],
          ashColor: [0.5, 0.5, 0.5], ashAlpha: 0, glowKelvin: 1800, glowStrength: 1, emberKelvin: 1200, emberStrength: 1,
        },
      } as never,
      { nx: 4, ny: 3 }, { now: 0, timeStep: 1 / 16 },
    ), null);
    br.update(0, { x: 0, y: 0, scale: 1 });
    expect(handed).toBeInstanceOf(RenderTexture);
    const entry = (br as unknown as { entries: Map<string, { materialShader: Shader; glowShader: Shader }> }).entries.get('k')!;
    checkShader(entry.materialShader, '颜色图 mesh');
    checkShader(entry.glowShader, '自发光图 mesh');
    br.clear();
  });
});
