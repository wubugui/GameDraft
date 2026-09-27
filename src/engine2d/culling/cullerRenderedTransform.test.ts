/**
 * Culler 缺省参数(`skipUpdateTransform = true`)读**上一次渲染时**的世界变换,与 Pixi 8.17 逐节点相同。
 *
 * Pixi 的 `worldTransform` 只在渲染时(updateRenderGroupTransforms)更新:渲染之后逻辑里挪过的节点、这一帧才加进来的节点
 * (relativeGroupTransform 还是初值单位阵)、藏着(visible=false)时挪过的节点,Culler 看到的都是渲染那一刻的变换。
 * 游戏每帧在逻辑里调 `Culler.shared.cull(entityLayer, view)`,正好落在"上一帧渲染之后、这一帧渲染之前"。
 *
 * 真机来源(2026-09-28 A/B 对照 feature__fg__跑马梁 / feature__strike__雾津街头 的 strike+120):落雷那一帧新建的
 * 粒子网格里,满载的那两张(impact_core / impact_hot,max = 1)包围盒就是那一颗粒子;master 按单位阵把场景坐标当屏幕坐标,
 * 在画面外扩视口之外 ⇒ 第一帧被剔掉;engine2d 以前读当帧变换、照画,于是落点多一团白光。
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../scene/Container';
import { Graphics } from '../graphics/Graphics';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { Rectangle } from '../math/Rectangle';
import { prepareTree } from '../gpu/collect';
import { Culler } from './Culler';

type View = { x: number; y: number; width: number; height: number };

/** 同 Game.updateFrustumCulling:screen 外扩 0.2 */
const gameView = (): View => new Rectangle(0, 0, 1024, 768).pad(1024 * 0.2, 768 * 0.2);

/** 两边各一棵:Pixi 的舞台是渲染组(才能 updateRenderGroupTransforms),engine2d 的是普通容器 */
interface Pair {
  pixiStage: PIXI.Container;
  e2dStage: Container;
  pixiLayer: PIXI.Container;
  e2dLayer: Container;
}

let tick = 1000;
/** "渲染一帧"的变换那一半:Pixi = AbstractRenderer.render 里的 updateLocalTransform + updateRenderGroupTransforms;engine2d = prepareTree */
function renderBoth(p: Pair): void {
  p.pixiStage.updateLocalTransform();
  PIXI.updateRenderGroupTransforms((p.pixiStage as unknown as { renderGroup: Parameters<typeof PIXI.updateRenderGroupTransforms>[0] }).renderGroup, true);
  prepareTree(p.e2dStage, null, ++tick);
}

function makePair(): Pair {
  const pixiStage = new PIXI.Container({ isRenderGroup: true });
  const e2dStage = new Container();
  const pixiWorld = new PIXI.Container();
  const e2dWorld = new Container();
  const pixiLayer = new PIXI.Container();
  const e2dLayer = new Container();
  pixiStage.addChild(pixiWorld);
  e2dStage.addChild(e2dWorld);
  pixiWorld.addChild(pixiLayer);
  e2dWorld.addChild(e2dLayer);
  return { pixiStage, e2dStage, pixiLayer, e2dLayer };
}

function sprites(w: number, h: number): [PIXI.Sprite, Sprite] {
  const ps = new PIXI.Sprite(new PIXI.Texture({ source: new PIXI.TextureSource({ width: w, height: h }) }));
  const es = new Sprite(new Texture({ source: new TextureSource({ width: w, height: h }) }));
  ps.anchor.set(0.5, 0.5);
  es.anchor.set(0.5, 0.5);
  return [ps, es];
}

function cullBoth(p: Pair, view: View): void {
  for (const c of p.pixiLayer.children) c.cullable = true;
  for (const c of p.e2dLayer.children) c.cullable = true;
  PIXI.Culler.shared.cull(p.pixiLayer, view);
  Culler.shared.cull(p.e2dLayer, view);
}

