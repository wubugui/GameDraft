// 前景层装配：覆盖图网格、接地采样、远→近次序、拆除顺序；遮挡使用方（三支滤镜 + 粒子）的接法。
// 前景层不再往实体层里挂任何东西——遮挡全在使用方的判据里逐像素做（被挡 = 与深度遮挡同一个虚影系数）。
// 拆除顺序：覆盖图 RT 销毁**之前**必须先广播 null（滤镜 / 粒子绑回占位），反了是整局卡死（pixi-v8-traps）。
import { Container, DOMAdapter, Shader, Texture, UniformGroup } from 'pixi.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SceneDepthSystem } from '../../core/SceneDepthSystem';
import type { SceneDepthConfig } from '../../data/types';
import { DepthOcclusionFilter } from '../DepthOcclusionFilter';
import { EntityLightingFilter } from '../EntityLightingFilter';
import { resolveLightEnv } from '../lightEnv';
import { VfxRenderer, type VfxRenderDeps } from '../vfx/VfxRenderer';
import type { ForegroundBaseSamples, ForegroundDepthModel, ResolvedForegroundLayer } from './foregroundLayerDefs';
import {
  FG_COVERAGE_DILATE_PX, FG_COVERAGE_DOWNSCALE, SceneForegroundLayers, type ForegroundMask, type ForegroundMaskHost,
} from './SceneForegroundLayers';
import MASK_SRC from './foregroundMaskGlsl.ts?raw';
import DEPTH_SRC from '../DepthOcclusionFilter.ts?raw';
import LIGHT_SRC from '../EntityLightingFilter.ts?raw';
import CHAR_SRC from '../CharacterShadingFilter.ts?raw';
import VFX_SRC from '../vfx/vfxShaders.ts?raw';

class FakeMask implements ForegroundMask {
  readonly mesh = new Container();
  destroyed = false;
  constructor(
    public rect: readonly number[], readonly inst: number, public base: ForegroundBaseSamples, public upright: number,
    readonly target: { w: number; h: number }, readonly dilate: number, private readonly log: string[],
  ) {}
  setRect(rect: readonly [number, number, number, number]): void { this.rect = rect; }
  setBase(base: ForegroundBaseSamples, upright: number): void { this.base = base; this.upright = upright; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.log.push(`destroy mask ${this.inst}`);
    this.mesh.destroy();
  }
}

const flatGround: ForegroundDepthModel = { uprightPerY: 0.00222, groundAt: (_x, y) => 1 - 0.00126 * y };

function rig(layers: ResolvedForegroundLayer[], opts: { noMask?: boolean; model?: ForegroundDepthModel | null } = {}) {
  const log: string[] = [];
  const disp = { v: 30 };
  const masks: FakeMask[] = [];
  const maskHost: ForegroundMaskHost = {
    createForegroundMask: (rect, inst, target, dilate, base, upright) => {
      if (opts.noMask) return null;
      const m = new FakeMask(rect, inst, base, upright, target, dilate, log);
      masks.push(m);
      return m;
    },
  };
  const coverage: Array<Texture | null> = [];
  const logs: string[] = [];
  const fg = new SceneForegroundLayers({
    layers, maskHost, paintSize: [2048, 1152], sceneSize: [2048, 1152],
    displacementOf: () => disp.v,
    depthModel: opts.model === undefined ? flatGround : opts.model,
    onCoverage: (t) => { coverage.push(t); log.push(`coverage ${t ? 'on' : 'null'}`); },
    log: (m) => logs.push(m),
  });
  return { fg, log, masks, coverage, disp, logs };
}

const layer = (id: string, instId: number, baseY: number, extra: Partial<ResolvedForegroundLayer> = {}): ResolvedForegroundLayer => ({
  id, label: id, instId, baseX: 1227.2, baseY, baseLine: null,
  rect: [0, 0, 1, 1], bbox: [1214, 364, 1457, 583], ...extra,
});
const TREE = layer('fg_tree', 1, 577);

