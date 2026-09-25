/**
 * vendored earcut 与 Pixi v8.17 导出的 earcut(npm earcut 3.0.2)逐项对照:三角形索引序列必须完全相同。
 */
import { earcut as pixiEarcut } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { earcut } from './utils/earcut';

/** 可复现的伪随机 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function starPolygon(cx: number, cy: number, n: number, r0: number, r1: number, rand: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = i % 2 ? r0 : r1 * (0.8 + rand() * 0.4);
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

describe('earcut 与 Pixi 对照', () => {
  it('简单形状:三角形 / 矩形 / 凹多边形 / 退化', () => {
    const cases: number[][] = [
      [0, 0, 10, 0, 5, 8],
      [0, 0, 100, 0, 100, 50, 0, 50],
      [0, 0, 100, 0, 100, 100, 50, 40, 0, 100],
      [0, 0, 10, 0, 20, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0],
      [],
      [0, 0, 10, 0, 10, 10, 10, 10, 0, 10, 0, 0],
    ];
    for (const c of cases) expect(earcut(c)).toEqual(pixiEarcut(c));
  });

  it('随机星形(< 80 点走普通 isEar,> 80 点走 z-order 哈希)', () => {
    const rand = rng(7);
    for (const n of [5, 12, 40, 79, 81, 160, 400]) {
      for (let k = 0; k < 5; k++) {
        const pts = starPolygon(rand() * 100, rand() * 100, n, 10 + rand() * 20, 40 + rand() * 60, rand);
        expect(earcut(pts)).toEqual(pixiEarcut(pts));
      }
    }
  });

  it('带洞(单洞 / 多洞 / 洞贴边 / 洞共点)', () => {
    const rand = rng(99);
    const outer = [0, 0, 200, 0, 200, 200, 0, 200];
    const holeA = [20, 20, 60, 20, 60, 60, 20, 60];
    const holeB = [100, 100, 150, 110, 120, 160];
    const holeEdge = [0, 80, 30, 90, 0, 100];
    const holeTouch = [60, 60, 80, 60, 80, 80];
    const cases: Array<[number[], number[]]> = [
      [[...outer, ...holeA], [4]],
      [[...outer, ...holeA, ...holeB], [4, 8]],
      [[...outer, ...holeEdge], [4]],
      [[...outer, ...holeA, ...holeTouch], [4, 8]],
    ];
    for (let k = 0; k < 6; k++) {
      const big = starPolygon(100, 100, 120, 80, 95, rand);
      const hole = starPolygon(100, 100, 30, 20, 30, rand);
      cases.push([[...big, ...hole], [big.length / 2]]);
    }
    for (const [data, holes] of cases) expect(earcut(data, holes)).toEqual(pixiEarcut(data, holes));
  });

  it('自相交(走 cureLocalIntersections / splitEarcut)', () => {
    const rand = rng(3);
    for (let k = 0; k < 20; k++) {
      const pts: number[] = [];
      const n = 6 + Math.floor(rand() * 30);
      for (let i = 0; i < n; i++) pts.push(Math.round(rand() * 50), Math.round(rand() * 50));
      expect(earcut(pts)).toEqual(pixiEarcut(pts));
    }
  });
});
