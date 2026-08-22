import { describe, expect, it } from 'vitest';

// 直接读 GLSL 本体：契约版本、切片标记、eps 常量都从它解析出来比对，
// 让"改 GLSL 忘了改 TS"变成机械可捕获的失败，而不是靠自觉。
import GLSL from '../rendering/lighting/worldReconstruct.glsl?raw';
import {
  WR_CONTRACT,
  WR_EPS_PROJ,
  WR_EPS_SCENE,
  isGameConventionMatrix,
  matrixDet3,
  resolveDepthPerSy,
  wrCellInside,
  wrDecodeGroundDepthFromBytes,
  wrDecodeRG16Unit,
  wrDecodeRG16UnitBytes,
  wrDecodeSceneDepthFromBytes,
  wrProbeWorldToQComponent,
  wrQToProbeWorldComponent,
  wrQToWorldRow,
  wrQx,
  wrQxToPx,
  wrQy,
  wrQyToPx,
  wrSpriteDepth,
  wrUprightDelta,
  wrWorldToPxDiv,
  wrWorldXZToCell,
} from './worldReconstruct';

/**
 * 世界重建数学的口径锁。这套数学收编前散在 9 处、已经漂出分叉
 * （`uDepthPerSy` 缺字段时一处从 M 现推、一处直接归零＝悄悄退回 billboard）。
 * 这些测试锁的是**符号与顺序**——这类错误不会崩，只会让画面"看着差不多但是错的"。
 */

