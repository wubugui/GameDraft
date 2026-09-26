import { describe, expect, it, vi } from 'vitest';

// Shader.from 在无 DOM 的测试环境要 document：换成只记资源表的空壳，Mesh 换成带 geometry 的普通容器。
// 这里要验的是覆盖图网格绑了哪几张图、接地参数怎么进去、谁先销毁——渲染本身不在测试范围。
vi.mock('pixi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('pixi.js')>();
  return {
    ...real,
    Shader: {
      from: (opts: { gl: { fragment: string }; resources: Record<string, unknown> }) => ({
        frag: opts.gl.fragment,
        resources: Object.fromEntries(Object.entries(opts.resources).map(([k, v]) => [k,
          v && typeof v === 'object' && !('source' in v) && !('uid' in v) && !('_resourceType' in v)
            ? { uniforms: Object.fromEntries(Object.entries(v as Record<string, { value: unknown }>).map(([n, u]) => [n, u.value])) }
            : v])),
        destroy() { (this as { destroyed?: boolean }).destroyed = true; },
      }),
    },
    Mesh: class extends real.Container {
      geometry: { destroy: (b?: boolean) => void };
      shader: unknown;
      constructor(o: { geometry: { destroy: (b?: boolean) => void }; shader: unknown } = { geometry: { destroy() {} }, shader: null }) {
        super();
        this.geometry = o.geometry;
        this.shader = o.shader;
      }
    },
  };
});

import { Texture } from 'pixi.js';
import { SwayBackground, type BackgroundSwayInput } from './backgroundSway';
import { FG_BASE_SAMPLES, type ForegroundBaseSamples } from './foreground/foregroundLayerDefs';
import { resolveSceneWind } from '../utils/sceneWind';

const tex = () => Texture.from({ resource: new Uint8Array(4), width: 1, height: 1 } as never);

function build(composite: boolean) {
  const plateTex = tex(), matteTex = tex(), idsTex = tex(), painting = tex();
  const inp = {
    urls: [], plateTex, matteTex, idsTex,
    meta: { version: 3, margin: 48, instances: [{ id: 1, kind: 'plant', root: [100, 180], height: 200, persp: 1, reach: 150, bbox: [60, 40, 200, 185] }] },
    sceneSize: [400, 200], paintSize: [800, 400],
    jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
    sceneToWorldXZ: null, scaleAt: null, ids: null, matte: null, rigid: null, litPlate: null,
  } as unknown as BackgroundSwayInput;
  const sb = new SwayBackground(painting, inp, { composite });
  return { sb, plateTex, matteTex, idsTex, painting };
}

const base = (y: number, d: number): ForegroundBaseSamples => {
  const data = new Float32Array(FG_BASE_SAMPLES * 2);
  for (let i = 0; i < FG_BASE_SAMPLES; i++) { data[i * 2] = y; data[i * 2 + 1] = d; }
  return { x0: 0, x1: 400, data, meanDepth: d };
};

type Res = Record<string, unknown>;
const res = (s: { mesh: unknown }) => (s.mesh as { shader: { resources: Res } }).shader.resources;
const uni = (s: { mesh: unknown }) => (res(s).fgMaskU as { uniforms: Record<string, Float32Array | number> }).uniforms;

