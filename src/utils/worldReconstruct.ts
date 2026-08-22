/**
 * 「世界重建数学」唯一真相源 —— **CPU 侧镜像**。
 *
 * GLSL 本体在 `src/rendering/lighting/worldReconstruct.glsl`；本文件是它的逐函数严格镜像，
 * 供 `SceneDepthSystem.isCollision` / `CharacterLightingSystem` / `groundDepthField` 使用。
 *
 * **为什么在 utils 而不是 rendering**：这套数学被核心层（碰撞、脚点）与渲染层（着色、影子）
 * 同时消费。按分层规则（UI→系统→渲染→核心→数据）它必须落在最低消费者之下，
 * 与同样被两层共用的 `groundDepthField.ts` 同处一层。
 *
 * >>> 改 GLSL = 必须同步改本文件，并 bump `WR_CONTRACT`。<<<
 * 这条不是靠自觉：`worldReconstruct.test.ts` 会**直接从 GLSL 文本里解析出
 * `#define WR_CONTRACT`** 与本文件的常量比对，改一边不改另一边当场红。
 *
 * ---------------------------------------------------------------------------
 * 设计约束（来自 P0 对抗验证暴露出的四个真坑，逐条对应）：
 *
 * 1. **标量优先，热路径零分配**。`resolveShadowLights` 逐实体逐帧调用，内部对最多
 *    48 个 surfel 各转一次坐标。若签名收 `number[]`，每帧会产生数百个临时数组。
 *    所以本文件的函数**只收标量**，需要多分量时用 `out` 参数或返回预分配对象。
 *
 * 2. **字节域入口**。CPU 侧拿到的是 `getImageData().data` 的 0..255 原始字节，
 *    而 GLSL 的 `wrDecodeRG16Unit` 收的是归一化 texel（体内乘 255）。
 *    直接把字节塞进去会整体 ×255、且**不报错**——脚深度、遮挡、影子一起静默错位。
 *    故本文件提供 `wrDecodeRG16UnitBytes(r, g)`，签名就杜绝这个误用。
 *
 * 3. **先除后乘 vs 先算比值**。现役 CPU 站点写的是 `(worldX / max(S, 1e-6)) * W`；
 *    若换成 `worldX * (W / S)`，实测 20 万组随机输入里 31.5% 的 double 结果不同
 *    （最大 5.68e-14 work px）。视觉上是零（地面场梯度约 0.0096/px ⇒ d 差 ~1e-15），
 *    但 P0 的口径是"逐像素截图一致"，为稳妥起见**保留先除后乘的同体异名版**。
 *
 * 4. **逆变换**。probe 可视化与 NEE 光源需要 world→q、q→px 的反向换算，
 *    GLSL 侧全是单向的。这里补齐，避免站点继续内联手写（那正是漂移的源头）。
 * ---------------------------------------------------------------------------
 */

/** 与 GLSL 的 `#define WR_CONTRACT` 同值。语义变更必须 bump。 */
export const WR_CONTRACT = 2;

/** 各站点原文里的下限守卫，原样保留（数值不许改，改了就是行为变化）。 */
export const WR_EPS_PROJ = 1e-6;
export const WR_EPS_COSPP = 1e-6;
export const WR_EPS_SCENE = 1e-3;
export const WR_EPS_TIGHT = 1e-5;

// ===========================================================================
// 1. 世界 → 像素栅格
//    两个函数体一样，**名字就是类型系统**：选错名字 = 选错标定 = 错一个整数倍。
//    native px = 背景原生分辨率（配 depthConfig.M 的 ppu/cx/cy）
//    work px   = 照明载荷工作分辨率（配 meta.cal 的 ppu/cx/cy）
// ===========================================================================

/** 世界 → native px（预乘比例版）。 */
export function wrWorldToNativePx(world: number, worldToNativePx: number): number {
  return world * worldToNativePx;
}

/** 世界 → work px（预乘比例版）。 */
export function wrWorldToWorkPx(world: number, worldToWorkPx: number): number {
  return world * worldToWorkPx;
}

/**
 * 世界 → 像素（**先除后乘**版）。现役 CPU 站点用的就是这个写法，
 * 换成预乘比例版会在末位产生 ~1e-14 的差异（见文件头约束 3）。
 * 迁移期一律用本函数，P1 再评估是否统一到预乘版。
 */
export function wrWorldToPxDiv(world: number, sceneExtent: number, px: number, eps = WR_EPS_SCENE): number {
  return (world / Math.max(sceneExtent, eps)) * px;
}

