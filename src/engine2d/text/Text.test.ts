/**
 * Text 与 pixi.js 8.17 对照:width / height / 本地包围盒 / containsPoint / setSize 的读写语义;
 * 渲染收集出的四边形(updateTextBounds)、纹理 frame / uvs / 源像素尺寸与 Pixi 的 CanvasTextSystem +
 * updateTextBounds 算出的相同;另测纹理按 styleKey 共享与引用计数、分辨率自动跟随、destroy 释放。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from './_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from './adapter';
import { Text, type CanvasTextOptions } from './Text';
import { TextStyle } from './TextStyle';
import { canvasTextSystem } from './CanvasTextSystem';
import type { BatchableElement, RenderCollector } from '../core/contracts';
import { Container } from '../scene/Container';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

class FakeCollector implements RenderCollector {
  items: BatchableElement[] = [];
  constructor(public resolution: number) {}
  addBatchable(e: BatchableElement): void {
    this.items.push(e);
  }
  addCustom(): void {}
  pushFilter(): void {}
  popFilter(): void {}
  pushMask(): void {}
  popMask(): void {}
}

function pixiRenderData(opts: PIXI.CanvasTextOptions, rendererResolution: number): {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  frame: number[];
  uvs: Record<string, number>;
  source: number[];
} {
  const text = new PIXI.Text(opts);
  const system = new PIXI.CanvasTextSystem({ resolution: rendererResolution, texture: { initSource() {} } } as unknown as PIXI.Renderer);
  const texture = system.getManagedTexture(text);
  const batchable = { texture, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 0 } };
  PIXI.updateTextBounds(batchable as unknown as PIXI.BatchableSprite, text);
  return {
    bounds: { ...batchable.bounds },
    frame: [texture.frame.x, texture.frame.y, texture.frame.width, texture.frame.height],
    uvs: { ...texture.uvs },
    source: [texture.source.pixelWidth, texture.source.pixelHeight, texture.source.width, texture.source.height, texture.source.resolution],
  };
}

function mineRenderData(opts: CanvasTextOptions, rendererResolution: number): ReturnType<typeof pixiRenderData> & { text: Text; item: BatchableElement } {
  const text = new Text(opts);
  const collector = new FakeCollector(rendererResolution);
  text.collectRenderables(collector);
  const item = collector.items[0];
  const texture = item.texture;
  return {
    text,
    item,
    bounds: { ...item.bounds! },
    frame: [texture.frame.x, texture.frame.y, texture.frame.width, texture.frame.height],
    uvs: { ...texture.uvs },
    source: [texture.source.pixelWidth, texture.source.pixelHeight, texture.source.width, texture.source.height, texture.source.resolution],
  };
}

const LONG = '夜里的巷子很安静,只有远处传来几声狗叫。He stopped, looked back — nothing there.';

const CASES: Array<[string, CanvasTextOptions]> = [
  ['缺省', { text: 'Hello' }],
  ['空串', { text: '' }],
  ['锚点 0.5', { text: 'Centered', anchor: 0.5, style: { fontSize: 20 } }],
  ['锚点 (1, 0.25)', { text: 'Anchor', anchor: { x: 1, y: 0.25 }, style: { fontSize: 22, padding: 4 } }],
  ['换行居中', { text: LONG, anchor: { x: 0.5, y: 1 }, style: { fontSize: 18, wordWrap: true, wordWrapWidth: 220, align: 'center', breakWords: true } }],
  ['描边投影 padding', { text: 'Fancy', anchor: 0.3, style: { fontSize: 28, stroke: { color: 0, width: 4 }, dropShadow: true, padding: 5 } }],
  ['固定分辨率 3', { text: 'Res3', resolution: 3, style: { fontSize: 16 } }],
  ['trim', { text: 'Trim me', anchor: 0.5, style: { fontSize: 30, trim: true, padding: 2 } }],
  ['标签', { text: '他说<c1>别回头</c1>。', style: { fontSize: 18, tagStyles: { c1: { fill: 0xff0000 } } } }],
];

describe('Text 尺寸语义与 pixi 一致', () => {
  for (const [name, opts] of CASES) {
    it(name, () => {
      const p = new PIXI.Text(structuredClone(opts) as PIXI.CanvasTextOptions);
      const m = new Text(structuredClone(opts));
      expect([m.width, m.height]).toEqual([p.width, p.height]);
      const pb = p.getLocalBounds();
      const mb = m.getLocalBounds();
      expect([mb.minX, mb.minY, mb.maxX, mb.maxY]).toEqual([pb.minX, pb.minY, pb.maxX, pb.maxY]);
      expect(m.getSize()).toEqual(p.getSize());
      for (const pt of [{ x: 0, y: 0 }, { x: -5, y: 3 }, { x: 10, y: -10 }, { x: 40, y: 12 }]) {
        expect(m.containsPoint(pt)).toBe(p.containsPoint(pt));
      }
      m.scale.set(-2, 0.5);
      p.scale.set(-2, 0.5);
      expect([m.width, m.height]).toEqual([p.width, p.height]);
      m.width = 123;
      p.width = 123;
      m.height = 45;
      p.height = 45;
      expect([m.scale.x, m.scale.y]).toEqual([p.scale.x, p.scale.y]);
      m.setSize(80);
      p.setSize(80);
      expect([m.scale.x, m.scale.y]).toEqual([p.scale.x, p.scale.y]);
      m.setSize({ width: 60, height: 30 });
      p.setSize({ width: 60, height: 30 });
      expect([m.scale.x, m.scale.y]).toEqual([p.scale.x, p.scale.y]);
      expect(m.styleKey.split(':').slice(0, 1)).toEqual(p.styleKey.split(':').slice(0, 1));
    });
  }

  it('构造选项 width / height / 旧写法 new Text(字, 样式)', () => {
    const p = new PIXI.Text({ text: 'Sized', width: 200, height: 50, style: { fontSize: 20 } });
    const m = new Text({ text: 'Sized', width: 200, height: 50, style: { fontSize: 20 } });
    expect([m.scale.x, m.scale.y]).toEqual([p.scale.x, p.scale.y]);
    const p2 = new PIXI.Text('legacy', { fontSize: 30 } as Partial<PIXI.TextStyle>);
    const m2 = new Text('legacy', { fontSize: 30 });
    expect([m2.text, m2.width, m2.height]).toEqual([p2.text, p2.width, p2.height]);
    const m3 = new Text({ text: 42 as unknown as string, x: 5, y: 6, label: 'n' });
    expect([m3.text, m3.x, m3.y, m3.label]).toEqual(['42', 5, 6, 'n']);
  });

  it('在父容器里的包围盒随变换', () => {
    const pp = new PIXI.Container();
    const mp = new Container();
    pp.position.set(10, 20);
    mp.position.set(10, 20);
    pp.scale.set(2);
    mp.scale.set(2);
    const p = pp.addChild(new PIXI.Text({ text: 'child', anchor: 0.5, style: { fontSize: 20 } }));
    const m = mp.addChild(new Text({ text: 'child', anchor: 0.5, style: { fontSize: 20 } }));
    p.rotation = 0.3;
    m.rotation = 0.3;
    const pb = p.getBounds();
    const mb = m.getBounds();
    expect(mb.minX).toBeCloseTo(pb.minX, 9);
    expect(mb.maxY).toBeCloseTo(pb.maxY, 9);
    const pl = pp.getLocalBounds();
    const ml = mp.getLocalBounds();
    expect(ml.width).toBeCloseTo(pl.width, 9);
    expect(ml.height).toBeCloseTo(pl.height, 9);
  });
});

describe('Text 渲染数据与 pixi 一致', () => {
  for (const res of [1, 2, 1.25]) {
    for (const [name, opts] of CASES) {
      it(`${name} @${res}x`, () => {
        const p = pixiRenderData(structuredClone(opts) as PIXI.CanvasTextOptions, res);
        const m = mineRenderData(structuredClone(opts), res);
        expect(m.bounds).toEqual(p.bounds);
        expect(m.frame).toEqual(p.frame);
        expect(m.uvs).toEqual(p.uvs);
        expect(m.source).toEqual(p.source);
        expect(m.item.packAsQuad).toBe(true);
        expect(m.item.transform).toBe(m.text.groupTransform);
        m.text.destroy();
      });
    }
  }

  it('颜色 / 混合 / roundPixels 取本次渲染的 group 量', () => {
    const t = new Text({ text: 'g', roundPixels: true });
    t.groupColorAlpha = 0x80112233;
    t.groupBlendMode = 'add';
    const c = new FakeCollector(1);
    t.collectRenderables(c);
    expect(c.items[0].color).toBe(0x80112233);
    expect(c.items[0].blendMode).toBe('add');
    expect(c.items[0].roundPixels).toBe(1);
    t.destroy();
  });
});

describe('Text 纹理生命周期', () => {
  it('同样式同文字共享纹理,引用计数;改字后各自独立;destroy 释放', () => {
    const style = new TextStyle({ fontSize: 20 });
    const a = new Text({ text: 'shared', style });
    const b = new Text({ text: 'shared', style });
    const c = new FakeCollector(2);
    a.collectRenderables(c);
    b.collectRenderables(c);
    expect(c.items[0].texture).toBe(c.items[1].texture);
    expect(canvasTextSystem.getReferenceCount(a.styleKey)).toBe(2);
    const keyShared = a.styleKey;
    b.text = 'changed';
    b.collectRenderables(c);
    expect(canvasTextSystem.getReferenceCount(keyShared)).toBe(1);
    expect(canvasTextSystem.getReferenceCount(b.styleKey)).toBe(1);
    expect(c.items[2].texture).not.toBe(c.items[0].texture);
    a.destroy();
    expect(canvasTextSystem.getReferenceCount(keyShared)).toBe(0);
    const keyB = b.styleKey;
    b.destroy();
    expect(canvasTextSystem.getReferenceCount(keyB)).toBe(0);
  });

  it('只改锚点不重生成纹理;改样式重生成并更新内容版本', () => {
    const t = new Text({ text: 'anchor', style: { fontSize: 20 } });
    const c = new FakeCollector(1);
    t.collectRenderables(c);
    const tex = c.items[0].texture;
    const version = tex.source._updateId;
    t.anchor.set(0.5);
    t.collectRenderables(c);
    expect(c.items[1].texture).toBe(tex);
    expect(tex.source._updateId).toBe(version);
    expect(c.items[1].bounds!.minX).toBeLessThan(0);
    t.style.fontSize = 21;
    t.collectRenderables(c);
    expect(c.items[2].texture.source._updateId).toBeGreaterThan(0);
    t.destroy();
  });

  it('打字机式逐字变化:旧纹理还回后同尺寸画布与纹理对象被复用', () => {
    const t = new Text({ text: 'abcdefg', style: { fontSize: 20 } });
    const c = new FakeCollector(1);
    t.collectRenderables(c);
    const first = c.items[0].texture;
    t.text = 'abcdefgh';
    t.collectRenderables(c);
    expect(c.items[1].texture).toBe(first); // 画布同是 2 的幂档,纹理对象随画布复用
    expect(c.items[1].texture.frame.width).toBeGreaterThan(0);
    t.destroy();
  });

  it('自动分辨率跟随收集器;固定分辨率不跟', () => {
    const auto = new Text({ text: 'res', style: { fontSize: 20 } });
    const fixed = new Text({ text: 'res', resolution: 1, style: { fontSize: 20 } });
    const c1 = new FakeCollector(1);
    auto.collectRenderables(c1);
    fixed.collectRenderables(c1);
    expect(auto.resolution).toBe(1);
    const c2 = new FakeCollector(2);
    auto.collectRenderables(c2);
    fixed.collectRenderables(c2);
    expect(auto.resolution).toBe(2);
    expect(c2.items[0].texture.source.resolution).toBe(2);
    expect(c2.items[1].texture.source.resolution).toBe(1);
    auto.resolution = 3;
    auto.collectRenderables(c2);
    expect(c2.items[2].texture.source.resolution).toBe(3);
    auto.destroy();
    fixed.destroy();
  });

  it('destroy({ style: true }) 销毁样式;共享样式的监听被解除', () => {
    const style = new TextStyle({ fontSize: 20 });
    const t = new Text({ text: 'x', style });
    expect(style.listenerCount('update')).toBe(1);
    t.destroy();
    expect(style.listenerCount('update')).toBe(0);
    const t2 = new Text({ text: 'y', style });
    t2.destroy({ style: true });
    expect(style._fill).toBeNull();
  });
});
