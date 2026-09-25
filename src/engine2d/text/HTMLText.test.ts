/**
 * HTMLText / HTMLTextStyle 与 pixi.js 8.17 对照。node 没有 DOM:这里给最小的假 document(createElementNS /
 * body / scrollWidth·scrollHeight 按内容确定性给值)、假 XMLSerializer、假 Image(设 src 后微任务里 onload)。
 * 比较:cssStyle 串、字体族收集、文字清洗、测量尺寸、SVG 串(Image.src)、画到画布的调用、纹理 frame / uvs /
 * 源尺寸;以及异步出图后 HTMLText 交给收集器的四边形。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { FakeCanvas, FakeImage, makeFakeAdapter, type FakeContext2D } from './_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from './adapter';
import { HTMLText } from './html/HTMLText';
import { HTMLTextStyle, type HTMLTextStyleOptions } from './html/HTMLTextStyle';
import { htmlTextSystem } from './html/HTMLTextSystem';
import { extractFontFamilies } from './html/utils/extractFontFamilies';
import { measureHtmlText } from './html/utils/measureHtmlText';
import type { BatchableElement, RenderCollector } from '../core/contracts';

class FakeElement {
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  innerHTML = '';
  textContent = '';
  parent: FakeElement | null = null;
  constructor(public ns: string | null, public tag: string) {}
  setAttribute(k: string, v: unknown): void {
    this.attributes[k] = String(v);
  }
  appendChild(c: FakeElement): FakeElement {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  private get _plain(): string {
    return this.innerHTML.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<br\/>/g, '\n').replace(/<[^>]*>/g, '');
  }
  get scrollWidth(): number {
    return Math.max(...this._plain.split('\n').map((l) => l.length)) * 9 + 1;
  }
  get scrollHeight(): number {
    return this._plain.split('\n').length * 23;
  }
}

function serialize(el: FakeElement): string {
  const attrs = Object.entries(el.attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
  const style = Object.keys(el.style).length ? ` style-obj="${JSON.stringify(el.style)}"` : '';
  return `<${el.tag}${attrs}${style}>${el.textContent}${el.innerHTML}${el.children.map(serialize).join('')}</${el.tag}>`;
}

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
/** 每次设 Image.src 记一条 [src, width, height](两边的 Image 会被池复用,按设置记录) */
const srcLog: Array<[string, number, number]> = [];

class TrackingImage extends FakeImage {
  override get src(): string {
    return super.src;
  }
  override set src(v: string) {
    if (v) srcLog.push([v, this.width, this.height]);
    super.src = v;
  }
}

beforeAll(() => {
  const base = makeFakeAdapter();
  const adapter = {
    ...base,
    createImage: () => new TrackingImage(),
  };
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
  saved.document = g.document;
  saved.XMLSerializer = g.XMLSerializer;
  const body = new FakeElement(null, 'body');
  g.document = {
    body,
    createElementNS: (ns: string, tag: string) => new FakeElement(ns, tag),
    createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement(null, tag)),
  };
  g.XMLSerializer = class {
    serializeToString(el: FakeElement): string {
      return serialize(el);
    }
  };
});

afterAll(() => {
  g.document = saved.document;
  g.XMLSerializer = saved.XMLSerializer;
});

const STYLES: Array<[string, HTMLTextStyleOptions]> = [
  ['缺省', {}],
  ['游戏字幕', { fontSize: 18, fill: '#ffffff', fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: 600, align: 'center' }],
  ['全字段', {
    fontSize: 22, fill: 0x336699, fontFamily: ['Songti SC', 'serif'], fontWeight: 'bold', fontStyle: 'italic', fontVariant: 'small-caps',
    letterSpacing: 2, align: 'right', padding: 3, whiteSpace: 'normal', lineHeight: 30, wordWrap: true, breakWords: true, wordWrapWidth: 300,
    stroke: { color: 0x000000, width: 2 }, dropShadow: { color: 0x111111, alpha: 0.5, blur: 3, distance: 4, angle: 1 },
    cssOverrides: ['text-decoration: underline'],
  }],
  ['tagStyles', {
    fontSize: 16,
    tagStyles: {
      red: { fill: 'red', fontSize: 20, fontWeight: 'bold' },
      shout: { breakWords: true, letterSpacing: 1, dropShadow: true, lineHeight: 12, fontFamily: 'Kaiti' },
      pad: { padding: 2, align: 'center', whiteSpace: 'pre', wordWrapWidth: 50, fontStyle: 'italic', fontVariant: 'normal' },
    },
  }],
  ['pre + 不换行', { whiteSpace: 'pre', wordWrap: false, fill: 'rgba(255,0,0,0.6)' }],
];

const SUBTITLE = '<span style="color:#ffcc88">老板:</span>欢迎回来 &amp; 坐&lt;下&gt;吧';