// ===========================================================================
// 2. 像素栅格 → 伪世界 q
//    契约：q = ( (sx − cx)/ppu , (cy − sy)/ppu , d )
//    x 不翻号；y **翻 Y**（cy − sy，不是 sy − cy）；z 是 d，不除 ppu。
// ===========================================================================

export function wrQx(sxPx: number, ppu: number, cx: number): number {
  return (sxPx - cx) / ppu;
}

/** **翻 Y 就在这里**。 */
export function wrQy(syPx: number, ppu: number, cy: number): number {
  return (cy - syPx) / ppu;
}

// ---- 逆变换（GLSL 侧没有；补齐以免站点继续内联手写）----

/** q.x → 像素 x。`wrQx` 的逆。 */
export function wrQxToPx(qx: number, ppu: number, cx: number): number {
  return cx + qx * ppu;
}

/** q.y → 像素 y。`wrQy` 的逆（同样翻 Y）。 */
export function wrQyToPx(qy: number, ppu: number, cy: number): number {
  return cy - qy * ppu;
}

// ===========================================================================
// 3. 伪世界 q → M-world（depthConfig.M.R，**det = +1**）
//    world = R · q，R 行主。表达式树与站点原文逐字一致，不用 dot/mat3。
// ===========================================================================

/** (R·q) 的某一行。`row` 三个分量按标量传，热路径零分配。 */
export function wrQToWorldRow(
  r0: number, r1: number, r2: number,
  qx: number, qy: number, qz: number,
): number {
  return r0 * qx + r1 * qy + r2 * qz;
}

/**
 * 上者的逆：M-world → q。R 正交（`|RᵀR−I| ≤ 1.11e-16`，28/28 场景实测）
 * ⇒ 转置即逆，即把行主 R **按列**取。
 *
 * GLSL 侧没有这个方向（shader 只从 q 往外走）；补在这里是为了让 CPU 侧需要反投影的
 * 站点（画灯的 gizmo、把世界点摆回屏幕）别各自手写一遍转置——手写转置写反了不报错，
 * 只是整体差一个旋转，画面上表现为「gizmo 与灯的光斑差一点」。
 *
 * `rRows` 是行主九元（`shadowBasisRows` 的原样），第 i 分量 =
 * `rRows[i]*wx + rRows[i+3]*wy + rRows[i+6]*wz`。
 */
export function wrWorldToQComponent(
  rRows: ArrayLike<number>, i: 0 | 1 | 2,
  wx: number, wy: number, wz: number,
): number {
  return rRows[i] * wx + rRows[i + 3] * wy + rRows[i + 6] * wz;
}

/**
 * ⚠⚠ **另一个 M**：实验室 `lighting.json` 的 `world.M`，**det = −1**（GL 右手，Z 反号）。
 * 只服务 probe / 体素晶格查表，与 `wrQToWorldRow` 一族**不可互换**——
 * 把它的结果喂进碰撞格 = Z 轴整体翻号。
 * `mCol` 是按**列**展开的 9 元数组（CPU 侧上传给 shader 的同一份），
 * `M·q` 的第 i 分量 = `mCol[i]*qx + mCol[i+3]*qy + mCol[i+6]*qz`。
 */
export function wrQToProbeWorldComponent(
  mCol: ArrayLike<number>, i: 0 | 1 | 2,
  qx: number, qy: number, qz: number,
): number {
  return mCol[i] * qx + mCol[i + 3] * qy + mCol[i + 6] * qz;
}

/** 上者的逆：M-world → q（M 正交 ⇒ 转置即逆，即按**行**取）。 */
export function wrProbeWorldToQComponent(
  mCol: ArrayLike<number>, i: 0 | 1 | 2,
  wx: number, wy: number, wz: number,
): number {
  return mCol[i * 3] * wx + mCol[i * 3 + 1] * wy + mCol[i * 3 + 2] * wz;
}

// ===========================================================================
// 4. M-world 水平面 → 碰撞格
//    连续格坐标（不 floor、不加半格），边界判据是半开区间 [0, grid)。
// ===========================================================================

export function wrWorldXZToCell(worldXZ: number, cellMin: number, cellSize: number): number {
  return (worldXZ - cellMin) / cellSize;
}

/** **NaN → false = 出界**（推荐口径）。 */
export function wrCellInside(cx: number, cy: number, gw: number, gh: number): boolean {
  return cx >= 0 && cx < gw && cy >= 0 && cy < gh;
}

