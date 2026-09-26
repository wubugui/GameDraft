// 前景层数据解析：定义归一化、`at`（原画像素）→ 拆层实例、排序点与网格范围。
// 真机上这几步错了**没有任何红字**——层被跳过，树照样画在人后面——所以逐条钉住。
import { describe, expect, it } from 'vitest';

import {
  FG_BASE_SAMPLES, FG_BASE_X_MARGIN, FG_RECT_EXTRA_PAD, FG_SWAY_SNAP_PX, baseLineY, foregroundBaseSamples, foregroundRect,
  foregroundSurfaceDepth, normalizeForegroundLayerDefs, quantizeForegroundDisplacement, resolveForegroundLayers, swayInstanceAtPaint,
  type ForegroundSwaySource,
} from './foregroundLayerDefs';

/** w×h 的 RGBA id 图，fill(x, y) 给该像素的实例 id */
function idMap(w: number, h: number, fill: (x: number, y: number) => number) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = fill(x, y);
      data[(y * w + x) * 4] = id & 255;
      data[(y * w + x) * 4 + 1] = id >> 8;
    }
  }
  return { data, w, h };
}

describe('normalizeForegroundLayerDefs', () => {
  it('合法项原样过；缺省 = 空表；非数组整份忽略并出声', () => {
    const warns: string[] = [];
    expect(normalizeForegroundLayerDefs(undefined, (m) => warns.push(m))).toEqual([]);
    expect(normalizeForegroundLayerDefs({}, (m) => warns.push(m))).toEqual([]);
    expect(warns.length).toBe(1);
    const ok = normalizeForegroundLayerDefs([
      { id: ' fg_a ', label: '树', source: { kind: 'swayPlant', at: [10, 20] }, base: { y: 30 } },
    ], () => {});
    expect(ok).toEqual([{ id: 'fg_a', label: '树', source: { kind: 'swayPlant', at: [10, 20] }, base: { y: 30 } }]);
    // 接地折线按 x 排好序，x 相同的只留第一个
    const [ln] = normalizeForegroundLayerDefs([
      { id: 'l', source: { kind: 'swayPlant', at: [1, 1] }, base: { line: [[50, 9], [10, 5], [10, 7], [30, 6]] } },
    ], () => {});
    expect(ln.base).toEqual({ line: [[10, 5], [30, 6], [50, 9]] });
  });

  it('坏项逐条跳过、各说一次，不连坐好项；id 重复时后一个跳过', () => {
    const warns: string[] = [];
    const out = normalizeForegroundLayerDefs([
      null,
      { source: { kind: 'swayPlant', at: [1, 1] } },
      { id: 'a', source: { kind: 'mask', image: 'x.png' } },
      { id: 'b', source: { kind: 'swayPlant', at: [1] } },
      { id: 'c', source: { kind: 'swayPlant', at: [1, 2] }, base: { y: 'x' } },
      { id: 'e', source: { kind: 'swayPlant', at: [1, 2] }, base: { line: [[1, 2]] } },
      { id: 'd', source: { kind: 'swayPlant', at: [3, 4] } },
      { id: 'd', source: { kind: 'swayPlant', at: [5, 6] } },
    ], (m) => warns.push(m));
    expect(out.map((d) => d.id)).toEqual(['d']);
    expect(out[0].source.at).toEqual([3, 4]);
    expect(warns.length).toBe(7);
  });
});

describe('swayInstanceAtPaint（与烘焙端 owner_at 同形）', () => {
  // 原画 200×100，id 图是降半的 100×50：株 7 占原画 x∈[40,80)、株 9 占 x∈[150,160)
  const ids = idMap(100, 50, (x) => (x >= 20 && x < 40 ? 7 : x >= 75 && x < 80 ? 9 : 0));
  const paint: [number, number] = [200, 100];

  it('点在株上 → 就是它（按比例落到降采样的格子上）', () => {
    expect(swayInstanceAtPaint(ids, paint, [50, 30])).toBe(7);
    expect(swayInstanceAtPaint(ids, paint, [155, 90])).toBe(9);
  });

  it('点不在株上 → 吸附半径内最近的一株；超出半径 → 0', () => {
    expect(swayInstanceAtPaint(ids, paint, [90, 30])).toBe(7);       // 离株 7 右沿 10 px
    expect(swayInstanceAtPaint(ids, paint, [145, 30])).toBe(9);      // 离株 9 左沿 5 px
    expect(swayInstanceAtPaint(ids, paint, [115, 30])).toBe(0);      // 两边都 > 24 px
    expect(FG_SWAY_SNAP_PX).toBe(24);
  });

  it('点在原画外 → 0', () => {
    expect(swayInstanceAtPaint(ids, paint, [-1, 10])).toBe(0);
    expect(swayInstanceAtPaint(ids, paint, [10, 100])).toBe(0);
  });

  it('实例 id 超过 255 时按 R + 256·G 解', () => {
    const big = idMap(4, 4, () => 300);
    expect(swayInstanceAtPaint(big, [4, 4], [1, 1])).toBe(300);
  });
});

