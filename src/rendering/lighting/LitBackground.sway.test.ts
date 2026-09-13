import { describe, expect, it, vi } from 'vitest';

// Shader.from 在没有 DOM 的测试环境要 document：换成只记资源表的空壳，Mesh 换成普通容器。
// 这里要验的正是资源表里绑的是哪张图——渲染本身不在测试范围。
vi.mock('pixi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('pixi.js')>();
  return {
    ...real,
    Shader: {
      from: (opts: { resources: Record<string, unknown> }) => {
        const res: Record<string, unknown> = { ...opts.resources };
        const group = res.litBg as Record<string, { value: unknown }>;
        res.litBg = { uniforms: Object.fromEntries(Object.entries(group).map(([k, v]) => [k, v.value])) };
        return { resources: res };
      },
    },
    Mesh: class extends real.Container {},
  };
});

import { Texture } from 'pixi.js';
import { LitBackground } from './LitBackground';
import type { SceneLightingGeometry } from './SceneLightingPass';

/**
 * 打光的背景接上 / 拆下草木摆动。
 *
 * 位移图与"扣掉植物"那份光照缓存都归别人销毁；拆下时要是没把槽位绑回占位，
 * BindGroup 见到已销毁的资源会自毁、下一帧渲染即抛——**整局卡死**（pixi-v8-traps）。
 */
describe('LitBackground.setSway', () => {
  const tex = () => Texture.from({ resource: new Uint8Array(4), width: 1, height: 1 } as never);
  const radiance = tex(), depth = tex();
  const geo = {
    depth, normal: tex(), albedo: tex(), depthSize: [1, 1], cal: [1, 0, 0], wuPerQUnit: 1,
    depthMapping: [0, 1, 0], mRows: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  } as unknown as SceneLightingGeometry;

  const res = (bg: LitBackground) =>
    (bg as unknown as { shader: { resources: Record<string, unknown> & { litBg: { uniforms: { uSwayOn: number } } } } }).shader.resources;

  it('没接草木时开关是 0，三张槽位绑的是占位（位移图空、露出处就是主缓存与主深度）', () => {
    const bg = new LitBackground(radiance, geo, [0, 1, 0], 10, 10);
    const r = res(bg);
    expect(r.litBg.uniforms.uSwayOn).toBe(0);
    expect(r.uUvMap).toBe(Texture.EMPTY.source);
    expect(r.uRadiancePlate).toBe(radiance.source);
    expect(r.uDepthPlate).toBe(depth.source);
  });

  it('接上后读别人的三张图；🔴 拆下时先绑回占位（否则销毁那几张图的下一帧整局卡死）', () => {
    const bg = new LitBackground(radiance, geo, [0, 1, 0], 10, 10);
    const uvMap = tex(), radiancePlate = tex(), depthPlate = tex();
    bg.setSway({ uvMap, radiancePlate, depthPlate });
    const r = res(bg);
    expect(r.litBg.uniforms.uSwayOn).toBe(1);
    expect(r.uUvMap).toBe(uvMap.source);
    expect(r.uRadiancePlate).toBe(radiancePlate.source);
    expect(r.uDepthPlate).toBe(depthPlate.source);

    bg.setSway(null);
    expect(r.litBg.uniforms.uSwayOn).toBe(0);
    expect(r.uUvMap).not.toBe(uvMap.source);
    expect(r.uRadiancePlate).not.toBe(radiancePlate.source);
    expect(r.uDepthPlate).not.toBe(depthPlate.source);
  });
});
