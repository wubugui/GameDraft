/**
 * Randomized differential: engine2d Container/Sprite/Graphics bounds + transforms vs Pixi 8.17.
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';

let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function ri(n: number): number {
  return Math.floor(rnd() * n);
}

type Pair = { p: PIXI.Container; e: Container };

function makeTex(): [PIXI.Texture, Texture] {
  const w = 10 + ri(50);
  const h = 10 + ri(50);
  const trimmed = rnd() < 0.3;
  const pSrc = new PIXI.TextureSource({ width: 100, height: 100 });
  const eSrc = new TextureSource({ width: 100, height: 100 });
  const fx = ri(40);
  const fy = ri(40);
  const frame = { x: fx, y: fy, w, h };
  if (trimmed) {
    const ow = w + ri(10);
    const oh = h + ri(10);
    const tx = ri(ow - w + 1);
    const ty = ri(oh - h + 1);
    const pt = new PIXI.Texture({
      source: pSrc,
      frame: new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
      orig: new PIXI.Rectangle(0, 0, ow, oh),
      trim: new PIXI.Rectangle(tx, ty, w, h),
    });
    const et = new Texture({
      source: eSrc,
      frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      orig: new Rectangle(0, 0, ow, oh),
      trim: new Rectangle(tx, ty, w, h),
    });
    return [pt, et];
  }
  return [
    new PIXI.Texture({ source: pSrc, frame: new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h) }),
    new Texture({ source: eSrc, frame: new Rectangle(frame.x, frame.y, frame.w, frame.h) }),
  ];
}

function randomTransform(pair: Pair): void {
  const vals = {
    x: (rnd() - 0.5) * 200,
    y: (rnd() - 0.5) * 200,
    sx: rnd() < 0.2 ? -(0.5 + rnd()) : 0.5 + rnd() * 1.5,
    sy: rnd() < 0.2 ? -(0.5 + rnd()) : 0.5 + rnd() * 1.5,
    rot: rnd() < 0.5 ? 0 : (rnd() - 0.5) * 4,
    px: rnd() < 0.5 ? 0 : (rnd() - 0.5) * 20,
    py: rnd() < 0.5 ? 0 : (rnd() - 0.5) * 20,
    kx: rnd() < 0.8 ? 0 : (rnd() - 0.5),
    ky: rnd() < 0.8 ? 0 : (rnd() - 0.5),
  };
  for (const c of [pair.p, pair.e] as Array<PIXI.Container | Container>) {
    c.position.set(vals.x, vals.y);
    c.scale.set(vals.sx, vals.sy);
    c.rotation = vals.rot;
    c.pivot.set(vals.px, vals.py);
    c.skew.set(vals.kx, vals.ky);
  }
}

function makeLeaf(): Pair {
  const r = rnd();
  if (r < 0.5) {
    const [pt, et] = makeTex();
    const p = new PIXI.Sprite(pt);
    const e = new Sprite(et);
    if (rnd() < 0.5) {
      const ax = rnd();
      const ay = rnd();
      p.anchor.set(ax, ay);
      e.anchor.set(ax, ay);
    }
    return { p, e };
  }
  const p = new PIXI.Graphics();
  const e = new Graphics();
  const n = 1 + ri(3);
  for (let i = 0; i < n; i++) {
    const kind = ri(3);
    const x = (rnd() - 0.5) * 50;
    const y = (rnd() - 0.5) * 50;
    const w = 1 + rnd() * 40;
    const h = 1 + rnd() * 40;
    const stroke = rnd() < 0.4 ? 1 + ri(6) : 0;
    for (const g of [p, e] as Array<PIXI.Graphics | Graphics>) {
      if (kind === 0) g.rect(x, y, w, h);
      else if (kind === 1) g.circle(x, y, w / 2);
      else g.roundRect(x, y, w, h, 4);
      if (stroke) g.stroke({ width: stroke, color: 0xff0000, alignment: 0.5 });
      else g.fill({ color: 0xffffff });
    }
  }
  return { p, e };
}

function buildTree(depth: number): Pair {
  if (depth === 0 || rnd() < 0.3) {
    const leaf = makeLeaf();
    randomTransform(leaf);
    return leaf;
  }
  const p = new PIXI.Container();
  const e = new Container();
  const pair = { p, e };
  randomTransform(pair);
  const n = 1 + ri(3);
  for (let i = 0; i < n; i++) {
    const child = buildTree(depth - 1);
    p.addChild(child.p);
    e.addChild(child.e);
    if (rnd() < 0.15) {
      child.p.visible = false;
      child.e.visible = false;
    }
    if (rnd() < 0.1) {
      const b = new Rectangle(-5, -5, 30, 30);
      child.p.boundsArea = new PIXI.Rectangle(-5, -5, 30, 30);
      child.e.boundsArea = b;
    }
  }
  // mask on a random child with a sibling graphics mask
  if (rnd() < 0.3 && p.children.length) {
    const mg = new PIXI.Graphics().rect(-10, -10, 40, 30).fill(0xffffff);
    const eg = new Graphics().rect(-10, -10, 40, 30).fill(0xffffff);
    const mx = (rnd() - 0.5) * 30;
    mg.x = mx;
    eg.x = mx;
    p.addChild(mg);
    e.addChild(eg);
    const idx = ri(p.children.length - 1);
    p.children[idx].mask = mg;
    e.children[idx].mask = eg;
  }
  return pair;
}

const r4 = (b: { x: number; y: number; width: number; height: number }): number[] =>
  [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 1e4) / 1e4 + 0);

describe('bounds differential', () => {
  it('random trees', () => {
    const fails: string[] = [];
    for (let iter = 0; iter < 400; iter++) {
      const root = buildTree(3);
      const pStage = new PIXI.Container();
      const eStage = new Container();
      pStage.addChild(root.p);
      eStage.addChild(root.e);
      const pb = r4(root.p.getBounds());
      const eb = r4(root.e.getBounds());
      if (JSON.stringify(pb) !== JSON.stringify(eb)) fails.push(`it${iter} getBounds p=${pb} e=${eb}`);
      const plb = r4(root.p.getLocalBounds());
      const elb = r4(root.e.getLocalBounds());
      if (JSON.stringify(plb) !== JSON.stringify(elb)) fails.push(`it${iter} getLocalBounds p=${plb} e=${elb}`);
      const pw = [root.p.width, root.p.height].map((v) => Math.round(v * 1e4) / 1e4);
      const ew = [root.e.width, root.e.height].map((v) => Math.round(v * 1e4) / 1e4);
      if (JSON.stringify(pw) !== JSON.stringify(ew)) fails.push(`it${iter} size p=${pw} e=${ew}`);
      // deepest child toGlobal / toLocal
      let pc: PIXI.Container = root.p;
      let ec: Container = root.e;
      while (pc.children.length) {
        pc = pc.children[0];
        ec = ec.children[0];
      }
      const pg = pc.toGlobal({ x: 3, y: 7 });
      const eg = ec.toGlobal({ x: 3, y: 7 });
      if (Math.abs(pg.x - eg.x) > 1e-6 || Math.abs(pg.y - eg.y) > 1e-6) fails.push(`it${iter} toGlobal`);
      const pl = pc.toLocal({ x: 11, y: -4 });
      const el = ec.toLocal({ x: 11, y: -4 });
      if (Math.abs(pl.x - el.x) > 1e-6 || Math.abs(pl.y - el.y) > 1e-6) fails.push(`it${iter} toLocal`);
      // set width on root and compare scale
      const target = 10 + rnd() * 100;
      root.p.width = target;
      root.e.width = target;
      if (Math.abs(root.p.scale.x - root.e.scale.x) > 1e-6) fails.push(`it${iter} width= scale p=${root.p.scale.x} e=${root.e.scale.x}`);
    }
    console.log(fails.slice(0, 30).join('\n'));
    expect(fails.length).toBe(0);
  });
});
