/**
 * 光照体实验室环境 FX(`lightvolFx.ts` + `lightvolFx.wgsl`)的无 GPU 单测:统一数据的排布 + 空后端(`NullRhiDevice`)上的命令流。
 *
 * - 统一数据:19 个 vec4 的每一格落在 WGSL `struct U` 的对应位置;缺地面直线(新管线数据)= NaN,与迁移前 uniform1f(undefined) 同;
 * - 装场景:四张渲染目标(雾 ×2 清成速度中性 (0.5, 0.5, 0, 1)、脚印 / 湿度清成黑),五条管线的目标格式 / 混合
 *   (脚印 = 加性、画积水 = 加性、擦积水 = 反向减,与 GL 的 blendFunc(ONE, ONE) + blendEquation 同);
 * - 每一步:雾模拟读 fog[cur] 写 fog[cur ^ 1] 并换;脚印 / 积水各写各的图;合成画到画布;**任何 pass 都不把自己正在写的图绑来采样**;
 * - 着色器只有一份 WGSL、不是 GLSL。
 * 真 GPU 的像素断言在光照体实验室的自检里(Chrome)。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiRenderPipelineDesc } from '../../src/rendering/rhi';
import { traceRhi } from './rhiTrace';
import { BLEND_ERASE, LIGHTVOL_FX_WGSL, LV_UNIFORM_FLOATS, LightVolFx, packUniforms, type LvCalib, type LvCompParams, type LvSimParams } from './lightvolFx';

const CAL: LvCalib = {
  W: 1500, H: 837.3, wtpX: 1376 / 1500, wtpY: 752 / 837.3, ppu: 512, cx: 688, cy: 376, invert: 1,
  scale: 2.5, offset: 0.4, floorA: -8e-4, floorB: -0.79,
  right: [0, 0, 1], up: [0.8, 0.6, 0], vd: [0.6, -0.8, 0],
};
const COMP: LvCompParams = {
  enHFog: 1, enVFog: 1, enGod: 0, enPud: 1, enSnow: 0, enFoot: 1, time: 1.25, dbg: 0,
  fogCol: [0.6, 0.65, 0.69], fogD: 0.8, fogH: 4, snowCol: [0.91, 0.93, 0.95], skyCol: [0.16, 0.17, 0.16], godInt: 1,
  lightW: [0.26, 0.64, 0.72], shadowDist: 7, shadowSteps: 72.4,
  pudAmt: 0.6, pudRefl: 0.7, snowAmt: 0.7, snowUp: 0.3, ripple: 0.04, ssrDist: 1.5, reflMinH: 0.35, ssrSteps: 219.6,
  charShow: [0.5, 0.18],
};
const SIM: LvSimParams = { time: 2.5, dt: 0.016, flow: 1.2, dissip: 0.985, src: 1.4, carveR: 0.1, vort: 0.8, charUv: [0.4, 0.3], charVel: [0.07, -0.02] };

function img(w: number, h: number, seed: number) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * 31 + seed * 7) & 255;
  return { width: w, height: h, data: d };
}

async function setup() {
  const dev = new NullRhiDevice({ swapchainSize: [900, 492] });
  const pipes: RhiRenderPipelineDesc[] = [];
  const orig = dev.createRenderPipeline.bind(dev);
  dev.createRenderPipeline = (scope, desc) => {
    pipes.push(desc);
    return orig(scope, desc);
  };
  const shaders: string[] = [];
  const origS = dev.createShader.bind(dev);
  dev.createShader = (scope, desc) => {
    shaders.push(desc.wgsl);
    return origS(scope, desc);
  };
  const trace = traceRhi(dev);
  const fx = new LightVolFx(dev, null);
  await fx.setScene({ bg: img(900, 492, 1), depth: img(900, 492, 2), simSize: [220, 120] });
  return { dev, trace, fx, pipes, shaders };
}

/** 每个 pass:目标里的纹理编号 + 绑定里的纹理编号 */
function passes(lines: string[]) {
  const out: { target: string; bound: string[]; line: string; bind: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('pass')) continue;
    const target = lines[i];
    let bind = '';
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('end'); j++) if (lines[j].trim().startsWith('bind ')) bind = lines[j];
    out.push({ target: (/\[(T\d+)/.exec(target) ?? [])[1] ?? 'canvas', bound: [...bind.matchAll(/=(T\d+)\(/g)].map((m) => m[1]), line: target, bind });
  }
  return out;
}