describe('SceneForegroundLayers · 覆盖图网格与接地', () => {
  it('不往实体层里挂任何东西；覆盖图网格按 1/4 原画、膨胀 4 px、接地采样与深度梯度交给背景对象', () => {
    const { fg, masks } = rig([TREE]);
    expect(fg.layerCount).toBe(1);
    expect(masks[0].target).toEqual({ w: 2048 / FG_COVERAGE_DOWNSCALE, h: 1152 / FG_COVERAGE_DOWNSCALE });
    expect(masks[0].dilate).toBe(FG_COVERAGE_DILATE_PX);
    expect(FG_COVERAGE_DILATE_PX).toBeGreaterThanOrEqual(FG_COVERAGE_DOWNSCALE);
    expect(masks[0].upright).toBe(0.00222);
    expect(masks[0].base.data[0]).toBe(577);                              // 接地 y
    expect(masks[0].base.data[1]).toBeCloseTo(1 - 0.00126 * 577, 6);       // 接地深度 = 行走面在树根
    // 位移 30 → 档 32，外扩 32 + 8
    expect(masks[0].rect).toEqual([1214 - 40, 364 - 40, 1457 + 40, 583 + 40]);
    fg.destroy();
  });

  it('多层按远→近挂进覆盖图（预乘 over：近的盖远的；深度越大越远）', () => {
    const near = layer('near', 2, 900), far = layer('far', 3, 300), mid = layer('mid', 1, 577);
    const { fg, masks } = rig([near, far, mid]);
    const root = (fg as unknown as { maskRoot: Container }).maskRoot;
    const order = root.children.map((c) => masks.find((m) => m.mesh === c)!.inst);
    expect(order).toEqual([3, 1, 2]);
    fg.destroy();
  });

  it('没有行走面场 / 接地点取不到深度：那层（或整个前景层）不建，并出声', () => {
    const a = rig([TREE], { model: null });
    expect(a.fg.layerCount).toBe(0);
    expect(a.logs.length).toBe(1);
    const b = rig([TREE], { model: { uprightPerY: 0.002, groundAt: () => null } });
    expect(b.fg.layerCount).toBe(0);
    expect(b.masks.length).toBe(0);
    expect(b.logs.length).toBe(1);
  });

  it('行走面换了（地形推送 / 载荷落地）：接地深度重取、交给网格，次序按新深度重排', () => {
    const { fg, masks } = rig([layer('a', 1, 300), layer('b', 2, 900)]);
    fg.refreshBase({ uprightPerY: 0.003, groundAt: (_x, y) => 0.5 + 0.001 * y });   // 反过来：y 大的更远
    expect(masks[0].upright).toBe(0.003);
    expect(masks[1].base.data[1]).toBeCloseTo(0.5 + 0.001 * 900, 6);
    const root = (fg as unknown as { maskRoot: Container }).maskRoot;
    expect(root.children.map((c) => masks.find((m) => m.mesh === c)!.inst)).toEqual([2, 1]);
    fg.destroy();
  });

  it('网格范围跟这株的真实位移走：变档才改，不变档不动；风停缩回 bbox + 余量', () => {
    const { fg, masks, disp } = rig([TREE]);
    const before = masks[0].rect;
    disp.v = 31.9;
    fg.updateDisplacement();
    expect(masks[0].rect).toBe(before);
    disp.v = 57;
    fg.updateDisplacement();
    expect(masks[0].rect).toEqual([1214 - 72, 364 - 72, 1457 + 72, 583 + 72]);
    disp.v = 0;
    fg.updateDisplacement();
    expect(masks[0].rect).toEqual([1206, 356, 1465, 591]);
    fg.destroy();
    expect(() => fg.updateDisplacement()).not.toThrow();
  });
});

describe('SceneForegroundLayers · 覆盖图生命周期与拆除', () => {
  it('第一次渲出来之前不交给使用方；渲过才交', () => {
    const { fg, coverage } = rig([TREE]);
    expect(coverage).toEqual([]);
    expect(fg.coverageTexture).toBeNull();
    fg.renderCoverage({ render: () => {} } as never);
    expect(coverage.length).toBe(1);
    expect(fg.coverageTexture).not.toBeNull();
    fg.destroy();
  });

  it('关掉（F2）= 覆盖图收回；打开要等下一次渲完再交出去', () => {
    const { fg, coverage } = rig([TREE]);
    fg.renderCoverage({ render: () => {} } as never);
    fg.setEnabled(false);
    expect(coverage[coverage.length - 1]).toBeNull();
    expect(fg.coverageTexture).toBeNull();
    fg.setEnabled(true);
    expect(coverage.length).toBe(2);
    fg.renderCoverage({ render: () => {} } as never);
    expect(coverage.length).toBe(3);
    fg.destroy();
  });

  it('拆除：先广播 null，再销毁覆盖图网格，最后才是 RT；幂等', () => {
    const { fg, log } = rig([TREE]);
    fg.renderCoverage({ render: () => {} } as never);
    const rt = (fg as unknown as { coverage: { destroyed: boolean } }).coverage;
    fg.destroy();
    expect(log).toEqual(['coverage on', 'coverage null', 'destroy mask 1']);
    expect(rt.destroyed).toBe(true);
    fg.destroy();
    expect(log.length).toBe(3);
  });

  it('背景对象先把网格销毁了（拆摆动的兜底）：前景层再拆不重复销毁、不抛', () => {
    const { fg, masks, log } = rig([TREE]);
    masks[0].destroy();
    expect(() => fg.destroy()).not.toThrow();
    expect(log.filter((l) => l.startsWith('destroy')).length).toBe(1);
  });

  it('覆盖图网格没建起来：那层不算建成、不开 RT', () => {
    const { fg } = rig([TREE], { noMask: true });
    expect(fg.layerCount).toBe(0);
    expect((fg as unknown as { coverage: unknown }).coverage).toBeNull();
    fg.destroy();
  });
});

