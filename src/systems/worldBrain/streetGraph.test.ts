import { describe, expect, it } from 'vitest';
import { StreetGraph } from './streetGraph';

const places = [
  { id: 'a', name: 'A', x: 0, y: 0 },
  { id: 'b', name: 'B', x: 100, y: 0 },
  { id: 'c', name: 'C', x: 200, y: 0 },
  { id: 'd', name: 'D', x: 100, y: 300 },
  { id: 'lonely', name: 'L', x: 900, y: 900 },
];

describe('StreetGraph', () => {
  it('最短路沿边走，不抄近道穿房子', () => {
    const g = new StreetGraph(places, [['a', 'b'], ['b', 'c'], ['b', 'd']]);
    expect(g.shortestPath('a', 'c')).toEqual(['a', 'b', 'c']);
    expect(g.shortestPath('d', 'c')).toEqual(['d', 'b', 'c']);
    expect(g.pathLength('a', 'c')).toBeCloseTo(200);
  });

  it('不连通返回 null，isConnected 报出来', () => {
    const g = new StreetGraph(places, [['a', 'b'], ['b', 'c'], ['b', 'd']]);
    expect(g.shortestPath('a', 'lonely')).toBeNull();
    expect(g.isConnected()).toBe(false);
    const g2 = new StreetGraph(places.slice(0, 4), [['a', 'b'], ['b', 'c'], ['b', 'd']]);
    expect(g2.isConnected()).toBe(true);
  });

  it('坏边（未知地点 / 自环）被忽略', () => {
    const g = new StreetGraph(places, [['a', 'nope'], ['a', 'a'], ['a', 'b']]);
    expect(g.neighbors('a')).toEqual(['b']);
  });

  it('route：起点就在第一个节点旁边时不倒退去踩它', () => {
    const g = new StreetGraph(places, [['a', 'b'], ['b', 'c']]);
    const pts = g.route(5, 0, 'c')!;
    expect(pts[0]).toEqual({ x: 100, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 200, y: 0 });
  });

  it('route：给了终点就停在终点（走到某人跟前 / 自己的摊子）', () => {
    const g = new StreetGraph(places, [['a', 'b'], ['b', 'c']]);
    const pts = g.route(0, 0, 'c', { x: 210, y: 20 })!;
    expect(pts[pts.length - 1]).toEqual({ x: 210, y: 20 });
  });

  it('nearest 可带过滤', () => {
    const g = new StreetGraph(places, []);
    expect(g.nearest(90, 10)?.id).toBe('b');
    expect(g.nearest(90, 10, (p) => p.id !== 'b')?.id).toBe('a');
  });
});