describe('HTMLTextStyle 与 pixi 一致', () => {
  for (const [name, opts] of STYLES) {
    it(`cssStyle:${name}`, () => {
      const p = new PIXI.HTMLTextStyle(structuredClone(opts) as PIXI.HTMLTextStyleOptions);
      const m = new HTMLTextStyle(structuredClone(opts));
      expect(m.cssStyle).toBe(p.cssStyle);
      expect(m.clone().cssStyle).toBe(p.clone().cssStyle);
      expect(extractFontFamilies(SUBTITLE + '<b style="font-family:Foo">x</b>', m)).toEqual(
        PIXI.extractFontFamilies(SUBTITLE + '<b style="font-family:Foo">x</b>', p),
      );
    });
  }

  it('addOverride / removeOverride / cssOverrides 串', () => {
    const p = new PIXI.HTMLTextStyle({ fontSize: 10 });
    const m = new HTMLTextStyle({ fontSize: 10 });
    for (const s of [p, m]) {
      s.addOverride('color: red', 'opacity: 0.5');
      s.addOverride('color: red');
      s.removeOverride('opacity: 0.5');
      s.cssOverrides = 'font-kerning: none';
    }
    expect(m.cssOverrides).toEqual(p.cssOverrides);
    expect(m.cssStyle).toBe(p.cssStyle);
    expect(m._tick).toBe((p as unknown as { _tick: number })._tick);
  });

  it('测量尺寸与 pixi 相同(含投影 / padding)', () => {
    for (const [, opts] of STYLES) {
      const p = new PIXI.HTMLTextStyle(structuredClone(opts) as PIXI.HTMLTextStyleOptions);
      const m = new HTMLTextStyle(structuredClone(opts));
      expect(measureHtmlText(SUBTITLE, m)).toEqual(PIXI.measureHtmlText(SUBTITLE, p));
    }
  });
});

describe('HTMLText 与 pixi 一致', () => {
  it('文字清洗 / 尺寸 / 包围盒', () => {
    const raw = 'a<br>b&nbsp;c<hr> broken <b>ok</b> <i';
    const p = new PIXI.HTMLText({ text: raw, anchor: 0.5, style: { fontSize: 18 } });
    const m = new HTMLText({ text: raw, anchor: 0.5, style: { fontSize: 18 } });
    expect(m.text).toBe(p.text);
    expect([m.width, m.height]).toEqual([p.width, p.height]);
    const pb = p.getLocalBounds();
    const mb = m.getLocalBounds();
    expect([mb.minX, mb.minY, mb.maxX, mb.maxY]).toEqual([pb.minX, pb.minY, pb.maxX, pb.maxY]);
    m.destroy();
  });

  for (const res of [1, 2]) {
    for (const [name, opts] of STYLES) {
      it(`出图(SVG / 画布 / 纹理):${name} @${res}x`, async () => {
        const system = new PIXI.HTMLTextSystem({ type: PIXI.RendererType.WEBGPU, texture: { initSource() {} } } as unknown as PIXI.Renderer);
        const ps = new PIXI.HTMLTextStyle(structuredClone(opts) as PIXI.HTMLTextStyleOptions);
        srcLog.length = 0;
        const ptex = await system.getTexturePromise({ text: SUBTITLE, style: ps, resolution: res });
        const pSvg = srcLog.slice();

        const ms = new HTMLTextStyle(structuredClone(opts));
        srcLog.length = 0;
        const mtex = await htmlTextSystem.getTexturePromise({ text: SUBTITLE, style: ms, resolution: res });
        const mSvg = srcLog.slice();
        const mCanvas = mtex.source.resource as unknown as FakeCanvas;

        expect(mSvg.length).toBe(1);
        expect(mSvg).toEqual(pSvg);
        expect([mtex.frame.x, mtex.frame.y, mtex.frame.width, mtex.frame.height]).toEqual([ptex.frame.x, ptex.frame.y, ptex.frame.width, ptex.frame.height]);
        expect({ ...mtex.uvs }).toEqual({ ...ptex.uvs });
        expect([mtex.source.pixelWidth, mtex.source.pixelHeight, mtex.source.resolution]).toEqual([
          ptex.source.pixelWidth, ptex.source.pixelHeight, ptex.source.resolution,
        ]);
        // Pixi 上传后把画布还池(已清空);engine2d 留着画布,绘制调用应与 Pixi 当时画的相同
        const mCalls = (mCanvas.context as FakeContext2D).calls.filter((c) => c[0] === 'drawImage' || c[0] === 'clearRect').slice(-2);
        expect(mCalls[0]).toEqual(['clearRect', 0, 0, mSvg[0][1], mSvg[0][2]]);
        expect(mCalls[1]).toEqual(['drawImage', 'image', 0, 0]);
        htmlTextSystem.returnTexturePromise(Promise.resolve(mtex));
      });
    }
  }

  it('异步出图后交给收集器;生成中途改字最终落到最后一次', async () => {
    const items: BatchableElement[] = [];
    const collector: RenderCollector = {
      resolution: 2,
      addBatchable: (e) => items.push({ ...e, bounds: { ...e.bounds! } }),
      addCustom() {}, addUnbatched() {}, pushFilter() {}, popFilter() {}, pushMask() {}, popMask() {},
    };
    const t = new HTMLText({ text: '第一句', anchor: 0.5, style: { fontSize: 18, fill: '#ffffff' } });
    t.collectRenderables(collector);
    expect(items.length).toBe(0); // 纹理还没出来
    t.text = '第一句,第二句';
    t.collectRenderables(collector); // 生成中:这次改动先挂着
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    };
    await flush();
    t.collectRenderables(collector); // 第一张出来;发现键已变,补生成
    await flush();
    t.collectRenderables(collector);
    const last = items[items.length - 1];
    const expected = new PIXI.HTMLText({ text: '第一句,第二句', style: { fontSize: 18, fill: '#ffffff' } });
    expect(last.texture.frame.width).toBe(Math.ceil(Math.ceil(expected.width) * 2) / 2);
    // 四边形 = orig 按锚点居中
    expect(last.bounds!.minX).toBeCloseTo(-last.texture.frame.width / 2, 9);
    t.destroy();
  });
});
