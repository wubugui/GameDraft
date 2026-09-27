/**
 * 引擎扩展 `FilterSystemLike.filterPassOrigin`(Pixi 没有):滤镜顶点位置 + 它 = 渲染根上的坐标。
 * 照 Pixi,`uOutputFrame.xy` 只在链的最后一道(画回外层目标)带 bounds 偏移、中间几道是 0;按屏幕位置取东西的滤镜排在链中间
 * (燃烧材质在自发光前面)要靠它补回来。空后端,不需要 GPU。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import type { FilterSystemLike } from '../filters/Filter';
import type { RenderSurface } from './renderTargets';
import { WebGPURenderer } from './WebGPURenderer';

function setup(size = 256) {
  const rhi = new NullRhiDevice({ swapchainSize: [size, size] });
  const canvas = { width: size, height: size, style: {} } as unknown as HTMLCanvasElement;
  return new WebGPURenderer({ rhi, canvas, width: size, height: size });
}

/** 记下每道 pass 的原点,并按 Pixi 的式子重算那一道的 uOutputFrame.xy,两者相加应 = 滤镜 bounds 左上(根坐标) */
class Rec extends AlphaFilter {
  readonly seen: Array<{ x: number; y: number }> = [];
  override apply(fm: FilterSystemLike, input: Texture, output: RenderSurface, clear: boolean): void {
    this.seen.push(fm.filterPassOrigin(output));
    super.apply(fm, input, output, clear);
  }
}

function box(x: number, y: number, w: number, h: number): Sprite {
  const s = new Sprite(Texture.WHITE);
  s.position.set(x, y);
  s.width = w;
  s.height = h;
  return s;
}

describe('filterPassOrigin:链中间 = 本滤镜 bounds 左上,最后一道 = 外层滤镜目标的偏移', () => {
  it('两道滤镜画到画布:第一道(中间)拿到 bounds 左上,第二道(最后)拿到 0', () => {
    const r = setup();
    const root = new Container();
    const s = box(40, 30, 20, 10);
    const a = new Rec();
    const b = new Rec();
    s.filters = [a, b];
    root.addChild(s);
    r.render(root);
    expect(a.seen).toEqual([{ x: 40, y: 30 }]);
    expect(b.seen).toEqual([{ x: 0, y: 0 }]);
  });

  it('套在外层滤镜里:内层最后一道 = 外层 bounds 左上(它画回外层的池纹理),中间一道仍是自己的 bounds 左上', () => {
    const r = setup();
    const root = new Container();
    const outer = new Container();
    outer.addChild(box(10, 5, 4, 4));
    const inner = box(40, 30, 20, 10);
    outer.addChild(inner);
    const o = new Rec();
    outer.filters = [o];
    const a = new Rec();
    const b = new Rec();
    inner.filters = [a, b];
    root.addChild(outer);
    r.render(root);
    expect(a.seen).toEqual([{ x: 40, y: 30 }]);
    expect(b.seen).toEqual([{ x: 10, y: 5 }]);
    expect(o.seen).toEqual([{ x: 0, y: 0 }]);
  });

  it('只有一道滤镜:就是最后一道,原点 0(uOutputFrame.xy 本来就带着 bounds 偏移)', () => {
    const r = setup();
    const root = new Container();
    const s = box(40, 30, 20, 10);
    const a = new Rec();
    s.filters = [a];
    root.addChild(s);
    r.render(root);
    expect(a.seen).toEqual([{ x: 0, y: 0 }]);
  });
});
