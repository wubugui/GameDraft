/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from '../../../../src/engine2d/graphics/GraphicsContext';
import { GraphicsContextSystem } from '../../../../src/engine2d/graphics/GraphicsContextSystem';

const cases: Record<string, (g: any) => void> = {
  nanRect: (g) => g.rect(NaN, 0, 10, 10).fill(0xff0000),
  nanStroke: (g) => g.moveTo(0, 0).lineTo(NaN, 5).lineTo(10, 10).stroke({ width: 2, color: 0 }),
  dupPoints: (g) => g.moveTo(0, 0).lineTo(0, 0).lineTo(10, 0).lineTo(10, 0).lineTo(10, 10).stroke({ width: 3, color: 0 }),
  dupClosed: (g) => g.moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).lineTo(0, 0).closePath().stroke({ width: 3, color: 0, join: 'round' }),
  width0: (g) => g.rect(0, 0, 10, 10).stroke({ width: 0, color: 0 }),
  negCircle: (g) => g.circle(10, 10, -5).fill(0).stroke({ width: 1, color: 0 }),
  zeroEllipse: (g) => g.ellipse(10, 10, 0, 5).fill(0).stroke({ width: 1, color: 0 }),
  poly2: (g) => g.poly([0, 0, 10, 10]).fill(0).stroke({ width: 1, color: 0 }),
  polyEmpty: (g) => g.poly([]).fill(0),
  closeOnly: (g) => g.closePath().stroke({ width: 1, color: 0 }),
  strokeNoPath: (g) => g.stroke({ width: 1, color: 0 }),
  fillNoPath: (g) => g.fill(0xff),
  moveOnly: (g) => g.moveTo(5, 5).fill(0).stroke({ width: 2, color: 0 }),
  negRoundRect: (g) => g.roundRect(10, 10, -20, -10, 4).fill(0).stroke({ width: 1, color: 0 }),
  hugeRadius: (g) => g.roundRect(0, 0, 10, 10, 1000).fill(0).stroke({ width: 1, color: 0 }),
  negRadius: (g) => g.roundRect(0, 0, 50, 30, -5).fill(0).stroke({ width: 1, color: 0 }),
  tinyArc: (g) => g.arc(0, 0, 0.1, 0, 0.0001).stroke({ width: 1, color: 0 }),
  fullArc: (g) => g.arc(0, 0, 50, 0, Math.PI * 2).fill(0).stroke({ width: 4, color: 0 }),
  arcBig: (g) => g.arc(0, 0, 50, 0, Math.PI * 7).stroke({ width: 4, color: 0 }),
  pieWedge: (g) => g.moveTo(0, 0).arc(0, 0, 80, 0.3, 1.4, false).closePath().fill(0xff0000).stroke({ width: 2, color: 0 }),
  twoSubpaths: (g) => g.moveTo(0, 0).lineTo(10, 0).moveTo(20, 0).lineTo(30, 10).stroke({ width: 2, color: 0, cap: 'round' }),
  hitStrokeOpen: (g) => g.moveTo(0, 0).lineTo(100, 0).stroke({ width: 10, color: 0 }),
  sharpMiter: (g) => g.moveTo(0, 0).lineTo(100, 1).lineTo(0, 2).stroke({ width: 10, color: 0 }),
  bigWidth: (g) => g.rect(0, 0, 10, 10).stroke({ width: 40, color: 0 }),
  cutStroke: (g) => g.circle(50, 50, 40).stroke({ width: 6, color: 0 }).circle(50, 50, 10).cut(),
  fillAfterStrokeSameTick: (g) => g.rect(0, 0, 10, 10).stroke({ width: 2, color: 0 }).fill(0xff0000),
  sugarWheelSector: (g) => { const R = 120; for (let i = 0; i < 8; i++) { const s = i * Math.PI / 4, e = s + Math.PI / 4; g.moveTo(0, 0); g.arc(0, 0, R, s, e, false); g.closePath(); g.fill({ color: 0x884422 + i * 0x101010, alpha: 0.9 }); g.stroke({ width: 2, color: 0x222222 }); } },
};

function geom(ctx: any, isPixi: boolean) {
  let data: any;
  if (isPixi) { data = new (PIXI as any).GpuGraphicsContext(); (PIXI as any).buildContextBatches(ctx, data); } else data = GraphicsContextSystem.updateGpuContext(ctx);
  return JSON.stringify([data.geometryData.vertices, data.geometryData.uvs, data.geometryData.indices, data.batches.map((b: any) => [b.indexOffset, b.indexSize, b.attributeOffset, b.attributeSize, b.color, b.topology])]);
}

describe('edge cases vs pixi', () => {
  for (const [name, fn] of Object.entries(cases)) {
    it(name, () => {
      const p = new PIXI.GraphicsContext();
      const e = new GraphicsContext();
      let pe = '', ee = '';
      try { fn(p); } catch (err) { pe = String(err); }
      try { fn(e); } catch (err) { ee = String(err); }
      expect(!!ee).toBe(!!pe);
      let pg = '', eg = '';
      try { pg = geom(p, true); } catch (err) { pg = 'THROW ' + err; }
      try { eg = geom(e, false); } catch (err) { eg = 'THROW ' + err; }
      expect(eg).toBe(pg);
      const pb = p.bounds, eb = e.bounds;
      expect([eb.minX, eb.minY, eb.maxX, eb.maxY]).toEqual([pb.minX, pb.minY, pb.maxX, pb.maxY]);
      const pts: any[] = [];
      for (let x = -60; x <= 140; x += 3.7) for (let y = -60; y <= 140; y += 3.7) pts.push({ x, y });
      const ph = pts.map((pt) => { try { return p.containsPoint(pt); } catch { return 'T'; } });
      const eh = pts.map((pt) => { try { return e.containsPoint(pt); } catch { return 'T'; } });
      expect(eh).toEqual(ph);
    });
  }
});
