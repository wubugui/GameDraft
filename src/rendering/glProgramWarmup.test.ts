import { DOMAdapter, GlProgram, type Shader } from '../engine2d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GlProgramWarmup, glWarmupTargetOf, type GlWarmupTarget } from './glProgramWarmup';

const COMPLETION = 0x91b1;

/** 记账型 GL 桩：只数调用、按开关报后台编译完没完 */
function fakeGl(opts: { parallel: boolean }) {
  let seq = 0;
  const calls: string[] = [];
  const live = new Set<number>();
  const state = { done: false, lost: false };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3,
    getExtension: (name: string) => (opts.parallel && name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: COMPLETION } : null),
    isContextLost: () => state.lost,
    createShader: () => { const id = ++seq; live.add(id); return { id }; },
    createProgram: () => { const id = ++seq; live.add(id); return { id }; },
    shaderSource: () => { calls.push('shaderSource'); },
    compileShader: () => { calls.push('compileShader'); },
    attachShader: () => {},
    linkProgram: () => { calls.push('linkProgram'); },
    getProgramParameter: (_p: unknown, pname: number) => {
      calls.push(pname === COMPLETION ? 'poll' : 'LINK_STATUS');
      return pname === COMPLETION ? state.done : true;
    },
    deleteProgram: (p: { id: number }) => { live.delete(p.id); },
    deleteShader: (s: { id: number }) => { live.delete(s.id); },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls, live, state };
}

function rig(opts: { parallel: boolean }) {
  const g = fakeGl(opts);
  const bound: GlProgram[] = [];
  const target: GlWarmupTarget = { gl: g.gl, shader: { bind: (sh: Shader, skip?: boolean) => { expect(skip).toBe(true); bound.push(sh.glProgram!); } } };
  let current: GlWarmupTarget | null = target;
  const logs: string[] = [];
  const warm = new GlProgramWarmup(() => current, (m) => logs.push(m));
  return { ...g, bound, warm, logs, setTarget: (t: GlWarmupTarget | null) => { current = t; } };
}

const prog = (tag: string) => new GlProgram({
  vertex: `in vec2 aPosition; void main(void) { gl_Position = vec4(aPosition, 0.0, 1.0); } // ${tag}`,
  fragment: `out vec4 finalColor; void main(void) { finalColor = vec4(1.0); } // ${tag}`,
});

describe('GlProgramWarmup', () => {
  // node 里没有 document：GlProgram 构造时探片元精度要建画布，换个不建 GL 上下文的适配器（同 VfxRenderer.test）
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });
  it('request 只在后台开编（不等链接结果、不交给 Pixi）；编完才交，每个只交一次，GL 对象收干净', async () => {
    const r = rig({ parallel: true });
    const a = prog('a'), b = prog('b');
    r.warm.request([a, b, a]);
    expect(r.calls.filter((c) => c === 'linkProgram')).toHaveLength(2);
    expect(r.calls).not.toContain('LINK_STATUS');
    expect(r.bound).toEqual([]);
    expect(r.warm.pending).toBe(2);

    // 还没编完：限时一到放行，一个都不交
    expect(await r.warm.whenReady(30)).toBe(false);
    expect(r.bound).toEqual([]);
    expect(r.logs.join()).toContain('没编完');

    r.state.done = true;
    expect(await r.warm.whenReady(1000)).toBe(true);
    expect(r.bound).toEqual([a, b]);
    expect(r.warm.pending).toBe(0);
    expect(r.live.size).toBe(0);

    // 再登记同一批 / 再等：不重交
    r.warm.request([a, b]);
    expect(await r.warm.whenReady(10)).toBe(true);
    expect(r.bound).toEqual([a, b]);
  });

  it('没有并行扩展：交接时同步编（在遮罩下），不做后台编译', async () => {
    const r = rig({ parallel: false });
    const a = prog('a');
    r.warm.request([a]);
    expect(r.calls).toEqual([]);
    expect(await r.warm.whenReady(0)).toBe(true);
    expect(r.bound).toEqual([a]);
  });

  it('上下文换了（丢失后重建）：在新上下文上整份重编重交', async () => {
    const r = rig({ parallel: true });
    const a = prog('a');
    r.warm.request([a]);
    r.state.done = true;
    expect(await r.warm.whenReady(100)).toBe(true);
    const g2 = fakeGl({ parallel: true });
    const bound2: GlProgram[] = [];
    r.setTarget({ gl: g2.gl, shader: { bind: (sh: Shader) => { bound2.push(sh.glProgram!); } } });
    expect(await r.warm.whenReady(20)).toBe(false);          // 新上下文上还在编
    expect(g2.calls.filter((c) => c === 'linkProgram')).toHaveLength(1);
    g2.state.done = true;
    expect(await r.warm.whenReady(100)).toBe(true);
    expect(bound2).toEqual([a]);
    expect(g2.live.size).toBe(0);
  });

  it('上下文不可用 / 不是 WebGL 渲染器：不做任何事，不悬挂', async () => {
    const r = rig({ parallel: true });
    r.setTarget(null);
    r.warm.request([prog('a')]);
    expect(await r.warm.whenReady(1000)).toBe(false);
    expect(glWarmupTargetOf({ name: 'webgpu' })).toBeNull();
    expect(glWarmupTargetOf(null)).toBeNull();
    const t = { gl: {}, shader: { bind: () => {} } };
    expect(glWarmupTargetOf(t)).toBe(t);
  });

  it('等待中销毁：立刻放行、删掉后台编译的 GL 对象', async () => {
    const r = rig({ parallel: true });
    r.warm.request([prog('a'), prog('b')]);
    const waiting = r.warm.whenReady(60_000);
    await Promise.resolve();
    r.warm.destroy();
    expect(await waiting).toBe(false);
    expect(r.live.size).toBe(0);
    r.warm.request([prog('c')]);
    expect(await r.warm.whenReady(10)).toBe(false);
  });
});
