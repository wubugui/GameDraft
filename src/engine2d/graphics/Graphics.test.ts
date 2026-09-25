/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Graphics 节点对照测试:渲染输出(BatchableElement)按 Pixi DefaultBatcher 的打包公式打成顶点 / 索引流,
 * 与 Pixi 自己的 BatchableGraphics(GraphicsPipe 为节点复制的那份)逐数比较;另比 bounds、containsPoint、
 * 颜色(tint / alpha / BGR 字节序)、clear 后重画、共享 context、destroy 选项。
 */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { BatchableElement, CustomDrawable, RenderCollector } from '../core/contracts';
import { Matrix } from '../math/Matrix';
import { Container } from '../scene/Container';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { Graphics } from './Graphics';
import { GraphicsContext } from './GraphicsContext';

class FakeCollector implements RenderCollector {
  readonly resolution = 1;
  elements: BatchableElement[] = [];
  addBatchable(element: BatchableElement): void {
    this.elements.push(element);
  }
  addCustom(_d: CustomDrawable): void {
    throw new Error('Graphics 不该交自定义绘制');
  }
  unbatchedNodes: unknown[] = [];
  addUnbatched(node: unknown, elements: readonly BatchableElement[]): void {
    this.unbatchedNodes.push(node);
    this.elements.push(...elements);
  }
  pushFilter(): void {}
  popFilter(): void {}
  pushMask(): void {}
  popMask(): void {}
}

/** 照 Pixi DefaultBatcher.packAttributes / Batcher.packIndex 把元素打成一条流(textureId 固定 0) */
function pack(elements: any[]): { f32: number[]; u32: number[]; indices: number[]; meta: unknown[] } {
  const f32: number[] = [];
  const u32: number[] = [];
  const indices: number[] = [];
  const meta: unknown[] = [];
  const view = new Float32Array(1);
  const uview = new Uint32Array(1);
  let vertexCount = 0;
  for (const el of elements) {
    const wt = el.transform;
    const { positions, uvs } = el;
    const argb = el.color;
    const offset = el.attributeOffset;
    const end = offset + el.attributeSize;
    for (let i = offset; i < end; i++) {
      const i2 = i * 2;
      const x = positions[i2];
      const y = positions[i2 + 1];
      view[0] = wt.a * x + wt.c * y + wt.tx;
      f32.push(view[0]);
      view[0] = wt.d * y + wt.b * x + wt.ty;
      f32.push(view[0]);
      view[0] = uvs[i2];
      f32.push(view[0]);
      view[0] = uvs[i2 + 1];
      f32.push(view[0]);
      uview[0] = argb;
      u32.push(uview[0]);
      uview[0] = (0 << 16) | (el.roundPixels & 65535);
      u32.push(uview[0]);
    }
    for (let i = 0; i < el.indexSize; i++) {
      indices.push(vertexCount + el.indices[i + el.indexOffset] - el.attributeOffset);
    }
    vertexCount += el.attributeSize;
    meta.push({ packAsQuad: el.packAsQuad, topology: el.topology, blendMode: el.blendMode, texW: el.texture.source.width });
  }
  return { f32, u32, indices, meta };
}

/**
 * Pixi 这边:可合批时照 GraphicsPipe._updateBatchesForRenderable(context 区段复制一份挂到节点);
 * 不可合批(顶点 ≥ 200)时照 GraphicsContextSystem._initContextRenderData,直接用 context 层区段
 * (本地坐标、颜色不乘节点,节点量在着色器里乘)。
 */
function pixiElements(pg: PIXI.Graphics, roundPixels = 0): any[] {
  const gpu = new PIXI.GpuGraphicsContext();
  PIXI.buildContextBatches(pg.context, gpu);
  gpu.isBatchable = isBatchableLikePixi(pg.context, gpu);
  if (!gpu.isBatchable) {
    for (const b of gpu.batches as any[]) b.applyTransform = false;
    return gpu.batches;
  }
  return gpu.batches.map((batch: any) => {
    const clone = new PIXI.BatchableGraphics();
    batch.copyTo(clone);
    clone.renderable = pg;
    clone.roundPixels = roundPixels as 0 | 1;
    return clone;
  });
}

