/**
 * 粒子渲染侧的两件事：**曲线采样**与**按水平纵深在实体之间分桶**。
 *
 * 分桶是玩家唯一能直接看见的排序结果（蝙蝠飞到关二狗身前还是身后），而它没有任何
 * 画面之外的痕迹——排错了只是"层级有点怪"。这里直接测渲染器导出的纯函数，不再写镜像。
 */
import { Container, DOMAdapter, Shader, Texture, UniformGroup } from 'pixi.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VfxEmitterRuntime, VfxInstanceSim } from '../../systems/vfx/vfxSim';
import {
  MAX_BUCKETS, VFX_LIGHT_GAIN_MAX, VfxRenderer, bucketOfDepth, bucketSortFootY, buildSortThresholds, horizontalViewAxis,
  sampleCurve, vfxLightGain, vfxParamValues,
  type VfxRenderDeps, type VfxSortAnchor, type VfxSpriteSheet,
} from './VfxRenderer';
import { getVfxLitProgram, getVfxPlateLitProgram, getVfxUnlitProgram } from './vfxShaders';
import VFX_SRC from './vfxShaders.ts?raw';

describe('sampleCurve', () => {
  it('空 / 缺省恒 1', () => {
    expect(sampleCurve(undefined, 0.5)).toBe(1);
    expect(sampleCurve([], 0.5)).toBe(1);
  });
  it('端点钳位，中间线性', () => {
    const c: [number, number][] = [[0, 0], [0.5, 1], [1, 0]];
    expect(sampleCurve(c, -1)).toBe(0);
    expect(sampleCurve(c, 0)).toBe(0);
    expect(sampleCurve(c, 0.25)).toBeCloseTo(0.5, 9);
    expect(sampleCurve(c, 0.5)).toBe(1);
    expect(sampleCurve(c, 0.75)).toBeCloseTo(0.5, 9);
    expect(sampleCurve(c, 2)).toBe(0);
  });
  it('单点 = 常数', () => {
    expect(sampleCurve([[0.3, 0.7]], 0)).toBe(0.7);
    expect(sampleCurve([[0.3, 0.7]], 1)).toBe(0.7);
  });
});

/**
 * 平地（平面近似那条约定：世界 z = −脚点y·k，视线 +z）上的实体：水平纵深 = −footY·k。
 * 在这种地面上新判据必须与旧的"比脚点 y"逐位一致——下面几条就是旧用例原样搬过来。
 */
const K = Math.SQRT2;
function flat(entityFootYs: number[]): { of: (particleFootY: number) => number; footY: (b: number) => number } {
  const th = buildSortThresholds(entityFootYs.map((y): VfxSortAnchor => ({ footY: y, depthKey: -y * K })));
  return { of: (y) => bucketOfDepth(th, -y * K), footY: (b) => bucketSortFootY(th, b) };
}

describe('VfxRenderer · 按水平纵深分桶', () => {
  it('场上只有玩家时：身后进 0 桶（排在他前面之前）、身前进 1 桶', () => {
    const b = flat([600]);
    // 真机实测的两组脚点（崖墓前段，玩家脚点 600）
    expect(b.of(416.2)).toBe(0);
    expect(b.of(783.8)).toBe(1);
    expect(b.footY(0)).toBeCloseTo(599.999, 6);   // 比玩家小 → 排他后面
    expect(b.footY(1)).toBeCloseTo(600.001, 6);   // 比玩家大 → 排他前面
  });

  it('多个实体：粒子落进相邻两实体之间，桶数 = 实体数 + 1', () => {
    const b = flat([200, 450, 600]);
    expect(b.of(100)).toBe(0);
    expect(b.of(300)).toBe(1);
    expect(b.of(500)).toBe(2);
    expect(b.of(900)).toBe(3);
    // 每个桶的锚都严格落在它上界实体之前
    expect(b.footY(1)).toBeLessThan(450);
    expect(b.footY(2)).toBeLessThan(600);
    expect(b.footY(3)).toBeGreaterThan(600);
  });

  it('纵深恰好等于某实体时算它前面（与旧 >= 脚点判据同向）', () => {
    const b = flat([600]);
    expect(b.of(600)).toBe(1);
  });

  it('实体重复脚点去重；实体多于上限时按分位数合并，桶数不超 MAX_BUCKETS', () => {
    const b = flat([100, 100, 100]);
    expect(b.of(50)).toBe(0);
    expect(b.of(150)).toBe(1);
    const many = Array.from({ length: 40 }, (_, i) => i * 10);
    const b2 = flat(many);
    expect(b2.of(1e9)).toBeLessThanOrEqual(MAX_BUCKETS - 1);
  });

  it('场上没有实体时退化成单桶', () => {
    const b = flat([]);
    expect(b.of(123)).toBe(0);
    expect(b.footY(0)).toBe(0);
  });

  it('悬在更低地面上方的粒子：按水平纵深排，不按"正下方地面点"的画面 y', () => {
    // 玩家站在崖边（脚点画面 y 600、水平纵深 −600·k）。一只蝙蝠在他**身后** 100 wu 的空中，
    // 正下方是崖底——那一点投到画面在 900（很靠下）。旧判据拿 900 比 600 → 错排到人前面。
    const th = buildSortThresholds([{ footY: 600, depthKey: -600 * K }]);
    const batDepth = -600 * K + 100;              // 比玩家远 100
    expect(bucketOfDepth(th, batDepth)).toBe(0);  // 排在玩家之前（身后）
    expect(bucketSortFootY(th, 0)).toBeLessThan(600);
  });

  it('水平视线轴：去掉竖直分量再归一；正俯视时退化成 +z', () => {
    const [x, z] = horizontalViewAxis([0, -0.7071, 0.7071]);
    expect(x).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(1, 9);
    const [x2, z2] = horizontalViewAxis([0.6, -0.6, 0.8 * 0.6]);
    expect(Math.hypot(x2, z2)).toBeCloseTo(1, 9);
    expect(horizontalViewAxis([0, -1, 0])).toEqual([0, 1]);
  });
});

