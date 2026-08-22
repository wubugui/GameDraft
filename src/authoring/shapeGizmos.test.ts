import { describe, expect, it } from 'vitest';

import type { LightDef } from '../data/types';
import type { Camera } from '../rendering/Camera';
import { directionFromAngles } from '../rendering/lighting/lightPacking';
import { LightSpace, type LightSpaceGeometry, type Vec3 } from './lightSpace';
import {
  anglesFromDirection,
  areaSizeFromPointer,
  axesFromNormal,
  normalizeDeg,
  rollFromPointer,
  buildAreaGizmo,
  buildSpotGizmo,
  coneAngleFromPointer,
  lightAxisOf,
  normalFromPointerDelta,
  viewDirection,
} from './shapeGizmos';

/**
 * 形状 gizmo 的验收判据是**往返闭合**：画出来的手柄拖回同一个位置，必须解出
 * 原来那个值。差一点就是「拖着框调、画面上亮的却是别处」——那种偏差用眼睛调不回来，
 * 只会让人以为是灯的公式错了。
 *
 * 几何取自雾津街头（与 lightSpace.test.ts 同一份）。
 */
const WUJIN: Omit<LightSpaceGeometry, 'ground'> = {
  work: { w: 512, h: 288 },
  cal: { ppu: 112.64, cx: 256, cy: 144 },
  sceneWorld: { w: 4000, h: 2251.2 },
  basisRows: [
    1, 0, 0,
    0, Math.SQRT1_2, -Math.SQRT1_2,
    0, Math.SQRT1_2, Math.SQRT1_2,
  ],
  wuPerQUnit: 880,
};

function ground(base = 0.4, slope = 0) {
  const w = 512;
  const h = 288;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = base + slope * (x / w);
  }
  return { data, w, h };
}

function space(slope = 0): LightSpace {
  return new LightSpace({ ...WUJIN, ground: ground(0.4, slope) });
}

/** 最小相机替身：只用到 worldToScreen / screenToWorld，且两者互为逆。 */
function camera(scale = 0.5, cx = 640, cy = 360): Camera {
  return {
    worldToScreen: (x: number, y: number) => ({ x: x * scale - cx, y: y * scale - cy }),
    screenToWorld: (x: number, y: number) => ({ x: (x + cx) / scale, y: (y + cy) / scale }),
  } as unknown as Camera;
}

function spotAt(pos: Vec3, dir: Vec3, inner = 20, outer = 35): LightDef {
  return {
    id: 'lamp_t', kind: 'spot', intensity: 2.5, pos,
    dir, innerAngleDeg: inner, outerAngleDeg: outer, range: 450,
  };
}

describe('朝向轴的缺省口径', () => {
  it('照抄 packLights：dir ?? orientation ?? [0,0,-1]', () => {
    expect(lightAxisOf({ id: 'a', kind: 'spot', intensity: 1 })).toEqual([0, 0, -1]);
    expect(lightAxisOf({
      id: 'a', kind: 'area', intensity: 1, orientation: [0, 0, 2],
    })).toEqual([0, 0, 1]);
    // dir 压过 orientation（与 packLights 的 ?? 链同序）
    expect(lightAxisOf({
      id: 'a', kind: 'spot', intensity: 1, dir: [1, 0, 0], orientation: [0, 1, 0],
    })).toEqual([1, 0, 0]);
  });
});

describe('面光的正交基与 shader 的 areaAxes 同构', () => {
  it('u/v/n 两两正交且都是单位长', () => {
    for (const n0 of [[0, 0, -1], [0, 1, 0], [0.3, -0.8, 0.5], [1, 0, 0]] as Vec3[]) {
      const { n, u, v } = axesFromNormal(n0);
      expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 10);
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 10);
      expect(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).toBeCloseTo(0, 10);
      expect(u[0] * n[0] + u[1] * n[1] + u[2] * n[2]).toBeCloseTo(0, 10);
      expect(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]).toBeCloseTo(0, 10);
    }
  });

  it('法线接近 ±Y 时改用 X 当 up（否则 cross 退化成零向量）', () => {
    const { u } = axesFromNormal([0, 1, 0]);
    expect(Number.isFinite(u[0]) && Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 10);
  });
});

