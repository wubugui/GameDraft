/**
 * Culler 与 PixiJS 8.17 对照:同一棵场景树(随机生成、同一种子)分别在 pixi.js 与 engine2d 里搭出来,
 * 连续对几个视口做剔除,逐节点比较 culled。
 *
 * Pixi 缺省 `skipUpdateTransform = true` 读的是上一次渲染留下的 worldTransform:对照时先用
 * `updateRenderGroupTransforms` 把 Pixi 的变换算到最新(等价于"刚渲染过一帧"),再跑缺省参数;
 * 另外也对照 `skipUpdateTransform = false`(现算)。engine2d 两种取值都读当前变换。
 */
import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { Culler } from './Culler';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { Rectangle } from '../math/Rectangle';

interface NodeDesc {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
  sprite: { w: number; h: number; ax: number; ay: number } | null;
  boundsArea: [number, number, number, number] | null;
  cullArea: [number, number, number, number] | null;
  cullable: boolean;
  cullableChildren: boolean;
  visible: boolean;
  renderable: boolean;
  children: NodeDesc[];
}

/** 确定性伪随机(mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genTree(r: () => number, depth: number): NodeDesc {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const n: NodeDesc = {
    x: Math.round((r() - 0.3) * 900),
    y: Math.round((r() - 0.3) * 700),
    scaleX: pick([1, 1, 0.5, 2, -1, 1.5]),
    scaleY: pick([1, 1, 0.5, 2, -1, 0.75]),
    rotation: pick([0, 0, 0, 0.3, -1.2, Math.PI / 2, 2.5]),
    pivotX: pick([0, 0, 10, -20]),
    pivotY: pick([0, 0, 15]),
    sprite: r() < 0.6 ? { w: pick([16, 64, 128, 300]), h: pick([16, 48, 200]), ax: pick([0, 0.5, 1]), ay: pick([0, 0.5, 1]) } : null,
    boundsArea: r() < 0.1 ? [pick([-50, 0]), pick([-30, 0]), pick([40, 100]), pick([40, 90])] : null,
    cullArea: r() < 0.25 ? [pick([-40, 0, 10]), pick([-20, 0]), pick([30, 80, 160]), pick([30, 60, 120])] : null,
    cullable: r() < 0.75,
    cullableChildren: r() < 0.85,
    visible: r() < 0.92,
    renderable: r() < 0.92,
    children: [],
  };
  if (depth > 0) {
    const count = Math.floor(r() * 4);
    for (let i = 0; i < count; i++) n.children.push(genTree(r, depth - 1));
  }
  return n;
}

interface Lib {
  Container: new () => AnyNode;
  makeSprite: (w: number, h: number, ax: number, ay: number) => AnyNode;
  Rectangle: new (x: number, y: number, w: number, h: number) => unknown;
}

/** 两个库的节点共有的那部分接口 */
interface AnyNode {
  x: number;
  y: number;
  rotation: number;
  scale: { set(x: number, y: number): void };
  pivot: { set(x: number, y: number): void };
  boundsArea?: unknown;
  cullArea: unknown;
  cullable: boolean;
  cullableChildren: boolean;
  visible: boolean;
  renderable: boolean;
  culled: boolean;
  children: AnyNode[];
  addChild(child: AnyNode): unknown;
}

const pixiLib: Lib = {
  Container: PIXI.Container as unknown as Lib['Container'],
  makeSprite: (w, h, ax, ay) => {
    const tex = new PIXI.Texture({ source: new PIXI.TextureSource({ width: w, height: h }) });
    const s = new PIXI.Sprite(tex);
    s.anchor.set(ax, ay);
    return s as unknown as AnyNode;
  },
  Rectangle: PIXI.Rectangle as unknown as Lib['Rectangle'],
};

const e2dLib: Lib = {
  Container: Container as unknown as Lib['Container'],
  makeSprite: (w, h, ax, ay) => {
    const tex = new Texture({ source: new TextureSource({ width: w, height: h }) });
    const s = new Sprite(tex);
    s.anchor.set(ax, ay);
    return s as unknown as AnyNode;
  },
  Rectangle: Rectangle as unknown as Lib['Rectangle'],
};

function build(lib: Lib, d: NodeDesc, root?: AnyNode): AnyNode {
  const node = root ?? (d.sprite ? lib.makeSprite(d.sprite.w, d.sprite.h, d.sprite.ax, d.sprite.ay) : new lib.Container());
  node.x = d.x;
  node.y = d.y;
  node.scale.set(d.scaleX, d.scaleY);
  node.rotation = d.rotation;
  node.pivot.set(d.pivotX, d.pivotY);
  if (d.boundsArea) node.boundsArea = new lib.Rectangle(...d.boundsArea);
  if (d.cullArea) node.cullArea = new lib.Rectangle(...d.cullArea);
  node.cullable = d.cullable;
  node.cullableChildren = d.cullableChildren;
  node.visible = d.visible;
  node.renderable = d.renderable;
  for (const c of d.children) node.addChild(build(lib, c));
  return node;
}

