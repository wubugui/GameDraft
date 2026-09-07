import type { GroundDepthField } from '../utils/groundDepthField';
import {
  groundDepthAtQ as ssGroundDepthAtQ,
  groundWorldAt as ssGroundWorldAt,
  qToWorld as ssQToWorld,
  raise as ssRaise,
  worldToQ as ssWorldToQ,
  worldToScene as ssWorldToScene,
  type SceneSpaceGeometry,
} from '../utils/sceneSpace';

/**
 * 运行时摆灯用的坐标换算：**场景坐标 ↔ 灯的世界坐标**。
 *
 * ## 两个 frame 只共用一把尺，不共用原点
 *
 * 灯的 `pos` 是 `[x,y,z]` **wu**，原点 = 画面中心、**Y 朝上**、Z 是纵深；
 * 而 NPC / 热点 / spawn 的场景坐标原点在**画布左上、y 朝下**。两者共用 wu 这把尺
 * （角色高 **150 wu**，28 个场景恒定），但**不是同一个 frame**。
 * 判据在 `packLights`：它对 `pos` 只乘 `quPerWu`，**不挪原点、不翻 Y**——
 * 也就是说灯的 frame 就是伪世界 q 转个朝向再换把尺。
 *
 * `agent_docs/runtime/mechanisms/coordinate-spaces.md` 的总表把「灯的作者面」列在
 * 「原点=画布左上」那一行，**那一行会误导人**（已入 inbox 偏差记录）。以本文件为准。
 *
 * ## ⚠ 用 work 栅格，不是 native 栅格
 *
 * 本项目有**两套像素栅格**：native（配 `depthConfig.M` 的 ppu/cx/cy）与
 * work（配照明载荷 `meta.cal` 的）。**比例不是恒定的 4**（实测 1.95–4.0，只有 19/28
 * 个场景是 4），混用不报错、只是位置差一截。
 *
 * 这里一律走 **work**：因为地面深度场（`ground_d`）本身就是 work 分辨率的，
 * 而运行时既有的同类站点（`chestQAt` / `driveFilter` / `SceneDepthSystem`）也全在 work。
 * 桌面编辑器 `tools/editor/editors/scene_lights.py` 那份用的是 native + `depthConfig.M`，
 * **别照抄它的 ppu/cx/cy 过来**。
 *
 * ## 作者模型：点哪儿摆哪儿，再拉杆调高度
 *
 * 2D 画面只给得出两个自由度，第三个（纵深）必须由地面深度场补出来；高度则另给一个手柄，
 * 在**灯世界的 Y** 上直接加减。与 `scene_lights.raise_world` 同口径。
 */

export type { Vec3 } from '../utils/sceneSpace';
import type { Vec3 } from '../utils/sceneSpace';

/**
 * 与 {@link SceneSpaceGeometry} 同一份形状。
 *
 * ⚠ 保留这个别名只为不动既有调用点（`AuthoringMode` / `lightGizmos` / `shapeGizmos` 与它们的单测）；
 * **它不是第二份定义**——换算全部委托给 `src/utils/sceneSpace.ts`，这里一行数学都没有。
 */
export type LightSpaceGeometry = SceneSpaceGeometry;
export type { GroundDepthField };

export class LightSpace {
  constructor(private readonly geo: LightSpaceGeometry) {}

  /** 伪世界 q → 灯世界（wu）。见 `sceneSpace.qToWorld`。 */
  qToWorld(q: Vec3): Vec3 {
    return ssQToWorld(this.geo, q);
  }

  /** 灯世界 → 伪世界 q（上者的逆）。 */
  worldToQ(w: Vec3): Vec3 {
    return ssWorldToQ(this.geo, w);
  }

  /**
   * 画面上一点（场景 wu）正下方**地面**的灯世界坐标。
   * 深度由行走面场给，所以点在墙上/天上也会得到"那个像素处地面的深度"——
   * 这正是作者模型要的：先落地，再拉高。
   */
  groundWorldAt(sceneX: number, sceneY: number): Vec3 {
    return ssGroundWorldAt(this.geo, sceneX, sceneY);
  }

  /**
   * 灯世界 → 场景坐标（wu）。**正交投影，丢掉深度分量**——相机是正交的，
   * 同一条视线上不同深度落在同一个像素，与 shader 画灯体光晕的口径一致。
   *
   * 调用方再走 `camera.worldToScreen` 就是屏幕像素。
   */
  worldToScene(w: Vec3): { x: number; y: number } {
    return ssWorldToScene(this.geo, w);
  }

  /**
   * 把地面点抬高若干 wu（沿**灯世界的 Y**）。角色高 150 wu，街灯大约挂在 2.5 个人高。
   *
   * ⚠ 抬高之后灯的**投影会往上跑**（R 把三个分量都混了），所以
   * `worldToScene(raise(g, h))` ≠ 落笔的那个地面点。这不是 bug：真实的灯就该画在
   * 它自己的位置上，脚下拖一条竖线连回地面（gizmo 就是这么画的）。
   * 也因此「离地高度」必须记住**落笔时的地面锚点**，见 {@link heightAbove}。
   */
  raise(ground: Vec3, heightWu: number): Vec3 {
    return ssRaise(ground, heightWu);
  }

  /**
   * 相对给定地面锚点的离地高度（wu）。锚点由调用方给（拖动落笔的那个地面点），
   * 或用 {@link groundBelow} 现解一个。
   */
  heightAbove(w: Vec3, ground: Vec3): number {
    return w[1] - ground[1];
  }

