/**
 * NineSliceGeometry / NineSliceSprite 与 Pixi 8.17 对照:
 * - 几何:各种尺寸 / 边条 / 锚点 / 裁切(含宽高小于边条和时四角等比缩小)下的顶点 / uv / 索引逐元素相同;
 * - 精灵:构造缺省(texture.defaultBorders / defaultAnchor / 纹理尺寸)、width / height / setSize / getSize、
 *   包围盒,以及出图——`collectRenderables` 发出的合批元素的位置 / uv(经纹理矩阵映射到图集帧)/ 索引与
 *   Pixi NineSliceSpritePipe 给合批器的 BatchableMesh 相同;属性变化后重算也相同。
 */
import { describe, expect, it } from 'vitest';
import {
  NineSliceGeometry as PixiNineSliceGeometry,
  NineSliceSprite as PixiNineSliceSprite,
  NineSliceSpriteGpuData as PixiNineSliceSpriteGpuData,
  Rectangle as PixiRectangle,
  Texture as PixiTexture,
  TextureSource as PixiTextureSource,
} from 'pixi.js';
import { NineSliceGeometry, type NineSliceGeometryOptions } from './NineSliceGeometry';
import { NineSliceSprite, type NineSliceSpriteOptions } from './NineSliceSprite';
import { Rectangle } from '../math/Rectangle';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import type { BatchableElement, RenderCollector } from '../core/contracts';

const arr = (a: ArrayLike<number>): number[] => Array.from(a);

function geometryOf(g: { positions: ArrayLike<number>; uvs: ArrayLike<number>; indices: ArrayLike<number> }) {
  return { positions: arr(g.positions), uvs: arr(g.uvs), indices: arr(g.indices) };
}

// ─────────────────────────── 几何

const GEOMETRY_CASES: Array<{ name: string; options?: NineSliceGeometryOptions }> = [
  { name: '无参(未给 anchor:Pixi 原样位置为 NaN)' },
  { name: '只给 anchor', options: { anchor: { x: 0, y: 0 } } },
  {
    name: '一般情形',
    options: { width: 200, height: 120, leftWidth: 12, topHeight: 8, rightWidth: 20, bottomHeight: 6, originalWidth: 64, originalHeight: 32, anchor: { x: 0, y: 0 } },
  },
  {
    name: '宽高小于边条和(四角等比缩小)+ 锚点',
    options: { width: 20, height: 10, leftWidth: 16, rightWidth: 16, topHeight: 16, bottomHeight: 16, originalWidth: 64, originalHeight: 64, anchor: { x: 0.5, y: 0.25 } },
  },
  {
    name: '只有高不够',
    options: { width: 500, height: 7, leftWidth: 3, rightWidth: 5, topHeight: 4, bottomHeight: 9, originalWidth: 30, originalHeight: 40, anchor: { x: 1, y: 1 } },
  },
  {
    name: '裁切',
    options: { width: 90, height: 70, originalWidth: 64, originalHeight: 48, trim: { x: 3, y: 5, width: 50, height: 20 }, anchor: { x: 0.3, y: 0.6 } },
  },
  {
    name: 'trim = null',
    options: { width: 90, height: 70, originalWidth: 64, originalHeight: 48, trim: null, anchor: { x: 0, y: 0 } },
  },
];