function collect(node: AnyNode, out: boolean[] = []): boolean[] {
  out.push(node.culled);
  for (const c of node.children) collect(c, out);
  return out;
}

const VIEWS = [
  { x: 0, y: 0, width: 800, height: 600 },
  { x: -200, y: 150, width: 400, height: 300 },
  { x: 500, y: -100, width: 300, height: 900 },
  { x: 100, y: 100, width: 1, height: 1 },
];

/** 场景根:一个不剔除的舞台(Pixi 那边是渲染组,才能用 updateRenderGroupTransforms 把变换算到最新) */
function buildScene(lib: Lib, desc: NodeDesc, pixi: boolean): AnyNode {
  const stage = pixi
    ? (new PIXI.Container({ isRenderGroup: true }) as unknown as AnyNode)
    : new lib.Container();
  // 舞台自己带一点变换,覆盖"父链变换"这条路径
  stage.x = 37;
  stage.y = -12;
  stage.scale.set(1.25, 0.8);
  stage.addChild(build(lib, desc));
  return stage;
}

describe('Culler(对照 pixi.js 8.17)', () => {
  it('随机场景树:skipUpdateTransform = false 时每个节点的 culled 与 Pixi 相同', () => {
    let culledCount = 0;
    let keptCount = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const desc = genTree(rng(seed), 4);
      const pixiStage = buildScene(pixiLib, desc, true);
      const e2dStage = buildScene(e2dLib, desc, false);
      for (const view of VIEWS) {
        PIXI.Culler.shared.cull(pixiStage as unknown as PIXI.Container, view, false);
        Culler.shared.cull(e2dStage as unknown as Container, view, false);
        const flags = collect(e2dStage);
        expect(flags, `seed ${seed} view ${JSON.stringify(view)}`).toEqual(collect(pixiStage));
        for (const f of flags) f ? culledCount++ : keptCount++;
      }
    }
    // 对照要有意义:两种结果都得大量出现
    expect(culledCount).toBeGreaterThan(50);
    expect(keptCount).toBeGreaterThan(50);
  });

  it('随机场景树:缺省参数(Pixi 先把变换算到最新)与 Pixi 相同', () => {
    for (let seed = 101; seed <= 160; seed++) {
      const desc = genTree(rng(seed), 4);
      const pixiStage = buildScene(pixiLib, desc, true);
      const e2dStage = buildScene(e2dLib, desc, false);
      const group = (pixiStage as unknown as { renderGroup: Parameters<typeof PIXI.updateRenderGroupTransforms>[0] }).renderGroup;
      // 与 Pixi 的 AbstractRenderer.render 相同:先更新根的本地变换,再算整个渲染组
      (pixiStage as unknown as PIXI.Container).updateLocalTransform();
      PIXI.updateRenderGroupTransforms(group, true);
      for (const view of VIEWS) {
        PIXI.Culler.shared.cull(pixiStage as unknown as PIXI.Container, view);
        Culler.shared.cull(e2dStage as unknown as Container, view);
        expect(collect(e2dStage), `seed ${seed} view ${JSON.stringify(view)}`).toEqual(collect(pixiStage));
      }
    }
  });

  it('游戏的用法:entityLayer 下逐个 cullable、视口外扩后剔除', () => {
    const layer = new Container();
    const inside = new Sprite(new Texture({ source: new TextureSource({ width: 50, height: 50 }) }));
    inside.position.set(100, 100);
    const outside = new Sprite(new Texture({ source: new TextureSource({ width: 50, height: 50 }) }));
    outside.position.set(2000, 100);
    const player = new Sprite(new Texture({ source: new TextureSource({ width: 50, height: 50 }) }));
    player.position.set(5000, 5000);
    layer.addChild(inside, outside, player);
    for (const c of layer.children) c.cullable = c !== player;
    const screen = new Rectangle(0, 0, 800, 600);
    const view = screen.clone().pad(screen.width * 0.25, screen.height * 0.25);
    Culler.shared.cull(layer, view);
    expect(layer.culled).toBe(false);
    expect(inside.culled).toBe(false);
    expect(outside.culled).toBe(true);
    expect(player.culled).toBe(false);
    // 关掉剔除:cullable=false 的节点一律 culled=false
    outside.cullable = false;
    Culler.shared.cull(layer, view);
    expect(outside.culled).toBe(false);
  });

  it('父节点被剔除时不再往下走:子节点保留上次的 culled(同 Pixi)', () => {
    const parent = new Container();
    parent.cullable = true;
    parent.cullArea = new Rectangle(0, 0, 10, 10);
    const child = new Sprite(new Texture({ source: new TextureSource({ width: 10, height: 10 }) }));
    child.cullable = true;
    child.position.set(1000, 0);
    parent.addChild(child);
    Culler.shared.cull(parent, { x: 0, y: 0, width: 100, height: 100 });
    expect(parent.culled).toBe(false);
    expect(child.culled).toBe(true);
    parent.x = 5000;
    child.x = 0;
    Culler.shared.cull(parent, { x: 0, y: 0, width: 100, height: 100 });
    expect(parent.culled).toBe(true);
    expect(child.culled).toBe(true); // 没被重新判定
  });
});
