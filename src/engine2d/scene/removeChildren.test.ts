/**
 * R4-3 Container.removeChildren(begin, end) 与 Pixi 8.17 逐项对照(真 pixi.js 并排跑)。
 * Pixi 8.17 用 `removeItems(children, begin, end)` 摘数组——第三参是「个数」不是终点:
 * begin > 0 时从 children 里摘掉 end 个(夹到数组尾),但只把 [begin, end) 这 end - begin 个断父、发事件、返回;
 * 多摘的那几个离开 children 却仍 parent === 容器、不发 removed / childRemoved。这里照原样复刻,不"修"。
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from './Container';

type AnyContainer = {
  children: AnyContainer[];
  parent: AnyContainer | null;
  addChild(c: AnyContainer): AnyContainer;
  removeChildren(begin?: number, end?: number): AnyContainer[];
  on(ev: string, fn: (...a: unknown[]) => void): void;
};

function run(make: () => AnyContainer, n: number, begin?: number, end?: number) {
  const p = make();
  const kids = Array.from({ length: n }, () => make());
  kids.forEach((k) => p.addChild(k));
  const log: string[] = [];
  p.on('childRemoved', (c, _p, i) => log.push(`childRemoved:${kids.indexOf(c as AnyContainer)}@${i as number}`));
  kids.forEach((k, i) => k.on('removed', () => log.push(`removed:${i}`)));
  let error: string | null = null;
  let returned: number[] = [];
  try {
    const args: number[] = [];
    if (begin !== undefined) args.push(begin);
    if (end !== undefined) args.push(end);
    returned = p.removeChildren(...args).map((k) => kids.indexOf(k));
  } catch (e) {
    error = `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  return {
    error,
    returned,
    left: p.children.map((k) => kids.indexOf(k)),
    parentIsP: kids.map((k) => k.parent === p),
    log,
  };
}

const pixi = () => new PIXI.Container() as unknown as AnyContainer;
const ours = () => new Container() as unknown as AnyContainer;

describe('R4-3 removeChildren 与 Pixi 8.17 一致', () => {
  const cases: Array<[string, number, number | undefined, number | undefined]> = [
    ['无参', 10, undefined, undefined],
    ['(0, 4)', 10, 0, 4],
    ['(2, 5):begin > 0 多摘出孤儿', 10, 2, 5],
    ['(1, 2)', 10, 1, 2],
    ['(7, 10):摘到尾', 10, 7, 10],
    ['(6, 9):个数夹到数组尾', 10, 6, 9],
    ['(3):只给 begin', 10, 3, undefined],
    ['(2, 15):end 越界', 10, 2, 15],
    ['(3, 3):空区间非空容器抛 RangeError', 10, 3, 3],
    ['(5, 2):反向抛 RangeError', 10, 5, 2],
    ['(-1, 2):负 begin 抛 RangeError', 10, -1, 2],
    ['空容器无参', 0, undefined, undefined],
    ['空容器 (0, 0)', 0, 0, 0],
  ];
  for (const [name, n, b, e] of cases) {
    it(name, () => {
      expect(run(ours, n, b, e)).toEqual(run(pixi, n, b, e));
    });
  }
});