describe('packUniforms', () => {
  it('19 个 vec4 与 WGSL struct U 同序;地面直线缺 = NaN', () => {
    const f = packUniforms(CAL, COMP, SIM, [0.012, 0.5, 0.3, 0.7]);
    expect(f.length).toBe(LV_UNIFORM_FLOATS);
    expect([...f.slice(0, 4)]).toEqual([1500, Math.fround(837.3), Math.fround(1376 / 1500), Math.fround(752 / 837.3)]);
    expect([...f.slice(4, 12)].map((v) => +v.toFixed(4))).toEqual([512, 688, 376, 1, 2.5, 0.4, -0.0008, -0.79]);
    expect([...f.slice(12, 24)]).toEqual([0, 0, 1, 0, Math.fround(0.8), Math.fround(0.6), 0, 0, Math.fround(0.6), Math.fround(-0.8), 0, 0]);
    expect([...f.slice(24, 32)]).toEqual([1, 1, 0, 1, 0, 1, 2.5, 0]);          // 开关 + time(SIM 的 time 盖同一格)+ dbg
    expect(f[35]).toBeCloseTo(0.8); expect(f[39]).toBe(4); expect(f[43]).toBe(1); expect(f[47]).toBe(7);
    expect(f[55]).toBe(220);                                                 // 倒影行数取整(迁移前 uniform1i(Math.round))
    expect([...f.slice(56, 59)].map((v) => +v.toFixed(3))).toEqual([0.5, 0.18, 72]);
    expect([...f.slice(60, 72)].map((v) => +v.toFixed(3))).toEqual([0.016, 1.2, 0.985, 1.4, 0.1, 0.8, 0.4, 0.3, 0.07, -0.02, 0.012, 0.5]);
    expect([...f.slice(72, 74)].map((v) => +v.toFixed(3))).toEqual([0.3, 0.7]);
    const bare = packUniforms({ ...CAL, floorA: undefined, floorB: undefined });
    expect(Number.isNaN(bare[10]) && Number.isNaN(bare[11])).toBe(true);
    expect([...bare.slice(24)].every((v) => v === 0)).toBe(true);
  });
});