describe('仰角/方位角 ↔ 方向向量', () => {
  it('与 directionFromAngles 互为逆（那是 GPU 真正在用的那条公式）', () => {
    for (const [e, a] of [[0, 0], [45, 180], [-30, 90], [12.5, -75]]) {
      const d = directionFromAngles(e, a);
      const back = anglesFromDirection(d);
      expect(back.elevationDeg).toBeCloseTo(e, 8);
      // 方位角在 ±180 处等价，比向量而不是比角度
      const again = directionFromAngles(back.elevationDeg, back.azimuthDeg);
      for (let i = 0; i < 3; i++) expect(again[i]).toBeCloseTo(d[i], 8);
    }
  });

  it('拖法线针：零位移不改朝向', () => {
    const base: Vec3 = [0, 0, -1];
    const same = normalFromPointerDelta(base, 0, 0, 1);
    for (let i = 0; i < 3; i++) expect(same[i]).toBeCloseTo(base[i], 8);
  });

  it('拖法线针：仰角夹在 ±89（±90 是万向锁，转过去就转不回来）', () => {
    const up = normalFromPointerDelta([0, 0, -1], 0, -100000, 1);
    expect(anglesFromDirection(up).elevationDeg).toBeCloseTo(89, 6);
    const down = normalFromPointerDelta([0, 0, -1], 0, 100000, 1);
    expect(anglesFromDirection(down).elevationDeg).toBeCloseTo(-89, 6);
  });
});

describe('聚光：靶点与锥角', () => {
  it('朝下射到平地：靶点就在地面上，离地高度归零', () => {
    const ls = space();
    const lamp: Vec3 = [0, 0, 0];
    const g = ls.groundBelow(lamp);
    const pos: Vec3 = [g[0], g[1] + 300, g[2]];
    const hit = ls.groundHitAlong(pos, [0, -1, 0], 1200);
    expect(hit).not.toBeNull();
    const clearance = hit![1] - ls.groundBelow(hit!)[1];
    expect(Math.abs(clearance)).toBeLessThan(1);
  });

  it('朝上射：射不到地面，返回 null（不假装有交点）', () => {
    const ls = space();
    const g = ls.groundBelow([0, 0, 0]);
    expect(ls.groundHitAlong([g[0], g[1] + 300, g[2]], [0, 1, 0], 1200)).toBeNull();
  });

  it('锥口手柄拖回原处 → 解出原来的锥角（往返闭合）', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const light = spotAt([g[0], g[1] + 300, g[2]], [0, -1, 0], 18, 33);
    const gz = buildSpotGizmo(ls, cam, light);
    expect(gz).not.toBeNull();
    expect(gz!.onGround).toBe(true);
    expect(coneAngleFromPointer(gz!, gz!.outerHandle)).toBeCloseTo(33, 4);
    expect(coneAngleFromPointer(gz!, gz!.innerHandle)).toBeCloseTo(18, 4);
  });

  it('射不到地面时靶点悬空，但仍然给得出手柄（能拖回来）', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const light = spotAt([g[0], g[1] + 300, g[2]], [0, 1, 0]);
    const gz = buildSpotGizmo(ls, cam, light);
    expect(gz).not.toBeNull();
    expect(gz!.onGround).toBe(false);
    expect(Number.isFinite(gz!.target.x)).toBe(true);
  });

  it('不是聚光就没有聚光 gizmo', () => {
    const ls = space();
    expect(buildSpotGizmo(ls, camera(), {
      id: 'p', kind: 'point', intensity: 1, pos: [0, 100, 0],
    })).toBeNull();
  });
});

