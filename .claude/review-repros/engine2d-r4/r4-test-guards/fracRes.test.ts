/**
 * r4-test-guards: 分数分辨率(1.25 / 1.5 / 1.75)下的尺寸取整,engine2d vs Pixi 8.17 逐项比。
 * 对照工具只测 1 与 2,这里看分数分辨率有没有现成的分歧。
 */
import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import * as E from '../../../../src/engine2d';

const RES = [1.25, 1.5, 1.75, 2.25];
const SIZES: Array<[number, number]> = [[101, 57], [33.3, 17.7], [1, 1], [640.4, 359.6], [1279, 719]];

describe('分数分辨率尺寸取整对照', () => {
  it('RenderTexture.create pixelWidth / pixelHeight / width / height', () => {
    const diffs: string[] = [];
    for (const r of RES) for (const [w, h] of SIZES) {
      const p = PIXI.RenderTexture.create({ width: w, height: h, resolution: r });
      const o = E.RenderTexture.create({ width: w, height: h, resolution: r });
      const a = [p.source.pixelWidth, p.source.pixelHeight, p.source.width, p.source.height, p.width, p.height, p.frame.width, p.frame.height];
      const b = [o.source.pixelWidth, o.source.pixelHeight, o.source.width, o.source.height, o.width, o.height, o.frame.width, o.frame.height];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${w}x${h}@${r}: pixi ${a} ours ${b}`);
    }
    expect(diffs).toEqual([]);
  });

  it('RenderTexture.resize', () => {
    const diffs: string[] = [];
    for (const r of RES) for (const [w, h] of SIZES) {
      const p = PIXI.RenderTexture.create({ width: 8, height: 8, resolution: r });
      const o = E.RenderTexture.create({ width: 8, height: 8, resolution: r });
      p.resize(w, h, r);
      o.resize(w, h, r);
      const a = [p.source.pixelWidth, p.source.pixelHeight, p.source.width, p.source.height, p.frame.width, p.frame.height];
      const b = [o.source.pixelWidth, o.source.pixelHeight, o.source.width, o.source.height, o.frame.width, o.frame.height];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${w}x${h}@${r}: pixi ${a} ours ${b}`);
    }
    expect(diffs).toEqual([]);
  });

  it('TexturePool.getOptimalTexture', () => {
    const diffs: string[] = [];
    for (const r of RES) for (const [w, h] of SIZES) {
      const p = PIXI.TexturePool.getOptimalTexture(w, h, r, false);
      const o = E.TexturePool.getOptimalTexture(w, h, r, false);
      const a = [p.source.pixelWidth, p.source.pixelHeight, p.source.width, p.source.height, p.frame.width, p.frame.height, p.source.resolution];
      const b = [o.source.pixelWidth, o.source.pixelHeight, o.source.width, o.source.height, o.frame.width, o.frame.height, o.source.resolution];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${w}x${h}@${r}: pixi ${a} ours ${b}`);
      PIXI.TexturePool.returnTexture(p);
      E.TexturePool.returnTexture(o);
    }
    expect(diffs).toEqual([]);
  });
});
