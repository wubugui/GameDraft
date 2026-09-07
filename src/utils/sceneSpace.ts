import { sampleGroundField, type GroundDepthField } from './groundDepthField';
import {
  WR_EPS_PROJ,
  wrQToWorldRow,
  wrQx,
  wrQxToPx,
  wrQy,
  wrQyToPx,
  wrWorldToPxDiv,
  wrWorldToQComponent,
} from './worldReconstruct';

/**
 * 「场景坐标(2D wu) ↔ M-world(3D wu)」换算 —— **唯一实现**。
 *
 * ## 为什么在 utils，而不是留在 authoring
 *
 * 这套链原本只住在 `src/authoring/lightSpace.ts`（摆灯用）。但 `src/authoring/` 整层被
 * `import.meta.env.DEV` 门控（`Game.ts` 里 AuthoringMode 的创建处），**玩法路径不能 import 它**。
 * 空间化音频是玩法路径上的消费者，与摆灯需要的是同一条链——按 `worldReconstruct.ts` 文件头
 * 那条分层论述（「被多层同时消费的数学落在最低消费者之下」），它必须下沉到这里。
 *
 * 下沉而不是复制：`worldReconstruct.glsl` 文件头记着「收编前 9 处各写一份，口径已经漂出
 * 20 条差异」。**再抄一份就是回归。** `LightSpace` 现在是本文件的薄包装（外加只有摆灯才用的
 * 迭代求解），音频侧直接用本文件。
 *
 * ## 两个都叫「世界空间 wu」的 frame，共用一把尺、不共用原点
 *
 * | frame | 原点 | 轴向 | 维度 | 住户 |
 * |---|---|---|---|---|
 * | **场景坐标** | 画布左上 | x 右、y **下** | 2D | `player.contactX/Y`、NPC、热区、spawn、zone 多边形、`Camera.getX/getY` |
 * | **M-world** | 画面中心 @ 深度 0 | x 右、Y **上**、Z 纵深 | 3D | 灯 `pos`、`N·L`、`1/r²`、**音频的距离与方位** |
 *
 * 尺度锚：**角色高 150 wu**，28/28 场景恒定。
 *
 * ⚠ `src/data/types.ts` 里 `LightDef.pos` 的两处注释写「原点就是世界空间的原点」，**那是错的**；
 * 权威判据是 `packLights`（`lightPacking.ts`）对 `pos` 零平移、零缩放、零翻 Y。
 *
 * ## 翻 Y 只发生一次
 *
 * 就在 `wrQy`（px → q）。之前（场景 wu / native px / work px）Y 一律向下，之后（q / M-world）
 * Y 一律向上。本文件不许出现第二个 `(cy − sy)` 或 `(sy − cy)`。
 *
 * ## ⚠ work 栅格，不是 native 栅格
 *
 * 本项目有两套像素栅格，比例**不是恒定的 4**（实测 2.6875–4.0，只有 19/28 场景是 4）。
 * 本文件一律走 **work**（照明载荷 `meta.cal`），因为行走面场 `ground_d` 就是 work 分辨率的。
 * 桌面编辑器 `tools/editor/editors/scene_lights.py` 用的是 native + `depthConfig.M`，
 * **别把它的 ppu/cx/cy 抄过来**。
 */
export interface SceneSpaceGeometry {
  /** 照明载荷的工作分辨率（`meta.work`）。行走面场就是这个尺寸。 */
  work: { w: number; h: number };
  /** work 栅格的标定（`meta.cal`）。**不是** `depthConfig.M`。 */
  cal: { ppu: number; cx: number; cy: number };
  /** 场景世界宽高（wu，NPC/热点那套 frame） */
  sceneWorld: { w: number; h: number };
  /** q → M-world 的基，行主 r00..r22（det=+1 的**游戏约定** R，取自 `shadowBasisRows`） */
  basisRows: ArrayLike<number>;
  /** 1 个伪世界 q 单位 = 多少 wu（逐场景不同：teahouse 154、雾津街头 880） */
  wuPerQUnit: number;
  /** 行走面深度场（work 分辨率） */
  ground: GroundDepthField;
}

export type Vec3 = [number, number, number];

/** 场景 wu → work px。先除后乘、eps 取 `WR_EPS_PROJ`——与既有地面采样站点逐位一致。 */
export function sceneToWorkPx(geo: SceneSpaceGeometry, sceneX: number, sceneY: number): [number, number] {
  const { sceneWorld, work } = geo;
  return [
    wrWorldToPxDiv(sceneX, sceneWorld.w, work.w, WR_EPS_PROJ),
    wrWorldToPxDiv(sceneY, sceneWorld.h, work.h, WR_EPS_PROJ),
  ];
}

