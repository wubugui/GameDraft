/** verify r4-test-guards-0: 分数分辨率下滤镜包围盒取整链(scale(res).ceil().scale(1/res).pad)engine2d vs Pixi 8.17 */
import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import * as E from '../../../../src/engine2d';

const RES = [1.25, 1.5, 1.75, 2.25, 1];
function rnd(seed: number) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

describe('filter bounds chain @ fractional res', () => {
  it('Bounds.scale(res).ceil().scale(1/res).pad + fitBounds identical', () => {
    const r = rnd(7);
    const diffs: string[] = [];
    let n = 0;
    for (let i = 0; i < 20000; i++) {
      const res = RES[i % RES.length];
      const x = (r() - 0.3) * 1500, y = (r() - 0.3) * 900, w = r() * 700, h = r() * 500;
      const pad = Math.floor(r() * 12);
      const vw = 1600 * res, vh = 900 * res;
      const p = new PIXI.Bounds(x, y, x + w, y + h);
      const e = new E.Bounds(x, y, x + w, y + h);
      p.fitBounds(0, vw / res, 0, vh / res); e.fitBounds(0, vw / res, 0, vh / res);
      p.scale(res).ceil().scale(1 / res).pad(pad); e.scale(res).ceil().scale(1 / res).pad(pad);
      const a = [p.minX, p.minY, p.maxX, p.maxY, p.isPositive], b = [e.minX, e.minY, e.maxX, e.maxY, e.isPositive];
      n++;
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${[x, y, w, h, res]}: ${a} vs ${b}`);
    }
    expect(n).toBe(20000);
    expect(diffs.slice(0, 5)).toEqual([]);
  });

  it('renderer resize at fractional res: canvas px / screen same as Pixi TextureSource.resize', () => {
    const diffs: string[] = [];
    for (const res of [1.25, 1.5, 1.75]) for (const [w, h] of [[1001, 333], [1366, 768], [1537, 865], [799, 601]]) {
      const src = new PIXI.TextureSource({ width: 1, height: 1, resolution: res });
      src.resize(w, h, res);
      const pw = Math.round(w * res), ph = Math.round(h * res);
      const a = [src.pixelWidth, src.pixelHeight, src.width, src.height];
      const b = [pw, ph, pw / res, ph / res];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${w}x${h}@${res}: ${a} vs ${b}`);
    }
    expect(diffs).toEqual([]);
  });
});
