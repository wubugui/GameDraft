import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../backends/null/NullRhiDevice';
import type { RhiFrame, RhiTexture } from '../RhiDevice';
import { RhiBufferUsage, RhiError, RhiTextureUsage } from '../types';
import { RenderGraph } from './RenderGraph';
import { RgTransientPool } from './RgTransientPool';

function setup() {
  const dev = new NullRhiDevice();
  const pool = new RgTransientPool(dev.rootScope);
  const graph = (label = '帧') => new RenderGraph({ label, pool });
  return { dev, pool, graph };
}

const HDR = { width: 64, height: 32, format: 'rgba16float' as const };

/** 录一帧并要求成功提交;回调里的断言失败会被 runFrame 截住,这里把首个诊断重新抛出来 */
function run(dev: NullRhiDevice, record: (f: RhiFrame) => void): void {
  const errors: RhiError[] = [];
  const off = dev.onDiagnostic((e) => errors.push(e));
  let thrown: unknown;
  const ok = dev.runFrame((f) => {
    try {
      record(f);
    } catch (e) {
      thrown = e;
      throw e;
    }
  });
  off();
  if (thrown) throw thrown;
  if (errors.length) throw errors[0];
  expect(ok).toBe(true);
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof RhiError ? e.code : 'not-rhi-error';
  }
  return undefined;
}

describe('RenderGraph · 剔除与依赖', () => {
  it('结果没人要的 pass 被剔除;写导入目标的 pass 及其上游保留', () => {
    const { dev, graph } = setup();
    const ran: string[] = [];
    run(dev, (f) => {
      const g = graph();
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      const scene = g.createTexture('场景', HDR);
      const unused = g.createTexture('没人读', HDR);
      g.addRenderPass('场景', { colors: [{ texture: scene }], execute: () => ran.push('场景') });
      g.addRenderPass('孤儿', { colors: [{ texture: unused }], execute: () => ran.push('孤儿') });
      g.addRenderPass('合成', { target: { renderTarget: back }, reads: [scene], execute: () => ran.push('合成') });
      const c = g.compile();
      expect(c.passes.map((p) => [p.name, p.culled])).toEqual([['场景', false], ['孤儿', true], ['合成', false]]);
      g.execute(f.commands);
    });
    expect(ran).toEqual(['场景', '合成']);
    // 被剔除 pass 独占的资源根本不分配
    expect(dev.log.some((l) => l.includes('没人读'))).toBe(false);
  });

  it('sideEffect 的 pass 不剔除', () => {
    const { dev, graph } = setup();
    const ran: string[] = [];
    run(dev, (f) => {
      const g = graph();
      const t = g.createTexture('调试', HDR);
      g.addRenderPass('调试画', { colors: [{ texture: t }], sideEffect: true, execute: () => ran.push('调试画') });
      g.execute(f.commands);
    });
    expect(ran).toEqual(['调试画']);
  });

  it('读了此前没人写过的图内资源:编译报错', () => {
    const { dev, graph } = setup();
    const g = graph();
    run(dev, (f) => {
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      const t = g.createTexture('空', HDR);
      g.addRenderPass('合成', { target: { renderTarget: back }, reads: [t], execute: () => {} });
      expect(codeOf(() => g.compile())).toBe('invalid-usage');
    });
  });

  it('load 一张图内纹理 = 读:同样要求此前有人写', () => {
    const { graph } = setup();
    const g = graph();
    const t = g.createTexture('累积', HDR);
    g.addRenderPass('叠加', { colors: [{ texture: t, load: 'load' }], sideEffect: true, execute: () => {} });
    expect(() => g.compile()).toThrow(/没有任何 pass 写过/);
  });

  it('同一资源多次写:后面的 load 依赖前一个写者;中间的 clear 写者切断依赖', () => {
    const { dev, graph } = setup();
    const ran: string[] = [];
    run(dev, (f) => {
      const g = graph();
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      const t = g.createTexture('累积', HDR);
      g.addRenderPass('A 清', { colors: [{ texture: t }], execute: () => ran.push('A') });
      g.addRenderPass('B 叠', { colors: [{ texture: t, load: 'load' }], execute: () => ran.push('B') });
      g.addRenderPass('C 重清', { colors: [{ texture: t }], execute: () => ran.push('C') });
      g.addRenderPass('合成', { target: { renderTarget: back }, reads: [t], execute: () => ran.push('合成') });
      g.execute(f.commands);
    });
    // C 清屏覆盖了 A、B 的结果,A、B 没人要
    expect(ran).toEqual(['C', '合成']);
  });
});

