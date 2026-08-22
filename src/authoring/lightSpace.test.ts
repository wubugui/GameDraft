import { describe, expect, it } from 'vitest';

import { LightSpace, type LightSpaceGeometry, type Vec3 } from './lightSpace';
import { CHARACTER_HEIGHT_WU } from '../rendering/lighting/lightPacking';

/**
 * 换算的验收判据不是"看着对"，而是**逆变换必须逐位闭合**：
 * gizmo 画在哪、点下去落在哪，全靠这两个方向互为逆。差一个转置或错一套像素栅格
 * 都不报错，只表现为"gizmo 与灯的光斑差一点"——那种偏差用眼睛调不回来。
 *
 * 几何取自 **雾津街头**（目前唯一真摆了灯的场景）的真实产物：
 * `lighting2/meta.json` 的 work/cal/scale + 场景 JSON 的 `depthConfig.M.R` 与世界宽高。
 */
const WUJIN: Omit<LightSpaceGeometry, 'ground'> = {
  work: { w: 512, h: 288 },
  cal: { ppu: 112.64, cx: 256, cy: 144 },
  sceneWorld: { w: 4000, h: 2251.2 },
  // 绕 X 轴 45°，det = +1（游戏约定）。混进实验室那份 det = −1 的会让 Z 整体翻号。
  basisRows: [
    1, 0, 0,
    0, Math.SQRT1_2, -Math.SQRT1_2,
    0, Math.SQRT1_2, Math.SQRT1_2,
  ],
  wuPerQUnit: 880,
};

/** 造一块地面场：`slope` 非 0 时深度沿 x 线性变化，用来验斜坡上也闭合。 */
function ground(w: number, h: number, base = 0.4, slope = 0) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = base + slope * (x / w);
  }
  return { data, w, h };
}

function make(slope = 0): LightSpace {
  return new LightSpace({ ...WUJIN, ground: ground(512, 288, 0.4, slope) });
}

describe('灯世界 ↔ 伪世界 q', () => {
  it('两个方向互为逆', () => {
    const ls = make();
    const q: Vec3 = [0.37, -1.21, 0.83];
    const back = ls.worldToQ(ls.qToWorld(q));
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(q[i], 10);
  });

  it('尺度就是 wuPerQUnit（R 是旋转，不改长度）', () => {
    const ls = make();
    const w = ls.qToWorld([1, 0, 0]);
    expect(Math.hypot(w[0], w[1], w[2])).toBeCloseTo(WUJIN.wuPerQUnit, 6);
  });
});

describe('场景坐标 ↔ 灯世界', () => {
  it('地面点往返闭合（平地）', () => {
    const ls = make();
    for (const [sx, sy] of [[2000, 1125.6], [100, 200], [3900, 2100]]) {
      const back = ls.worldToScene(ls.groundWorldAt(sx, sy));
      expect(back.x).toBeCloseTo(sx, 6);
      expect(back.y).toBeCloseTo(sy, 6);
    }
  });

  it('地面点往返闭合（斜坡——投影丢的是深度，与地面高低无关）', () => {
    const ls = make(0.9);
    const back = ls.worldToScene(ls.groundWorldAt(1234, 1800));
    expect(back.x).toBeCloseTo(1234, 6);
    expect(back.y).toBeCloseTo(1800, 6);
  });

  it('画面中心的地面点落在 q 原点的 xy 上', () => {
    const ls = make();
    // work px = (cx, cy) ⇒ q.xy = (0,0)，只剩深度分量
    const q = ls.worldToQ(ls.groundWorldAt(2000, 1125.6));
    expect(q[0]).toBeCloseTo(0, 9);
    expect(q[1]).toBeCloseTo(0, 9);
    // 场是 Float32Array，0.4 存进去就不是精确的 0.4
    expect(q[2]).toBeCloseTo(0.4, 6);
  });
});

describe('抬高', () => {
  it('离地高度就是灯世界 Y 的差', () => {
    const ls = make();
    const g = ls.groundWorldAt(2000, 1125.6);
    const lamp = ls.raise(g, 2.5 * CHARACTER_HEIGHT_WU);
    expect(ls.heightAbove(lamp, g)).toBeCloseTo(2.5 * CHARACTER_HEIGHT_WU, 9);
    expect(lamp[0]).toBe(g[0]);
    expect(lamp[2]).toBe(g[2]);
  });

  it('抬高会把 gizmo 往画面上方推（45° 视角下高度看得见）', () => {
    const ls = make();
    const g = ls.groundWorldAt(2000, 1125.6);
    const onGround = ls.worldToScene(g);
    const raised = ls.worldToScene(ls.raise(g, CHARACTER_HEIGHT_WU));
    expect(raised.x).toBeCloseTo(onGround.x, 9);
    // 场景 y 朝下，所以"更高" = 更小的 y
    expect(raised.y).toBeLessThan(onGround.y);
  });

  it('正下方的地面点：恒定深度的场上也不跑偏（naive 投影估计会差一半）', () => {
    const ls = make();
    const g = ls.groundWorldAt(1500, 1600);
    const lamp = ls.raise(g, 300);
    const below = ls.groundBelow(lamp);
    // 正下方 = 世界 x、z 与灯相同
    expect(below[0]).toBeCloseTo(lamp[0], 4);
    expect(below[2]).toBeCloseTo(lamp[2], 4);
    expect(ls.heightAbove(lamp, below)).toBeCloseTo(300, 4);
  });

  it('正下方的地面点：真·世界水平地面上闭合', () => {
    // 世界 Y 恒为 Y0 的地面：worldY = (qy − d)·√½·k ⇒ d = qy − Y0/(√½·k)
    const Y0 = -500;
    const { work, cal, wuPerQUnit: k } = WUJIN;
    const data = new Float32Array(work.w * work.h);
    for (let py = 0; py < work.h; py++) {
      const qy = (cal.cy - py) / cal.ppu;
      const d = qy - Y0 / (Math.SQRT1_2 * k);
      for (let px = 0; px < work.w; px++) data[py * work.w + px] = d;
    }
    const ls = new LightSpace({ ...WUJIN, ground: { data, w: work.w, h: work.h } });

    const g = ls.groundWorldAt(1500, 1600);
    expect(g[1]).toBeCloseTo(Y0, 2);

    const lamp = ls.raise(g, 2 * CHARACTER_HEIGHT_WU);
    const below = ls.groundBelow(lamp);
    expect(below[1]).toBeCloseTo(Y0, 2);
    expect(ls.heightAbove(lamp, below)).toBeCloseTo(2 * CHARACTER_HEIGHT_WU, 2);
  });

});