describe('覆盖图着色：通道与前景面深度', () => {
  it('B = 前景面（按纹素足迹取样，细枝不漏）、R = A = 外沿、G = R × 前景面深度（预乘）', () => {
    expect(MASK_SRC).toContain('fragColor = vec4(rim, rim * fgSurfaceDepth(vUv * uSceneSize), body, rim);');
    expect(MASK_SRC).toContain('return b.y + uUpright * (p.y - b.x);');            // 与 foregroundSurfaceDepth 同一个式子
    expect(MASK_SRC).toContain('body = max(body, fgMaskAt(vUv + h));');
  });

  it('使用方取样：外沿不判、前景面按 G / R 解出深度', () => {
    expect(MASK_SRC).toContain('outDepth = s.g / max(s.r, 1e-4);');
    expect(MASK_SRC).toContain('if (s.r <= 0.5) { return 0.0; }');
  });
});

const CFG = {
  depth_map: 'raw_depth_rg.png',
  depth_mapping: { invert: false, scale: 1, offset: 0 },
  shader: { depth_per_sy: 0.001 },
  floor_offset: 0, depth_tolerance: 0.02,
  M: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ppu: 100, cx: 0, cy: 0 },
} as unknown as SceneDepthConfig;

const fgUniform = (f: object): number => {
  const res = (f as { resources: Record<string, { uniforms?: Record<string, unknown> }> }).resources;
  for (const k of ['depthUniforms', 'lightUniforms', 'shadeUniforms']) {
    const u = res[k]?.uniforms;
    if (u && 'uHasFgCoverage' in u) return u['uHasFgCoverage'] as number;
  }
  throw new Error('没有 uHasFgCoverage');
};
const fgTex = (f: object): unknown => (f as { resources: Record<string, unknown> }).resources['uFgCoverage'];