  /**
   * 灯**正下方**的地面点（世界 x、z 与灯相同，y 落在行走面上）。
   *
   * ## 为什么不能"把灯投影到屏幕、在那儿采一下地面"
   *
   * 那个便宜做法是错的，而且错得很像对的。深度图里「深度恒定」的一片**不是**世界里的
   * 水平地面——45° 视角下它是一片斜面。实测（本文件的单测锁着）：在恒定深度的场上
   * 把灯抬高 300 wu，用投影落点估出来的地面会跟着爬 150 wu，于是离地高度读数只剩一半，
   * 而且越拖越飘。
   *
   * ## 解法：两个方程解两个未知数，**必须带阻尼**
   *
   * 要找的 q 满足 `world(q).x == w.x`、`world(q).z == w.z`，同时 `q.z == ground(q.xy)`。
   * 给定一个 d，前两条是关于 (qx,qy) 的线性方程组；解完再按新的 (qx,qy) 重采 d。
   *
   * ⚠ **裸迭代会在真·水平地面上原地打转**（本文件单测锁着这个反例）：那种地面上
   * `∂d/∂qy` 恰好是 1，迭代映射的斜率是 −1 —— 不发散也不收敛，在两个值之间来回跳，
   * 偶数次迭代正好跳回出发点，于是"解"出来的就是灯自己。取半步（阻尼 0.5）之后
   * 那一档反而一步到位，恒定深度那一档也只是变成几何收敛。
   */
  groundBelow(w: Vec3, maxIterations = 32): Vec3 {
    const r = this.geo.basisRows;
    const k = Math.max(this.geo.wuPerQUnit, 1e-9);
    const det = r[0] * r[7] - r[1] * r[6];
    if (Math.abs(det) < 1e-9) {
      // 退化：世界 Y 轴与视轴平行（正俯视），"正下方"本来就投影成一个点。
      const s = this.worldToScene(w);
      return this.groundWorldAt(s.x, s.y);
    }
    const tx = w[0] / k;
    const tz = w[2] / k;
    let q = this.worldToQ(w);
    for (let i = 0; i < maxIterations; i++) {
      const d = this.groundDepthAtQ(q[0], q[1]);
      // r00*qx + r01*qy = tx - r02*d ;  r20*qx + r21*qy = tz - r22*d
      const a = tx - r[2] * d;
      const b = tz - r[8] * d;
      const sx = (a * r[7] - b * r[1]) / det;
      const sy = (r[0] * b - r[6] * a) / det;
      const nx = (q[0] + sx) * 0.5;
      const ny = (q[1] + sy) * 0.5;
      const moved = Math.abs(nx - q[0]) + Math.abs(ny - q[1]);
      q = [nx, ny, d];
      if (moved < 1e-9) break;
    }
    // 收尾把深度对齐到最终 (qx,qy) 上——上一轮存的 d 是上一个位置采的。
    return this.qToWorld([q[0], q[1], this.groundDepthAtQ(q[0], q[1])]);
  }

  /**
   * 从 `origin` 沿 `dir` 射出，找**第一次落到行走面上**的那一点。
   *
   * ## 为什么需要它（聚光靶点的正向解）
   *
   * 摆聚光的交互是反的方向好写：人在画面上点一个地面点 T，`dir = normalize(T − pos)`，
   * 一步到位。但**画 gizmo 要的是正向**——手上只有 `dir`，得知道那束光打在哪儿，
   * 才能把靶点画出来给人拖。这就是这个函数。
   *
   * ## 为什么是求根，不是解方程
   *
   * 行走面**不是平面**。它是一张深度场，「灯正下方的地面」都得靠 {@link groundBelow}
   * 迭代解（见那边的注释：裸迭代在真·水平地面上会原地打转）。射线与它的交点同理
   * 没有闭式解，只能沿射线走一段、看「离地高度」何时穿零。
   *
   * `f(t) = p(t).y − groundBelow(p(t)).y`，t=0 时 f = 灯的离地高度 > 0。
   * 先粗扫找出变号区间，再二分。粗扫**不能省**：直接二分要求 f 在 [0, maxDist] 上
   * 单调，而深度场上（屋檐、台阶）它并不单调，会二分到一个假根上。
   *
   * @param maxDist 最远走多远（wu）。射不到就返回 null —— 平射/朝上的聚光**本来就
   *                照不到地面**，那种情况调用方要画悬空靶点，不能假装有交点。
   */
  groundHitAlong(origin: Vec3, dir: Vec3, maxDist: number, coarseSteps = 24): Vec3 | null {
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 1e-9) || !(maxDist > 0)) return null;
    const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
    const at = (t: number): Vec3 => [
      origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t,
    ];
    const clearance = (t: number): number => {
      const p = at(t);
      return p[1] - this.groundBelow(p)[1];
    };

    let t0 = 0;
    let f0 = clearance(0);
    if (f0 <= 0) return at(0);          // 灯已经埋在地里，靶点就是它自己
    let t1 = -1;
    let f1 = 0;
    const step = maxDist / coarseSteps;
    for (let i = 1; i <= coarseSteps; i++) {
      const t = step * i;
      const f = clearance(t);
      if (f <= 0) { t1 = t; f1 = f; break; }
      t0 = t; f0 = f;
    }
    if (t1 < 0) return null;            // 一路都在地面之上：射不到
    // 二分。20 次把区间砍到 maxDist/24/2^20 —— 远在 0.1 wu 的落盘精度之下。
    for (let i = 0; i < 20; i++) {
      const tm = (t0 + t1) * 0.5;
      const fm = clearance(tm);
      if (fm > 0) { t0 = tm; f0 = fm; } else { t1 = tm; f1 = fm; }
    }
    void f0; void f1;
    return at(t1);
  }

  /** 给定 q 的 xy（不含深度）处的行走面深度。 */
  private groundDepthAtQ(qx: number, qy: number): number {
    return ssGroundDepthAtQ(this.geo, qx, qy);
  }
}
