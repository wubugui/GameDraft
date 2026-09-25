/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 形状对照测试:Circle / Ellipse / Polygon / RoundedRectangle / Triangle 与 Pixi v8.17 同名类在网格点上的
 * contains / strokeContains(多种宽度与 alignment)、getBounds、clone / copy、Polygon 专有方法逐项相等。
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Rectangle } from '../Rectangle';
import { Circle } from './Circle';
import { Ellipse } from './Ellipse';
import { Polygon } from './Polygon';
import { RoundedRectangle } from './RoundedRectangle';
import { Triangle } from './Triangle';

function probe(shape: any, box: [number, number, number, number]): unknown[] {
  const out: unknown[] = [];
  const [x0, y0, x1, y1] = box;
  const n = 36;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * j) / n;
      out.push(shape.contains(x, y));
      for (const w of [1, 4, 9]) {
        for (const a of [0, 0.25, 0.5, 1]) out.push(shape.strokeContains(x, y, w, a));
      }
      out.push(shape.strokeContains(x, y, 3));
    }
  }
  const b = shape.getBounds();
  out.push([b.x, b.y, b.width, b.height]);
  return out;
}

const pairs: Array<[string, () => any, () => any, [number, number, number, number]]> = [
  ['Circle', () => new PIXI.Circle(10, 20, 15), () => new Circle(10, 20, 15), [-10, 0, 30, 40]],
  ['Circle 半径 0', () => new PIXI.Circle(0, 0, 0), () => new Circle(0, 0, 0), [-2, -2, 2, 2]],
  ['Circle 缺省', () => new PIXI.Circle(), () => new Circle(), [-1, -1, 1, 1]],
  ['Ellipse', () => new PIXI.Ellipse(5, -5, 20, 8), () => new Ellipse(5, -5, 20, 8), [-20, -20, 30, 10]],
  ['Ellipse 退化', () => new PIXI.Ellipse(0, 0, 0, 5), () => new Ellipse(0, 0, 0, 5), [-5, -5, 5, 5]],
  ['RoundedRectangle', () => new PIXI.RoundedRectangle(0, 0, 60, 30, 8), () => new RoundedRectangle(0, 0, 60, 30, 8), [-8, -8, 68, 38]],
  ['RoundedRectangle 缺省半径', () => new PIXI.RoundedRectangle(0, 0, 30, 30), () => new RoundedRectangle(0, 0, 30, 30), [-5, -5, 35, 35]],
  ['RoundedRectangle 半径超半', () => new PIXI.RoundedRectangle(0, 0, 20, 10, 40), () => new RoundedRectangle(0, 0, 20, 10, 40), [-5, -5, 25, 15]],
  ['Triangle', () => new PIXI.Triangle(0, 0, 40, 10, 10, 30), () => new Triangle(0, 0, 40, 10, 10, 30), [-5, -5, 45, 35]],
  ['Triangle 反向', () => new PIXI.Triangle(0, 0, 10, 30, 40, 10), () => new Triangle(0, 0, 10, 30, 40, 10), [-5, -5, 45, 35]],
  ['Polygon 扁平', () => new PIXI.Polygon([0, 0, 50, 0, 60, 40, 20, 50, -10, 20]), () => new Polygon([0, 0, 50, 0, 60, 40, 20, 50, -10, 20]), [-15, -5, 65, 55]],
  ['Polygon 点对象参数', () => new PIXI.Polygon(new PIXI.Point(0, 0), new PIXI.Point(30, 5), new PIXI.Point(10, 30)), () => new Polygon({ x: 0, y: 0 }, { x: 30, y: 5 }, { x: 10, y: 30 }), [-5, -5, 35, 35]],
  ['Polygon 数字参数', () => new PIXI.Polygon(0, 0, 30, 5, 10, 30, 0, 20), () => new Polygon(0, 0, 30, 5, 10, 30, 0, 20), [-5, -5, 35, 35]],
  ['Polygon 凹', () => new PIXI.Polygon([0, 0, 100, 0, 100, 100, 50, 40, 0, 100]), () => new Polygon([0, 0, 100, 0, 100, 100, 50, 40, 0, 100]), [-5, -5, 105, 105]],
];