describe('遮挡使用方 · 覆盖图', () => {
  // GlProgram 构造时要探一次片元精度（建 canvas）：node 里给个空壳，与 VfxRenderer.test 同一个做法
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('三支滤镜与粒子拼的是同一段取样；滤镜在前景面里比「前景面深度 < 脚点深度 + 直立面」，外沿不判，其余照旧', () => {
    for (const src of [DEPTH_SRC, LIGHT_SRC, CHAR_SRC, VFX_SRC]) {
      expect(src).toContain('${FG_OCCLUSION_GLSL}');
      expect(src).toContain('fgSample(');
    }
    for (const [src, foot] of [[DEPTH_SRC, 'uFootDepthQ'], [LIGHT_SRC, 'uFootDepthQ'], [CHAR_SRC, 'uFootQ.z']] as const) {
      expect(src).toContain('float fgKind = fgSample(depthUV, fgDepth);');
      expect(src).toContain('occluded = fgKind > 1.5 ? false');
      expect(src).toContain(`: fgKind > 0.5 ? fgDepth < ${foot} + upright - 1e-4`);
      expect(src).toContain(': sceneDepth + uTolerance < spriteDepth;');
      expect(src).toContain('uFgCoverage: Texture.EMPTY.source');
    }
    // 粒子：前景面里拿前景面深度顶替深度图（容差照旧），外沿不判
    expect(VFX_SRC).toContain('if (fgKind > 1.5) return 1.0;');
    expect(VFX_SRC).toContain('float sceneDepth = fgDepth;');
  });

  it('没有前景层时开关恒 0、绑永不销毁的占位（逐像素与改动前相同）；交来 / 收回即换绑', () => {
    const d = DepthOcclusionFilter.createForEntity(Texture.WHITE, CFG);
    const l = EntityLightingFilter.createForEntity({
      depthTexture: Texture.WHITE, cfg: CFG, probeSource: null, lightEnv: resolveLightEnv(undefined, undefined), sampleLiftWorld: 0,
    });
    for (const f of [d, l]) {
      expect(fgUniform(f)).toBe(0);
      expect(fgTex(f)).toBe(Texture.EMPTY.source);
      f.setForegroundCoverage(Texture.WHITE.source);
      expect(fgUniform(f)).toBe(1);
      expect(fgTex(f)).toBe(Texture.WHITE.source);
      f.setForegroundCoverage(null);
      expect(fgUniform(f)).toBe(0);
      expect(fgTex(f)).toBe(Texture.EMPTY.source);
    }
  });

  it('SceneDepthSystem 广播：现有滤镜立刻换绑、之后新建的在创建时绑上、unload 解绑', () => {
    const sys = new SceneDepthSystem();
    sys.enableLighting(null, resolveLightEnv(undefined, undefined), 2048, 1152, 1, 1);
    const a = sys.createLightingFilterForEntity(10)!;
    expect(fgUniform(a)).toBe(0);
    const cov = Texture.WHITE;
    sys.setForegroundCoverage(cov);
    expect(sys.hasForegroundCoverage).toBe(true);
    expect(fgUniform(a)).toBe(1);
    const b = sys.createLightingFilterForEntity(10)!;
    expect(fgUniform(b)).toBe(1);
    expect(fgTex(b)).toBe(cov.source);
    sys.unload();
    expect(sys.hasForegroundCoverage).toBe(false);
    for (const f of [a, b]) {
      expect(fgUniform(f)).toBe(0);
      expect(fgTex(f)).toBe(Texture.EMPTY.source);
    }
  });

  it('没有深度 / 没有行走面场时不给前景面深度模型（前景层不建）', () => {
    const sys = new SceneDepthSystem();
    expect(sys.foregroundDepthModel()).toBeNull();
  });

  it('粒子渲染器：交来覆盖图当场换绑所有视图（不等下一次 render），收回绑占位；新建视图按当前那张建', () => {
    const shared = {
      sceneShade: new UniformGroup({ uGiStrength: { value: 1, type: 'f32' } }),
      frameShade: new UniformGroup({ uMode: { value: 1, type: 'f32' } }),
      charLights: new UniformGroup({ uDispEv: { value: 0, type: 'f32' } }),
    };
    const deps = {
      entityLayer: new Container(),
      createLitShader: () => null, releaseLitShader: (sh: Shader) => sh.destroy(), canLight: () => false,
      getLightFactors: () => ({ indirectFactor: 1, directFactor: 1, totalFactor: 1 }),
      displayUniforms: shared.charLights,
      getToneEnv: () => null, getDepth: () => null, getSceneSize: () => ({ w: 100, h: 100 }), perspective: () => 1,
    } as unknown as VfxRenderDeps;
    const r = new VfxRenderer(deps);
    const sheet = { texture: Texture.WHITE, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: 1, frameRate: 0 };
    const e = { def: { id: '纸', appearance: { image: 'x', sizeWu: 4, lit: false } }, p: { cap: 0 } };
    const inst = { id: 'inst', emitters: [e], time: 0, space: { kind: 'field', viewDir: [0, -0.7, 0.7], wuPerQ: 1, groundWorldAtScene: () => [0, 0, 0] } };
    r.render([inst] as never, new Map([['inst/纸', sheet]]) as never);
    const view = () => (r as unknown as { views: Map<string, { shader: Shader; depthGroup: UniformGroup }> }).views.get('inst/纸')!;
    expect((view().shader.resources as Record<string, unknown>).uFgCoverage).toBe(Texture.EMPTY.source);
    r.setForegroundCoverage(Texture.WHITE.source);
    expect((view().shader.resources as Record<string, unknown>).uFgCoverage).toBe(Texture.WHITE.source);
    expect((view().depthGroup.uniforms as Record<string, number>).uHasFgCoverage).toBe(1);
    r.render([inst] as never, new Map([['inst/纸', sheet]]) as never);
    expect((view().depthGroup.uniforms as Record<string, number>).uHasFgCoverage).toBe(1);
    r.setForegroundCoverage(null);
    expect((view().shader.resources as Record<string, unknown>).uFgCoverage).toBe(Texture.EMPTY.source);
    expect((view().depthGroup.uniforms as Record<string, number>).uHasFgCoverage).toBe(0);
    r.clear();
  });
});
