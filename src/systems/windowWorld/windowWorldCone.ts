import { wrDecodeSceneDepthFromBytes, wrQToWorldRow, wrQx, wrQy } from '../../utils/worldReconstruct';
import type { SceneLightingGeometry } from '../../rendering/lighting/SceneLightingPass';

/**
 * 楔形判据的 **CPU 镜像** —— 与 `WindowBackground` 片元里那一段逐条对应。
 *
 * ## 为什么要有 CPU 这一份
 *
 * 窗里的**背景**要按楔形裁，窗里的**实体**也要。两者的判据必须是同一个楔形，
 * 但**取世界位置的方式不同**，这一点是本文件最容易搞错的地方：
 *
 * - 背景：逐像素，走 {@link uvToWorldWu} 读 `depth_map`。
 * - 实体：整只，走 {@link GroundWorldSampler} 读**行走面** `ground_d`。
 *
 * 那不是"两个深度族"的问题（2026-09-21 实测：同一批点两者相差 <1%，就是同一个世界），
 * 是**问的面不一样** —— 详见 {@link GroundWorldSampler} 的注释与那次实测数据。
 *
 * ## 为什么 CPU 这一份非有不可
 *
 * 实体不能靠 Pixi filter 来裁：`renderer.extract.pixels` **不过 filter**
 * （见 [[pixi-v8-traps]]），整个像素取证链会对实体瞎掉——A/B 出来的结论全是假的，
 * 而这个项目的取证方式就靠它。
 *
 * 背景那一份 CPU 深度也必须是**自己解的 `depth_map` 副本**，用
 * `wrDecodeSceneDepthFromBytes`（与 GLSL 的 `wrDecodeSceneDepth` 逐字对应的那一个）解码，
 * 于是 CPU 与 shader 吃的是同一张图、同一套解码、同一套 M。
 *
 * ## 改这里就要同步改那里
 *
 * 本文件的 {@link coneMaskAt} 与 `WindowBackground.ts` 片元里「楔形判定」那一段是同一个
 * 式子的两种写法。改一边不改另一边，症状是**实体与背景各按各的边界裁**——画面上像窗里的人
 * 提前半步出现，谁也不会想到是两份式子漂了。
 */

/** 解出来的楔形（顶点与朝向已在 M-world，wu）。 */
export interface SolvedCone {
  apex: [number, number, number];
  /** 已归一的水平朝向。 */
  axisH: [number, number, number];
  cosHalf: number;
  /** 角度软化，按**余弦差**（与 shader 同口径，省掉逐点反三角）。 */
  cosSoft: number;
  nearWu: number;
  farWu: number;
  softRangeWu: number;
  heightDownWu: number;
  heightUpWu: number;
  softHeightWu: number;
  opacity: number;
}

/** `depth_map` 族的 CPU 副本。与 shader 读的是同一张图、同一套解码。 */
export interface CpuDepthMap {
  width: number;
  height: number;
  /** 按 UV 取场景深度（`depth_map` 族）。越界按边缘夹取。 */
  at(u: number, v: number): number;
}

/**
 * 把那张深度图解到 CPU。
 *
 * ⚠ 解码期预乘只糟蹋 alpha 当数据用的图（见 [[pixi-v8-traps]]）；`raw_depth_rg.png`
 *   的数据在 R/G、alpha 恒 255，所以走普通 `createImageBitmap` 是安全的。
 */
export async function loadCpuDepthMap(
  url: string,
  mapping: { invert: boolean; scale: number; offset: number },
): Promise<CpuDepthMap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const w = bmp.width;
    const h = bmp.height;
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d');
    if (!ctx) { bmp.close(); return null; }
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    bmp.close();
    return {
      width: w,
      height: h,
      at(u: number, v: number): number {
        const x = Math.min(w - 1, Math.max(0, Math.round(u * w - 0.5)));
        const y = Math.min(h - 1, Math.max(0, Math.round(v * h - 0.5)));
        const i = (y * w + x) * 4;
        return wrDecodeSceneDepthFromBytes(
          data[i], data[i + 1], mapping.invert, mapping.scale, mapping.offset,
        );
      },
    };
  } catch {
    return null;
  }
}

/**
 * UV + 该点深度 → M-world（wu）。与 shader 里 `wrPixelToQ → wrQToWorld → ×uWuPerQ`
 * 逐步对应，连乘 `wuPerQUnit` 这一步都不能少（少了就是整体缩到 1/450，判定全落空）。
 */
export function uvToWorldWu(
  geo: SceneLightingGeometry,
  depth: CpuDepthMap,
  u: number,
  v: number,
): [number, number, number] {
  const d = depth.at(u, v);
  const px = u * geo.depthSize[0];
  const py = v * geo.depthSize[1];
  const qx = wrQx(px, geo.cal[0], geo.cal[1]);
  const qy = wrQy(py, geo.cal[0], geo.cal[2]);
  const k = geo.wuPerQUnit;
  const [r0, r1, r2] = geo.mRows;
  return [
    wrQToWorldRow(r0[0], r0[1], r0[2], qx, qy, d) * k,
    wrQToWorldRow(r1[0], r1[1], r1[2], qx, qy, d) * k,
    wrQToWorldRow(r2[0], r2[1], r2[2], qx, qy, d) * k,
  ];
}

/**
 * 伪世界 q → M-world（wu）。`uvToWorldWu` 的后半段，单独拆出来给**已经有 q** 的调用方
 * （行走面采样器给的就是 q）。少乘 `wuPerQUnit` 就整体缩到 1/450，判定全落空。
 */
