/**
 * Sprite 与 Pixi 8.17 对照:
 * - D5 合批四边形(visualBounds)照 SpritePipe 缓存:只在 onViewUpdate(换纹理 / 改锚点 / 动态纹理 update)后重算。
 *   非动态的 RenderTexture 改尺寸不发 view update,四边形与滤镜 / 命中包围盒一起停在旧尺寸(与 master 一致);
 * - D22 构造参数 anchor 按真值判断:`anchor: 0` / `null` 落到纹理的 defaultAnchor,null 不抛。
 */
import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { Sprite } from './Sprite';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { RenderTexture } from '../textures/RenderTexture';
import type { BatchableElement, RenderCollector } from '../core/contracts';
import { Assets } from '../assets/Assets';

class FakeCollector implements RenderCollector {
  items: BatchableElement[] = [];
  resolution = 1;
  addBatchable(e: BatchableElement): void {
    this.items.push(e);
  }
  addCustom(): void {}
  addUnbatched(): void {}
  pushFilter(): void {}
  popFilter(): void {}
  pushMask(): void {}
  popMask(): void {}
}

type Q = { minX: number; maxX: number; minY: number; maxY: number };

describe('托管TextureSource视图租约', () => {
  function imageTexture(): { texture: Texture; close: ReturnType<typeof vi.fn> } {
    const close = vi.fn();
    return { texture: new Texture({ source: new TextureSource({ resource: { width: 16, height: 16, close } }) }), close };
  }

  it('先创建的Sprite也能保护后来由manager托管的源，destroy(true)不破坏其他view', () => {
    const { texture, close } = imageTexture();
    const source = texture.source;
    const first = new Sprite(texture);
    const second = new Sprite(texture);
    const manager = {};
    Assets.retainTexture(texture, manager);
    expect(Assets.releaseTexture(texture, manager)).toBe(false);
    first.destroy(true);
    expect(texture.destroyed).toBe(false);
    expect(source.destroyed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    second.destroy(true);
    expect(texture.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    second.destroy(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('动态子纹理换源先保新再放旧，两份根纹理共源时仅最终释放关闭一次', () => {
    const a = imageTexture();
    const b = imageTexture();
    const sourceA = a.texture.source;
    const sourceB = b.texture.source;
    const aliasB = new Texture({ source: sourceB });
    const ownerA = {};
    const ownerB = {};
    const aliasOwner = {};
    Assets.retainTexture(a.texture, ownerA);
    Assets.retainTexture(b.texture, ownerB);
    Assets.retainTexture(aliasB, aliasOwner);
    const frame = new Texture({ source: sourceA, dynamic: true });
    const sprite = new Sprite(frame);
    Assets.releaseTexture(a.texture, ownerA);
    frame.source = sourceB;
    expect(sourceA.destroyed).toBe(true);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(Assets.releaseTexture(b.texture, ownerB)).toBe(false);
    expect(Assets.releaseTexture(aliasB, aliasOwner)).toBe(false);
    expect(sourceB.destroyed).toBe(false);
    sprite.destroy();
    expect(sourceB.destroyed).toBe(true);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(b.texture.destroyed).toBe(true);
    expect(aliasB.destroyed).toBe(true);
    frame.destroy();
  });

  it('非托管图片与WHITE/EMPTY不会因解绑自动销毁，非托管destroy选项仍有效', () => {
    const { texture, close } = imageTexture();
    const sprite = new Sprite(texture);
    sprite.texture = Texture.WHITE;
    sprite.texture = Texture.EMPTY;
    sprite.destroy(true);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(Texture.WHITE.destroyed).toBe(false);
    expect(Texture.EMPTY.destroyed).toBe(false);
    const explicit = new Sprite(texture);
    explicit.destroy(true);
    expect(texture.destroyed).toBe(true);
  });
});

const quad = (b: Q): number[] => [b.minX, b.minY, b.maxX, b.maxY].map((v) => v + 0); // -0 → 0

function collectQuad(s: Sprite): number[] {
  const c = new FakeCollector();
  s.collectRenderables(c);
  return quad(c.items[0].bounds!);
}

describe('D5 合批四边形照 SpritePipe 缓存', () => {
  it('非动态 RenderTexture 首帧后改尺寸:四边形与包围盒都停在旧尺寸(Pixi 相同)', () => {
    // Pixi:SpritePipe 只在 didViewUpdate 时刷新 batchableSprite.bounds
    const renderer = { uid: 1, _roundPixels: 0, renderPipes: { batch: { addToBatch() {} } } };
    const pipe = new PIXI.SpritePipe(renderer as never);
    const prt = PIXI.RenderTexture.create({ width: 600, height: 450 });
    const ps = new PIXI.Sprite(prt);
    pipe.addRenderable(ps, {} as never);
    ps.didViewUpdate = false; // 收集完清标志(ViewContainer.collectRenderablesSimple)
    void ps.bounds; // 首帧滤镜区域 / 命中读过一次包围盒
    const pg = ps._gpuData[1] as unknown as { bounds: Q };
    prt.resize(800, 600);
    ps.texture = prt; // 同一张:setter 直接返回
    ps.width = 900;
    ps.height = 675;
    pipe.addRenderable(ps, {} as never); // 下一帧重收集(didViewUpdate 仍为 false)
    const pixiQuad = quad(pg.bounds);
    const pixiBounds = quad(ps.bounds);

    const rt = RenderTexture.create({ width: 600, height: 450 });
    const s = new Sprite(rt);
    collectQuad(s);
    void s.bounds;
    rt.resize(800, 600);
    s.texture = rt;
    s.width = 900;
    s.height = 675;
    const mineQuad = collectQuad(s);
    const mineBounds = quad(s.bounds);

    expect(pixiQuad).toEqual([0, 0, 600, 450]);
    expect(pixiBounds).toEqual([0, 0, 600, 450]);
    expect(mineQuad).toEqual(pixiQuad);
    expect(mineBounds).toEqual(pixiBounds);
  });

  it('改锚点 / 换纹理(view update)后重算', () => {
    const rt = RenderTexture.create({ width: 60, height: 40 });
    const s = new Sprite(rt);
    expect(collectQuad(s)).toEqual([0, 0, 60, 40]);
    rt.resize(80, 50);
    expect(collectQuad(s)).toEqual([0, 0, 60, 40]);
    s.anchor.set(0.5);
    expect(collectQuad(s)).toEqual([-40, -25, 40, 25]);
    s.texture = RenderTexture.create({ width: 10, height: 20 });
    expect(collectQuad(s)).toEqual([-5, -10, 5, 10]);
  });

  it('动态纹理发 update 时照常刷新(Pixi 只对 dynamic 纹理挂 update 监听)', () => {
    const rt = RenderTexture.create({ width: 60, height: 40, dynamic: true });
    const s = new Sprite(rt);
    expect(collectQuad(s)).toEqual([0, 0, 60, 40]);
    rt.resize(80, 50);
    expect(collectQuad(s)).toEqual([0, 0, 80, 50]);
  });
});

describe('D22 构造参数 anchor', () => {
  function withDefaultAnchor(): { mine: Texture; pixi: PIXI.Texture } {
    const mine = new Texture({ source: new TextureSource({ width: 10, height: 10 }), defaultAnchor: { x: 0.5, y: 1 } });
    const pixi = new PIXI.Texture({ source: new PIXI.TextureSource({ width: 10, height: 10 }), defaultAnchor: { x: 0.5, y: 1 } });
    return { mine, pixi };
  }

  it('anchor: 0 落到纹理的 defaultAnchor(Pixi `if (anchor)`)', () => {
    const { mine, pixi } = withDefaultAnchor();
    const ps = new PIXI.Sprite({ texture: pixi, anchor: 0 });
    const s = new Sprite({ texture: mine, anchor: 0 });
    expect([s.anchor.x, s.anchor.y]).toEqual([ps.anchor.x, ps.anchor.y]);
    expect([s.anchor.x, s.anchor.y]).toEqual([0.5, 1]);
  });

  it('anchor: null 不抛,同样取 defaultAnchor', () => {
    const { mine, pixi } = withDefaultAnchor();
    const ps = new PIXI.Sprite({ texture: pixi, anchor: null as never });
    const s = new Sprite({ texture: mine, anchor: null as never });
    expect([s.anchor.x, s.anchor.y]).toEqual([ps.anchor.x, ps.anchor.y]);
  });

  it('给了非零锚点照常生效', () => {
    const { mine } = withDefaultAnchor();
    const s = new Sprite({ texture: mine, anchor: 0.25 });
    expect([s.anchor.x, s.anchor.y]).toEqual([0.25, 0.25]);
  });
});