describe('Culler 缺省参数读上一次渲染时的世界变换(同 Pixi 8.17)', () => {
  it('这一帧才加进来、还没渲染过的节点:变换按单位阵判(落雷第一帧的满载粒子网格)', () => {
    const p = makePair();
    // 跑马梁 strike+120 那一帧:worldContainer 的相机变换 = 缩放 1.28、平移 (-1127.147, -298.583)
    for (const w of [p.pixiLayer.parent!, p.e2dLayer.parent!]) {
      w.scale.set(1.28, 1.28);
      w.position.set(-1127.147, -298.583);
    }
    // 粒子批网格:节点在原点、顶点直接是场景坐标(VfxBatchMesh)。这里用同样"几何在场景坐标"的图形代替
    const quad = (g: { rect(x: number, y: number, w: number, h: number): { fill(c: number): unknown } }, x: number, y: number, s: number) =>
      g.rect(x - s / 2, y - s / 2, s, s).fill(0xffffff);
    const pOld = new PIXI.Graphics();
    const eOld = new Graphics();
    quad(pOld, 1300, 450, 60);
    quad(eOld, 1300, 450, 60);
    p.pixiLayer.addChild(pOld);
    p.e2dLayer.addChild(eOld);
    renderBoth(p);
    // 逻辑里新建:impact_core 那一颗在场景 (1446.5, 359.2)、边长约 92 —— 相机变换后在画面 (724, 161),明明在画面里
    const pNew = new PIXI.Graphics();
    const eNew = new Graphics();
    quad(pNew, 1446.5, 359.2, 92);
    quad(eNew, 1446.5, 359.2, 92);
    // 没有落在原点的空槽时包围盒就是这一颗(有空槽的网格 max > 已用,空槽缩在 (0,0),包围盒被撑进画面、不会被剔)
    const pSlack = new PIXI.Graphics();
    const eSlack = new Graphics();
    quad(pSlack, 1446.5, 359.2, 20);
    quad(eSlack, 1446.5, 359.2, 20);
    quad(pSlack, 0, 0, 0.001);
    quad(eSlack, 0, 0, 0.001);
    p.pixiLayer.addChild(pNew, pSlack);
    p.e2dLayer.addChild(eNew, eSlack);
    cullBoth(p, gameView());
    expect([pNew.culled, pSlack.culled, pOld.culled]).toEqual([true, false, false]);
    expect([eNew.culled, eSlack.culled, eOld.culled]).toEqual([true, false, false]);
    // 渲染过一帧之后按真实位置判:在画面里
    renderBoth(p);
    cullBoth(p, gameView());
    expect([pNew.culled, eNew.culled]).toEqual([false, false]);
  });

  it('这一帧才加进来的节点自己的位置也不算(单位阵),与 Pixi 相同', () => {
    const p = makePair();
    const [ps, es] = sprites(50, 50);
    ps.position.set(5000, 5000);
    es.position.set(5000, 5000);
    renderBoth(p);
    p.pixiLayer.addChild(ps);
    p.e2dLayer.addChild(es);
    cullBoth(p, gameView());
    expect([ps.culled, es.culled]).toEqual([false, false]);
    renderBoth(p);
    cullBoth(p, gameView());
    expect([ps.culled, es.culled]).toEqual([true, true]);
  });

  it('渲染之后逻辑里挪过的节点晚一帧反映;现算参数(false)不受影响', () => {
    const p = makePair();
    const [ps, es] = sprites(40, 80);
    ps.position.set(500, 300);
    es.position.set(500, 300);
    p.pixiLayer.addChild(ps);
    p.e2dLayer.addChild(es);
    renderBoth(p);
    ps.x = es.x = 5000;
    cullBoth(p, gameView());
    expect([ps.culled, es.culled]).toEqual([false, false]);
    PIXI.Culler.shared.cull(p.pixiLayer, gameView(), false);
    Culler.shared.cull(p.e2dLayer, gameView(), false);
    expect([ps.culled, es.culled]).toEqual([true, true]);
    renderBoth(p);
    cullBoth(p, gameView());
    expect([ps.culled, es.culled]).toEqual([true, true]);
  });

  it('藏着(Pixi visible=false / engine2d setActive(false))时挪过、这一帧才露面:按藏着那次渲染算好的位置判', () => {
    for (const [hiddenX, shownX] of [[5000, 400], [400, 5000], [3000, 3000]]) {
      const p = makePair();
      const pn = new PIXI.Container();
      const en = new Container();
      const [ps, es] = sprites(40, 80);
      pn.addChild(ps);
      en.addChild(es);
      p.pixiLayer.addChild(pn);
      p.e2dLayer.addChild(en);
      pn.x = en.x = 300;
      renderBoth(p);
      pn.visible = false;
      en.setActive(false);
      pn.x = en.x = hiddenX;
      renderBoth(p);
      pn.visible = true;
      en.setActive(true);
      pn.x = en.x = shownX;
      cullBoth(p, gameView());
      expect(en.culled, `藏着挪到 ${hiddenX}、露面挪到 ${shownX}`).toBe(pn.culled);
    }
  });

  it('随机树:渲染后随机挪动 / 新加 / 藏起节点,每个节点的 culled 与 Pixi 相同', () => {
    let seed = 7;
    const r = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let culled = 0;
    let kept = 0;
    for (let round = 0; round < 40; round++) {
      const p = makePair();
      const pw = p.pixiLayer.parent!;
      const ew = p.e2dLayer.parent!;
      const sx = 0.5 + r() * 1.5;
      pw.scale.set(sx, sx);
      ew.scale.set(sx, sx);
      pw.position.set((r() - 0.5) * 2000, (r() - 0.5) * 1200);
      ew.position.copyFrom(pw.position);
      const pairs: [PIXI.Container, Container][] = [];
      const add = (): void => {
        const pc = new PIXI.Container();
        const ec = new Container();
        const [ps, es] = sprites(10 + Math.floor(r() * 200), 10 + Math.floor(r() * 200));
        const cx = Math.round((r() - 0.25) * 3000);
        const cy = Math.round((r() - 0.25) * 2000);
        ps.position.set(cx, cy);
        es.position.set(cx, cy);
        pc.addChild(ps);
        ec.addChild(es);
        p.pixiLayer.addChild(pc);
        p.e2dLayer.addChild(ec);
        pairs.push([pc, ec]);
      };
      for (let i = 0; i < 12; i++) add();
      renderBoth(p);
      for (const [pc, ec] of pairs) {
        const k = r();
        if (k < 0.3) {
          pc.x = ec.x = Math.round((r() - 0.5) * 4000);
        } else if (k < 0.45) {
          pc.visible = false;
          ec.setActive(false);
        }
      }
      if (r() < 0.5) {
        pw.x += 300;
        ew.x += 300;
      }
      for (let i = 0; i < 4; i++) add();
      cullBoth(p, gameView());
      for (let i = 0; i < pairs.length; i++) {
        expect(pairs[i][1].culled, `round ${round} node ${i}`).toBe(pairs[i][0].culled);
        pairs[i][1].culled ? culled++ : kept++;
      }
      // 再渲染一帧(藏着的照样算变换),露面后再判一次
      renderBoth(p);
      for (const [pc, ec] of pairs) {
        if (!pc.visible) {
          pc.x = ec.x = Math.round((r() - 0.5) * 4000);
        }
      }
      renderBoth(p);
      for (const [pc, ec] of pairs) {
        pc.visible = true;
        ec.setActive(true);
      }
      cullBoth(p, gameView());
      for (let i = 0; i < pairs.length; i++) {
        expect(pairs[i][1].culled, `round ${round} node ${i}(露面后)`).toBe(pairs[i][0].culled);
      }
    }
    expect(culled).toBeGreaterThan(50);
    expect(kept).toBeGreaterThan(50);
  });
});