export function qToWorldWu(
  geo: SceneLightingGeometry,
  q: readonly [number, number, number],
): [number, number, number] {
  const k = geo.wuPerQUnit;
  const [r0, r1, r2] = geo.mRows;
  return [
    wrQToWorldRow(r0[0], r0[1], r0[2], q[0], q[1], q[2]) * k,
    wrQToWorldRow(r1[0], r1[1], r1[2], q[0], q[1], q[2]) * k,
    wrQToWorldRow(r2[0], r2[1], r2[2], q[0], q[1], q[2]) * k,
  ];
}

/**
 * 「站在地上的东西在世界的哪儿」——玩家（楔形顶点）与窗里的实体都该问这个。
 * 给场景坐标，返回 M-world（wu）；取不到底层数据时返回 null，调用方回落 {@link uvToWorldWu}。
 *
 * ## 与 `uvToWorldWu` 的区别不是「哪个深度族」，是**问的是哪张面**
 *
 * · `uvToWorldWu` 读 `depth_map`，答的是"**这个像素上画的那个东西**有多远"——
 *   对背景的每一个像素这正是要的答案。
 * · 本采样器读烘焙的**行走面**（`ground_d`），答的是"**这个屏幕位置的地**在多远"。
 *
 * 一个人站在屋檐 / 灯笼 / 招牌的像素底下时，前者会把他判到屋檐上去。
 * 2026-09-21 实测雾津街头送葬队伍：13 人里 3 人的深度落在遮挡物上（世界 Y 偏
 * +55 / +138 / +179 wu），其中 2 人因此被楔形判到界外、**整只不显示**，零报错。
 * 其余 10 人两者相差 ≤9 wu（<1%）——两族在这张图上就是同一个世界，
 * 出事的从来不是"族"，是拿错了"面"。
 */
export type GroundWorldSampler = (sceneX: number, sceneY: number) => [number, number, number] | null;

/** 上升沿：`x <= e0` 给 0，`x >= e0+w` 给 1；`w<=0` 即硬边。与 shader 的 `softStep` 同式。 */
function softStep(x: number, e0: number, w: number): number {
  if (w <= 0) return x >= e0 ? 1 : 0;
  return Math.min(1, Math.max(0, (x - e0) / w));
}

/**
 * 解楔形：顶点取**玩家脚下那块地**，朝向指向鼠标指着的那个像素。
 *
 * 顶点收的是已经解好的 M-world 点（调用方用行走面采样器算，理由见
 * {@link GroundWorldSampler}——玩家站在屋檐底下时用 `depth_map` 会把窗架到屋檐上）。
 * 瞄准点仍读 `depth_map`：指针指的就是"**这个像素上画的那个东西**"，那正是它该答的。
 *
 * 返回 null = 顶点与瞄准点水平重合（没有可用方向），调用方这一帧别画。
 */
export function solveCone(
  geo: SceneLightingGeometry,
  depth: CpuDepthMap,
  apexWorld: readonly [number, number, number],
  aimUv: [number, number],
  cfg: {
    halfAngleDeg: number; softAngleDeg: number;
    nearWu: number; farWu: number; softRangeWu: number;
    heightDownWu: number; heightUpWu: number; softHeightWu: number;
    apexLiftWu: number; opacity: number;
  },
): SolvedCone | null {
  const apex: [number, number, number] = [apexWorld[0], apexWorld[1], apexWorld[2]];
  apex[1] += cfg.apexLiftWu;
  const aim = uvToWorldWu(geo, depth, aimUv[0], aimUv[1]);
  const ax = aim[0] - apex[0];
  const az = aim[2] - apex[2];
  const len = Math.hypot(ax, az);
  if (len < 1e-6) return null;

  const half = Math.min(89.9, Math.max(0, cfg.halfAngleDeg));
  const cosHalf = Math.cos((half * Math.PI) / 180);
  const softA = Math.min(89.9, Math.max(0, cfg.softAngleDeg));
  const cosSoft = Math.max(0, Math.cos((Math.max(0, half - softA) * Math.PI) / 180) - cosHalf);

  return {
    apex,
    axisH: [ax / len, 0, az / len],
    cosHalf,
    cosSoft,
    nearWu: cfg.nearWu,
    farWu: cfg.farWu,
    softRangeWu: cfg.softRangeWu,
    heightDownWu: cfg.heightDownWu,
    heightUpWu: cfg.heightUpWu,
    softHeightWu: cfg.softHeightWu,
    opacity: cfg.opacity,
  };
}

/**
 * 某个 M-world 点落在楔形里的程度（0..1）。
 * **与 `WindowBackground` 片元里那一段逐条对应**，改一边必须改另一边。
 */
export function coneMaskAt(cone: SolvedCone, world: readonly [number, number, number]): number {
  const relX = world[0] - cone.apex[0];
  const relY = world[1] - cone.apex[1];
  const relZ = world[2] - cone.apex[2];
  const dist = Math.hypot(relX, relZ);
  let mask = 1;

  mask *= softStep(dist, cone.nearWu, cone.softRangeWu);
  mask *= 1 - softStep(dist, cone.farWu - cone.softRangeWu, cone.softRangeWu);

  if (dist > 1e-4) {
    const c = (relX / dist) * cone.axisH[0] + (relZ / dist) * cone.axisH[2];
    mask *= softStep(c, cone.cosHalf, cone.cosSoft);
  }

  if (cone.heightUpWu > cone.heightDownWu) {
    mask *= softStep(relY, cone.heightDownWu, cone.softHeightWu);
    mask *= 1 - softStep(relY, cone.heightUpWu - cone.softHeightWu, cone.softHeightWu);
  }

  return Math.min(1, Math.max(0, mask)) * Math.min(1, Math.max(0, cone.opacity));
}