describe('契约版本', () => {
  it('**直接从 GLSL 文本解析**，改一边不改另一边当场红', () => {
    const m = /#define\s+WR_CONTRACT\s+(\d+)/.exec(GLSL);
    expect(m, 'GLSL 里找不到 #define WR_CONTRACT').not.toBeNull();
    expect(Number(m![1])).toBe(WR_CONTRACT);
  });

  it('GLSL 的三个切片标记齐全（拼接器靠它们切）', () => {
    for (const tag of ['WR_CORE', 'WR_TEX', 'WR_SPRITE']) {
      expect(GLSL, `缺 ${tag} 起始标记`).toContain(`//__${tag}_BEGIN__`);
      expect(GLSL, `缺 ${tag} 结束标记`).toContain(`//__${tag}_END__`);
    }
  });

  it('GLSL 不含 #version / precision / uniform 声明（它永远是被塞进别人 shader 中段的一段）', () => {
    const body = GLSL.slice(GLSL.indexOf('//__WR_CORE_BEGIN__'));
    expect(body).not.toMatch(/^\s*#version/m);
    expect(body).not.toMatch(/^\s*precision\s+\w+p\s+float\s*;/m);
    expect(body).not.toMatch(/^\s*uniform\s/m);
  });

  it('GLSL 里的 eps 常量与 TS 侧同值（数值改了就是行为变化）', () => {
    for (const [name, value] of [
      ['WR_EPS_PROJ', WR_EPS_PROJ], ['WR_EPS_SCENE', WR_EPS_SCENE],
    ] as const) {
      const re = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*([0-9.eE+-]+)\\s*;`);
      const m = re.exec(GLSL);
      expect(m, `GLSL 里找不到 ${name}`).not.toBeNull();
      expect(Number(m![1])).toBe(value);
    }
  });
});

describe('像素 → 伪世界 q', () => {
  const ppu = 450.56;
  const cx = 1024;
  const cy = 571.5;

  it('q.x 不翻号：主点右侧为正', () => {
    expect(wrQx(cx + ppu, ppu, cx)).toBeCloseTo(1, 9);
    expect(wrQx(cx - ppu, ppu, cx)).toBeCloseTo(-1, 9);
  });

  it('q.y **翻 Y**：屏幕上方为正（cy − sy，不是 sy − cy）', () => {
    expect(wrQy(cy - ppu, ppu, cy)).toBeCloseTo(1, 9);
    expect(wrQy(cy + ppu, ppu, cy)).toBeCloseTo(-1, 9);
  });

  it('逆变换往返', () => {
    for (const px of [0, 137.5, 1024, 2047]) {
      expect(wrQxToPx(wrQx(px, ppu, cx), ppu, cx)).toBeCloseTo(px, 6);
      expect(wrQyToPx(wrQy(px, ppu, cy), ppu, cy)).toBeCloseTo(px, 6);
    }
  });
});

describe('q → M-world', () => {
  it('行主展开，表达式与站点原文一致', () => {
    expect(wrQToWorldRow(1, 2, 3, 10, 100, 1000)).toBe(1 * 10 + 2 * 100 + 3 * 1000);
  });

  it('probe 矩阵按**列**展开，与 shader 的 mat3*q 一致', () => {
    // 列主 9 元：col0=(1,2,3) col1=(4,5,6) col2=(7,8,9)
    const mCol = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    // (M·q).x = col0.x*qx + col1.x*qy + col2.x*qz = 1*qx + 4*qy + 7*qz
    expect(wrQToProbeWorldComponent(mCol, 0, 1, 10, 100)).toBe(1 + 40 + 700);
    expect(wrQToProbeWorldComponent(mCol, 1, 1, 10, 100)).toBe(2 + 50 + 800);
  });

  it('probe 矩阵的逆是转置（正交）', () => {
    // 用一个真正交阵：绕 x 轴 45°，列主展开
    const c = Math.SQRT1_2;
    const mCol = [1, 0, 0, 0, c, s(), 0, -s(), c];
    function s() { return Math.SQRT1_2; }
    const q = [0.3, -0.7, 1.1];
    const w = [0, 1, 2].map((i) => wrQToProbeWorldComponent(mCol, i as 0 | 1 | 2, q[0], q[1], q[2]));
    const back = [0, 1, 2].map((i) => wrProbeWorldToQComponent(mCol, i as 0 | 1 | 2, w[0], w[1], w[2]));
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(q[i], 9);
  });
});

describe('RG16 解码', () => {
  it('字节域与归一化域给出同一个 t', () => {
    for (const [r, g] of [[0, 0], [0, 255], [255, 0], [255, 255], [17, 200]]) {
      expect(wrDecodeRG16UnitBytes(r, g)).toBeCloseTo(wrDecodeRG16Unit(r / 255, g / 255), 12);
    }
  });

  it('R 是高字节，端点精确', () => {
    expect(wrDecodeRG16UnitBytes(0, 0)).toBe(0);
    expect(wrDecodeRG16UnitBytes(255, 255)).toBe(1);
    expect(wrDecodeRG16UnitBytes(1, 0)).toBeCloseTo(256 / 65535, 12);
  });

  it('depth_map 族吃 invert，ground_d 族**不吃**', () => {
    const d0 = wrDecodeSceneDepthFromBytes(64, 0, false, 2, -1);
    const d1 = wrDecodeSceneDepthFromBytes(64, 0, true, 2, -1);
    expect(d0).not.toBeCloseTo(d1, 6);
    // ground 族只有 min/max 线性映射
    expect(wrDecodeGroundDepthFromBytes(0, 0, 3, 7)).toBeCloseTo(3, 9);
    expect(wrDecodeGroundDepthFromBytes(255, 255, 3, 7)).toBeCloseTo(7, 9);
  });

  it('把字节喂给归一化版本会整体 ×255（这正是要用签名杜绝的误用）', () => {
    const bytes = wrDecodeRG16UnitBytes(10, 20);
    const wrong = wrDecodeRG16Unit(10, 20);
    expect(wrong / bytes).toBeCloseTo(255, 6);
  });
});

describe('精灵深度代理（直立 quad）', () => {
  it('脚点上方 → 负增量（更近相机），**不钳非负**', () => {
    const up = wrUprightDelta(100, 200, 0.5, 0.0022);
    expect(up).toBeLessThan(0);
  });

  it('脚点下方 → 正增量（被推远）', () => {
    expect(wrUprightDelta(300, 200, 0.5, 0.0022)).toBeGreaterThan(0);
  });

  it('加法顺序固定：footBias 是减号', () => {
    expect(wrSpriteDepth(1, 0.1, 0.01, 0.001, 0.5)).toBeCloseTo(1 + 0.1 + 0.01 + 0.001 - 0.5, 12);
  });
});

describe('碰撞格', () => {
  it('连续格坐标，不 floor 不加半格', () => {
    expect(wrWorldXZToCell(2.5, 0.5, 0.5)).toBeCloseTo(4, 9);
  });

  it('半开区间 [0, grid)，NaN 判出界', () => {
    expect(wrCellInside(0, 0, 10, 10)).toBe(true);
    expect(wrCellInside(9.999, 9.999, 10, 10)).toBe(true);
    expect(wrCellInside(10, 5, 10, 10)).toBe(false);
    expect(wrCellInside(-0.001, 5, 10, 10)).toBe(false);
    expect(wrCellInside(NaN, 5, 10, 10)).toBe(false);
  });
});

describe('先除后乘的数值口径', () => {
  it('与预乘比例版在多数输入上一致，但保留先除后乘以求逐位复现现役', () => {
    const S = 3000.5;
    const W = 2048;
    for (const x of [0, 1, 137.25, 2999.5]) {
      expect(wrWorldToPxDiv(x, S, W)).toBeCloseTo((x / S) * W, 12);
    }
  });

  it('sceneExtent 趋零时被 eps 守住，不出 Inf', () => {
    expect(Number.isFinite(wrWorldToPxDiv(1, 0, 2048, WR_EPS_SCENE))).toBe(true);
  });
});

describe('装载期一致性断言', () => {
  it('depth_per_sy ≡ tanθ/ppu —— 用 bridge_underpass 的真实数值验', () => {
    // θ=45°：R.row1 = [0, cos, −sin]
    const c = Math.SQRT1_2;
    const R = [1, 0, 0, 0, c, -c, 0, c, c];
    const r = resolveDepthPerSy(R, 450.56, 0.002219460227272727);
    expect(r.expected).toBeCloseTo(0.002219460227272727, 12);
    expect(r.ok).toBe(true);
  });

  it('改了 ppu 却没重烘 depth_per_sy → 判不一致（这类错静默到底，必须抓）', () => {
    const c = Math.SQRT1_2;
    const R = [1, 0, 0, 0, c, -c, 0, c, c];
    expect(resolveDepthPerSy(R, 900, 0.002219460227272727).ok).toBe(false);
  });

  it('缺字段判不 ok（调用方据此决定现推还是报警）', () => {
    const c = Math.SQRT1_2;
    expect(resolveDepthPerSy([1, 0, 0, 0, c, -c, 0, c, c], 450.56, undefined).ok).toBe(false);
  });
});

/**
 * 迁移等价性：把**迁移前的内联写法**原样抄在这里，与迁移后的组合调用逐位比对。
 * `audit-walkable` 是 Python 重实现，跑不到 TS 代码，所以那条路证明不了这次替换；
 * 这组测试才是。随机 + 边界共 3 万组。
 */
describe('迁移等价性（旧内联写法 vs 新统一源）', () => {
  function legacyIsCollisionCell(
    worldX: number, worldY: number, w2pX: number, w2pY: number,
    ppu: number, cx: number, cy: number,
    R: number[], dFloor: number, colXMin: number, colZMin: number, cell: number,
  ) {
    const sx = worldX * w2pX;
    const sy = worldY * w2pY;
    const px = (sx - cx) / ppu;
    const py = (cy - sy) / ppu;
    const wx = R[0] * px + R[1] * py + R[2] * dFloor;
    const wz = R[6] * px + R[7] * py + R[8] * dFloor;
    return [
      Math.floor((wx - colXMin) / cell),
      Math.floor((wz - colZMin) / cell),
    ];
  }

  function migratedIsCollisionCell(
    worldX: number, worldY: number, w2pX: number, w2pY: number,
    ppu: number, cx: number, cy: number,
    R: number[], dFloor: number, colXMin: number, colZMin: number, cell: number,
  ) {
    const sx = worldX * w2pX;
    const sy = worldY * w2pY;
    const px = wrQx(sx, ppu, cx);
    const py = wrQy(sy, ppu, cy);
    const wx = wrQToWorldRow(R[0], R[1], R[2], px, py, dFloor);
    const wz = wrQToWorldRow(R[6], R[7], R[8], px, py, dFloor);
    return [
      Math.floor(wrWorldXZToCell(wx, colXMin, cell)),
      Math.floor(wrWorldXZToCell(wz, colZMin, cell)),
    ];
  }

  it('isCollision 的格坐标逐位一致（3 万组随机 + 边界）', () => {
    // 用真实场景量级的参数（bridge_underpass 那一套）
    const c = Math.SQRT1_2;
    const R = [1, 0, 0, 0, c, -c, 0, c, c];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let checked = 0;
    for (let i = 0; i < 30000; i++) {
      const worldX = (rnd() - 0.5) * 6000;
      const worldY = (rnd() - 0.5) * 4000;
      const d = (rnd() - 0.5) * 4;
      const args = [worldX, worldY, 0.6827, 0.6827, 450.56, 1024, 571.5,
        R, d, -2.27, -1.86, 0.0286] as const;
      const a = legacyIsCollisionCell(...args);
      const b = migratedIsCollisionCell(...args);
      expect(b[0]).toBe(a[0]);
      expect(b[1]).toBe(a[1]);
      checked++;
    }
    expect(checked).toBe(30000);
  });

  it('sampleGroundFieldWorld 的 work px 逐位一致（先除后乘，eps=1e-6）', () => {
    const legacy = (v: number, S: number, n: number) => (v / Math.max(S, 1e-6)) * n;
    let seed = 999;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 20000; i++) {
      const v = (rnd() - 0.5) * 8000;
      const S = rnd() * 5000 + 0.001;
      const n = Math.floor(rnd() * 2048) + 1;
      expect(wrWorldToPxDiv(v, S, n, WR_EPS_PROJ)).toBe(legacy(v, S, n));
    }
    // 退化：sceneExtent = 0
    expect(wrWorldToPxDiv(1, 0, 512, WR_EPS_PROJ)).toBe(legacy(1, 0, 512));
  });
});

describe('两个 M 的手性', () => {
  it('游戏约定 det = +1', () => {
    const c = Math.SQRT1_2;
    const gameR = [1, 0, 0, 0, c, -c, 0, c, c];
    expect(matrixDet3(gameR)).toBeCloseTo(1, 9);
    expect(isGameConventionMatrix(gameR)).toBe(true);
  });

  it('实验室约定 det = −1，必须判出来（混用会让整个 Z 轴翻号）', () => {
    const c = Math.SQRT1_2;
    const labM = [1, 0, 0, 0, c, -c, 0, -c, -c];
    expect(matrixDet3(labM)).toBeCloseTo(-1, 9);
    expect(isGameConventionMatrix(labM)).toBe(false);
  });
});
