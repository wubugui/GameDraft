/**
 * F2「层级」页纯逻辑:展平 / 过滤 / 虚拟滚动区间 / 检视器读写(度 ↔ 弧度、世界量)/ 舞台 → CSS 映射 / 画面拾取。
 * 节点用真的 engine2d Container(与 hierarchy.test.ts 同一套),拾取用一个固定包围盒的视图节点。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Container } from '../engine2d/scene/Container';
import { ViewContainer } from '../engine2d/scene/ViewContainer';
import { PlayerLoop } from '../engine2d/scene/PlayerLoop';
import {
  ancestorChain,
  applyNumericField,
  clientToStage,
  countNodes,
  degToRad,
  filterTree,
  flattenTree,
  formatNum,
  intersectBox,
  nextPick,
  nodeDisplayName,
  nodeMatchesQuery,
  parseNum,
  pickAll,
  radToDeg,
  readTransform,
  scrollTopToReveal,
  stageRectToHost,
  visibleRange,
} from './debugHierarchyModel';

afterEach(() => PlayerLoop.shared.reset());

/** 本地 [0,w]×[0,h] 的可画节点(拾取 / 包围盒用) */
class Box extends ViewContainer {
  override renderPipeId = 'test-box';
  constructor(private readonly w: number, private readonly h: number, label?: string) {
    super(label ? { label } : {});
  }
  protected updateBounds(): void {
    this._bounds.set(0, 0, this.w, this.h);
  }
}

function tree(): { stage: Container; world: Container; ents: Container; a: Container; b: Container; ui: Container } {
  const stage = new Container({ label: 'stage' });
  stage.isSceneRoot = true;
  const world = new Container({ label: 'world' });
  const ents = new Container({ label: 'entities' });
  const a = new Container({ label: 'npc_a' });
  const b = new Container();
  const ui = new Container({ label: 'ui' });
  stage.addChild(world, ui);
  world.addChild(ents);
  ents.addChild(a, b);
  return { stage, world, ents, a, b, ui };
}

describe('显示名与过滤匹配', () => {
  it('有 label 用 label;没有时先用别名,再退回「类名#uid」', () => {
    const { a, b } = tree();
    expect(nodeDisplayName(a)).toEqual({ text: 'npc_a', kind: 'label' });
    expect(nodeDisplayName(b)).toEqual({ text: `Container#${b.uid}`, kind: 'anon' });
    expect(nodeDisplayName(b, new Map([[b, 'player']]))).toEqual({ text: 'player', kind: 'alias' });
  });

  it('子串忽略大小写,比 label / 别名 / 类名;# 开头按 uid 精确', () => {
    const { a, b } = tree();
    expect(nodeMatchesQuery(a, 'npc')).toBe(true);
    expect(nodeMatchesQuery(a, 'zzz')).toBe(false);
    expect(nodeMatchesQuery(b, 'play', new Map([[b, 'Player']]))).toBe(true);
    expect(nodeMatchesQuery(new Box(1, 1), 'box')).toBe(true);
    expect(nodeMatchesQuery(b, `#${b.uid}`)).toBe(true);
    expect(nodeMatchesQuery(a, `#${b.uid}`)).toBe(false);
  });
});

describe('展平(懒展开)', () => {
  it('只下探展开了的节点;根是第 0 行', () => {
    const { stage, world, ents, a, b, ui } = tree();
    let r = flattenTree(stage, new Set([stage.uid]));
    expect(r.rows.map((x) => [x.node, x.depth])).toEqual([[stage, 0], [world, 1], [ui, 1]]);
    expect(r.rows[0].expanded).toBe(true);
    expect(r.rows[1]).toMatchObject({ hasChildren: true, expanded: false });
    expect(r.rows[2]).toMatchObject({ hasChildren: false, expanded: false });

    r = flattenTree(stage, new Set([stage.uid, world.uid, ents.uid]));
    expect(r.rows.map((x) => [x.node, x.depth])).toEqual([[stage, 0], [world, 1], [ents, 2], [a, 3], [b, 3], [ui, 1]]);
  });

  it('展开了但没有子节点的不算展开;超过上限截断', () => {
    const { stage, ui } = tree();
    const r = flattenTree(stage, new Set([stage.uid, ui.uid]), 2);
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(2);
    const r2 = flattenTree(stage, new Set([stage.uid, ui.uid]));
    expect(r2.rows.find((x) => x.node === ui)?.expanded).toBe(false);
  });

  it('几千个子节点不展开时只产出一行', () => {
    const root = new Container();
    const big = new Container();
    root.addChild(big);
    for (let i = 0; i < 3000; i++) big.addChild(new Container());
    expect(flattenTree(root, new Set([root.uid])).rows).toHaveLength(2);
    expect(countNodes(root)).toBe(3002);
  });
});