describe('NineSliceGeometry 与 Pixi 对照', () => {
  for (const c of GEOMETRY_CASES) {
    it(c.name, () => {
      const ours = new NineSliceGeometry(c.options);
      const pixi = new PixiNineSliceGeometry(c.options);
      expect(geometryOf(ours)).toEqual(geometryOf(pixi));
      expect(ours.positions).toHaveLength(32);
      expect(ours.indices).toHaveLength(54);
      expect([ours.width, ours.height, ours.verticesX, ours.verticesY]).toEqual([pixi.width, pixi.height, pixi.verticesX, pixi.verticesY]);
    });
  }

  it('连续 update(没给的项保持原值;trim 未给时回到无裁切)', () => {
    const ours = new NineSliceGeometry({ anchor: { x: 0, y: 0 } });
    const pixi = new PixiNineSliceGeometry({ anchor: { x: 0, y: 0 } });
    const steps: NineSliceGeometryOptions[] = [
      { width: 300, anchor: { x: 0, y: 0 } },
      { leftWidth: 40, rightWidth: 2, originalWidth: 80, anchor: { x: 0.5, y: 0.5 } },
      { trim: { x: 1, y: 2, width: 30, height: 40 }, anchor: { x: 0.5, y: 0.5 } },
      { height: 15, topHeight: 20, bottomHeight: 20, anchor: { x: 1, y: 0 } },
      { anchor: { x: 0.25, y: 0.75 } },
      {},
    ];
    for (const [i, s] of steps.entries()) {
      ours.update(s);
      pixi.update(s);
      expect(geometryOf(ours), `第 ${i} 步`).toEqual(geometryOf(pixi));
    }
  });

  it('update 会让位置 / uv 缓冲的版本号前进并触发几何 update 事件', () => {
    const g = new NineSliceGeometry({ anchor: { x: 0, y: 0 } });
    const pos = g.getBuffer('aPosition')._updateID;
    const uv = g.getBuffer('aUV')._updateID;
    let fired = 0;
    g.on('update', () => fired++);
    g.update({ width: 50, anchor: { x: 0, y: 0 } });
    expect(g.getBuffer('aPosition')._updateID).toBeGreaterThan(pos);
    expect(g.getBuffer('aUV')._updateID).toBeGreaterThan(uv);
    expect(fired).toBeGreaterThan(0);
    expect(g.bounds.maxX).toBe(50);
  });
});

// ─────────────────────────── 精灵

interface TexSpec {
  name: string;
  w: number;
  h: number;
  res?: number;
  frame?: [number, number, number, number];
  orig?: [number, number, number, number];
  trim?: [number, number, number, number];
  defaultBorders?: { left: number; top: number; right: number; bottom: number };
  defaultAnchor?: { x: number; y: number };
}

const TEXTURES: TexSpec[] = [
  { name: '整张源', w: 64, h: 48 },
  { name: '图集帧', w: 256, h: 128, frame: [32, 16, 64, 48] },
  { name: '图集帧 + defaultBorders + defaultAnchor', w: 256, h: 128, frame: [100, 40, 96, 64], defaultBorders: { left: 5, top: 6, right: 7, bottom: 8 }, defaultAnchor: { x: 0.5, y: 1 } },
  { name: '裁切帧', w: 256, h: 128, frame: [32, 16, 40, 30], orig: [0, 0, 64, 48], trim: [10, 8, 40, 30] },
  { name: '分辨率 2 的源', w: 64, h: 48, res: 2, frame: [8, 4, 32, 24] },
];

function makeTextures(spec: TexSpec): { ours: Texture; pixi: PixiTexture } {
  const ours = new Texture({
    source: new TextureSource({ width: spec.w, height: spec.h, resolution: spec.res ?? 1 }),
    frame: spec.frame && new Rectangle(...spec.frame),
    orig: spec.orig && new Rectangle(...spec.orig),
    trim: spec.trim && new Rectangle(...spec.trim),
    defaultBorders: spec.defaultBorders,
    defaultAnchor: spec.defaultAnchor,
  });
  const pixi = new PixiTexture({
    source: new PixiTextureSource({ width: spec.w, height: spec.h, resolution: spec.res ?? 1 }),
    frame: spec.frame && new PixiRectangle(...spec.frame),
    orig: spec.orig && new PixiRectangle(...spec.orig),
    trim: spec.trim && new PixiRectangle(...spec.trim),
    defaultBorders: spec.defaultBorders,
    defaultAnchor: spec.defaultAnchor,
  });
  return { ours, pixi };
}

class FakeCollector implements RenderCollector {
  addUnbatched(): void {
    throw new Error('九宫格不该交不合批图形');
  }
  readonly resolution = 1;
  readonly elements: BatchableElement[] = [];
  addBatchable(element: BatchableElement): void {
    this.elements.push(element);
  }
  addCustom(): void {
    throw new Error('九宫格不应走自定义绘制');
  }
  pushFilter(): void {}
  popFilter(): void {}
  pushMask(): void {}
  popMask(): void {}
}

/** engine2d:收集一次,取出合批元素 */
function collectOurs(sprite: NineSliceSprite): BatchableElement {
  const c = new FakeCollector();
  sprite.collectRenderables(c);
  expect(c.elements).toHaveLength(1);
  return c.elements[0];
}

