/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Matrix } from '../../../../src/engine2d/math/Matrix';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { GraphicsContext } from '../../../../src/engine2d/graphics/GraphicsContext';
import { GraphicsContextSystem } from '../../../../src/engine2d/graphics/GraphicsContextSystem';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Op = (g: any, lib: any) => void;

function genOps(seed: number): Op[] {
  const r = rng(seed);
  const n = (a: number, b: number) => a + (b - a) * r();
  const i = (a: number, b: number) => Math.floor(n(a, b + 1));
  const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)];
  const ops: Op[] = [];
  const count = i(1, 8);
  for (let k = 0; k < count; k++) {
    const shape = i(0, 11);
    const x = n(-50, 300), y = n(-50, 300), w = n(-5, 200), h = n(-5, 150);
    const b1 = r() < 0.5, b2 = r() < 0.5, b3 = r() < 0.5, b4 = r() < 0.5, b5 = r() < 0.5, m1 = n(0.5, 2), m2 = n(0.5, 2), m3 = n(0, 10), m4 = n(0, 10);
    const q1 = n(0, 40), q2 = n(0, 80), q3 = n(0, 60), q4 = n(-20, 20), q5 = r(), q6 = n(0, 20), q7 = n(-3, 3), q8 = n(-3, 6);
    const rad = pick([0, 1, 2, 3, 4, 6, 8, 12, 50, undefined as any, n(0, 30)]);
    const shapeOp: Op = [
      (g) => g.rect(x, y, w, h),
      (g) => g.roundRect(x, y, w, h, rad),
      (g) => g.circle(x, y, Math.abs(rad ?? 5) + q1),
      (g) => g.ellipse(x, y, q2, q3),
      (g) => g.poly([x, y, x + w, y + q4, x + q5 * w, y + h, x - q6, y + h * 0.5], b1),
      (g) => g.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h),
      (g) => g.moveTo(x, y).lineTo(x + w, y + h).lineTo(x, y + h).closePath(),
      (g) => g.moveTo(x, y).bezierCurveTo(x + w * 0.3, y - h, x + w * 0.7, y + h, x + w, y),
      (g) => g.moveTo(x, y).quadraticCurveTo(x + w * 0.5, y - h, x + w, y),
      (g) => g.arc(x, y, Math.abs(w) / 2 + 1, q7, q8, b2),
      (g) => g.moveTo(x, y).lineTo(x + w, y),
      (g) => g.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).closePath(),
    ][shape];
    ops.push(shapeOp);
    const act = i(0, 5);
    const color = i(0, 0xffffff);
    const alpha = pick([1, 0.5, n(0, 1), 0.001]);
    const width = pick([1, 1.5, 2, 2.5, 3, n(0.2, 10)]);
    const alignment = pick([undefined, 0, 0.5, 1, n(0, 1)]);
    const join = pick([undefined, 'miter', 'round', 'bevel']);
    const cap = pick([undefined, 'butt', 'round', 'square']);
    const acts: Op[] = [
      (g) => g.fill({ color, alpha }),
      (g) => g.stroke({ color, alpha, width, alignment, join, cap }),
      (g) => g.fill(color).stroke({ color, width, alignment, join, cap }),
      (g) => g.fill({ color, alpha }).circle(x + 5, y + 5, 3).cut(),
      (g) => g.stroke({ color, width, pixelLine: b3 }),
      (g, lib) => g.fill({ texture: lib.tex, color, alpha, textureSpace: b4 ? 'global' : 'local', matrix: b5 ? new lib.Matrix() : new lib.Matrix(m1, 0, 0, m2, m3, m4) }),
    ];
    ops.push(acts[act]);
    if (r() < 0.15) ops.push((g) => g.clear());
    if (r() < 0.1) {
      const tx = n(-20, 20), ty = n(-20, 20), rot = n(-1, 1), s = n(0.5, 2);
      ops.push((g) => g.translate(tx, ty).rotate(rot).scale(s));
    }
  }
  return ops;
}

function geometry(ctx: any, isPixi: boolean) {
  let data: any;
  if (isPixi) {
    data = new (PIXI as any).GpuGraphicsContext();
    (PIXI as any).buildContextBatches(ctx, data);
    data.isBatchable = data.geometryData.vertices.length < 400;
  } else {
    data = GraphicsContextSystem.updateGpuContext(ctx);
  }
  return {
    v: data.geometryData.vertices.slice(),
    uv: data.geometryData.uvs.slice(),
    ix: data.geometryData.indices.slice(),
    b: data.batches.map((b: any) => [b.indexOffset, b.indexSize, b.attributeOffset, b.attributeSize, b.baseColor, b.alpha, b.topology, b.color]),
    batchable: data.isBatchable,
  };
}

describe('graphics fuzz vs pixi', () => {
  const pixiLib = { Matrix: PIXI.Matrix, tex: new PIXI.Texture({ source: new PIXI.TextureSource({ width: 64, height: 32 }) }) };
  const e2dLib = { Matrix, tex: new Texture({ source: new TextureSource({ width: 64, height: 32 }) }) };
  const fails: string[] = [];
  it('fuzz', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const ops = genOps(seed);
      const p = new PIXI.GraphicsContext();
      const e = new GraphicsContext();
      let pe: unknown = null, ee: unknown = null;
      try { for (const op of ops) op(p, pixiLib); } catch (err) { pe = String(err); }
      try { for (const op of ops) op(e, e2dLib); } catch (err) { ee = String(err); }
      if (pe || ee) {
        if (String(pe) !== String(ee)) fails.push(`seed ${seed}: throw pixi=${pe} e2d=${ee}`);
        continue;
      }
      const pg = geometry(p, true);
      const eg = geometry(e, false);
      const pb = p.bounds, eb = e.bounds;
      const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
      const probs: string[] = [];
      if (!same(pg.v, eg.v)) probs.push('vertices');
      if (!same(pg.uv, eg.uv)) probs.push('uvs');
      if (!same(pg.ix, eg.ix)) probs.push('indices');
      if (!same(pg.b, eg.b)) probs.push('batches');
      if (pg.batchable !== eg.batchable) probs.push('batchable');
      if (!same([pb.minX, pb.minY, pb.maxX, pb.maxY], [eb.minX, eb.minY, eb.maxX, eb.maxY])) probs.push('bounds');
      // hit grid
      const r = rng(seed * 7);
      for (let k = 0; k < 200; k++) {
        const pt = { x: pb.minX - 5 + (pb.maxX - pb.minX + 10) * r(), y: pb.minY - 5 + (pb.maxY - pb.minY + 10) * r() };
        if (p.containsPoint(pt) !== e.containsPoint(pt)) { probs.push(`hit@${pt.x},${pt.y}`); break; }
      }
      if (probs.length) fails.push(`seed ${seed}: ${probs.join(',')}`);
    }
    console.log(fails.slice(0, 40).join('\n'), '\nTOTAL', fails.length);
    expect(fails).toEqual([]);
  });
});