describe('resolveForegroundLayers', () => {
  // 场景世界 400×200、原画 200×100（2 倍）：跑马梁恰好 1:1，这里故意不等，钉"一律按比例"
  const src = (extra: Partial<ForegroundSwaySource> = {}): ForegroundSwaySource => ({
    ids: idMap(200, 100, (x, y) => (x >= 50 && x < 70 && y >= 20 && y < 60 ? 1 : 0)),
    paintSize: [200, 100],
    sceneSize: [400, 200],
    instances: [{ id: 1, root: [110, 118], bbox: [100, 40, 140, 120] }],
    maxDisplacement: 30,
    ...extra,
  });

  it('接地点缺省取该株 root；网格范围 = bbox 外扩（最大位移 + 余量）', () => {
    const [L] = resolveForegroundLayers(
      [{ id: 'fg', source: { kind: 'swayPlant', at: [60, 40] } }], src(), () => { throw new Error('不该出声'); });
    expect(L.instId).toBe(1);
    expect(L.label).toBe('fg');
    expect([L.baseX, L.baseY, L.baseLine]).toEqual([110, 118, null]);
    // 位移 30 按 8 wu 一档向上取整到 32，再加余量
    const p = quantizeForegroundDisplacement(30) + FG_RECT_EXTRA_PAD;
    expect(p).toBe(40);
    expect(L.rect).toEqual([100 - p, 40 - p, 140 + p, 120 + p]);
    expect(L.bbox).toEqual([100, 40, 140, 120]);
    expect(foregroundRect(L.bbox, 32, [400, 200])).toEqual(L.rect);
    // 给了逐株的真实位移就按它（不按统一的软封顶）
    const [L2] = resolveForegroundLayers(
      [{ id: 'fg', source: { kind: 'swayPlant', at: [60, 40] } }], src({ displacementOf: () => 3 }), () => {});
    expect(L2.rect).toEqual([100 - 16, 40 - 16, 140 + 16, 120 + 16]);
  });

  it('base 写了哪项覆盖哪项；写了折线就带折线', () => {
    const [a] = resolveForegroundLayers(
      [{ id: 'a', source: { kind: 'swayPlant', at: [60, 40] }, base: { y: 150 } }], src(), () => {});
    expect([a.baseX, a.baseY]).toEqual([110, 150]);
    const [b] = resolveForegroundLayers(
      [{ id: 'b', source: { kind: 'swayPlant', at: [60, 40] }, base: { x: 5, y: 6 } }], src(), () => {});
    expect([b.baseX, b.baseY]).toEqual([5, 6]);
    const [c] = resolveForegroundLayers(
      [{ id: 'c', source: { kind: 'swayPlant', at: [60, 40] }, base: { line: [[0, 100], [400, 180]] } }], src(), () => {});
    expect(c.baseLine).toEqual([[0, 100], [400, 180]]);
  });

  it('网格范围钳在场景内', () => {
    const [L] = resolveForegroundLayers(
      [{ id: 'fg', source: { kind: 'swayPlant', at: [60, 40] } }],
      src({ instances: [{ id: 1, root: [10, 10], bbox: [0, 0, 390, 195] }] }), () => {});
    expect(L.rect).toEqual([0, 0, 400, 200]);
  });

  it('点不在任何株上 / 株不在这份拆层 / 在原画外 / 没有 CPU id 图：各自出声、跳过', () => {
    const warns: string[] = [];
    const out = resolveForegroundLayers([
      { id: 'miss', source: { kind: 'swayPlant', at: [150, 90] } },
      { id: 'out', source: { kind: 'swayPlant', at: [250, 10] } },
    ], src(), (m) => warns.push(m));
    expect(out).toEqual([]);
    expect(warns.length).toBe(2);
    const w2: string[] = [];
    expect(resolveForegroundLayers([{ id: 'x', source: { kind: 'swayPlant', at: [60, 40] } }],
      src({ instances: [] }), (m) => w2.push(m))).toEqual([]);
    expect(w2.length).toBe(1);
    const w3: string[] = [];
    expect(resolveForegroundLayers([{ id: 'x', source: { kind: 'swayPlant', at: [60, 40] } }],
      src({ ids: null }), (m) => w3.push(m))).toEqual([]);
    expect(w3.length).toBe(1);
  });
});