/** work px → 场景 wu（上者的逆）。 */
export function workPxToScene(geo: SceneSpaceGeometry, px: number, py: number): { x: number; y: number } {
  const { sceneWorld, work } = geo;
  return {
    x: (px / Math.max(work.w, 1e-6)) * sceneWorld.w,
    y: (py / Math.max(work.h, 1e-6)) * sceneWorld.h,
  };
}

/**
 * 伪世界 q → M-world（wu）。**转一次朝向（R），再折一次尺度（wuPerQUnit）。**
 *
 * 铁律 0：要转就转到底。只折尺度不折朝向、或只折朝向不折尺度，都会造出
 * 「世界朝向 + q 尺度」的无名第四空间——它自洽、结果也「差不多对」，但任何长度读数
 * 都没法判断是哪把尺。`1/r²`、`refDistance`、可听半径全是长度，照单全收这条。
 */
export function qToWorld(geo: SceneSpaceGeometry, q: Vec3): Vec3 {
  const r = geo.basisRows;
  const k = geo.wuPerQUnit;
  return [
    wrQToWorldRow(r[0], r[1], r[2], q[0], q[1], q[2]) * k,
    wrQToWorldRow(r[3], r[4], r[5], q[0], q[1], q[2]) * k,
    wrQToWorldRow(r[6], r[7], r[8], q[0], q[1], q[2]) * k,
  ];
}

/** M-world → 伪世界 q（上者的逆；R 正交 ⇒ 转置即逆）。 */
export function worldToQ(geo: SceneSpaceGeometry, w: Vec3): Vec3 {
  const r = geo.basisRows;
  const k = 1 / Math.max(geo.wuPerQUnit, 1e-9);
  const wq: Vec3 = [w[0] * k, w[1] * k, w[2] * k];
  return [
    wrWorldToQComponent(r, 0, wq[0], wq[1], wq[2]),
    wrWorldToQComponent(r, 1, wq[0], wq[1], wq[2]),
    wrWorldToQComponent(r, 2, wq[0], wq[1], wq[2]),
  ];
}

/** 给定 q 的 xy（不含深度）处的行走面深度。 */
export function groundDepthAtQ(geo: SceneSpaceGeometry, qx: number, qy: number): number {
  const { cal, ground, work } = geo;
  return sampleGroundField(
    ground.data, work.w, work.h,
    wrQxToPx(qx, cal.ppu, cal.cx),
    wrQyToPx(qy, cal.ppu, cal.cy),
  );
}

/**
 * 画面上一点（场景 wu）正下方**地面**的 M-world 坐标。
 *
 * 深度由行走面场给，所以点在墙上/天上也会得到「那个像素处地面的深度」——
 * 这正是作者模型要的：先落地，再拉高。脚步声恒在行走面上，用的就是这一条。
 */
export function groundWorldAt(geo: SceneSpaceGeometry, sceneX: number, sceneY: number): Vec3 {
  const { cal, ground, work } = geo;
  const [px, py] = sceneToWorkPx(geo, sceneX, sceneY);
  const d = sampleGroundField(ground.data, work.w, work.h, px, py);
  return qToWorld(geo, [wrQx(px, cal.ppu, cal.cx), wrQy(py, cal.ppu, cal.cy), d]);
}

/**
 * 把地面点抬高若干 wu（沿 **M-world 的 Y**，即真·世界上方）。角色高 150 wu。
 *
 * ⚠ 抬高之后该点的**投影会往上跑**（R 把三个分量都混了），所以
 * `worldToScene(raise(g, h))` ≠ 落笔的那个地面点。这不是 bug。
 */
export function raise(ground: Vec3, heightWu: number): Vec3 {
  return [ground[0], ground[1] + heightWu, ground[2]];
}

/**
 * M-world → 场景坐标（wu）。**正交投影，丢掉深度分量**——相机是正交的，
 * 同一条视线上不同深度落在同一个像素。
 */
export function worldToScene(geo: SceneSpaceGeometry, w: Vec3): { x: number; y: number } {
  const { cal } = geo;
  const q = worldToQ(geo, w);
  return workPxToScene(
    geo,
    wrQxToPx(q[0], cal.ppu, cal.cx),
    wrQyToPx(q[1], cal.ppu, cal.cy),
  );
}

/**
 * 相机视线方向在 M-world 里的单位向量（「往画面里去」的方向）。
 *
 * 即 q 的 +z 轴过 R。**用有限差分而不是手推 R 的第三列**：手推要求这里对 basisRows 的
 * 行/列约定不写反，而写反了**也自洽**（只是整体差一个旋转），没有任何报错。
 * 与 `src/authoring/shapeGizmos.ts` 的 `viewDirection` 同法。
 */
export function viewDirWorld(geo: SceneSpaceGeometry): Vec3 {
  const o = qToWorld(geo, [0, 0, 0]);
  const z = qToWorld(geo, [0, 0, 1]);
  const v: Vec3 = [z[0] - o[0], z[1] - o[1], z[2] - o[2]];
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-9)) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}