/** 照 Pixi GraphicsContextSystem.updateGpuContext 的判定:auto 下顶点浮点数 < 400(即 < 200 个顶点) */
function isBatchableLikePixi(context: any, gpu: any): boolean {
  if (context.customShader || context.batchMode === 'no-batch') return false;
  if (context.batchMode === 'auto') return gpu.geometryData.vertices.length < 400;
  return true;
}

function collect(g: Graphics): BatchableElement[] {
  const c = new FakeCollector();
  g.collectRenderables(c);
  return c.elements;
}

type Draw = (g: any) => void;

const draws: Record<string, Draw> = {
  '面板:圆角底 + 描边 + 细线(>200 顶点,Pixi 非合批)': (g) => {
    g.roundRect(0, 0, 320, 180, 8).fill({ color: 0x1a1410, alpha: 0.92 }).stroke({ color: 0xc8a050, width: 1.5, alpha: 0.8 });
    g.moveTo(12, 40).lineTo(308, 40).stroke({ color: 0xc8b89a, width: 1, alpha: 0.3 });
  },
  '按钮:矩形 + 圆点 + 三角箭头': (g) => {
    g.rect(0, 0, 120, 32).fill({ color: 0x2a2018, alpha: 0.85 });
    g.circle(12, 16, 3).fill(0xd8b060);
    g.moveTo(100, 10).lineTo(110, 16).lineTo(100, 22).closePath().fill(0xffffff);
  },
  '星 + 洞 + 描边': (g) => {
    g.star(40, 40, 5, 30, 12).fill(0xffd700).stroke({ width: 3, color: 0x442200, join: 'round' });
    g.rect(100, 0, 80, 80).fill(0x3366aa).circle(140, 40, 15).cut();
  },
};

function setGroup(target: any, color: number, alpha: number, transform: { a: number; b: number; c: number; d: number; tx: number; ty: number }, blendMode: string): void {
  target.groupColor = color;
  target.groupAlpha = alpha;
  target.groupColorAlpha = color + ((alpha * 255) << 24);
  target.groupTransform.a = transform.a;
  target.groupTransform.b = transform.b;
  target.groupTransform.c = transform.c;
  target.groupTransform.d = transform.d;
  target.groupTransform.tx = transform.tx;
  target.groupTransform.ty = transform.ty;
  target.groupBlendMode = blendMode;
}

const groups: Array<[string, number, number, { a: number; b: number; c: number; d: number; tx: number; ty: number }, string]> = [
  ['恒等', 0xffffff, 1, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 'normal'],
  ['平移缩放 + 半透明', 0xffffff, 0.5, { a: 1.5, b: 0, c: 0, d: 1.5, tx: 33.25, ty: -7.5 }, 'normal'],
  ['旋转 + tint(BGR) + alpha 0.37 + add', 0x3080ff, 0.37, { a: Math.cos(0.4), b: Math.sin(0.4), c: -Math.sin(0.4), d: Math.cos(0.4), tx: 100, ty: 50 }, 'add'],
  ['黑色 tint', 0x000000, 1, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 'multiply'],
];

