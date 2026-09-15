import { describe, expect, it, vi } from 'vitest';

// 只把两个渲染对象换成空壳（Shader.from 在无 DOM 的测试环境要 document），网格与 update 全走真实的 SwayBackground
vi.mock('pixi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('pixi.js')>();
  return { ...real, Shader: { from: () => ({ resources: {} }) }, Mesh: class extends real.Container {} };
});

import { Texture } from 'pixi.js';
import {
  SwayBackground, grayRange, swayPivotSplits, type BackgroundSwayInput, type GrayMap, type SwayInstanceDef,
} from './backgroundSway';
import { resolveSceneWind } from '../utils/sceneWind';

/**
 * 🔴 刚体要真的刚（制作人 2026-09-14："我把一个地方涂抹成了刚体，怎么运行起来发现还有扭曲呢"
 * "第一条肯定要改啊，不然大部分时候刚体没用"）。
 *
 * 原先网格一格 24 wu、刚体度只在格点上取一次：比格子细的竿一个顶点都压不中（整根照弯），
 * 半格竿半格叶的格子插出来半软半硬。现在：刚体交界 / 锚点分界的格子细分成 6，顶点取一个细格内的最大刚体度。
 * 判据全是**画出来的位移**（与光栅化同一个三角插值）对上刚体转动公式，不是看中间量。
 */

const SIZE = 800;
// 包围盒 [300, 516] × [100, 700]，补带 12 ⇒ 格网 [288, 528] × [88, 712]：正好 10 × 26 个 24 的整格
const BBOX: [number, number, number, number] = [300, 100, 516, 700];
const X0 = 288, Y0 = 88, CELL = 24, FINE = 6;

type Rt = {
  def: SwayInstanceDef; v0: number; v1: number;
  rig: [number, number, number, number]; inv: [number, number, number, number];
  grid: { nx: number; ny: number; mode: Uint8Array };
};
type Probe = {
  insts: Rt[]; p0: Float32Array; pos: Float32Array; vRigid: Float32Array;
  mesh: { geometry: { indexBuffer: { data: Uint32Array } } };
  drawnOffset(rt: Rt, sx: number, sy: number, out: { x: number; y: number }): void;
};

/** 整个包围盒都是 1 号株的 id 图（RGBA，与运行时 CPU 副本同形） */
function idsMap(): { data: Uint8ClampedArray; w: number; h: number } {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = BBOX[1]; y < BBOX[3]; y++) for (let x = BBOX[0]; x < BBOX[2]; x++) data[(y * SIZE + x) * 4] = 1;
  return { data, w: SIZE, h: SIZE };
}

/** 刚体度图：[x0, x1) × [y0, y1) 涂满 */
function stripe(x0: number, x1: number, y0: number, y1: number): GrayMap {
  const data = new Uint8Array(SIZE * SIZE);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * SIZE + x] = 255;
  return { data, w: SIZE, h: SIZE };
}

function build(inst: SwayInstanceDef, rigid: GrayMap | null, withIds = true): { sb: SwayBackground; S: Probe } {
  const inp = {
    urls: [], plateTex: Texture.WHITE, matteTex: Texture.WHITE, idsTex: Texture.WHITE,
    meta: { version: 3, margin: 12, instances: [inst] },
    sceneSize: [SIZE, SIZE], paintSize: [SIZE, SIZE],
    jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
    sceneToWorldXZ: null, scaleAt: null, ids: withIds ? idsMap() : null, matte: null, rigid, litPlate: null,
  } as unknown as BackgroundSwayInput;
  const sb = new SwayBackground(Texture.WHITE, inp);
  return { sb, S: sb as unknown as Probe };
}

const WIND = resolveSceneWind({
  direction: [-1, 0, 0], speed: 700, gust: { amount: 0.8, period: 5 }, turbulence: { intensity: 0.4, scale: 120 },
})!;

function blow(sb: SwayBackground, secs = 2.5): void {
  for (let i = 1; i <= Math.round(secs * 60); i++) sb.update(WIND, i / 60);
}

/** 刚体转动公式：绕支点 (px, py) 转，画面位移 = rig · inv · (p − 支点)（与 update 里 plant / 刚体像素同一式） */
function rigidOffset(rt: Rt, x: number, y: number, px: number, py: number): [number, number] {
  const rx = x - px, ry = y - py;
  const a = rt.inv[0] * rx + rt.inv[1] * ry, b = rt.inv[2] * rx + rt.inv[3] * ry;
  return [rt.rig[0] * a + rt.rig[1] * b, rt.rig[2] * a + rt.rig[3] * b];
}

const FIELD: SwayInstanceDef = { id: 1, kind: 'field', root: [400, 700], height: 85, persp: 1, reach: 620, bbox: BBOX };