describe('RenderGraph · 声明纪律', () => {
  it('pass 回调里取没声明的资源:报错', () => {
    const { dev, graph } = setup();
    const errors: RhiError[] = [];
    dev.onDiagnostic((e) => errors.push(e));
    dev.runFrame((f) => {
      const g = graph();
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      const a = g.createTexture('a', HDR);
      const b = g.createTexture('b', HDR);
      g.addRenderPass('写a', { colors: [{ texture: a }], execute: () => {} });
      g.addRenderPass('写b', { colors: [{ texture: b }], execute: () => {} });
      g.addRenderPass('合成', {
        target: { renderTarget: back },
        reads: [a],
        execute: (_p, ctx) => {
          ctx.texture(b);
        },
      });
      g.execute(f.commands);
    });
    expect(errors[0]?.message).toContain('没声明就用了「b」');
  });

  it('同一 pass 里既当附件又采样:反馈回路,声明时报错', () => {
    const { graph } = setup();
    const g = graph();
    const t = g.createTexture('t', HDR);
    expect(() => g.addRenderPass('自采样', { colors: [{ texture: t }], reads: [t], execute: () => {} })).toThrow(/反馈回路/);
  });

  it('附件尺寸不一致 / 颜色槽放深度格式:编译报错', () => {
    const { graph } = setup();
    const g1 = graph();
    const a = g1.createTexture('a', HDR);
    const b = g1.createTexture('b', { ...HDR, width: 32 });
    g1.addRenderPass('mrt', { colors: [{ texture: a }, { texture: b }], sideEffect: true, execute: () => {} });
    expect(() => g1.compile()).toThrow(/尺寸不一致/);

    const g2 = setup().graph();
    const d = g2.createTexture('d', { width: 8, height: 8, format: 'depth24plus' });
    g2.addRenderPass('错槽', { colors: [{ texture: d }], sideEffect: true, execute: () => {} });
    expect(() => g2.compile()).toThrow(/深度格式/);
  });

  it('导入资源缺图里用法需要的用途位:编译报错并点名', () => {
    const { dev, graph } = setup();
    const history = dev.rootScope.createTexture({ label: '历史帧', ...HDR, usage: RhiTextureUsage.SAMPLED });
    const g = graph();
    const h = g.importTexture('历史帧', history);
    g.addRenderPass('写历史', { colors: [{ texture: h }], execute: () => {} });
    expect(() => g.compile()).toThrow(/缺用途位 RENDER_TARGET/);
  });

  it('编译后不能再改;一张图只能执行一次', () => {
    const { dev, graph } = setup();
    const errors: RhiError[] = [];
    dev.onDiagnostic((e) => errors.push(e));
    const g = graph();
    dev.runFrame((f) => {
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      g.addRenderPass('清屏', { target: { renderTarget: back }, execute: () => {} });
      g.execute(f.commands);
    });
    expect(() => g.createTexture('晚了', HDR)).toThrow(/已编译/);
    dev.runFrame((f) => g.execute(f.commands));
    expect(errors[0]?.message).toContain('已经执行过');
  });
});