describe('形状与 Pixi 对照', () => {
  for (const [name, mkP, mkE, box] of pairs) {
    it(name, () => {
      const p = mkP();
      const e = mkE();
      expect(e.type).toBe(p.type);
      expect(probe(e, box)).toEqual(probe(p, box));
      const pc = p.clone();
      const ec = e.clone();
      expect(probe(ec, box)).toEqual(probe(pc, box));
      expect(ec).not.toBe(e);
    });
  }

  it('Polygon:closePath=false 的描边命中 / isClockwise / containsPolygon / last/start', () => {
    const pts = [0, 0, 50, 0, 50, 50, 0, 50];
    const p = new PIXI.Polygon(pts.slice());
    const e = new Polygon(pts.slice());
    p.closePath = false;
    e.closePath = false;
    expect(probe(e, [-5, -5, 55, 55])).toEqual(probe(p, [-5, -5, 55, 55]));
    expect(e.isClockwise()).toBe(p.isClockwise());
    const rev = [0, 50, 50, 50, 50, 0, 0, 0];
    expect(new Polygon(rev).isClockwise()).toBe(new PIXI.Polygon(rev).isClockwise());
    const inner = [10, 10, 20, 10, 20, 20];
    const outside = [10, 10, 80, 10, 20, 20];
    expect(e.containsPolygon(new Polygon(inner))).toBe(p.containsPolygon(new PIXI.Polygon(inner)));
    expect(e.containsPolygon(new Polygon(outside))).toBe(p.containsPolygon(new PIXI.Polygon(outside)));
    expect([e.lastX, e.lastY, e.startX, e.startY]).toEqual([p.lastX, p.lastY, p.startX, p.startY]);
    const c = new Polygon([]).copyFrom(e);
    expect(c.points).toEqual(e.points);
    expect(c.points).not.toBe(e.points);
    expect(c.closePath).toBe(false);
  });

  it('copyFrom / copyTo / getBounds(out)', () => {
    const out = new Rectangle();
    expect(new Circle(1, 2, 3).getBounds(out)).toBe(out);
    expect([out.x, out.y, out.width, out.height]).toEqual([-2, -1, 6, 6]);
    const c = new Circle().copyFrom(new Circle(4, 5, 6));
    expect([c.x, c.y, c.radius]).toEqual([4, 5, 6]);
    const el = new Ellipse(1, 2, 3, 4).copyTo(new Ellipse());
    expect([el.x, el.y, el.halfWidth, el.halfHeight]).toEqual([1, 2, 3, 4]);
    // 照 Pixi:RoundedRectangle.copyFrom 不拷 radius
    const rr = new RoundedRectangle(0, 0, 1, 1, 3).copyFrom(new RoundedRectangle(5, 6, 7, 8, 9));
    const prr = new PIXI.RoundedRectangle(0, 0, 1, 1, 3).copyFrom(new PIXI.RoundedRectangle(5, 6, 7, 8, 9));
    expect([rr.x, rr.y, rr.width, rr.height, rr.radius]).toEqual([prr.x, prr.y, prr.width, prr.height, prr.radius]);
    const t = new Triangle().copyFrom(new Triangle(1, 2, 3, 4, 5, 6));
    expect([t.x, t.y, t.x2, t.y2, t.x3, t.y3]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('游戏用法:Circle 当 hitArea 与 Rectangle 组合', () => {
    const circle = new Circle(100, 80, 18);
    const rect = new Rectangle(120, 70, 60, 20);
    const hitArea = { contains: (x: number, y: number) => circle.contains(x, y) || rect.contains(x, y) };
    expect(hitArea.contains(100, 80)).toBe(true);
    expect(hitArea.contains(118, 80)).toBe(true);
    expect(hitArea.contains(119, 80)).toBe(false);
    expect(hitArea.contains(150, 75)).toBe(true);
    expect(hitArea.contains(50, 50)).toBe(false);
  });
});