describe('刚体涂层：画出来的就是整根转', () => {
  it('🔴 2 像素宽的竿不管落在格子里哪儿，竿上每一点的位移都等于绕根的刚体转动', () => {
    for (let px = 381; px <= 409; px += 4) {
      const { sb, S } = build(FIELD, stripe(px, px + 2, 200, 600));
      blow(sb);
      const rt = S.insts[0];
      const out = { x: 0, y: 0 };
      let worst = 0;
      for (let y = 205; y < 600; y += 15) {
        S.drawnOffset(rt, px + 1, y, out);
        const [ex, ey] = rigidOffset(rt, px + 1, y, FIELD.root[0], FIELD.root[1]);
        worst = Math.max(worst, Math.abs(out.x - ex), Math.abs(out.y - ey));
      }
      expect(worst, `竿在 x=${px}`).toBeLessThan(2e-3);
    }
  });

  it('对照：同一株上没涂刚体的地方是弯的（不然上一条什么都证明不了）', () => {
    const { sb, S } = build(FIELD, stripe(398, 400, 200, 600));
    blow(sb);
    const rt = S.insts[0];
    const out = { x: 0, y: 0 };
    let far = 0;
    for (let y = 205; y < 600; y += 15) {
      S.drawnOffset(rt, 470, y, out);
      const [ex, ey] = rigidOffset(rt, 470, y, FIELD.root[0], FIELD.root[1]);
      far = Math.max(far, Math.hypot(out.x - ex, out.y - ey));
    }
    expect(far).toBeGreaterThan(0.5);
  });

  it('过渡带只有一个细格：离竿超过一个细格的叶子一点刚体度都不带', () => {
    const { S } = build(FIELD, stripe(398, 400, 200, 600));
    const rt = S.insts[0];
    for (let v = rt.v0; v < rt.v1; v++) {
      const x = S.p0[v * 2], y = S.p0[v * 2 + 1];
      const dx = Math.max(398 - x, x - 400, 0), dy = Math.max(200 - y, y - 600, 0);
      if (Math.max(dx, dy) > FINE + 1e-3) expect(S.vRigid[v], `(${x},${y})`).toBe(0);
    }
  });

  it('只细分交界格：一根竿只细分它经过的那一列格子（外扩一个细格），其余格子一个顶点都不多', () => {
    const { S } = build(FIELD, stripe(398, 400, 200, 600));
    const g = S.insts[0].grid;
    const fine: string[] = [];
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (g.mode[j * g.nx + i] === 2) fine.push(`${i},${j}`);
    // 竿外扩 6：x ∈ [392, 406) 只落在第 4 列 [384, 408)；y ∈ [194, 606) 落在第 4..21 行
    const want: string[] = [];
    for (let j = 4; j <= 21; j++) want.push(`4,${j}`);
    expect(fine.sort()).toEqual(want.sort());
  });

  it('没涂刚体、没点两个以上锚点的株一格都不细分（顶点数与原来一样）', () => {
    const { S } = build(FIELD, null, false);
    expect(S.p0.length / 2).toBe((10 + 1) * (26 + 1));
  });
});

describe('锚点分界', () => {
  // 两个锚点在 x=300 与 x=366（同一高度），分界线 x=333，正好穿过 [312, 336) 这一列格子
  const PLANT: SwayInstanceDef = {
    id: 1, kind: 'plant', root: [333, 700], height: 300, persp: 1, reach: 620, bbox: BBOX,
    anchors: [[300, 650], [366, 650]],
  };

  it('swayPivotSplits：矩形跨分界才算', () => {
    expect(swayPivotSplits(PLANT.anchors, 312, 100, 336, 124)).toBe(true);
    expect(swayPivotSplits(PLANT.anchors, 288, 100, 312, 124)).toBe(false);
    expect(swayPivotSplits(PLANT.anchors, 336, 100, 360, 124)).toBe(false);
    expect(swayPivotSplits([[0, 0]], 0, 0, 1000, 1000)).toBe(false);
  });

  it('🔴 同一粗格里、分界两侧的点各绕各的锚点转（原先整格插值，两种转动搅在一起）', () => {
    const { sb, S } = build(PLANT, null);
    blow(sb);
    const rt = S.insts[0];
    const out = { x: 0, y: 0 };
    let worst = 0, mixed = 0;
    for (let y = 110; y < 700; y += 20) {
      for (const x of [315, 327]) {             // 都在 A（x=300）那侧，且离分界线超过一个细格
        S.drawnOffset(rt, x, y, out);
        const [ex, ey] = rigidOffset(rt, x, y, 300, 650);
        worst = Math.max(worst, Math.abs(out.x - ex), Math.abs(out.y - ey));
        const [bx, by] = rigidOffset(rt, x, y, 366, 650);
        mixed = Math.max(mixed, Math.hypot(ex - bx, ey - by));
      }
      S.drawnOffset(rt, 345, y, out);            // B 那侧
      const [ex, ey] = rigidOffset(rt, 345, y, 366, 650);
      worst = Math.max(worst, Math.abs(out.x - ex), Math.abs(out.y - ey));
    }
    expect(mixed, '两个支点给出的位移要确实不同').toBeGreaterThan(0.5);
    expect(worst).toBeLessThan(2e-3);
  });
});