describe('RenderGraph · 瞬时资源', () => {
  function chain(dev: NullRhiDevice, pool: RgTransientPool, seen: RhiTexture[][]) {
    run(dev, (f) => {
      const g = new RenderGraph({ label: '后处理', pool });
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      const a = g.createTexture('a', HDR);
      const b = g.createTexture('b', HDR);
      const c = g.createTexture('c', HDR);
      const used: RhiTexture[] = [];
      g.addRenderPass('写a', { colors: [{ texture: a }], execute: () => {} });
      g.addRenderPass('a→b', { colors: [{ texture: b }], reads: [a], execute: (_p, ctx) => used.push(ctx.texture(a)) });
      g.addRenderPass('b→c', { colors: [{ texture: c }], reads: [b], execute: (_p, ctx) => used.push(ctx.texture(b)) });
      g.addRenderPass('c→屏', { target: { renderTarget: back }, reads: [c], execute: (_p, ctx) => used.push(ctx.texture(c)) });
      g.execute(f.commands);
      seen.push(used);
    });
  }

  it('生命期不重叠、描述相同的资源共用一块物理纹理', () => {
    const { dev, pool } = setup();
    const seen: RhiTexture[][] = [];
    chain(dev, pool, seen);
    const [a, b, c] = seen[0];
    // a 与 b 同时活着(a→b),b 与 c 同时活着;a 在 a→b 之后就死了,c 可以复用 a
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(c).toBe(a);
    expect(pool.stats.textures).toBe(2);
  });

  it('跨帧复用:第二帧起不再新建物理资源', () => {
    const { dev, pool } = setup();
    const seen: RhiTexture[][] = [];
    chain(dev, pool, seen);
    expect(pool.stats.createdLastTick).toBeGreaterThan(0);
    chain(dev, pool, seen);
    expect(pool.stats.createdLastTick).toBe(0);
    expect(new Set([...seen[0], ...seen[1]]).size).toBe(2);
  });

  it('用途位按用法推:作附件 + 被采样 → RENDER_TARGET | SAMPLED', () => {
    const { dev, graph } = setup();
    run(dev, (f) => {
      const g = graph();
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      const t = g.createTexture('t', { ...HDR, usage: RhiTextureUsage.COPY_SRC });
      g.addRenderPass('写', { colors: [{ texture: t }], execute: () => {} });
      g.addRenderPass('读', { target: { renderTarget: back }, reads: [t], execute: () => {} });
      const r = g.compile().resources.find((x) => x.name === 't')!;
      expect(r.usage).toBe(RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_SRC);
      expect([r.firstPass, r.lastPass]).toEqual(['写', '读']);
      g.execute(f.commands);
    });
  });

  it('连续 maxIdleTicks 次没用到的物理资源被销毁', () => {
    const dev = new NullRhiDevice();
    const pool = new RgTransientPool(dev.rootScope, 2);
    const seen: RhiTexture[][] = [];
    chain(dev, pool, seen);
    const physical = seen[0][0];
    for (let i = 0; i < 2; i++) {
      run(dev, (f) => {
        const g = new RenderGraph({ label: '空帧', pool });
        const back = g.importRenderTarget('后备缓冲', f.swapchain);
        g.addRenderPass('清屏', { target: { renderTarget: back }, execute: () => {} });
        g.execute(f.commands);
      });
    }
    expect(physical.destroyed).toBe(true);
    expect(pool.stats.textures).toBe(0);
    expect(pool.stats.renderTargets).toBe(0);
  });

  it('池子销毁带走名下全部物理资源', () => {
    const { dev, pool } = setup();
    const seen: RhiTexture[][] = [];
    chain(dev, pool, seen);
    pool.destroy();
    expect(seen[0].every((t) => t.destroyed)).toBe(true);
  });

  it('compute 写缓冲:自动补 STORAGE;compute pass 由图开合', () => {
    const { dev, graph } = setup();
    run(dev, (f) => {
      const g = graph();
      const parts = g.createBuffer('粒子', { size: 1024, usage: RhiBufferUsage.VERTEX });
      const back = g.importRenderTarget('后备缓冲', f.swapchain);
      g.addComputePass('模拟', { writes: [parts], execute: () => {} });
      g.addRenderPass('画粒子', { target: { renderTarget: back }, reads: [parts], execute: () => {} });
      const r = g.compile().resources.find((x) => x.name === '粒子')!;
      expect(r.usage).toBe(RhiBufferUsage.VERTEX | RhiBufferUsage.STORAGE);
      g.execute(f.commands);
    });
    const tail = dev.log.filter((l) => /^(begin|end) /.test(l));
    expect(tail).toEqual(['begin compute 模拟', 'end compute 模拟', 'begin render 画粒子 -> 画布后备缓冲 [clear]', 'end render 画粒子']);
  });
});