/**
 * 受光 shader 的外观参数接线。这两个数没有任何画面之外的痕迹——错了只是"看着不对"。
 *
 * `uEmissive` 尤其要钉：水滴、火星这类电介质的漫反射反照率近乎 0，只靠 `lit` 的
 * 纯漫反射画出来比背景还黑（实测崖墓前段 23/255 vs 背景 68/255）。作者面填的
 * `appearance.emissive` 必须原值送到 uniform，漏接 = 效果整体退回黑疙瘩且不报错。
 */
describe('VfxRenderer · 受光外观参数（vfxParams）', () => {
  it('缺省不自发光；作者值原样送进去', () => {
    expect(vfxParamValues({}).uEmissive).toBe(0);
    expect(vfxParamValues({ emissive: 0.45 }).uEmissive).toBeCloseTo(0.45, 9);
    expect(vfxParamValues({ emissive: 1 }).uEmissive).toBe(1);
  });
  it('越界夹到 0..1（shader 里也夹，但别把脏值送过去）', () => {
    expect(vfxParamValues({ emissive: -3 }).uEmissive).toBe(0);
    expect(vfxParamValues({ emissive: 7 }).uEmissive).toBe(1);
    expect(vfxParamValues({ emissive: Number.NaN }).uEmissive).toBe(0);
  });
  it('加法混合不球化法线，普通混合球化 0.6', () => {
    expect(vfxParamValues({ blend: 'add' }).uSphere).toBe(0);
    expect(vfxParamValues({}).uSphere).toBe(0.6);
    expect(vfxParamValues({ blend: 'normal' }).uSphere).toBe(0.6);
  });
  it('两个参数互不干扰', () => {
    const v = vfxParamValues({ blend: 'add', emissive: 0.3 });
    expect(v).toEqual({ uSphere: 0, uEmissive: 0.3 });
  });
});

/**
 * 受光强度（`appearance.lightGain`）。它乘的是**这个发射器**收到的光——所以必须挂在本视图自己的
 * uniform 组上：写进角色共用组（sceneShade / frameShade / charLights）的话，一个纸钱调亮 = 场上 NPC 全亮，
 * 而且不报任何错。下面用假的照明依赖真跑 `render`，直接看每个视图 shader 上绑的是哪一组、值是多少。
 */