describe('SwayBackground · 前景层', () => {
  it('foregroundSource：两套尺寸按原样交出（不假设相等），位移 = 此刻的软封顶 0.8 × 补带（场景 wu）× clamp(增益, 1, 4)', () => {
    const { sb } = build(true);
    const src = sb.foregroundSource;
    expect(src.paintSize).toEqual([800, 400]);
    expect(src.sceneSize).toEqual([400, 200]);
    expect(src.instances.map((d) => d.id)).toEqual([1]);
    // 补带 48 原画像素 = 24 场景 wu（原画是场景的 2 倍）；还没吹过风 = 增益 1 那一档
    expect(src.maxDisplacement).toBeCloseTo(0.8 * 24, 9);
    sb.update(resolveSceneWind({ direction: [-1, 0, 0], speed: 400, gain: { sway: 2.5 } })!, 1 / 60);
    expect(sb.displacementCap).toBeCloseTo(0.8 * 24 * 2.5, 9);
    sb.update(resolveSceneWind({ direction: [-1, 0, 0], speed: 400, gain: { sway: 9 } })!, 2 / 60);
    expect(sb.displacementCap).toBeCloseTo(0.8 * 24 * 4, 9);   // 上限 4 倍
  });

  it('instanceDisplacement = 这株网格顶点此刻的最大位移（前景层按它铺范围；不认识的株 0）', () => {
    const { sb } = build(true);
    expect(sb.instanceDisplacement(1)).toBe(0);
    expect(sb.instanceDisplacement(99)).toBe(0);
    sb.update(resolveSceneWind({ direction: [-1, 0, 0], speed: 900, gain: { sway: 3 } })!, 1 / 60);
    const S = sb as unknown as { byId: Map<number, { v0: number; v1: number }>; pos: Float32Array; p0: Float32Array };
    const rt = S.byId.get(1)!;
    let m = 0;
    for (let v = rt.v0; v < rt.v1; v++) m = Math.max(m, Math.hypot(S.pos[v * 2] - S.p0[v * 2], S.pos[v * 2 + 1] - S.p0[v * 2 + 1]));
    expect(m).toBeGreaterThan(0);
    expect(sb.instanceDisplacement(1)).toBeCloseTo(m, 9);
    expect(sb.foregroundSource.displacementOf!(1)).toBeCloseTo(m, 9);
  });

  it('覆盖图网格：读位移图 + id / matte；膨胀与纹素足迹按原画像素换成 uv；接地采样与深度梯度进参数组', () => {
    const { sb, matteTex, idsTex } = build(false);
    const m = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 200, h: 100 }, 4, base(180, -0.2), 0.002)!;
    const r = res(m);
    expect(r.uUvMap).toBe(sb.uvMap.source);
    expect(r.uIds).toBe(idsTex.source);
    expect(r.uMatte).toBe(matteTex.source);
    const u = uni(m);
    expect([...(u.uTargetSize as Float32Array)]).toEqual([200, 100]);
    expect([...(u.uSceneSize as Float32Array)]).toEqual([400, 200]);
    expect([...(u.uDilate as Float32Array)].map((v) => +v.toFixed(6))).toEqual([4 / 800, 4 / 400]);
    expect([...(u.uTexelHalf as Float32Array)].map((v) => +v.toFixed(6))).toEqual([1.5 / 800, 1.5 / 400]);
    expect(u.uFgInst).toBe(1);
    expect(u.uUpright).toBe(0.002);
    expect([...(u.uBaseX as Float32Array)]).toEqual([0, 400]);
    expect((u.uBase as Float32Array).length).toBe(FG_BASE_SAMPLES * 2);
    expect((u.uBase as Float32Array)[1]).toBeCloseTo(-0.2, 6);
    // 行走面换了：原地换参数，不重建
    m.setBase({ ...base(170, 0.1), x0: 5, x1: 395 }, 0.003);
    expect(u.uUpright).toBe(0.003);
    expect([...(u.uBaseX as Float32Array)]).toEqual([5, 395]);
    expect((u.uBase as Float32Array)[0]).toBe(170);
  });

  it('网格可以原地改范围（四个顶点 + 场景归一化 uv）', () => {
    const { sb } = build(true);
    const m = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 1, h: 1 }, 4, base(0, 0), 0)!;
    m.setRect([0, 0, 200, 100]);
    const g = (m.mesh as unknown as { geometry: { positions: Float32Array; uvs: Float32Array } }).geometry;
    expect([...g.positions]).toEqual([0, 0, 200, 0, 200, 100, 0, 100]);
    expect([...g.uvs]).toEqual([0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]);
  });

  it('🔴 销毁：先销毁覆盖图网格，最后才销毁位移图（BindGroup 见死即自毁）', () => {
    const { sb } = build(true);
    const a = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 1, h: 1 }, 4, base(0, 0), 0)!;
    const b = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 1, h: 1 }, 4, base(0, 0), 0)!;
    let uvDestroyedFirst = false;
    const uvDestroy = sb.uvMap.destroy.bind(sb.uvMap);
    sb.uvMap.destroy = ((x?: boolean) => { uvDestroyedFirst = !a.destroyed || !b.destroyed; uvDestroy(x); }) as never;
    expect(sb.foregroundMaskCount).toBe(2);
    sb.destroy();
    expect(a.destroyed && b.destroyed).toBe(true);
    expect(uvDestroyedFirst).toBe(false);
    expect(sb.foregroundMaskCount).toBe(0);
    expect(sb.createForegroundMask([0, 0, 1, 1], 1, { w: 1, h: 1 }, 4, base(0, 0), 0)).toBeNull();
  });

  it('前景层自己先拆：从登记里摘掉，背景再销毁不重复', () => {
    const { sb } = build(true);
    const m = sb.createForegroundMask([10, 20, 30, 40], 1, { w: 1, h: 1 }, 4, base(0, 0), 0)!;
    m.destroy();
    expect(sb.foregroundMaskCount).toBe(0);
    expect(() => sb.destroy()).not.toThrow();
  });
});