describe('网格的完整性（细分 + 扇形）', () => {
  const cases: [string, SwayInstanceDef, GrayMap | null][] = [
    ['竿', FIELD, stripe(398, 400, 200, 600)],
    ['锚点分界', { ...FIELD, kind: 'plant', anchors: [[300, 650], [366, 650], [470, 300]] }, null],
    ['场里的竿 + 两根竿各一个锚点', { ...FIELD, anchors: [[350, 600], [460, 600]] }, stripe(340, 470, 150, 600)],
  ];

  for (const [name, inst, rigid] of cases) {
    it(`${name}：没有 T 形接缝（没有顶点落在别的三角形的边中间），三角形面积恰好铺满占用的格子`, () => {
      const { S } = build(inst, rigid);
      const rt = S.insts[0];
      const idx = S.mesh.geometry.indexBuffer.data;
      const key = (I: number, J: number) => `${I},${J}`;
      const lat = new Map<string, number>();
      const L = (v: number): [number, number] => [Math.round((S.p0[v * 2] - X0) / FINE), Math.round((S.p0[v * 2 + 1] - Y0) / FINE)];
      for (let v = rt.v0; v < rt.v1; v++) {
        const [I, J] = L(v);
        expect(Math.abs(S.p0[v * 2] - (X0 + I * FINE))).toBeLessThan(1e-3);
        lat.set(key(I, J), v);
      }
      const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
      let area = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const tri = [idx[t], idx[t + 1], idx[t + 2]];
        const P = tri.map(L);
        area += Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])) / 2;
        for (let e = 0; e < 3; e++) {
          const [a, b] = [P[e], P[(e + 1) % 3]];
          const dI = b[0] - a[0], dJ = b[1] - a[1], n = gcd(Math.abs(dI), Math.abs(dJ));
          for (let s = 1; s < n; s++) {
            const hit = lat.get(key(a[0] + (dI / n) * s, a[1] + (dJ / n) * s));
            expect(hit, `三角 ${tri} 的边上压着顶点 ${hit}`).toBeUndefined();
          }
        }
      }
      const g = rt.grid;
      let occ = 0;
      for (let c = 0; c < g.nx * g.ny; c++) if (g.mode[c] !== 0) occ++;
      expect(area).toBeCloseTo(occ * (CELL / FINE) ** 2, 6);
    });

    it(`${name}：纸钱取的位移在每个顶点上都等于那个顶点画出来的位移`, () => {
      const { sb, S } = build(inst, rigid);
      blow(sb, 1.5);
      const rt = S.insts[0];
      const out = { x: 0, y: 0 };
      for (let v = rt.v0; v < rt.v1; v++) {
        const x = S.p0[v * 2], y = S.p0[v * 2 + 1];
        if (x <= X0 || y <= Y0 || x >= X0 + g_w(rt) || y >= Y0 + g_h(rt)) continue;   // 外框上的点可能属于没铺的格
        S.drawnOffset(rt, x, y, out);
        expect(Math.abs(out.x - (S.pos[v * 2] - x)), `顶点 (${x},${y})`).toBeLessThan(2e-3);
        expect(Math.abs(out.y - (S.pos[v * 2 + 1] - y)), `顶点 (${x},${y})`).toBeLessThan(2e-3);
      }
    });
  }
});

const g_w = (rt: Rt) => rt.grid.nx * CELL;
const g_h = (rt: Rt) => rt.grid.ny * CELL;

describe('grayRange', () => {
  it('矩形内的最小 / 最大值；出图的部分钳掉', () => {
    const m = stripe(10, 12, 0, 5);
    expect(grayRange(m, SIZE, SIZE, 0, 0, 20, 20)).toEqual([0, 1]);
    expect(grayRange(m, SIZE, SIZE, 10, 0, 12, 5)).toEqual([1, 1]);
    expect(grayRange(m, SIZE, SIZE, 100, 100, 120, 120)).toEqual([0, 0]);
    expect(grayRange(m, SIZE, SIZE, -50, -50, -10, -10)).toEqual([0, 0]);
  });
});