describe('过滤(搜整棵树)', () => {
  it('命中行带出祖先链,祖先标记为非命中且展开;无关分支不出现', () => {
    const { stage, world, ents, a } = tree();
    const r = filterTree(stage, 'NPC');
    expect(r.matches).toBe(1);
    expect(r.rows.map((x) => [x.node, x.depth, x.match, x.expanded])).toEqual([
      [stage, 0, false, true],
      [world, 1, false, true],
      [ents, 2, false, true],
      [a, 3, true, false],
    ]);
  });

  it('祖先本身命中时只出现一次,且记为命中', () => {
    const { stage, world, ents, a, b } = tree();
    const r = filterTree(stage, 'en', new Map([[b, 'enemy']]));
    // entities 含 en(且是 b 的祖先);b 的别名 enemy 含 en;类名 Container 不含 en
    expect(r.rows.map((x) => [x.node, x.match])).toEqual([
      [stage, false],
      [world, false],
      [ents, true],
      [b, true],
    ]);
    expect(r.rows.filter((x) => x.node === a)).toHaveLength(0);
  });

  it('命中数超过上限截断', () => {
    const root = new Container({ label: 'root' });
    for (let i = 0; i < 50; i++) root.addChild(new Container({ label: `hit${i}` }));
    const r = filterTree(root, 'hit', undefined, 10);
    expect(r.truncated).toBe(true);
    expect(r.matches).toBe(10);
  });

  it('ancestorChain:从根到父;不在根下返回 null', () => {
    const { stage, world, ents, a } = tree();
    expect(ancestorChain(a, stage)).toEqual([stage, world, ents]);
    expect(ancestorChain(stage, stage)).toEqual([]);
    expect(ancestorChain(new Container(), stage)).toBeNull();
  });
});

describe('虚拟滚动区间', () => {
  it('按滚动位置取行区间(含 overscan),两端夹住', () => {
    expect(visibleRange(0, 100, 20, 1000, 2)).toEqual({ first: 0, last: 7 });
    expect(visibleRange(400, 100, 20, 1000, 2)).toEqual({ first: 18, last: 27 });
    expect(visibleRange(19_990, 100, 20, 1000, 2)).toEqual({ first: 997, last: 1000 });
    expect(visibleRange(0, 100, 20, 0)).toEqual({ first: 0, last: 0 });
  });

  it('定位某行所需的 scrollTop', () => {
    expect(scrollTopToReveal(10, 0, 100, 20)).toBe(120);    // 在下面:底边对齐
    expect(scrollTopToReveal(2, 200, 100, 20)).toBe(40);    // 在上面:顶边对齐
    expect(scrollTopToReveal(12, 200, 100, 20)).toBe(200);  // 看得见:不动
  });
});

describe('数值', () => {
  it('度 ↔ 弧度', () => {
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 12);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(radToDeg(degToRad(-37.5))).toBeCloseTo(-37.5, 12);
  });

  it('格式化去尾零、无 -0;解析拒收空 / 非数 / 无穷', () => {
    expect(formatNum(1.23456)).toBe('1.235');
    expect(formatNum(2)).toBe('2');
    expect(formatNum(-0.0001)).toBe('0');
    expect(formatNum(-1e-12)).toBe('0');
    expect(parseNum(' 12.5 ')).toBe(12.5);
    expect(parseNum('')).toBeNull();
    expect(parseNum('abc')).toBeNull();
    expect(parseNum('Infinity')).toBeNull();
  });
});

