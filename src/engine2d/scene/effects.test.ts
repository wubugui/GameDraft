/**
 * 容器效果(遮罩 / 滤镜)与 Pixi 8.17 对照:
 * - D14 FilterEffect.priority = 1、遮罩 0:同一容器上遮罩总在滤镜外层,与 `filters` / `mask` 赋值先后无关;
 * - D15 销毁被遮罩的容器只断开遮罩效果,不 reset 遮罩体:遮罩体仍 includeInBuild / measurable = false(不画、不计包围盒)。
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from './Container';
import { Graphics } from '../graphics/Graphics';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';

describe('D14 效果顺序', () => {
  it('先 filters 后 mask:遮罩在外层(Pixi StencilMask:0 在 FilterEffect:1 前)', () => {
    const pc = new PIXI.Container();
    pc.filters = [{} as PIXI.Filter]; // 只看效果排序,不建真滤镜(Pixi 的滤镜构造要 DOM)
    pc.mask = new PIXI.Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    const pixiOrder = (pc.effects ?? []).map((e) => e.priority);

    const c = new Container();
    c.filters = [new AlphaFilter()];
    c.mask = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    expect(pixiOrder).toEqual([0, 1]);
    expect(c.effects.map((e) => e.priority)).toEqual(pixiOrder);
    expect(c.effects.map((e) => e.kind)).toEqual(['mask', 'filters']);
  });

  it('先 mask 后 filters:同样遮罩在外层', () => {
    const c = new Container();
    c.mask = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    c.filters = [new AlphaFilter()];
    expect(c.effects.map((e) => e.kind)).toEqual(['mask', 'filters']);
  });
});

describe('D15 销毁被遮罩的容器', () => {
  it('遮罩体保持隐藏、不计入父节点包围盒(Pixi Container.destroy 只置 _maskEffect = null)', () => {
    const pp = new PIXI.Container();
    const pm = new PIXI.Graphics().rect(0, 0, 500, 500).fill(0xffffff);
    const pcontent = new PIXI.Graphics().rect(0, 0, 10, 10).fill(0xffffff);
    pp.addChild(pm, pcontent);
    pcontent.mask = pm;
    pcontent.destroy();
    const pixi = { inc: pm.includeInBuild, meas: pm.measurable, w: pp.getLocalBounds().width };

    const p = new Container();
    const m = new Graphics().rect(0, 0, 500, 500).fill(0xffffff);
    const content = new Graphics().rect(0, 0, 10, 10).fill(0xffffff);
    p.addChild(m, content);
    content.mask = m;
    content.destroy();
    const mine = { inc: m.includeInBuild, meas: m.measurable, w: p.getLocalBounds().width };

    expect(pixi).toEqual({ inc: false, meas: false, w: 0 });
    expect(mine).toEqual(pixi);
  });

  it('换遮罩 / 清遮罩照旧 reset 旧遮罩体(Pixi returnMaskEffect → reset)', () => {
    const c = new Container();
    const m = new Graphics().rect(0, 0, 4, 4).fill(0xffffff);
    c.mask = m;
    expect(m.includeInBuild).toBe(false);
    c.mask = null;
    expect(m.includeInBuild).toBe(true);
    expect(m.measurable).toBe(true);
  });
});