describe('Graphics 渲染输出与 Pixi 对照', () => {
  for (const [drawName, draw] of Object.entries(draws)) {
    for (const [groupName, color, alpha, transform, blend] of groups) {
      it(`${drawName} × ${groupName}`, () => {
        const pg = new PIXI.Graphics();
        const eg = new Graphics();
        draw(pg);
        draw(eg);
        setGroup(pg, color, alpha, transform, blend);
        setGroup(eg, color, alpha, transform, blend);
        const pEls = pixiElements(pg);
        const c = new FakeCollector();
        eg.collectRenderables(c);
        const eEls = c.elements;
        const unbatched = c.unbatchedNodes.length > 0;
        // 与 Pixi 同一判定:顶点 ≥ 200 的走非合批(本地坐标,节点量在着色器里乘)
        expect(unbatched).toBe(!eg.batched);
        expect(eEls.length).toBe(pEls.length);
        for (const el of eEls) {
          expect(el.packAsQuad).toBe(false);
          if (unbatched) expect(c.unbatchedNodes[0]).toBe(eg);
          else expect(el.transform).toBe(eg.groupTransform);
          expect(el.positions).toBe(eEls[0].positions);
        }
        const p = pack(pEls);
        const e = pack(eEls);
        expect(e.f32).toEqual(p.f32);
        expect(e.u32).toEqual(p.u32);
        expect(e.indices).toEqual(p.indices);
        expect(e.meta).toEqual(p.meta);
      });
    }
  }

  it('roundPixels 取节点当前值', () => {
    const eg = new Graphics({ roundPixels: true });
    eg.rect(0, 0, 10, 10).fill(0xffffff);
    expect(collect(eg).every((el) => el.roundPixels === 1)).toBe(true);
    eg.roundPixels = false;
    expect(collect(eg).every((el) => el.roundPixels === 0)).toBe(true);
  });

  it('纹理填充:texture 字段指向填充纹理,纯色为 Texture.WHITE', () => {
    const tex = new Texture({ source: new TextureSource({ width: 16, height: 16 }) });
    const eg = new Graphics();
    eg.rect(0, 0, 10, 10).fill(0xff0000).rect(20, 0, 10, 10).fill({ texture: tex });
    const els = collect(eg);
    expect(els[0].texture).toBe(Texture.WHITE);
    expect(els[1].texture).toBe(tex);
  });

  it('pixelLine 的拓扑是 line-list', () => {
    const eg = new Graphics();
    eg.moveTo(0, 0).lineTo(10, 10).stroke({ pixelLine: true, color: 0xffffff });
    expect(collect(eg)[0].topology).toBe('line-list');
  });
});