describe('面光：尺寸与朝向', () => {
  const areaAt = (pos: Vec3, size: [number, number], o: Vec3): LightDef => ({
    id: 'win_t', kind: 'area', intensity: 2, pos, size, orientation: o, range: 450,
  });

  it('宽/高手柄拖回原处 → 解出原来的尺寸（往返闭合）', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const light = areaAt([g[0], g[1] + 200, g[2]], [260, 140], [0, 0, -1]);
    const gz = buildAreaGizmo(ls, cam, light);
    expect(gz).not.toBeNull();
    expect(areaSizeFromPointer(gz!, gz!.widthHandle, 'w')).toBeCloseTo(260, 4);
    expect(areaSizeFromPointer(gz!, gz!.heightHandle, 'h')).toBeCloseTo(140, 4);
  });

  it('四角是中心 ± 半轴，绕向与 lcAreaLight 的顶点顺序一致', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const gz = buildAreaGizmo(ls, cam, areaAt([g[0], g[1] + 200, g[2]], [200, 100], [0, 0, -1]))!;
    expect(gz.corners).toHaveLength(4);
    // 对角线的中点必须都落在中心上（这是"± 半轴"的充要判据）
    for (const [a, b] of [[0, 2], [1, 3]] as const) {
      expect((gz.corners[a].x + gz.corners[b].x) / 2).toBeCloseTo(gz.center.x, 6);
      expect((gz.corners[a].y + gz.corners[b].y) / 2).toBeCloseTo(gz.center.y, 6);
    }
  });

  it('尺寸不会被拖成 0 或负（面板反折过去就再也拖不回来了）', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const gz = buildAreaGizmo(ls, cam, areaAt([g[0], g[1] + 200, g[2]], [200, 100], [0, 0, -1]))!;
    const far = { x: gz.center.x - 100000 * gz.uScreen.x, y: gz.center.y - 100000 * gz.uScreen.y };
    expect(areaSizeFromPointer(gz, far, 'w')!).toBeGreaterThan(0);
    expect(areaSizeFromPointer(gz, gz.center, 'w')!).toBeGreaterThanOrEqual(1);
  });

  it('自转把 u/v 在面板平面里转过去，法线不动', () => {
    const a0 = axesFromNormal([0, 0, -1], 0);
    const a90 = axesFromNormal([0, 0, -1], 90);
    // 法线不变
    for (let i = 0; i < 3; i++) expect(a90.n[i]).toBeCloseTo(a0.n[i], 10);
    // 转 90° 之后 u 落到原来的 v 上
    for (let i = 0; i < 3; i++) expect(a90.u[i]).toBeCloseTo(a0.v[i], 10);
    // 仍是正交基
    expect(a90.u[0] * a90.v[0] + a90.u[1] * a90.v[1] + a90.u[2] * a90.v[2]).toBeCloseTo(0, 10);
    expect(Math.hypot(a90.u[0], a90.u[1], a90.u[2])).toBeCloseTo(1, 10);
  });

  it('转 360° 回到原处（配方里没有累积误差）', () => {
    const a0 = axesFromNormal([0.3, -0.6, 0.74], 0);
    const a360 = axesFromNormal([0.3, -0.6, 0.74], 360);
    for (let i = 0; i < 3; i++) expect(a360.u[i]).toBeCloseTo(a0.u[i], 10);
  });

  it('转柄拖回原处 → 解出原来的自转角（往返闭合）', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    for (const roll of [0, 27, -63, 150]) {
      const light: LightDef = {
        id: 'win_r', kind: 'area', intensity: 2, pos: [g[0], g[1] + 200, g[2]],
        size: [260, 140], orientation: [0, 0, -1], rollDeg: roll, range: 450,
      };
      const gz = buildAreaGizmo(ls, cam, light)!;
      expect(gz.rollDeg).toBe(roll);
      const back = rollFromPointer(gz, gz.rollHandle);
      expect(back).not.toBeNull();
      expect(normalizeDeg(back! - roll)).toBeCloseTo(0, 4);
    }
  });

  it('转柄拖到 +U 方向 → 自转恰好走 90°', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const light: LightDef = {
      id: 'win_r', kind: 'area', intensity: 2, pos: [g[0], g[1] + 200, g[2]],
      size: [260, 140], orientation: [0, 0, -1], rollDeg: 0, range: 450,
    };
    const gz = buildAreaGizmo(ls, cam, light)!;
    // 转柄现在在 +V 上；把指针放到 +U 上，等价于绕法线转 −90°
    //（u' = u cos + v sin、v' = v cos − u sin ⇒ v' 落到 u 上时 roll = −90）
    const L = 200;
    const p = {
      x: gz.center.x + gz.uScreen.x * L * gz.pxPerWuU,
      y: gz.center.y + gz.uScreen.y * L * gz.pxPerWuU,
    };
    expect(rollFromPointer(gz, p)!).toBeCloseTo(-90, 4);
  });

  it('自转角规到 [-180,180)，拖几圈不会变成 3600°', () => {
    expect(normalizeDeg(370)).toBeCloseTo(10, 10);
    expect(normalizeDeg(-370)).toBeCloseTo(-10, 10);
    expect(normalizeDeg(180)).toBeCloseTo(-180, 10);
    expect(normalizeDeg(-180)).toBeCloseTo(-180, 10);
  });

  it('自转不改尺寸手柄的往返闭合（宽/高走的是转过之后的轴）', () => {
    const ls = space();
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const gz = buildAreaGizmo(ls, cam, {
      id: 'win_r', kind: 'area', intensity: 2, pos: [g[0], g[1] + 200, g[2]],
      size: [260, 140], orientation: [0, 0, -1], rollDeg: 41, range: 450,
    })!;
    expect(areaSizeFromPointer(gz, gz.widthHandle, 'w')).toBeCloseTo(260, 4);
    expect(areaSizeFromPointer(gz, gz.heightHandle, 'h')).toBeCloseTo(140, 4);
  });

  it('正面判据用的是真视线，不是"法线的 Z 分量为负"', () => {
    const ls = space();
    const view = viewDirection(ls);
    // 这套基（绕 X 45°）下视线在灯世界里**不是** (0,0,1)：
    // 若正面判据偷懒写成 n[2] < 0，下面这条法线就会判反。
    expect(Math.abs(view[1])).toBeGreaterThan(0.1);
    const cam = camera();
    const g = ls.groundBelow([0, 0, 0]);
    const facing = buildAreaGizmo(
      ls, cam,
      areaAt([g[0], g[1] + 200, g[2]], [200, 100], [-view[0], -view[1], -view[2]]),
    )!;
    const away = buildAreaGizmo(
      ls, cam, areaAt([g[0], g[1] + 200, g[2]], [200, 100], view),
    )!;
    expect(facing.facingCamera).toBe(true);
    expect(away.facingCamera).toBe(false);
  });
});