describe('检视器读写', () => {
  it('本地量:旋转 / 切变按度读写,位置 / 缩放 / pivot 原样', () => {
    const n = new Container();
    applyNumericField(n, 'posX', 10);
    applyNumericField(n, 'posY', -4);
    applyNumericField(n, 'rotDeg', 90);
    applyNumericField(n, 'scaleX', 2);
    applyNumericField(n, 'pivotY', 3);
    applyNumericField(n, 'skewXDeg', 45);
    expect(n.position.x).toBe(10);
    expect(n.position.y).toBe(-4);
    expect(n.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(n.scale.x).toBe(2);
    expect(n.pivot.y).toBe(3);
    expect(n.skew.x).toBeCloseTo(Math.PI / 4, 12);
    const t = readTransform(n);
    expect(t.rotDeg).toBeCloseTo(90, 9);
    expect(t.skewXDeg).toBeCloseTo(45, 9);
  });

  it('世界量:改 worldX 只动世界 x,在旋转缩放过的父节点下也对', () => {
    const root = new Container();
    root.isSceneRoot = true;
    const parent = new Container({ x: 100, y: 50, rotation: Math.PI / 2, scale: 2 as never });
    const child = new Container({ x: 3, y: 4 });
    root.addChild(parent);
    parent.addChild(child);
    const before = readTransform(child);
    applyNumericField(child, 'worldX', 7);
    const after = readTransform(child);
    expect(after.worldX).toBeCloseTo(7, 9);
    expect(after.worldY).toBeCloseTo(before.worldY, 9);

    applyNumericField(child, 'worldRotDeg', 30);
    expect(readTransform(child).worldRotDeg).toBeCloseTo(30, 9);
    expect(readTransform(child).worldX).toBeCloseTo(7, 9);
    expect(readTransform(child).lossyX).toBeCloseTo(2, 9);
  });

  it('alpha 夹到 [0,1];siblingIndex 夹到兄弟范围', () => {
    const { ents, a, b } = tree();
    applyNumericField(a, 'alpha', 3);
    expect(a.alpha).toBe(1);
    applyNumericField(a, 'siblingIndex', 99);
    expect(ents.children).toEqual([b, a]);
    expect(readTransform(a).siblingIndex).toBe(1);
  });
});

describe('舞台 → 画布 CSS 像素', () => {
  it('信箱盒:1024×768 的逻辑视口显示成 800×600、偏移 (40, 0)', () => {
    const r = stageRectToHost({ x: 512, y: 384, width: 128, height: 64 }, { width: 1024, height: 768 },
      { left: 40, top: 0, width: 800, height: 600 });
    expect(r).toEqual({ left: 40 + 400, top: 300, width: 100, height: 50 });
  });

  it('两轴各自按比例(显示盒宽高各自向下取整)', () => {
    const r = stageRectToHost({ x: 1024, y: 768, width: 0, height: 0 }, { width: 1024, height: 768 },
      { left: 0, top: 0, width: 1023, height: 767 })!;
    expect(r.left).toBe(1023);
    expect(r.top).toBe(767);
    expect(stageRectToHost({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 768 },
      { left: 0, top: 0, width: 1, height: 1 })).toBeNull();
  });

  it('client → 舞台是它的逆', () => {
    const canvas = { left: 140, top: 20, width: 800, height: 600 };
    const p = clientToStage(140 + 400, 20 + 300, { width: 1024, height: 768 }, canvas)!;
    expect(p.x).toBeCloseTo(512, 9);
    expect(p.y).toBeCloseTo(384, 9);
    expect(clientToStage(0, 0, { width: 1024, height: 768 }, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  it('裁到画布:相交取交,不相交为 null', () => {
    expect(intersectBox({ left: -10, top: 5, width: 30, height: 10 }, { left: 0, top: 0, width: 100, height: 100 }))
      .toEqual({ left: 0, top: 5, width: 20, height: 10 });
    expect(intersectBox({ left: 200, top: 0, width: 5, height: 5 }, { left: 0, top: 0, width: 100, height: 100 }))
      .toBeNull();
  });
});

describe('画面拾取', () => {
  function scene(): { stage: Container; back: Box; front: Box; hidden: Box; group: Container } {
    const stage = new Container({ label: 'stage' });
    stage.isSceneRoot = true;
    const back = new Box(100, 100, 'back');
    const group = new Container({ label: 'group', x: 20, y: 20 });
    const front = new Box(30, 30, 'front');
    const hidden = new Box(100, 100, 'hidden');
    hidden.visible = false;
    stage.addChild(back, group, hidden);
    group.addChild(front);
    return { stage, back, front, hidden, group };
  }

  it('自顶向下:后画的在前;纯容器不算命中;不可见的剪掉', () => {
    const { stage, back, front } = scene();
    expect(pickAll(stage, 25, 25)).toEqual([front, back]);
    expect(pickAll(stage, 5, 5)).toEqual([back]);
    expect(pickAll(stage, 500, 5)).toEqual([]);
  });

  it('未激活 / alpha 为 0 的整棵子树拾不到', () => {
    const { stage, back, front, group } = scene();
    group.setActive(false);
    expect(pickAll(stage, 25, 25)).toEqual([back]);
    group.setActive(true);
    group.alpha = 0;
    expect(pickAll(stage, 25, 25)).toEqual([back]);
    group.alpha = 1;
    expect(pickAll(stage, 25, 25)[0]).toBe(front);
  });

  it('按父节点的世界变换逆算到本地', () => {
    const { stage, front, group } = scene();
    group.scale.set(2, 2);                 // front 现在占舞台 [20,80]²
    expect(pickAll(stage, 75, 75)[0]).toBe(front);
    group.rotation = Math.PI;              // 转半圈:占 [-40,20]² → (75,75) 只剩 back
    expect(pickAll(stage, 75, 75)[0]).not.toBe(front);
  });

  it('同一处连点依次往下选', () => {
    const { stage, back, front } = scene();
    const hits = pickAll(stage, 25, 25);
    expect(nextPick(hits, null)).toBe(front);
    expect(nextPick(hits, front)).toBe(back);
    expect(nextPick(hits, back)).toBe(front);
    expect(nextPick([], front)).toBeNull();
  });
});
