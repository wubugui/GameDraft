import { describe, expect, it, vi } from 'vitest';

// 只把两个渲染对象换成空壳：`Shader.from` 在没有 DOM 的测试环境里要 `document`。
// 其余全是真的——网格、振子、封顶、整株转角与逐顶点位移都走 `SwayBackground.update`，
// 所以运行时哪天又被塞回"减掉平均风弯角"，这里会红（照抄一份公式去模拟是看不出调用处被改的）。
vi.mock('pixi.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('pixi.js')>();
  return { ...real, Shader: { from: () => ({ resources: {} }) }, Mesh: class extends real.Container {} };
});

import { Texture } from 'pixi.js';
import { SwayBackground, type BackgroundSwayInput } from './backgroundSway';
import { resolveSceneWind } from '../utils/sceneWind';

/**
 * 🔴 原画没有风：风往哪吹，草木就往哪斜，风一直在就一直斜着。
 *
 * 制作人 2026-09-13："纸钱往左边飞，树看起来往右边倒"。根因是 2026-09-11 第一版编了一句
 * "原画画的是平均风下的姿态"、画面上只画「此刻弯角 − 平均风弯角」——风弱于平均的时间占大半，
 * 树就大半时间被画在逆风侧（跑马梁实测松树 59%、草 54%）。原画里没有风，那一下减法整个删掉。
 *
 * 合成一株松树（株高 332，同跑马梁那棵）和一片草，补带 48（同现在的烘焙），吹跑马梁的风空跑 4 分钟。
 */
describe('草木随风的方向（真实 SwayBackground.update）', () => {
  const simulate = (dirX: number, speed: number) => {
    const inp = {
      urls: [], plateTex: Texture.WHITE, matteTex: Texture.WHITE, idsTex: Texture.WHITE,
      meta: {
        version: 3, margin: 48, instances: [
          { id: 1, kind: 'plant', root: [200, 380], height: 332, persp: 1, reach: 300, bbox: [150, 80, 250, 380] },
          { id: 2, kind: 'field', root: [320, 380], height: 85, persp: 1, reach: 100, bbox: [290, 290, 350, 380] },
        ],
      },
      sceneSize: [400, 400], paintSize: [400, 400],
      // 跑马梁的相机：世界 +X 往屏幕右，+Y / +Z 往屏幕上
      jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
      sceneToWorldXZ: null, scaleAt: null, ids: null, matte: null, rigid: null,
    } as unknown as BackgroundSwayInput;
    const sb = new SwayBackground(Texture.WHITE, inp);
    const w = resolveSceneWind({
      direction: [dirX, 0, -0.25], speed, gust: { amount: 0.8, period: 7 },
      veer: 14, turbulence: { intensity: 0.35, scale: 140 }, roughness: 1,
    })!;
    const S = sb as unknown as {
      insts: { def: { id: number }; theta: number; v0: number; v1: number }[];
      p0: Float32Array; pos: Float32Array;
    };
    const plant = S.insts.find((r) => r.def.id === 1)!;
    const field = S.insts.find((r) => r.def.id === 2)!;
    const ex = inp.jx[0] * w.dirX + inp.jz[0] * w.dirZ, ey = inp.jx[1] * w.dirX + inp.jz[1] * w.dirZ;
    const el = Math.hypot(ex, ey);
    const tipX: number[] = [], plantAng: number[] = [], fieldAlong: number[] = [];
    for (let i = 1; i <= 240 * 60; i++) {
      sb.update(w, i / 60);
      if (i < 600) continue;                               // 前 10 秒让振子适应
      plantAng.push(plant.theta);
      let tx = 0, tc = 0;
      for (let v = plant.v0; v < plant.v1; v++) {
        if (S.p0[v * 2 + 1] < 120) { tx += S.pos[v * 2] - S.p0[v * 2]; tc++; }   // 树梢那几排顶点的屏幕 x 位移
      }
      tipX.push(tc ? tx / tc : 0);
      let acc = 0, c = 0;
      for (let v = field.v0; v < field.v1; v++) {
        const d = ((S.pos[v * 2] - S.p0[v * 2]) * ex + (S.pos[v * 2 + 1] - S.p0[v * 2 + 1]) * ey) / el;
        if (d !== 0) { acc += d; c++; }
      }
      fieldAlong.push(c ? acc / c : 0);
    }
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    return {
      tipMean: mean(tipX), tipP05: q(tipX, 0.05), tipP95: q(tipX, 0.95),
      tipMaxAbs: Math.max(...tipX.map(Math.abs)),
      plantUpwind: plantAng.filter((x) => x < -1e-4).length / plantAng.length,
      fieldUpwind: fieldAlong.filter((x) => x < -0.05).length / fieldAlong.length,
    };
  };

  it('🔴 风往左吹，树梢一直在左边（95% 以上的时间），逆风只剩弹性回弹', () => {
    const s = simulate(-1, 400);
    expect(s.tipP95).toBeLessThan(0);
    expect(s.plantUpwind).toBeLessThan(0.02);
    expect(s.fieldUpwind).toBeLessThan(0.01);
  });

  it('🔴 风往右吹，树梢一直在右边', () => {
    const s = simulate(1, 400);
    expect(s.tipP05).toBeGreaterThan(0);
    expect(s.plantUpwind).toBeLessThan(0.02);
    expect(s.fieldUpwind).toBeLessThan(0.01);
  });

  it('左右两个方向完全镜像（同一棵树同样的风，斜得一样多）', () => {
    const l = simulate(-1, 400), r = simulate(1, 400);
    expect(Math.abs(l.tipMean + r.tipMean)).toBeLessThan(Math.abs(r.tipMean) * 0.05);
    expect(r.tipMean).toBeGreaterThan(5);
  });

  it('🔴 原画没有风：几乎没风时草木就是原画的样子，不偏向任何一边', () => {
    expect(simulate(-1, 5).tipMaxAbs).toBeLessThan(0.1);
  });
});