describe('LightVolFx · 空后端命令流', () => {
  it('装场景:四张 rgba8 渲染目标清好;五条管线的目标格式 / 混合对', async () => {
    const { trace, pipes, fx } = await setup();
    expect(fx.ready).toBe(true);
    const clears = passes(trace.lines);
    expect(clears.map((p) => /rt\((\d+x\d+) /.exec(p.line)?.[1])).toEqual(['220x120', '220x120', '900x492', '900x492']);
    expect(clears[0].line).toContain('"clearValue":[0.5,0.5,0,1]');
    expect(clears[1].line).toContain('"clearValue":[0.5,0.5,0,1]');
    expect(clears[2].line).toContain('"clearValue":[0,0,0,1]');
    expect(clears.every((p) => p.line.includes('rgba8unorm'))).toBe(true);
    const byFs = Object.fromEntries(pipes.map((p) => [p.label.replace('光照体 FX · ', ''), p]));
    expect(Object.keys(byFs).sort()).toEqual(['合成', '擦积水', '画积水', '脚印', '雾模拟'].sort());
    expect(byFs['合成'].blend ?? null).toBeNull();
    expect(byFs['雾模拟'].blend ?? null).toBeNull();
    expect(byFs['雾模拟'].colorFormats).toEqual(['rgba8unorm']);
    expect(byFs['脚印'].blend).toEqual({ color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } });
    expect(byFs['画积水'].blend).toEqual(byFs['脚印'].blend);
    expect(byFs['擦积水'].blend).toBe(BLEND_ERASE);
    expect(BLEND_ERASE.color.operation).toBe('reverse-subtract');
    expect(BLEND_ERASE.alpha.operation).toBe('reverse-subtract');
  });

  it('雾模拟乒乓、脚印 / 积水各写各的图、合成画画布;没有哪个 pass 把自己正在写的图绑来采样', async () => {
    const { trace, fx } = await setup();
    trace.clear();
    expect(fx.simStep(SIM, CAL)).toBe(true);
    expect(fx.cur).toBe(1);
    expect(fx.simStep(SIM, CAL)).toBe(true);
    expect(fx.cur).toBe(0);
    expect(fx.stamp([0.4, 0.3], 0.012)).toBe(true);
    expect(fx.paint([0.5, 0.2], 0.04, 0.5, false)).toBe(true);
    expect(fx.paint([0.5, 0.2], 0.04, 0.5, true)).toBe(true);
    expect(fx.composite(COMP, CAL)).toBe(true);
    const ps = passes(trace.lines);
    expect(ps).toHaveLength(6);
    for (const p of ps) {
      expect(p.bound).not.toContain(p.target);
      expect(p.line).toContain(p.target === 'canvas' ? '"load":"clear"' : '"load":"load"');   // 离屏的都在原内容上画(乒乓 / 累加)
      expect(p.bind).toMatch(/u=buf:/);
    }
    const uPrev = (b: string) => (/uPrev=(T\d+)/.exec(b) ?? [])[1];
    // 第一步读 fog0 写 fog1,第二步读 fog1 写 fog0
    expect(uPrev(ps[0].bind)).toBe(ps[1].target);
    expect(uPrev(ps[1].bind)).toBe(ps[0].target);
    expect([ps[0].target, ps[1].target, ps[3].target]).not.toContain(ps[2].target);   // 脚印图不是雾 / 湿度
    expect(ps[3].target).toBe(ps[4].target);                     // 画 / 擦 同一张湿度图
    expect(ps[5].line).toMatch(/^pass canvas\(900x492\)/);
    // 合成绑的雾 = 当前的雾(两步之后回到 fog0)、脚印 / 湿度 = 刚写的那两张
    expect((/uFog=(T\d+)/.exec(ps[5].bind) ?? [])[1]).toBe(ps[1].target);
    expect((/uFoot=(T\d+)/.exec(ps[5].bind) ?? [])[1]).toBe(ps[2].target);
    expect((/uWet=(T\d+)/.exec(ps[5].bind) ?? [])[1]).toBe(ps[3].target);
    expect(trace.lines.filter((l) => /^\s+draw/.test(l)).map((l) => l.trim())).toEqual(Array(6).fill('draw 3'));
  });

  it('同样输入记出同一串;参数差一点就不同', async () => {
    const run = async (comp: LvCompParams, cal: LvCalib) => {
      const { trace, fx } = await setup();
      fx.simStep(SIM, cal);
      fx.composite(comp, cal);
      return trace.lines.join('\n');
    };
    const base = await run(COMP, CAL);
    expect(await run(COMP, CAL)).toBe(base);
    expect(await run({ ...COMP, fogD: 0.81 }, CAL)).not.toBe(base);
    expect(await run(COMP, { ...CAL, floorA: -8.1e-4 })).not.toBe(base);
  });

  it('着色器只有一份:每条管线都从同一份 WGSL 建,不是 GLSL', async () => {
    const { shaders } = await setup();
    expect(new Set(shaders)).toEqual(new Set([LIGHTVOL_FX_WGSL]));
    expect(LIGHTVOL_FX_WGSL).not.toMatch(/#version|gl_Position|gl_FragColor|precision\s+highp|uniform\s+sampler2D/);
    for (const fs of ['fsComp', 'fsSim', 'fsStamp', 'fsPaint']) expect(LIGHTVOL_FX_WGSL).toContain(`@fragment fn ${fs}(`);
  });
});
