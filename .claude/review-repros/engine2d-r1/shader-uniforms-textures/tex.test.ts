import { describe, expect, it } from 'vitest';
import { Texture as ETexture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource as ESource } from '../../../../src/engine2d/textures/TextureSource';
import { TexturePoolClass as EPool } from '../../../../src/engine2d/textures/TexturePool';
import { Rectangle as ERect } from '../../../../src/engine2d/math/Rectangle';
import { Texture as PTexture, TextureSource as PSource, Rectangle as PRect, TexturePoolClass as PPool } from 'pixi.js';

describe('texture uv/matrix parity', () => {
  it('uvs + textureMatrix for all rotations, trims', () => {
    const diffs: string[] = [];
    for (const rot of [0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7]) {
      for (const trimOn of [false, true]) {
        for (const res of [1, 2, 0.5]) {
          const es = new ESource({ width: 300, height: 200, resolution: res });
          const ps = new PSource({ width: 300, height: 200, resolution: res });
          const fr = [13, 17, 91, 57];
          const opt = (R: any) => ({ frame: new R(...fr), orig: new R(0, 0, 120, 80), trim: trimOn ? new R(5, 7, 91, 57) : undefined, rotate: rot });
          const et = new ETexture({ source: es, ...opt(ERect) });
          const pt = new PTexture({ source: ps, ...(opt(PRect) as any) });
          const eu = JSON.stringify(et.uvs), pu = JSON.stringify(pt.uvs);
          if (eu !== pu) diffs.push(`uvs rot=${rot} trim=${trimOn} res=${res}: ${eu} vs ${pu}`);
          const em = et.textureMatrix, pm = pt.textureMatrix;
          const a = [em.mapCoord.a, em.mapCoord.b, em.mapCoord.c, em.mapCoord.d, em.mapCoord.tx, em.mapCoord.ty, ...em.uClampFrame, ...em.uClampOffset, em.isSimple];
          const b = [pm.mapCoord.a, pm.mapCoord.b, pm.mapCoord.c, pm.mapCoord.d, pm.mapCoord.tx, pm.mapCoord.ty, ...pm.uClampFrame, ...pm.uClampOffset, pm.isSimple];
          if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`tm rot=${rot} trim=${trimOn}: ${a} vs ${b}`);
          // resize
          es.resize(333, 222); ps.resize(333, 222);
          if (JSON.stringify(et.uvs) !== JSON.stringify(pt.uvs)) diffs.push(`uvs after resize rot=${rot}`);
          if (JSON.stringify([et.frame, et.width, et.height]) !== JSON.stringify([pt.frame, pt.width, pt.height])) diffs.push(`frame after resize rot=${rot}: ${JSON.stringify([et.frame, et.width, et.height])} vs ${JSON.stringify([pt.frame, pt.width, pt.height])}`);
        }
      }
    }
    // noFrame resize
    const es = new ESource({ width: 30, height: 20 }); const ps = new PSource({ width: 30, height: 20 });
    const et = new ETexture({ source: es }); const pt = new PTexture({ source: ps });
    es.resize(50, 40, 2); ps.resize(50, 40, 2);
    expect(JSON.stringify([et.frame, et.uvs, es.pixelWidth, es.width, es.isPowerOfTwo])).toBe(JSON.stringify([pt.frame, pt.uvs, ps.pixelWidth, ps.width, ps.isPowerOfTwo]));
    expect(diffs).toEqual([]);
  });
  it('pool', () => {
    const e = new EPool(); const p = new PPool();
    for (const [w, h, r, aa] of [[100.3, 50, 1, false], [640, 360, 2, true], [1, 1, 1.5, false], [1023.9999999, 5, 1, false]] as const) {
      const a = e.getOptimalTexture(w, h, r, aa); const b = p.getOptimalTexture(w, h, r, aa);
      expect(JSON.stringify([a.frame, a.uvs, a.source.pixelWidth, a.source.pixelHeight, a.source.width, a.source.height, a.source.resolution, a.source.antialias, a.source.format]))
        .toBe(JSON.stringify([b.frame, b.uvs, b.source.pixelWidth, b.source.pixelHeight, b.source.width, b.source.height, b.source.resolution, b.source.antialias, b.source.format]));
    }
  });
});