// ===========================================================================
// 5. RG16 解码 —— **两族，不可混用**
//    共同前半段：t = (r·256 + g) / 65535 ∈ [0,1]（R = 高字节）
//    · depth_map 族：d = (invert ? 1−t : t) · scale + offset
//    · ground_d 族： d = min + t · (max − min)   ← **没有 invert**
// ===========================================================================

/**
 * **字节域**入口（0..255）。CPU 侧从 `getImageData().data` 拿到的就是这个。
 * ⚠ 不要把字节喂给归一化版本 —— 会整体 ×255 且不报错。
 */
export function wrDecodeRG16UnitBytes(r: number, g: number): number {
  return (r * 256 + g) / 65535;
}

/** 归一化域入口（0..1），与 GLSL 的 `wrDecodeRG16Unit` 逐字对应。 */
export function wrDecodeRG16Unit(r: number, g: number): number {
  return (r * 255 * 256 + g * 255) / 65535;
}

/** depth_map 族。invert 作用在**归一化 t** 上，先于 scale/offset。 */
export function wrDecodeSceneDepthFromBytes(
  r: number, g: number, invert: boolean, scale: number, offset: number,
): number {
  const t = wrDecodeRG16UnitBytes(r, g);
  return (invert ? 1 - t : t) * scale + offset;
}

/** ground_d 族。**不吃 invert / scale / offset。** */
export function wrDecodeGroundDepthFromBytes(
  r: number, g: number, min: number, max: number,
): number {
  return min + wrDecodeRG16UnitBytes(r, g) * (max - min);
}

// ===========================================================================
// 6. 精灵深度代理（直立 quad）
// ===========================================================================

/**
 * 直立 quad 的深度增量。像素在脚点**上方** → 返回负值 → 更靠近相机。
 * ⚠ 不钳非负（遮挡路径三处原文都不钳）。
 */
export function wrUprightDelta(
  worldY: number, footWorldY: number, worldToNativePxY: number, depthPerSy: number,
): number {
  return depthPerSy * (worldY * worldToNativePxY - footWorldY * worldToNativePxY);
}

/** 加法顺序即站点原文顺序，**不许重排**（浮点结合律）。 */
export function wrSpriteDepth(
  footDepthQ: number, upright: number, floorOffset: number,
  floorOffsetExtra: number, footBias: number,
): number {
  return footDepthQ + upright + floorOffset + floorOffsetExtra - footBias;
}

// ===========================================================================
// 7. 装载期一致性断言
// ===========================================================================

/**
 * `depth_per_sy ≡ tanθ / ppu_native` —— 它**是 M 的函数**。
 * 改了 `M.ppu` 或俯角 θ 而没重烘 `depth_per_sy`，画面会**静默错到底**
 * （角色上半身穿透前景、影子落点整体偏移，且没有任何报错）。
 *
 * `R` 是 depthConfig.M.R 的行主 9 元；θ 由 `R[4] = cosθ`、`R[5] = −sinθ` 推出。
 * 返回 `{ expected, ok }`；不匹配时由调用方决定报警还是抛错（dev 应可见）。
 */
export function resolveDepthPerSy(
  R: ArrayLike<number>, ppuNative: number, declared: number | undefined,
  tolerance = 1e-4,
): { expected: number; declared: number | undefined; ok: boolean } {
  const cosT = R[4];
  const sinT = -R[5];
  const expected = ppuNative > 0 && Math.abs(cosT) > WR_EPS_COSPP
    ? (sinT / cosT) / ppuNative
    : 0;
  const ok = declared === undefined
    ? false
    : Math.abs(declared - expected) <= tolerance * Math.max(1, Math.abs(expected));
  return { expected, declared, ok };
}

/**
 * `depthConfig.M.R` 必须是 **det = +1** 的游戏约定矩阵。
 * 实验室 `lighting.json` 的 `world.M` 是 det = −1，两者**永不可互换**——
 * 混用会让整个 Z 轴翻号（碰撞、遮挡、影子一起错，且看着"差不多对"）。
 *
 * ⚠ 已知残留：`public/resources/runtime/scenes/teahouse/scene_depth_config.json`
 *   里那份 M.R 是 det = −1，与场景 JSON 里 det = +1 的那份不是同一套标定。
 *   运行时走场景 JSON，所以现役无害；但任何工具链若去读那份 runtime 配置就会炸。
 */
export function matrixDet3(m: ArrayLike<number>): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function isGameConventionMatrix(m: ArrayLike<number>, tolerance = 1e-3): boolean {
  return Math.abs(matrixDet3(m) - 1) <= tolerance;
}
