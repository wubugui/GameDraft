import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { Batcher, type BatchRecord } from '../../../../src/engine2d/gpu/Batcher';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { Matrix } from '../../../../src/engine2d/math/Matrix';

class TB extends (P.Batcher as any) {
  vertexSize = 6;
  name = 'default';
}
(TB.prototype as any).packAttributes = (P.DefaultBatcher.prototype as any).packAttributes;
(TB.prototype as any).packQuadAttributes = (P.DefaultBatcher.prototype as any).packQuadAttributes;

describe('Batcher vs Pixi DefaultBatcher', () => {
  it('fuzz: same batches, same vertex/index bytes', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const N_TEX = 22;
    const pSources: P.TextureSource[] = [];
    const eSources: TextureSource[] = [];
    const pTex: P.Texture[] = [];
    const eTex: Texture[] = [];
    for (let i = 0; i < N_TEX; i++) {
      const npm = rnd() < 0.2;
      const w = 16 + ((rnd() * 100) | 0);
      const h = 16 + ((rnd() * 100) | 0);
      const ps = new P.TextureSource({ width: w, height: h, alphaMode: npm ? 'no-premultiply-alpha' : 'premultiply-alpha-on-upload' });
      const es = new TextureSource({ width: w, height: h, alphaMode: npm ? 'no-premultiply-alpha' : 'premultiply-alpha-on-upload' } as never);
      pSources.push(ps);
      eSources.push(es);
      const fr = { x: 1, y: 2, width: w - 3, height: h - 4 };
      pTex.push(new P.Texture({ source: ps, frame: new P.Rectangle(fr.x, fr.y, fr.width, fr.height) }));
      eTex.push(new Texture({ source: es, frame: fr as never }));
    }
    const blends = ['normal', 'add', 'screen', 'multiply', 'normal', 'normal'] as const;
    let splitDiffs = 0;
    for (let round = 0; round < 60; round++) {
      const pb = new TB({ maxTextures: 16 }) as any;
      const eb = new Batcher();
      pb.begin();
      eb.begin();
      const pOut: any[] = [];
      const instr = { add: (b: any) => pOut.push({ start: b.start, size: b.size, blend: b.blendMode, topo: b.topology, tex: b.textures.textures.slice(0, b.textures.count).map((s: any) => pSources.indexOf(s)) }) };
      const eOut: BatchRecord[] = [];
      const n = 5 + ((rnd() * 200) | 0);
      for (let i = 0; i < n; i++) {
        const ti = (rnd() * N_TEX) | 0;
        const blend = blends[(rnd() * blends.length) | 0];
        const m = new Matrix(rnd() * 2, rnd() - 0.5, rnd() - 0.5, rnd() * 2, rnd() * 500, rnd() * 500);
        const color = ((rnd() * 0xffffffff) >>> 0) | 0;
        const round01 = rnd() < 0.3 ? 1 : 0;
        const quad = rnd() < 0.7;
        const bounds = { minX: -rnd() * 50, minY: -rnd() * 50, maxX: rnd() * 50, maxY: rnd() * 50 };
        const positions = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10, 5, 15]);
        const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 1]);
        const indices = new Uint32Array([0, 1, 2, 1, 2, 3, 2, 3, 4]);
        const topology = rnd() < 0.1 ? 'triangle-strip' : 'triangle-list';
        const common = {
          transform: m, color, roundPixels: round01, blendMode: blend, topology: quad ? 'triangle-list' : topology,
          packAsQuad: quad, bounds, positions, uvs, indices,
          attributeOffset: quad ? 0 : 1, attributeSize: quad ? 4 : 4, indexOffset: quad ? 0 : 3, indexSize: quad ? 6 : 6,
        };
        const pel = { ...common, texture: pTex[ti], batcherName: 'default' };
        const eel = { ...common, texture: eTex[ti] };
        pb.add(pel as never);
        eb.add(eel as never);
        if (rnd() < 0.05) {
          pb.break(instr as never);
          eb.break(eOut);
        }
      }
      pb.break(instr as never);
      eb.break(eOut);
      const pf = new Float32Array(pb.attributeBuffer.rawBinaryData, 0, pb.attributeSize);
      const ef = new Float32Array(eb.attr, 0, eb.attributeSize);
      const pu = new Uint32Array(pf.buffer, 0, pb.attributeSize);
      const eu = new Uint32Array(ef.buffer, 0, eb.attributeSize);
      expect(eb.attributeSize).toBe(pb.attributeSize);
      expect(eb.indexSize).toBe(pb.indexSize);
      expect(Array.from(eb.indices.subarray(0, eb.indexSize))).toEqual(Array.from(pb.indexBuffer.subarray(0, pb.indexSize)));
      // resolve per-index: (blend, topology, sampled source, vertex words except texture id)
      const resolve = (batches: { start: number; size: number; blend: string; topo: string; tex: number[] }[], u32: Uint32Array, idx: ArrayLike<number>) => {
        const out: string[] = [];
        for (const b of batches) {
          for (let k = b.start; k < b.start + b.size; k++) {
            const v = idx[k] * 6;
            const tid = u32[v + 5] >>> 16;
            const rest = [u32[v], u32[v + 1], u32[v + 2], u32[v + 3], u32[v + 4], u32[v + 5] & 0xffff].join(',');
            out.push(`${k}|${b.blend}|${b.topo}|${b.tex[tid]}|${rest}`);
          }
        }
        return out;
      };
      const eMapped = eOut.map((b) => ({ start: b.start, size: b.size, blend: b.blendMode, topo: b.topology, tex: b.textures.map((s) => eSources.indexOf(s)) }));
      expect(resolve(eMapped, eu, eb.indices)).toEqual(resolve(pOut, pu, pb.indexBuffer));
      if (eMapped.length !== pOut.length) splitDiffs++;
    }
    console.log('rounds with different batch split count', splitDiffs);
  });
});