/**
 * 前景面深度 = 接地深度 + 深度梯度 × (像素 y − 接地 y)：与角色直立 quad 同一个式子。
 * 下面这组拿一块"平地"（深度随画面 y 线性变）当行走面场，把滤镜里的判据
 * `前景面深度 < 角色脚点深度 + 深度梯度 × (像素 y − 脚底 y)` 用纯数算一遍——
 * 钉住制作人问的那件事：同一片蒙版，站的地方不同答案就不同。
 */
describe('接地线：逐像素判谁挡谁', () => {
  // 平地：往画面下方走深度变小（更近）；直立面往上走越近（梯度为正：往下越深）
  const K = 0.00126, UP = 0.00222;
  const ground = (_x: number, y: number) => 1 - K * y;
  const model = { uprightPerY: UP, groundAt: ground };
  /** 滤镜那一行：像素 (px, py) 上，前景面是否挡住脚站在 (fx, fy) 的人 */
  const occludes = (s: ReturnType<typeof foregroundBaseSamples>, px: number, py: number, fx: number, fy: number) => {
    const t = Math.min(1, Math.max(0, (px - s!.x0) / (s!.x1 - s!.x0))) * (FG_BASE_SAMPLES - 1);
    const i = Math.min(Math.floor(t), FG_BASE_SAMPLES - 2), f = t - i;
    const by = s!.data[i * 2] * (1 - f) + s!.data[(i + 1) * 2] * f;
    const bd = s!.data[i * 2 + 1] * (1 - f) + s!.data[(i + 1) * 2 + 1] * f;
    const fg = foregroundSurfaceDepth(by, bd, UP, py);
    return fg < ground(fx, fy) + UP * (py - fy) - 1e-4;
  };

  it('接地点：脚在接地线后（y 更小）被挡，在前不挡；和像素在蒙版哪一处无关（树立在一个点上）', () => {
    const tree = { baseX: 1227, baseY: 577, baseLine: null, bbox: [1214, 364, 1457, 583] as [number, number, number, number] };
    const s = foregroundBaseSamples(tree, model, [2048, 1152])!;
    expect(s.x0).toBe(1214 - FG_BASE_X_MARGIN);
    expect(s.data[1]).toBeCloseTo(ground(1227, 577), 6);
    for (const [px, py] of [[1240, 540], [1400, 400]]) {
      expect(occludes(s, px, py, px, 560)).toBe(true);
      expect(occludes(s, px, py, px, 600)).toBe(false);
    }
  });

  it('斜接地线：同一个脚底 y、站在不同的 x，一个被挡一个不挡（栏杆斜着伸进画面深处）', () => {
    // 左端接地在 y 500（远），右端 y 700（近）
    const rail = { baseX: 0, baseY: 0, baseLine: [[800, 500], [1200, 700]] as [number, number][], bbox: [800, 300, 1200, 700] as [number, number, number, number] };
    const s = foregroundBaseSamples(rail, model, [2048, 1152])!;
    expect(baseLineY(rail.baseLine, 1000)).toBe(600);
    // 脚都在 y 620：左端（接地 500）在它后面 → 人在栏杆前、不挡；右端（接地 690）在它前面 → 挡
    expect(occludes(s, 850, 560, 850, 620)).toBe(false);
    expect(occludes(s, 1180, 640, 1180, 620)).toBe(true);
  });

  it('两个人同时压着同一片蒙版，各判各的（不是整层一个先后）', () => {
    const tree = { baseX: 1227, baseY: 577, baseLine: null, bbox: [1214, 364, 1457, 583] as [number, number, number, number] };
    const s = foregroundBaseSamples(tree, model, [2048, 1152])!;
    expect(occludes(s, 1300, 500, 1300, 540)).toBe(true);    // 树后那个
    expect(occludes(s, 1300, 500, 1310, 640)).toBe(false);   // 树前那个，同一个像素
  });

  it('接地点取不到行走面深度 ⇒ null；折线上取不到的点用最近的有效点补', () => {
    const none = { ...model, groundAt: () => null };
    expect(foregroundBaseSamples({ baseX: 1, baseY: 1, baseLine: null, bbox: [0, 0, 10, 10] }, none, [100, 100])).toBeNull();
    const half = { ...model, groundAt: (x: number, y: number) => (x < 300 ? null : ground(x, y)) };
    const s = foregroundBaseSamples({ baseX: 0, baseY: 0, baseLine: [[0, 50], [600, 50]], bbox: [256, 0, 344, 10] }, half, [600, 100])!;
    expect(s.data[1]).toBeCloseTo(ground(0, 50), 6);          // 第一个点在场外，借最近的有效点
    expect(Number.isFinite(s.meanDepth)).toBe(true);
  });
});