describe('VfxRenderer · 受光强度（lightGain）', () => {
  // node 里没有 document：GlProgram 构造时探一次片元精度要建画布。换个不建 GL 上下文的适配器（探不到就按 mediump）
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('缺省 1；作者值原样；夹到 0..10；NaN 当缺省；lit:false 恒 1', () => {
    expect(vfxLightGain({})).toBe(1);
    expect(vfxLightGain({ lightGain: 2.5 })).toBe(2.5);
    expect(vfxLightGain({ lightGain: 0 })).toBe(0);
    expect(vfxLightGain({ lightGain: -1 })).toBe(0);
    expect(vfxLightGain({ lightGain: 99 })).toBe(VFX_LIGHT_GAIN_MAX);
    expect(VFX_LIGHT_GAIN_MAX).toBe(10);
    expect(vfxLightGain({ lightGain: Number.NaN })).toBe(1);
    expect(vfxLightGain({ lit: false, lightGain: 5 })).toBe(1);
    expect(vfxLightGain({ lit: true, lightGain: 5 })).toBe(5);
  });

  it('受光强度不进 vfxParamValues（自发光份额与它互不相干）', () => {
    expect(vfxParamValues({ emissive: 0.3, lightGain: 4 } as never)).toEqual({ uSphere: 0.6, uEmissive: 0.3 });
  });

  type Ap = { lit?: boolean; lightGain?: number; emissive?: number; blend?: 'normal' | 'add' };
  const sheet: VfxSpriteSheet = { texture: Texture.WHITE, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: 1, frameRate: 0 };
  const emitter = (id: string, ap: Ap): VfxEmitterRuntime =>
    ({ def: { id, appearance: { image: 'x', sizeWu: 4, ...ap } }, p: { cap: 0 } }) as unknown as VfxEmitterRuntime;
  const instance = (emitters: VfxEmitterRuntime[]): VfxInstanceSim =>
    ({ id: 'inst', emitters, time: 0, space: { kind: 'field', viewDir: [0, -0.7, 0.7], wuPerQ: 1, groundWorldAtScene: () => [0, 0, 0] } }) as unknown as VfxInstanceSim;
  const sheetsFor = (ems: VfxEmitterRuntime[]) => new Map(ems.map((e) => [`inst/${e.def.id}`, sheet] as const));

  function rig(opts: { canLight: boolean; tone?: boolean; factors?: { indirectFactor: number; directFactor: number; totalFactor: number } }) {
    // 角色共用的那几组（渲染器只许读它们、不许往里写受光强度）
    const shared = {
      sceneShade: new UniformGroup({ uGiStrength: { value: 1, type: 'f32' } }),
      frameShade: new UniformGroup({ uMode: { value: 1, type: 'f32' } }),
      charLights: new UniformGroup({ uDispEv: { value: 0, type: 'f32' } }),
    };
    const extras: Record<string, unknown>[] = [];
    const deps: VfxRenderDeps = {
      entityLayer: new Container(),
      createLitShader: (program, colorTex, extra) => {
        if (!opts.canLight) return null;
        extras.push(extra);
        return new Shader({ glProgram: program, resources: { ...shared, uColorTex: colorTex, ...extra } });
      },
      releaseLitShader: (sh) => sh.destroy(),
      canLight: () => opts.canLight,
      getLightFactors: () => opts.factors ?? { indirectFactor: 1, directFactor: 1, totalFactor: 1 },
      displayUniforms: shared.charLights,
      getToneEnv: () => (opts.tone
        ? { probe: Texture.WHITE.source, strength: 1, key: { color: [1, 1, 1], intensity: 1 }, ambient: { color: [1, 1, 1], intensity: 1 } }
        : null),
      getDepth: () => null,
      getSceneSize: () => ({ w: 100, h: 100 }),
      perspective: () => 1,
    };
    const r = new VfxRenderer(deps);
    const views = () => (r as unknown as { views: Map<string, { shader: Shader; lit: boolean; paramGroup: UniformGroup }> }).views;
    const gainOf = (id: string) => {
      const v = views().get(`inst/${id}`)!;
      const res = v.shader.resources as Record<string, UniformGroup>;
      const g = res[v.lit ? 'vfxParams' : 'vfxToneOn'];
      expect(g).toBe(v.paramGroup);
      return (g.uniforms as Record<string, number>)['uLightGain'];
    };
    return { r, shared, extras, views, gainOf };
  }

  it('场景三项因子原地更新，效果自己的强度独立相乘，不重撒粒子或串入角色组', () => {
    const factors = { indirectFactor: 2, directFactor: 0, totalFactor: 3 };
    const t = rig({ canLight: true, factors });
    const ems = [emitter('纸', { lightGain: 0.4 })];
    const inst = instance(ems);
    t.r.render([inst], sheetsFor(ems));
    const view = t.views().get('inst/纸')!;
    const u = view.paramGroup.uniforms as Record<string, number>;
    expect([u.uVfxIndirectFactor, u.uVfxDirectFactor, u.uVfxTotalFactor, u.uLightGain]).toEqual([2, 0, 3, 0.4]);
    factors.indirectFactor = 0;
    factors.directFactor = 1;
    factors.totalFactor = 0;
    t.r.render([inst], sheetsFor(ems));
    expect(t.views().get('inst/纸')).toBe(view);
    expect([u.uVfxIndirectFactor, u.uVfxDirectFactor, u.uVfxTotalFactor, u.uLightGain]).toEqual([0, 1, 0, 0.4]);
    for (const group of Object.values(t.shared)) expect('uVfxDirectFactor' in group.uniforms).toBe(false);
    t.r.clear();
  });

  it('lit 路：每个发射器一组 vfxParams，各带各的受光强度；自发光份额不受它影响；共用组里没有 uLightGain', () => {
    const t = rig({ canLight: true });
    const ems = [emitter('亮', { lightGain: 3.5, emissive: 0.45 }), emitter('缺省', { emissive: 0.45 })];
    t.r.render([instance(ems)], sheetsFor(ems));
    expect(t.views().size).toBe(2);
    expect(t.views().get('inst/亮')!.lit).toBe(true);
    expect(t.gainOf('亮')).toBe(3.5);
    expect(t.gainOf('缺省')).toBe(1);
    const g0 = t.views().get('inst/亮')!.paramGroup, g1 = t.views().get('inst/缺省')!.paramGroup;
    expect(g0).not.toBe(g1);
    for (const g of [g0, g1]) expect((g.uniforms as Record<string, number>)['uEmissive']).toBeCloseTo(0.45, 9);
    for (const x of t.extras) expect(x['vfxParams']).toBeInstanceOf(UniformGroup);
    for (const g of Object.values(t.shared)) expect('uLightGain' in g.uniforms).toBe(false);
    t.r.clear();
  });

  it('tone 路（要受光、没有照明载荷）吃受光强度；unlit（lit:false）恒 1', () => {
    for (const tone of [true, false]) {
      const t = rig({ canLight: false, tone });
      const ems = [emitter('要光', { lightGain: 2 }), emitter('自发光', { lit: false, lightGain: 7 })];
      t.r.render([instance(ems)], sheetsFor(ems));
      expect(t.views().get('inst/要光')!.lit).toBe(false);
      expect(t.gainOf('要光')).toBe(2);
      expect(t.gainOf('自发光')).toBe(1);
      expect(t.views().get('inst/要光')!.paramGroup).not.toBe(t.views().get('inst/自发光')!.paramGroup);
      for (const g of Object.values(t.shared)) expect('uLightGain' in g.uniforms).toBe(false);
      t.r.clear();
    }
  });

  it('改了跟得上：工作台推来新定义（换发射器）重建视图；同一个发射器原地改也逐帧写进去', () => {
    const t = rig({ canLight: true });
    const e1 = emitter('纸', { lightGain: 1.5 });
    t.r.render([instance([e1])], sheetsFor([e1]));
    expect(t.gainOf('纸')).toBe(1.5);
    const sh1 = t.views().get('inst/纸')!.shader;
    const e2 = emitter('纸', { lightGain: 6 });
    t.r.render([instance([e2])], sheetsFor([e2]));
    const sh2 = t.views().get('inst/纸')!.shader;
    expect(sh2).not.toBe(sh1);
    expect(t.gainOf('纸')).toBe(6);
    (e2.def.appearance as Ap).lightGain = 0.25;
    t.r.render([instance([e2])], sheetsFor([e2]));
    expect(t.views().get('inst/纸')!.shader).toBe(sh2);         // 原地改：不重建，只改本视图那一格
    expect(t.gainOf('纸')).toBe(0.25);
    delete (e2.def.appearance as Ap).lightGain;
    t.r.render([instance([e2])], sheetsFor([e2]));
    expect(t.gainOf('纸')).toBe(1);
    t.r.clear();
  });
});

