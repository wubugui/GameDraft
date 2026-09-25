import { describe, expect, it } from 'vitest';
import { Container } from '../engine2d';
import { FIRE_HINT_DISTANCE_OF_BODY, FireHintMarker, clipPolygonBelow, fireHintLook, flameGlyphOutline, type FireHintTarget } from './FireHintMarker';

const area = (p: readonly [number, number][]) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[(i + 1) % p.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

describe('「快灭了」符号：火苗轮廓里装着剩下的火', () => {
  it('轮廓：底在 0、尖在 −1，是个闭合的简单形', () => {
    const o = flameGlyphOutline();
    const ys = o.map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(0, 6);
    expect(Math.min(...ys)).toBeCloseTo(-1, 6);
    expect(area(o)).toBeGreaterThan(0.2);
  });

  it('装多少：裁出来的面积随线单调，满 = 整个轮廓，空 = 没有', () => {
    const o = flameGlyphOutline();
    const full = area(o);
    expect(area(clipPolygonBelow(o, -1.01))).toBeCloseTo(full, 6);
    expect(clipPolygonBelow(o, 0.01).length).toBe(0);
    let prev = 0;
    for (const level of [-0.1, -0.3, -0.5, -0.7, -0.9]) {
      const a = area(clipPolygonBelow(o, level));
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it('样子：往下掉时跳、越急越红；往回长时不跳；残炭一闪一闪', () => {
    const base: FireHintTarget = {
      sceneX: 0, sceneY: 0, dirX: 1, dirY: 0, bodyHeightWu: 100, fill: 0.5, danger: 0.2, falling: true, ember: false,
    };
    const beats = (t: FireHintTarget) => Array.from({ length: 200 }, (_, i) => fireHintLook(t, i / 100).scale);
    expect(Math.max(...beats(base))).toBeGreaterThan(1.05);
    expect(Math.max(...beats({ ...base, falling: false }))).toBe(1);
    const red = (c: number) => (c >> 16) & 0xff, green = (c: number) => (c >> 8) & 0xff;
    const calm = fireHintLook(base, 0).color, urgent = fireHintLook({ ...base, danger: 1 }, 0).color;
    expect(green(urgent)).toBeLessThan(green(calm));
    expect(red(urgent)).toBeGreaterThanOrEqual(red(calm) - 1);
    const alphas = Array.from({ length: 100 }, (_, i) => fireHintLook({ ...base, ember: true }, i / 100).alpha);
    expect(Math.min(...alphas)).toBeLessThan(0.65);
    expect(Math.max(...alphas)).toBeGreaterThan(0.95);
  });

  it('点火的样子：正在点 = 琥珀、不跳不抖、轻轻一亮一亮；没点着 = 红、左右抖', () => {
    const base: FireHintTarget = {
      sceneX: 0, sceneY: 0, dirX: 1, dirY: 0, bodyHeightWu: 100, fill: 0.4, danger: 0, falling: false, ember: false,
    };
    const ig = Array.from({ length: 100 }, (_, i) => fireHintLook({ ...base, mode: 'igniting' }, i / 100));
    for (const l of ig) { expect(l.scale).toBe(1); expect(l.shake).toBe(0); }
    expect(Math.min(...ig.map((l) => l.alpha))).toBeLessThan(0.85);
    const failed = Array.from({ length: 100 }, (_, i) => fireHintLook({ ...base, mode: 'failed' }, i / 100));
    expect(Math.max(...failed.map((l) => Math.abs(l.shake)))).toBeGreaterThan(0.05);
    expect((failed[0]!.color >> 8) & 0xff).toBeLessThan((ig[0]!.color >> 8) & 0xff);
  });

  it('摆位：小角度滑过去；大角度（换到杆子另一边）不滑——淡出、在新处淡入，不扫过火舌', () => {
    const layer = new Container();
    const m = new FireHintMarker(() => layer);
    const t: FireHintTarget = {
      sceneX: 100, sceneY: 200, dirX: 1, dirY: 0, bodyHeightWu: 100, fill: 0.5, danger: 0.5, falling: false, ember: false,
    };
    const r = 100 * FIRE_HINT_DISTANCE_OF_BODY;
    m.setTarget(t);
    for (let i = 0; i < 30; i++) m.tick(1 / 60);
    expect(m.root.parent).toBe(layer);
    expect(m.root.x).toBeCloseTo(100 + r, 6);
    expect(m.root.alpha).toBeCloseTo(1, 6);
    // 小角度：滑
    m.setTarget({ ...t, dirX: Math.cos(0.5), dirY: Math.sin(0.5) });
    m.tick(1 / 60);
    expect(m.root.y).toBeGreaterThan(200);
    expect(m.root.y).toBeLessThan(200 + Math.sin(0.5) * r * 0.5);
    for (let i = 0; i < 60; i++) m.tick(1 / 60);
    expect(m.root.y).toBeCloseTo(200 + Math.sin(0.5) * r, 2);
    // 大角度：翻到左边。位置只会在右边（淡出中）或左边（淡入中），中间不出现；淡到 0 那一下才换
    m.setTarget({ ...t, dirX: -1, dirY: 0 });
    const xs: number[] = [], alphas: number[] = [];
    for (let i = 0; i < 30; i++) { m.tick(1 / 60); xs.push(m.root.x); alphas.push(m.root.alpha); }
    for (const x of xs) expect(Math.abs(x - 100)).toBeGreaterThan(r * 0.8);
    expect(Math.min(...alphas)).toBeLessThan(0.1);
    expect(xs[xs.length - 1]!).toBeCloseTo(100 - r, 3);
    expect(alphas[alphas.length - 1]!).toBeCloseTo(1, 6);
    m.destroy();
  });
});
