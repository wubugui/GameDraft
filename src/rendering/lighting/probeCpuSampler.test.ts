import { describe, expect, it } from 'vitest';

import { indirectEY, probeEY, skyaoV, type ProbeCpuData } from './probeCpuSampler';

/**
 * 角色间接光的 CPU 查表必须与 CharacterShadingFilter 的 probeE / skyaoAt 同式
 * （接触 AO 的方向部分拿它算，与角色身上的间接光是同一份——制作人 2026-09-24）。
 * 这里用手搭的小载荷逐步钉口径：SH / L1 / 八面体三种图集、有效性回落 ambIrr、A7 折叠、skyao blend。
 */

/** number → IEEE half（测试只用精确可表示的值）。 */
function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000;
  const exp = ((u >>> 23) & 0xff) - 127 + 15;
  const man = (u >>> 13) & 0x3ff;
  if (v === 0) return sign;
  return sign | (exp << 10) | man;
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 2×2×2 网格、每颗 probe 系数相同的载荷（位置不影响结果，只看方向）。 */
function uniformProbes(mode: number, nCol: number, coeff: (k: number) => number, over: Partial<ProbeCpuData> = {}): ProbeCpuData {
  const P = 8;
  const atlas = new Uint16Array(P * nCol * 4);
  for (let p = 0; p < P; p++) {
    for (let k = 0; k < nCol; k++) {
      const h = toHalf(coeff(k));
      for (let ch = 0; ch < 3; ch++) atlas[(p * nCol + k) * 4 + ch] = h;
    }
  }
  return {
    atlas, nCol, valid: new Uint8Array(P).fill(255),
    pn: [2, 2, 2], wMin: [-10, -10, -10], wScale: [0.05, 0.05, 0.05], mCol: IDENT,
    mode, shK: nCol, binOb: 8, fold: false,
    ambSH: new Float32Array(27), ambStrength: 1,
    skyao: null, skyaoBlend: 1,
    ...over,
  };
}

const Q = [0, 0, 0];

describe('probeEY：与 shader probeE 同式', () => {
  it('线性 SH（L1 截断）：E(n) = c0·Y00 + c1·Y1y·n.y + c2·Y1z·n.z + c3·Y1x·n.x', () => {
    const c = [4, 0.5, -0.25, 1];
    const d = uniformProbes(2, 4, (k) => c[k]);
    for (const n of [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0.6, 0.8, 0]]) {
      const want = 0.282095 * c[0] + 0.488603 * (c[1] * n[1] + c[2] * n[2] + c[3] * n[0]);
      expect(probeEY(d, Q, n[0], n[1], n[2])).toBeCloseTo(want, 6);
    }
  });

  it('L1 Geomerics：L1 向量为零时就是 DC（R0）', () => {
    const d = uniformProbes(1, 4, (k) => (k === 0 ? 2 : 0));
    expect(probeEY(d, Q, 0, 1, 0)).toBeCloseTo(2 * 0.282095, 6);
  });

  it('八面体：64 个方向同值 ⇒ 任意方向都是它（双线性 + 接缝环绕不引入偏差）', () => {
    const d = uniformProbes(3, 64, () => 0.75);
    for (const n of [[0, 1, 0], [0, 0, -1], [-0.3, -0.9, 0.3], [0, -0.0001, -1]]) {
      expect(probeEY(d, Q, n[0], n[1], n[2])).toBeCloseTo(0.75, 3);
    }
  });

  it('A7 折叠：n.z < 0 时按 n.z 翻正去查（与 probeQueryN 同）', () => {
    const c = [4, 0, 1, 0];                                 // 只沿 q.z 有梯度
    const folded = uniformProbes(2, 4, (k) => c[k], { fold: true });
    const plain = uniformProbes(2, 4, (k) => c[k]);
    expect(probeEY(folded, Q, 0, 0, -1)).toBeCloseTo(probeEY(plain, Q, 0, 0, 1), 6);
    expect(probeEY(plain, Q, 0, 0, -1)).toBeLessThan(probeEY(plain, Q, 0, 0, 1));
  });

  it('8 个角都无效 ⇒ 回落 ambIrr', () => {
    const d = uniformProbes(2, 4, () => 9, { valid: new Uint8Array(8) });
    const amb = new Float32Array(27);
    amb[0] = amb[1] = amb[2] = 0.5;                         // 只有 DC
    const got = probeEY({ ...d, ambSH: amb, ambStrength: 2 }, Q, 0, 1, 0);
    expect(got).toBeCloseTo(0.5 * 3.141593 * 0.282095 * 2, 5);
  });
});

describe('skyaoV / indirectEY：skyao 乘在间接光上、与全白 blend', () => {
  // 2×2×2 节点、Z 切片横向平铺 2×1：图集宽 4、高 2；每个节点 a0 = 0.5，a1 = 0
  const n: [number, number, number] = [2, 2, 2];
  const data = new Uint16Array(4 * 2 * 4);
  for (let i = 0; i < 8; i++) data[i * 4] = toHalf(0.5);
  const skyao = { data, width: 4, n, tiles: [2, 1] as [number, number], wMin: [-10, -10, -10] as [number, number, number], wScale: [0.05, 0.05, 0.05] as [number, number, number], mCol: IDENT };

  it('朝上 cap = 1 ⇒ V = a0；水平 cap = 0.5 ⇒ V = 2·a0（钳到 1）', () => {
    const d = uniformProbes(2, 4, (k) => (k === 0 ? 4 : 0), { skyao });
    expect(skyaoV(d, Q, 0, 1, 0)).toBeCloseTo(0.5, 3);
    expect(skyaoV(d, Q, 1, 0, 0)).toBeCloseTo(1, 3);
  });

  it('blend = 1 乘满，blend = 0 不遮蔽；没有 skyao 载荷恒不遮蔽', () => {
    const base = uniformProbes(2, 4, (k) => (k === 0 ? 4 : 0));
    const e = probeEY(base, Q, 0, 1, 0);
    expect(indirectEY({ ...base, skyao, skyaoBlend: 1 }, Q, 0, 1, 0)).toBeCloseTo(e * 0.5, 3);
    expect(indirectEY({ ...base, skyao, skyaoBlend: 0 }, Q, 0, 1, 0)).toBeCloseTo(e, 6);
    expect(indirectEY(base, Q, 0, 1, 0)).toBeCloseTo(e, 6);
  });
});