/**
 * 着色器源码里受光强度落在哪一行。乘错位置画面只是"亮度怪"，不报错：
 * 乘在自发光混合之后 = 自发光份额也被放大；乘在灯循环之前 = 实体灯不吃它。
 */
describe('vfxShaders · 受光强度的位置', () => {
  it('lit：E 收齐（probe + 实体灯）之后、着色之前乘；自发光混合那行不带它', () => {
    const iLights = VFX_SRC.indexOf('vec3 directE = entitySceneLightsE(q, n);');
    const iShade = VFX_SRC.indexOf('vec3 litLin = shadeEntityLinear(');
    expect(iLights).toBeGreaterThan(0);
    expect(iShade).toBeGreaterThan(iLights);
    expect(VFX_SRC).toContain('uVfxIndirectFactor, uVfxDirectFactor, uVfxTotalFactor * uLightGain');
    const emissiveLine = VFX_SRC.split('\n').find((l) => l.includes('mix(litLin, srgb2lin(alb)'))!;
    expect(emissiveLine).toBeTruthy();
    expect(emissiveLine).not.toContain('uLightGain');
  });
  it('tone：乘在色调融入的光照因子上、同一个钳位', () => {
    expect(VFX_SRC).toContain('rgb = min(rgb * mix(vec3(1.0), wb, tone) * uLightGain, vec3(1.0));');
    expect(VFX_SRC).toContain('} else if (uLightGain != 1.0) {');
  });
  it('两个程序都声明了 uLightGain（没声明 = Pixi 按名跳过、静默不生效）', () => {
    expect(getVfxLitProgram().fragment).toContain('uniform float uLightGain;');
    expect(getVfxPlateLitProgram().fragment).toContain('uniform float uLightGain;');
    expect(getVfxUnlitProgram().fragment).toContain('uniform float uLightGain;');
  });
});