/** Pixi:照 NineSliceSpritePipe._updateBatchableSprite 更新 gpuData,取 BatchableMesh 给合批器的数据 */
function collectPixi(sprite: PixiNineSliceSprite, gpu: PixiNineSliceSpriteGpuData): { positions: number[]; uvs: number[]; indices: number[] } {
  (gpu.geometry as PixiNineSliceGeometry).update(sprite);
  gpu.setTexture(sprite.texture);
  return { positions: arr(gpu.positions), uvs: arr(gpu.uvs), indices: arr(gpu.indices) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function spriteState(s: any): Record<string, unknown> {
  const b = s.bounds;
  const lb = s.getLocalBounds();
  const trim = s.trim;
  return {
    width: s.width,
    height: s.height,
    size: s.getSize(),
    leftWidth: s.leftWidth,
    topHeight: s.topHeight,
    rightWidth: s.rightWidth,
    bottomHeight: s.bottomHeight,
    anchor: [s.anchor.x, s.anchor.y],
    originalWidth: s.originalWidth,
    originalHeight: s.originalHeight,
    trim: trim ? [trim.x, trim.y, trim.width, trim.height] : trim,
    roundPixels: s.roundPixels,
    batched: s.batched,
    allowChildren: s.allowChildren,
    label: s.label,
    bounds: [b.minX, b.minY, b.maxX, b.maxY],
    localBounds: [lb.minX, lb.minY, lb.maxX, lb.maxY],
    scale: [s.scale.x, s.scale.y],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type SpriteOpts = Omit<NineSliceSpriteOptions, 'texture'>;

const SPRITE_OPTIONS: Array<{ name: string; options: SpriteOpts }> = [
  { name: '只给纹理', options: {} },
  { name: '四边 + 宽高', options: { leftWidth: 10, rightWidth: 10, topHeight: 10, bottomHeight: 10, width: 300, height: 90 } },
  { name: 'PanelSkin 木框用法(32px 边条)', options: { leftWidth: 32, rightWidth: 32, topHeight: 32, bottomHeight: 32 } },
  { name: '宽高小于边条和 + 数字锚点', options: { width: 20, height: 12, anchor: 0.5, leftWidth: 16, rightWidth: 16, topHeight: 16, bottomHeight: 16 } },
  { name: '对象锚点 + roundPixels + 其它容器选项', options: { anchor: { x: 0.2, y: 0.7 }, roundPixels: true, x: 5, y: 6, alpha: 0.5, label: 'frame' } },
];

describe('NineSliceSprite 与 Pixi 对照', () => {
  for (const tex of TEXTURES) {
    for (const opt of SPRITE_OPTIONS) {
      it(`${tex.name} × ${opt.name}`, () => {
        const { ours: oTex, pixi: pTex } = makeTextures(tex);
        const ours = new NineSliceSprite({ texture: oTex, ...opt.options });
        const pixi = new PixiNineSliceSprite({ texture: pTex, ...(opt.options as object) });
        const gpu = new PixiNineSliceSpriteGpuData();

        expect(spriteState(ours)).toEqual(spriteState(pixi));

        const el = collectOurs(ours);
        const ref = collectPixi(pixi, gpu);
        expect({ positions: arr(el.positions!), uvs: arr(el.uvs!), indices: arr(el.indices!) }).toEqual(ref);

        // 合批元素的其余字段
        expect(el.packAsQuad).toBe(false);
        expect(el.topology).toBe('triangle-list');
        expect([el.attributeOffset, el.attributeSize, el.indexOffset, el.indexSize]).toEqual([0, 16, 0, 54]);
        expect(el.texture).toBe(oTex);
        expect(el.transform).toBe(ours.groupTransform);
        expect(el.color).toBe(ours.groupColorAlpha);
        expect(el.blendMode).toBe(ours.groupBlendMode);
        expect(el.roundPixels).toBe(opt.options.roundPixels ? 1 : 0);
      });
    }
  }

  it('属性变化后重算(宽高 / 边条 / 锚点 / setSize / 换纹理 / 缩放)', () => {
    const t0 = makeTextures(TEXTURES[1]);
    const t1 = makeTextures(TEXTURES[3]);
    const ours = new NineSliceSprite({ texture: t0.ours, leftWidth: 12, rightWidth: 12, topHeight: 12, bottomHeight: 12 });
    const pixi = new PixiNineSliceSprite({ texture: t0.pixi, leftWidth: 12, rightWidth: 12, topHeight: 12, bottomHeight: 12 });
    const gpu = new PixiNineSliceSpriteGpuData();
    const steps: Array<[string, (s: any, t: 'ours' | 'pixi') => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ['width', (s) => { s.width = 150; }],
      ['height', (s) => { s.height = 17; }],
      ['leftWidth', (s) => { s.leftWidth = 3; }],
      ['topHeight', (s) => { s.topHeight = 9; }],
      ['rightWidth', (s) => { s.rightWidth = 30; }],
      ['bottomHeight', (s) => { s.bottomHeight = 1; }],
      ['anchor.set', (s) => { s.anchor.set(0.3, 0.6); }],
      ['anchor =', (s) => { s.anchor = { x: 1, y: 0 }; }],
      ['setSize(80, 40)', (s) => { s.setSize(80, 40); }],
      ['setSize({ width })', (s) => { s.setSize({ width: 77 }); }],
      ['setSize(n)', (s) => { s.setSize(55); }],
      ['换纹理', (s, t) => { s.texture = t1[t]; }],
      ['PanelSkin:放大几何再缩回', (s) => { s.width = 240; s.height = 96; s.scale.set(0.5); }],
      ['texture = null → EMPTY', (s) => { s.texture = null; }],
    ];
    collectOurs(ours);
    for (const [name, step] of steps) {
      step(ours, 'ours');
      step(pixi, 'pixi');
      expect(spriteState(ours), name).toEqual(spriteState(pixi));
      const el = collectOurs(ours);
      expect({ positions: arr(el.positions!), uvs: arr(el.uvs!), indices: arr(el.indices!) }, name).toEqual(collectPixi(pixi, gpu));
    }
  });

  it('动态纹理改帧后 uv 跟着变', () => {
    const src = { ours: new TextureSource({ width: 128, height: 128 }), pixi: new PixiTextureSource({ width: 128, height: 128 }) };
    const ours = new Texture({ source: src.ours, frame: new Rectangle(0, 0, 32, 32), dynamic: true });
    const pixiTex = new PixiTexture({ source: src.pixi, frame: new PixiRectangle(0, 0, 32, 32), dynamic: true });
    const sOurs = new NineSliceSprite(ours);
    const sPixi = new PixiNineSliceSprite(pixiTex);
    const gpu = new PixiNineSliceSpriteGpuData();
    const before = arr(collectOurs(sOurs).uvs!);
    expect(before).toEqual(collectPixi(sPixi, gpu).uvs);
    ours.frame.x = 64;
    ours.frame.y = 32;
    ours.update();
    pixiTex.frame.x = 64;
    pixiTex.frame.y = 32;
    pixiTex.update();
    const after = arr(collectOurs(sOurs).uvs!);
    expect(after).not.toEqual(before);
    expect(after).toEqual(collectPixi(sPixi, gpu).uvs);
  });

  it('Texture 直接当参数;destroy 可按选项连带销毁纹理,重复 destroy 无害', () => {
    const { ours: tex } = makeTextures(TEXTURES[0]);
    const s = new NineSliceSprite(tex);
    expect(s.texture).toBe(tex);
    expect([s.width, s.height]).toEqual([64, 48]);
    collectOurs(s);
    s.destroy({ texture: true });
    expect(tex.destroyed).toBe(true);
    expect(s.destroyed).toBe(true);
    expect(() => s.destroy({ texture: true })).not.toThrow();
  });

  it('destroy 摘掉动态纹理上的 update 监听', () => {
    const tex = new Texture({ source: new TextureSource({ width: 32, height: 32 }), dynamic: true });
    const s = new NineSliceSprite(tex);
    const before = tex.listenerCount('update');
    s.destroy();
    expect(tex.listenerCount('update')).toBe(before - 1);
  });

  it('缺省值:无 defaultBorders 时边条为 10', () => {
    const { ours: tex } = makeTextures(TEXTURES[0]);
    const s = new NineSliceSprite({ texture: tex });
    expect([s.leftWidth, s.topHeight, s.rightWidth, s.bottomHeight]).toEqual([10, 10, 10, 10]);
    expect(NineSliceSprite.defaultOptions.texture).toBe(Texture.EMPTY);
  });
});
