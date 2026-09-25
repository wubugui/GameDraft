/**
 * D8 未激活节点的剔除与 Pixi 8.17 对照:master 用 `visible = false` 隐藏 NPC / 热点,Pixi 的 Culler 没有可见性判断,
 * 对它照样算——getGlobalBounds 给空盒、归一成 (0,0,0,0) 再与 view 比;不可剔除的节点 culled = false;子节点照常往下走。
 * engine2d 的"在场"改成了 setActive(false),这里要求 setActive(false) 的剔除结果与 Pixi 的 visible=false 逐项相同。
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { Rectangle } from '../math/Rectangle';
import { Culler } from './Culler';

type View = { x: number; y: number; width: number; height: number };

/** 同 Game.updateFrustumCulling:实体层的子节点可剔除,view = screen 外扩 */
const paddedView = (): View => new Rectangle(0, 0, 800, 600).pad(200, 150);
const screenView = (): View => new Rectangle(0, 0, 800, 600);

function run(view: View, startX: number, cullable: boolean): { mine: boolean[]; pixi: boolean[]; mineChild: boolean[]; pixiChild: boolean[] } {
  const layer = new Container();
  const npc = new Container();
  const s = new Sprite(Texture.WHITE);
  s.width = 40;
  s.height = 80;
  s.cullable = true;
  npc.addChild(s);
  layer.addChild(npc);
  npc.cullable = cullable;
  npc.x = startX;

  const pl = new PIXI.Container();
  const pn = new PIXI.Container();
  const ps = new PIXI.Sprite(PIXI.Texture.WHITE);
  ps.width = 40;
  ps.height = 80;
  ps.cullable = true;
  pn.addChild(ps);
  pl.addChild(pn);
  pn.cullable = cullable;
  pn.x = startX;

  const mine: boolean[] = [];
  const pixi: boolean[] = [];
  const mineChild: boolean[] = [];
  const pixiChild: boolean[] = [];
  const step = (): void => {
    Culler.shared.cull(layer, view);
    PIXI.Culler.shared.cull(pl, view, false);
    mine.push(npc.culled);
    pixi.push(pn.culled);
    mineChild.push(s.culled);
    pixiChild.push(ps.culled);
  };
  step();
  npc.setActive(false);
  pn.visible = false;
  npc.x = pn.x = 400;
  step();
  npc.x = pn.x = 3000;
  step();
  npc.setActive(true);
  pn.visible = true;
  npc.x = pn.x = 400;
  step();
  return { mine, pixi, mineChild, pixiChild };
}

describe('D8 Culler 对未激活节点的结果同 Pixi 的 visible=false', () => {
  for (const [name, view] of [['外扩视口(游戏用法)', paddedView()], ['原点视口', screenView()]] as const) {
    for (const startX of [2000, 400]) {
      for (const cullable of [true, false]) {
        it(`${name} 起点 x=${startX} cullable=${cullable}`, () => {
          const r = run(view, startX, cullable);
          expect(r.mine).toEqual(r.pixi);
          expect(r.mineChild).toEqual(r.pixiChild);
        });
      }
    }
  }

  it('原点视口下可剔除的未激活节点 culled = true(空盒 (0,0,0,0) 贴边算外),与 Pixi 相同', () => {
    const r = run(screenView(), 400, true);
    expect(r.pixi[1]).toBe(true);
    expect(r.mine[1]).toBe(true);
  });

  it('外扩视口下先被剔除、再 setActive(false) 挪进画面:culled 变回 false(不留旧值)', () => {
    const r = run(paddedView(), 2000, true);
    expect(r.pixi.slice(0, 2)).toEqual([true, false]);
    expect(r.mine.slice(0, 2)).toEqual([true, false]);
  });
});