describe('Graphics 节点行为', () => {
  it('bounds / getLocalBounds / getBounds / width / height 与 Pixi 相同', () => {
    for (const draw of Object.values(draws)) {
      const pParent = new PIXI.Container();
      const eParent = new Container();
      pParent.position.set(13, -7);
      eParent.position.set(13, -7);
      pParent.scale.set(1.25, 0.8);
      eParent.scale.set(1.25, 0.8);
      const pg = pParent.addChild(new PIXI.Graphics());
      const eg = eParent.addChild(new Graphics());
      pg.rotation = 0.3;
      eg.rotation = 0.3;
      draw(pg);
      draw(eg);
      const pb = pg.bounds;
      const eb = eg.bounds;
      expect([eb.minX, eb.minY, eb.maxX, eb.maxY]).toEqual([pb.minX, pb.minY, pb.maxX, pb.maxY]);
      const pl = pg.getLocalBounds();
      const el = eg.getLocalBounds();
      expect([el.minX, el.minY, el.maxX, el.maxY]).toEqual([pl.minX, pl.minY, pl.maxX, pl.maxY]);
      const pw = pg.getBounds();
      const ew = eg.getBounds();
      expect([ew.minX, ew.minY, ew.maxX, ew.maxY]).toEqual([pw.minX, pw.minY, pw.maxX, pw.maxY]);
      expect([eg.width, eg.height]).toEqual([pg.width, pg.height]);
    }
  });

  it('containsPoint(本地坐标,含描边、除洞)与 Pixi 相同', () => {
    for (const draw of Object.values(draws)) {
      const pg = new PIXI.Graphics();
      const eg = new Graphics();
      draw(pg);
      draw(eg);
      const b = pg.bounds;
      const pHits: boolean[] = [];
      const eHits: boolean[] = [];
      for (let j = 0; j <= 50; j++) {
        for (let i = 0; i <= 50; i++) {
          const pt = { x: b.minX - 4 + ((b.maxX - b.minX + 8) * i) / 50, y: b.minY - 4 + ((b.maxY - b.minY + 8) * j) / 50 };
          pHits.push(pg.containsPoint(pt));
          eHits.push(eg.containsPoint(pt));
        }
      }
      expect(eHits).toEqual(pHits);
      expect(eHits.some(Boolean)).toBe(true);
    }
  });

  it('clear 后重画:区段跟着重建', () => {
    const eg = new Graphics();
    eg.rect(0, 0, 10, 10).fill(0xff0000).circle(30, 5, 5).fill(0x00ff00);
    expect(collect(eg).length).toBe(2);
    eg.clear();
    expect(collect(eg).length).toBe(0);
    const b = eg.getLocalBounds();
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 0, 0]);
    eg.roundRect(0, 0, 40, 20, 4).fill({ color: 0x123456, alpha: 0.5 });
    const els = collect(eg);
    expect(els.length).toBe(1);
    const pg = new PIXI.Graphics();
    pg.rect(0, 0, 10, 10).fill(0xff0000).circle(30, 5, 5).fill(0x00ff00);
    pg.clear();
    pg.roundRect(0, 0, 40, 20, 4).fill({ color: 0x123456, alpha: 0.5 });
    const p = pack(pixiElements(pg));
    const e = pack(els);
    expect(e.f32).toEqual(p.f32);
    expect(e.u32).toEqual(p.u32);
    expect(e.indices).toEqual(p.indices);
  });

  it('逐帧 clear + 重画(区段对象走池复用)每帧都与 Pixi 相同', () => {
    const eg = new Graphics();
    const other = new Graphics();
    for (let frame = 0; frame < 12; frame++) {
      const draw: Draw = (g) => {
        g.clear();
        const w = 40 + frame * 13;
        g.rect(0, 0, w, 6).fill({ color: 0x2a2018, alpha: 0.8 });
        if (frame % 3 !== 0) g.roundRect(0, 10, w * 0.6, 6, 3).fill({ color: 0xd8b060, alpha: 0.95 });
        if (frame % 2) g.circle(w, 3, 2 + frame).stroke({ width: 1.5, color: 0xffffff, alpha: 0.5 });
      };
      const pg = new PIXI.Graphics();
      draw(pg);
      draw(eg);
      other.clear().rect(0, 0, frame + 1, 1).fill(0xffffff);
      collect(other);
      const p = pack(pixiElements(pg));
      const e = pack(collect(eg));
      expect(e.f32).toEqual(p.f32);
      expect(e.u32).toEqual(p.u32);
      expect(e.indices).toEqual(p.indices);
    }
  });

  it('共享 context:一处画,两个节点都更新;第二个节点的位置 / 颜色各自独立', () => {
    const ctx = new GraphicsContext();
    const a = new Graphics(ctx);
    const b = new Graphics({ context: ctx, x: 50 });
    ctx.rect(0, 0, 10, 10).fill(0xffffff);
    expect(collect(a).length).toBe(1);
    expect(collect(b).length).toBe(1);
    b.groupColor = 0x0000ff;
    const [ea] = collect(a);
    const [eb] = collect(b);
    expect(ea).not.toBe(eb);
    expect(ea.positions).toBe(eb.positions);
    expect(ea.color >>> 0).toBe(0xffffffff);
    expect(eb.color >>> 0).toBe(0xff0000ff);
    ctx.circle(20, 20, 4).fill(0xff0000);
    expect(collect(a).length).toBe(2);
    expect(collect(b).length).toBe(2);
  });

  it('destroy:自有 context 无参时销毁;{children:true} 不销毁(照 Pixi);{context:true} 销毁共享 context', () => {
    const g1 = new Graphics();
    const own1 = g1.context;
    g1.destroy();
    expect(own1.destroyed).toBe(true);
    expect(g1.destroyed).toBe(true);

    const g2 = new Graphics();
    const own2 = g2.context;
    g2.rect(0, 0, 1, 1).fill(0);
    g2.destroy({ children: true });
    expect(own2.destroyed).toBe(false);

    const shared = new GraphicsContext();
    const g3 = new Graphics(shared);
    const g4 = new Graphics(shared);
    g3.destroy();
    expect(shared.destroyed).toBe(false);
    shared.rect(0, 0, 2, 2).fill(0);
    expect(collect(g4).length).toBe(1);
    g4.destroy({ context: true });
    expect(shared.destroyed).toBe(true);

    const g5 = new Graphics();
    g5.destroy();
    expect(() => g5.destroy()).not.toThrow();
  });

  it('clone:浅拷共享 context,深拷复制 context', () => {
    const g = new Graphics();
    g.rect(0, 0, 5, 5).fill(0xff0000);
    const deep = g.clone(true);
    expect(deep.context).not.toBe(g.context);
    expect(deep.context.instructions.length).toBe(1);
    const shallow = g.clone();
    expect(shallow.context).toBe(g.context);
    g.destroy();
    expect(shallow.context.destroyed).toBe(false);
  });

  it('context 换人 / 构造参数 / 代理方法链式返回节点', () => {
    const g = new Graphics({ label: 'hit', alpha: 0.5, roundPixels: true });
    expect(g.label).toBe('hit');
    expect(g.alpha).toBe(0.5);
    expect(g.roundPixels).toBe(true);
    expect(g.renderPipeId).toBe('graphics');
    const ret = g.moveTo(0, 0).lineTo(5, 5).bezierCurveTo(1, 2, 3, 4, 5, 6).quadraticCurveTo(1, 1, 2, 2).arc(0, 0, 3, 0, 1)
      .arcTo(1, 1, 2, 2, 1).closePath().rect(0, 0, 1, 1).roundRect(0, 0, 2, 2, 1).circle(0, 0, 1).ellipse(0, 0, 2, 1)
      .poly([0, 0, 1, 0, 1, 1]).regularPoly(0, 0, 2, 5).roundPoly(0, 0, 3, 5, 1).star(0, 0, 5, 3).filletRect(0, 0, 4, 4, 1)
      .chamferRect(0, 0, 4, 4, 1).roundShape([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], 1)
      .fill({ color: 0xffffff }).stroke({ width: 1 }).cut().beginPath()
      .save().translateTransform(1, 2).rotateTransform(0.1).scaleTransform(2).setTransform(new Matrix()).transform(1, 0, 0, 1, 1, 1)
      .resetTransform().restore().setFillStyle(0xff0000).setStrokeStyle({ width: 2 }).clear();
    expect(ret).toBe(g);
    const other = new GraphicsContext();
    other.rect(0, 0, 3, 3).fill(0);
    g.context = other;
    expect(collect(g).length).toBe(1);
    expect(g.fillStyle).toBe(other.fillStyle);
    g.strokeStyle = { width: 3, color: 0x00ff00 };
    expect(other.strokeStyle.width).toBe(3);
  });

  it('v7 弃用写法(beginFill / drawRect / endFill / lineStyle)仍可用', () => {
    const pg = new PIXI.Graphics();
    const eg = new Graphics();
    for (const g of [pg, eg] as any[]) {
      g.lineStyle(2, 0xff0000, 0.5);
      g.beginFill(0x00ff00, 0.5);
      g.drawRect(0, 0, 20, 10);
      g.drawCircle(40, 5, 5);
      g.endFill();
    }
    const p = pack(pixiElements(pg));
    const e = pack(collect(eg));
    expect(e.f32).toEqual(p.f32);
    expect(e.u32).toEqual(p.u32);
    expect(e.indices).toEqual(p.indices);
  });
});
