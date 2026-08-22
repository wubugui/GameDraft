// ============================================================================
// worldReconstruct.glsl —— 「世界重建数学」唯一真相源 (single source of truth)
//
// 收编范围:屏幕/几何 → 场景世界 → 像素栅格 → 伪世界 q → M-world → 碰撞格,
// 以及深度图/行走面场的 RG16 解码与「直立 quad」精灵深度代理。
// 收编前这套数学在 9 处各写一份(3 个角色滤镜 + mesh 着色 + 2 个影子 + 调试滤镜
// + 2 个 CPU 版),口径已经漂出 20 条差异。**任何一处再内联重写都算回归。**
//
// ---------------------------------------------------------------------------
// 【设计铁律 1】本文件里的函数**一个 uniform 都不读**。
//   全部输入走形参。理由不是洁癖:9 处站点的 uniform 名/类型/单位互不相同
//   (uSceneSize 在遮挡路是世界单位、在 BackgroundDebugFilter 是屏幕像素;
//    R 在影子里是 6 个标量、在调试滤镜里是另外 6 个同义标量、在 CPU 里是 9 个字段;
//    `uM` 更是**另一个矩阵**),读 uniform 就等于把这些分叉焊死。
//   纯函数 = P0 阶段可以逐行替换而字节级不变,控制流(早退/门闸/discard)留在站点。
//
// 【设计铁律 2】表达式按站点原文逐字照抄,**不化简、不用 dot()、不用 mat3*vec3**。
//   `a.x*b.x + a.y*b.y + a.z*b.z` 与 `dot(a,b)` 在 GLSL 里不保证同一棵表达式树
//   (后者允许 FMA/重结合)。P0 的验收是「表现零变化」,所以宁可啰嗦。
//
// 【设计铁律 3】两个「M」永远不许混。
//   · depthConfig.M.R  —— **det = +1**(游戏约定)。q → M-world。
//     用途:碰撞格反投影、planar 影子、F2 碰撞可视化、CPU isCollision。
//     本文件用 `wrQToWorld* (vec3 r0, vec3 r1, vec3 r2, ...)` 一族。
//   · lighting.json world.M —— **det = −1**(实验室 GL 右手,Z 轴反号)。q → probe 晶格世界。
//     用途:**只有** probe/体素查表(`Xw = uM * q`)。
//     本文件用 `wrQToProbeWorld(mat3, vec3)`,名字与类型都不一样,防手滑。
//     实测 bridge_underpass:R.row2 = [0, +0.7071, +0.7071],M.row2 = [0, −0.7071, −0.7071],
//     即 M_lab = diag(1,1,−1) · R_game。把任一个喂给另一个的消费者 = Z 轴整体翻号。
//
// 【设计铁律 4】两套像素栅格永远不许混。
//   · native px  = 背景原生分辨率(background.png / raw_depth_rg.png,实测 2048×1143)
//     配 depthConfig.M 的 {ppu, cx, cy}(实测 450.56 / 1024 / 571.5)。
//     换算比例 = SceneManager 的 worldToPixelX/Y。
//   · work px    = 照明载荷工作分辨率(lighting.json work,实测 512×286)
//     配 meta.cal 的 {ppu, cx, cy}(雾津街头 112.64 / 256 / 144)。
//     ⚠ **比例不是恒定的 1/4**:28 个场景实测 native/work 从 1.95 到 4.0,
//       只有 19 个恰好是 4。任何「反正是 4 倍」的假设都会在其余 9 个场景上错。
//       但两套各自自洽——尺寸比与 ppu 比在每个场景上都逐位相等(实测)。
//     换算比例 = CharacterLightingSystem 的 worldToWorkX/Y。
//   两套各自自洽,**跨用即错一个整数倍**。本文件把换算拆成两个同体不同名的函数
//   (wrWorldToNativePx / wrWorldToWorkPx),让 code review 一眼能看出配对是否正确。
//
// ---------------------------------------------------------------------------
// 【拼接方式】项目现有范式(见 CharacterShadingFilter.ts:427-430 的 __CLC_*__ 切片、
//   charShadeCore.glsl 的 `?raw` 注入)。本文件同样走 vite `?raw`:
//
//     import WR from './lighting/worldReconstruct.glsl?raw';
//     const WR_CORE   = slice(WR, 'CORE');    // 纯数学,无 sampler
//     const WR_TEX    = slice(WR, 'TEX');     // 采样封装,依赖 CORE,须排在 CORE 之后
//     const WR_SPRITE = slice(WR, 'SPRITE');  // 直立 quad + 精灵法线,依赖 CORE
//     const FRAG = `#version 300 es
//     precision highp float;
//     ...uniform 声明...
//     ${WR_CORE}${WR_TEX}${WR_SPRITE}
//     void main(void){ ... }`;
//
//   切片器 = `s.substring(s.indexOf(B)+B.length, s.indexOf(E))`,与 CLC 同一行代码。
//
// 【语言与精度契约】
//   · GLSL ES 3.00 (Pixi v8 / WebGL2)。本文件**不含** `#version`、不含 `precision`
//     语句、不含 `in/out/uniform` 声明 —— 它永远是被塞进别人 shader 中段的一段。
//   · 调用方必须保证默认 float 精度为 **highp**:RG16 解码要在 [0,65535] 上分辨 1,
//     mediump(10 位尾数)会把深度量化成垃圾。CharacterShadingFilter/CharacterLitSprite
//     已显式写了 `precision highp float;`;DepthOcclusionFilter / EntityLightingFilter /
//     EntityShadow / BackgroundDebugFilter 依赖 Pixi 注入,迁移时**顺手补上显式声明**
//     (这是纯加固,不改数值)。
//   · sampler2D 作函数形参是 ES 3.00 合法用法,项目已在用(CharacterShadingFilter.ts:154
//     的 volTap)。实参必须能在编译期解析到某个 uniform。
//
// 【CPU 镜像】src/rendering/lighting/worldReconstruct.ts 是本文件的逐函数严格镜像,
//   供 SceneDepthSystem.isCollision / CharacterLightingSystem.driveFilter /
//   resolveShadowLights / groundDepthField 使用。两侧共用 worldReconstruct.fixtures.json
//   金标向量;`WR_CONTRACT` 常量必须两边一致,改了 GLSL 而没改 TS 会让 parity 测试红。
//   >>> 改本文件 = 必须同步改 worldReconstruct.ts,并 bump WR_CONTRACT。<<<
// ============================================================================

//__WR_CORE_BEGIN__
// ---------------------------------------------------------------------------
// 契约版本。TS 镜像里有同名同值常量;parity 测试比对两者。
// 语义变更必须 bump,纯注释/纯新增可不 bump。
// ---------------------------------------------------------------------------
#define WR_CONTRACT 2

// 各站点原文里的三种下限守卫,原样保留为具名常量(数值不许改,改了就是行为变化)。
const float WR_EPS_PROJ  = 1e-6;   // max(projectionScale, ·)  —— 4 处站点原文
const float WR_EPS_COSPP = 1e-6;   // max(cosT * ppu, ·)       —— 2 处着色站点原文
const float WR_EPS_SCENE = 1e-3;   // max(sceneExtent, ·)      —— EntityShadow.groundDepthAt 原文
const float WR_EPS_TIGHT = 1e-5;   // max(sceneExtent, ·)      —— CharacterLitSprite ground 原文
                                   //   (两个 epsilon 只在 sceneExtent≈0 时才有分别,
                                   //    现役 28 张场景的 worldWidth/Height 都在 1e3 量级 →
                                   //    统一成谁都是零行为变化。P1 收敛到 WR_EPS_SCENE。)

// ===========================================================================
// 1. 屏幕/几何 → 场景世界坐标
//    产出的 (wx, wy) 是**场景世界单位**,原点=世界左上,**Y 仍向下**(全程不翻)。
//    翻 Y 只发生在后面 wrQy 那一步(cy − sy),别提前翻。
// ===========================================================================

/**
 * 滤镜路径:全局屏幕像素 → 场景世界坐标。
 * 原文(逐字等价):
 *   float S  = max(uProjectionScale, 1e-6);
 *   float wx = (vScreenPos.x - uWorldContainerPos.x) / S;
 *   float wy = (vScreenPos.y - uWorldContainerPos.y) / S;
 * 站点:DepthOcclusionFilter:67-72 / EntityLightingFilter:116-118 /
 *       CharacterShadingFilter:325-327 / CharacterLitSprite VERT:56-57。
 */
vec2 wrScreenToWorld(vec2 screenPos, vec2 worldContainerPos, float projectionScale) {
    float S = max(projectionScale, WR_EPS_PROJ);
    return (screenPos - worldContainerPos) / S;
}

/**
 * 场景归一化 UV(深度图 / 背景 / 行走面场共用同一套寻址)。
 * v **不翻转**,与世界 Y 同向。
 *
 * ⚠ `extent` 的单位由调用方决定,本函数只做除法:
 *    · 遮挡/着色/影子路径喂**世界单位** sceneW/sceneH;
 *    · BackgroundDebugFilter 喂的是**屏幕像素** (worldW·S, worldH·S),而它的分子
 *      也是未除 S 的屏幕位移 —— 两者约掉 S,结果与前者代数相同。这不是 bug,
 *      但同名 uniform 两种单位是货真价实的坑,迁移时请把该 uniform 更名为
 *      uSceneSizeScreenPx(纯改名,零行为变化)。
 * ⚠ 无除零守卫:extent=0 → ±Inf/NaN。是否需要守卫由站点用 wrSceneUvGuarded 决定
 *    (原文里遮挡路径就是裸除,保持不变)。
 * 站点:DepthOcclusionFilter:75 / EntityLightingFilter:123 / CharacterShadingFilter:332 /
 *       EntityShadow:130 / BackgroundDebugFilter:100。
 */
vec2 wrSceneUv(vec2 p, vec2 extent) {
    return p / extent;
}

/** 带下限守卫 + 钳制的版本(行走面场寻址用)。eps 传 WR_EPS_SCENE 或 WR_EPS_TIGHT。 */
vec2 wrSceneUvGuarded(vec2 p, vec2 extent, float eps) {
    return clamp(p / max(extent, vec2(eps)), 0.0, 1.0);
}

/**
 * UV 是否落在 [0,1]²(**NaN → false = 出界**,推荐口径)。
 * 原文:EntityLightingFilter:124 / CharacterShadingFilter:333 / BackgroundDebugFilter:138
 *       (碰撞格版)全部是这个正向写法。
 */
bool wrUvInside(vec2 uv) {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

/**
 * 反向写法,**仅为逐字复刻 DepthOcclusionFilter:78 与 EntityShadow:99 保留**。
 * 与 wrUvInside 在有限输入下互为补集,但 **NaN 时两者都返回 false** —— 即
 * `!wrUvOutside(NaN)` = true(继续采样,踩 NaN 陷阱),而 `wrUvInside(NaN)` = false(跳过)。
 * 新代码一律用 wrUvInside;这个函数只在需要"字节级不变"的迁移期用。
 */
bool wrUvOutside(vec2 uv) {
    return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
}

// ===========================================================================
// 2. 世界 → 像素栅格
//    两个函数体完全一样,**名字就是类型系统**:选错名字 = 选错标定 = 错一个整数倍。
// ===========================================================================

/** 世界 → **native px**(背景原生分辨率)。必须配 depthConfig.M 的 {ppu,cx,cy}。 */
vec2 wrWorldToNativePx(vec2 worldXY, vec2 worldToNativePx) {
    return worldXY * worldToNativePx;
}

/** 世界 → **work px**(照明载荷分辨率)。必须配 meta.cal 的 {ppu,cx,cy}。 */
vec2 wrWorldToWorkPx(vec2 worldXY, vec2 worldToWorkPx) {
    return worldXY * worldToWorkPx;
}

// ===========================================================================
// 3. 像素栅格 → 伪世界 q
//    契约:q = ( (sx − cx)/ppu , (cy − sy)/ppu , d )
//    · x 不翻号,先减主点再除 ppu;
//    · y **翻 Y**:是 (cy − sy) 不是 (sy − cy) —— 屏幕 Y 向下、伪世界 Y 向上;
//    · z 是深度 d,**不除 ppu**、不减任何主点、不乘任何系数。
// ===========================================================================

/** q.x。站点:EntityShadow:93 / BackgroundDebugFilter:128 / CharacterShadingFilter:366 /
 *  CharacterLitSprite:101,111 / SceneDepthSystem.isCollision:372(CPU)。 */
float wrQx(float sxPx, float ppu, float cx) {
    return (sxPx - cx) / ppu;
}

/** q.y(**翻 Y 就在这里**)。站点:EntityShadow:94 / BackgroundDebugFilter:129 /
 *  CharacterLitSprite:102 / SceneDepthSystem.isCollision:373(CPU) /
 *  CharacterLightingSystem.driveFilter:916(CPU)。 */
float wrQy(float syPx, float ppu, float cy) {
    return (cy - syPx) / ppu;
}

/** 完整 q。d 原样进 z。 */
vec3 wrPixelToQ(vec2 pxXY, float ppu, float cx, float cy, float d) {
    return vec3(wrQx(pxXY.x, ppu, cx), wrQy(pxXY.y, ppu, cy), d);
}

// ---- 逆变换（q → 像素）。收编前只在 probeViz / lightsQ 两处内联手写过，
//      而那两处恰恰最容易把 lab M(det=−1)与 native/work 两套栅格搞串。
//      沿光线 march 深度场时每一步都要用，所以必须在这里，不能再散出去。----

/** `wrQx` 的逆。 */
float wrQxToPx(float qx, float ppu, float cx) {
    return cx + qx * ppu;
}

/** `wrQy` 的逆（同样翻 Y）。 */
float wrQyToPx(float qy, float ppu, float cy) {
    return cy - qy * ppu;
}

/** q → 像素坐标。 */
vec2 wrQToPixel(vec3 q, float ppu, float cx, float cy) {
    return vec2(wrQxToPx(q.x, ppu, cx), wrQyToPx(q.y, ppu, cy));
}

// ===========================================================================
// 4. 伪世界 q → M-world  (depthConfig.M.R,**det = +1**)
//    world = R · q,R 行主。这里刻意不用 mat3:6 处站点里有 3 处只上传了 R 的
//    第 0 行与第 2 行(世界 Y 高度它们根本不用),硬凑 mat3 会逼人补上没有的数据。
// ===========================================================================

/** (R·q).x —— 表达式树与站点原文 `R00*px + R01*py + R02*d` 完全一致。 */
float wrQToWorldRow(vec3 row, vec3 q) {
    return row.x * q.x + row.y * q.y + row.z * q.z;
}

/** 只要水平面 (X, Z):碰撞格反投影用。站点:EntityShadow:95-96 /
 *  BackgroundDebugFilter:131-132 / SceneDepthSystem.isCollision:375-376(CPU)。 */
vec2 wrQToWorldXZ(vec3 r0, vec3 r2, vec3 q) {
    return vec2(wrQToWorldRow(r0, q), wrQToWorldRow(r2, q));
}

/** 完整 M-world。现役无消费者(DeferredEntityShadow 是死码;它按**列**取 R,
 *  展开后与本函数逐项相同,但它把 lab 的角度约定当 M-world 用 —— 见文件尾注 D-DEAD)。 */
vec3 wrQToWorld(vec3 r0, vec3 r1, vec3 r2, vec3 q) {
    return vec3(wrQToWorldRow(r0, q), wrQToWorldRow(r1, q), wrQToWorldRow(r2, q));
}

/**
 * 上者的逆:M-world → 伪世界 q。R 正交(实测 |RᵀR−I| ≤ 1.11e-16,28/28 场景),
 * 所以转置即逆 —— 按**列**取,即 (Rᵀ·w)[i] = r0[i]·w.x + r1[i]·w.y + r2[i]·w.z。
 *
 * ⚠ 这个方向一度**只有 CPU 侧有**(worldReconstruct.ts 的 wrWorldToQComponent),
 *   GLSL 侧全是单向的。于是 2026-08-22 有人在场景 pass 里内联写了个 lightToQ,
 *   随后清理死代码时被一并删掉 —— 调用还在、定义没了,**整个重打光 shader 编译失败**,
 *   28 个场景的背景全黑。而全部门都绿:lint 只做字符串包含,没有一处真编译 GLSL。
 *   补在这里,两个方向就都有唯一真源了。
 *
 * 用途:把灯位从 M-world 折回 q(阴影的线扫前缀、光晕的视线积分都要)。
 */
vec3 wrWorldToQ(vec3 r0, vec3 r1, vec3 r2, vec3 w) {
    return vec3(
        r0.x * w.x + r1.x * w.y + r2.x * w.z,
        r0.y * w.x + r1.y * w.y + r2.y * w.z,
        r0.z * w.x + r1.z * w.y + r2.z * w.z);
}

/**
 * ⚠⚠ **另一个 M**:实验室 lighting.json 的 world.M,**det = −1**(GL 右手,Z 反号)。
 * 只服务 probe/体素晶格查表(CharacterShadingFilter.ts:282 的 `vec3 Xw = uM * q;`)。
 * 与上面 wrQToWorld* 一族**不可互换**:把它的结果喂进碰撞格 = Z 轴整体翻号。
 * mat3 在 GLSL 是列主,CPU 侧上传的 mCol 已按列展开(CharacterLightingSystem.ts:766-770),
 * 故 `M * q` 等于「meta.world.M 行 · q」。
 */
vec3 wrQToProbeWorld(mat3 labWorldM, vec3 q) {
    return labWorldM * q;
}

// ===========================================================================
// 5. M-world 水平面 → 碰撞格
//    连续格坐标(**不 floor、不加半格**),边界判据是半开区间 [0, grid)。
// ===========================================================================

/** 站点:EntityShadow:97-98 / BackgroundDebugFilter:134-135 / isCollision:378-379(CPU,后接 floor)。 */
vec2 wrWorldXZToCell(vec2 worldXZ, vec2 cellMinXZ, float cellSize) {
    return (worldXZ - cellMinXZ) / cellSize;
}

/** 格坐标是否在网格内(**NaN → false**,推荐口径;BackgroundDebugFilter:138 原文就是这个)。 */
bool wrCellInside(vec2 cell, vec2 gridSize) {
    return cell.x >= 0.0 && cell.x < gridSize.x && cell.y >= 0.0 && cell.y < gridSize.y;
}

/** 反向写法,仅为逐字复刻 EntityShadow:99。NaN 语义与 wrCellInside 不同,见 wrUvOutside 的说明。 */
bool wrCellOutside(vec2 cell, vec2 gridSize) {
    return cell.x < 0.0 || cell.x >= gridSize.x || cell.y < 0.0 || cell.y >= gridSize.y;
}

// ===========================================================================
// 6. RG16 解码 —— **两族,不可混用**
//    共同前半段:t = (r·255·256 + g·255) / 65535 ∈ [0,1](R = 高字节)。
//    · depth_map 族:  d = (invert ? 1−t : t) · scale + offset   ← 有 invert/scale/offset
//    · ground_d 族:   d = min + t · (max − min)                 ← **没有 invert**,
//                        用的是 lighting.json 的 ground_d.min/max,与 depth_mapping 无关。
//    两族解出的 d 同量纲(实验室 q 空间深度,越小越近),这一点**只靠烘焙保证**,
//    运行时无交叉校验 —— 见 TS 侧 assertCalibrationCoherence()。
// ===========================================================================

/** 归一化 t。逐字等价于 6 处站点的 `(s.r*255.0*256.0 + s.g*255.0)/65535.0`。 */
float wrDecodeRG16Unit(vec4 texel) {
    return (texel.r * 255.0 * 256.0 + texel.g * 255.0) / 65535.0;
}

/** depth_map 族。invert 作用在**归一化 t** 上,先于 scale/offset。 */
float wrDecodeSceneDepth(vec4 texel, float invert, float scale, float offset) {
    float rawDepth = wrDecodeRG16Unit(texel);
    float d_raw = invert > 0.5 ? 1.0 - rawDepth : rawDepth;
    return d_raw * scale + offset;
}

/** ground_d 族。range = vec2(min, max)。**不吃 invert / scale / offset。** */
float wrDecodeGroundDepth(vec4 texel, vec2 range) {
    return range.x + wrDecodeRG16Unit(texel) * (range.y - range.x);
}

// ===========================================================================
// 7. 精灵深度代理(遮挡判据) —— 「立在伪世界里的直立 quad」
//    depth_per_sy ≡ tanθ/ppu_native,是把「整套 M 反投影 + 沿直立面抬升」
//    折叠成的一维梯度。代数等价证明(与第 8 节的完整式对照):
//        h    = (footSy − sy) / (cosθ · ppu)
//        q.z  = footQ.z − h·sinθ
//             = footQ.z + (tanθ/ppu)·(sy − footSy)
//             = footDepthQ + depth_per_sy·(syTex − syTexFoot)
//    实测 bridge_underpass:θ=45°(R.row1=[0,.7071,−.7071])、M.ppu=450.56 →
//        tan45/450.56 = 0.00221946 == JSON 的 depth_per_sy 0.002219460227272727 ✓
//    ⚠ 所以 depth_per_sy **是 M 的函数**。改了 M.ppu/θ 而没重烘 depth_per_sy = 静默错到底。
//      TS 侧 resolveDepthPerSy() 负责在装载期断言这条恒等式。
// ===========================================================================

/**
 * 直立 quad 的深度增量,单位 = q 空间深度。
 * 符号:像素在脚点**上方** → syTex < syTexFoot → 返回负值 → 更靠近相机。
 * ⚠ **不钳非负**(与第 8 节的 wrUprightHeight 相反):脚点下方的像素会得到正值、被推远。
 *   三处遮挡站点原文都不钳,这里照搬。两条路对同一片元用不同 q.z 是已知分叉(见 D-08)。
 * 站点:DepthOcclusionFilter:93-95 / EntityLightingFilter:132-134 / CharacterShadingFilter:342-344。
 */
float wrUprightDelta(float worldY, float footWorldY, float worldToNativePxY, float depthPerSy) {
    float syTexFoot = footWorldY * worldToNativePxY;
    float syTex = worldY * worldToNativePxY;
    return depthPerSy * (syTex - syTexFoot);
}

/**
 * 精灵深度代理。加法顺序即三处站点原文顺序,不许重排(浮点结合律)。
 *   footDepthQ + upright + floorOffset + floorOffsetExtra − footBias
 * 语义:floorOffset / floorOffsetExtra 为正 = 推远 = 更易被遮;footBias 为正 = 拉近 = 更不易被遮。
 * 影子路径只有 (ground + floorOffset),用 wrSpriteDepth(g, 0.0, floorOffset, 0.0, 0.0) 精确复现
 * (x+0.0 与 x−0.0 对非 −0 的 x 都是恒等)。
 */
float wrSpriteDepth(float footDepthQ, float upright, float floorOffset,
                    float floorOffsetExtra, float footBias) {
    return footDepthQ + upright + floorOffset + floorOffsetExtra - footBias;
}

/**
 * 遮挡判据。容差加在**场景**一侧,严格小于。
 * true = 场景几何比精灵更靠近相机 = 精灵被前景挡住。
 */
bool wrIsOccluded(float sceneDepth, float spriteDepth, float tolerance) {
    return sceneDepth + tolerance < spriteDepth;
}

/**
 * 遮挡像素的预乘输出。**rgb 与 a 必须同乘同一系数** —— 只乘 a 会让预乘合成按完整 rgb
 * 参与 blend,画面发白(DepthOcclusionFilter.ts:108-109 的实证注释)。
 * blend < 1e-5 的 discard 分支留在站点(本文件不做控制流)。
 */
vec4 wrApplyOcclusionBlend(vec4 premultipliedColor, float blend) {
    return vec4(premultipliedColor.rgb * blend, premultipliedColor.a * blend);
}
//__WR_CORE_END__

//__WR_TEX_BEGIN__
// ===========================================================================
// 8. 采样封装(依赖 CORE,拼接时必须排在 WR_CORE 之后)
// ===========================================================================

/** 深度图直采 + 解码。站点:三个遮挡滤镜、EntityShadow:132-135、BackgroundDebugFilter:109-112。 */
float wrSampleSceneDepth(sampler2D depthMap, vec2 uv, float invert, float scale, float offset) {
    return wrDecodeSceneDepth(texture(depthMap, uv), invert, scale, offset);
}

/** 行走面场按**已算好的 UV** 直采(BackgroundDebugFilter:125-127 复用外层 uv)。 */
float wrSampleGroundAtUv(sampler2D groundTex, vec2 uv, vec2 range) {
    return wrDecodeGroundDepth(texture(groundTex, uv), range);
}

/**
 * 行走面场按**世界坐标**直采(带守卫 + 钳制)。
 * eps 传 WR_EPS_SCENE 复现 EntityShadow:83-86,传 WR_EPS_TIGHT 复现 CharacterLitSprite:103-106。
 * ⚠ 纹理是 scaleMode:'nearest'(CharacterLightingSystem.ts:712),所以这是**最近邻**;
 *   而 CPU 侧 sampleGroundField 是**双线性** —— 这是 GPU/CPU 之间最实的一条数值分叉(D-11)。
 *   P1 的收敛落点是下面的 wrSampleGroundWorldBilinear。
 */
float wrSampleGroundWorld(sampler2D groundTex, vec2 worldXY, vec2 sceneExtent,
                          vec2 range, float eps) {
    return wrSampleGroundAtUv(groundTex, wrSceneUvGuarded(worldXY, sceneExtent, eps), range);
}

/**
 * [P1,现役未启用] 行走面场双线性 —— 与 CPU 版 sampleGroundField 严格同源。
 * 逐行复刻 src/utils/groundDepthField.ts:29-37,包括:
 *   · 钳制在插值**之前**,上界是 (size − 1.001) 不是 (size − 1);
 *   · i11 写作 i01 + 1(CPU 原文如此;因 x0 ≤ w−2,不会跨行,合法)。
 * 前提:groundTex 必须是 nearest 且未预乘(现役已满足),否则 texelFetch 之外的路径会二次插值。
 * ⚠ 启用它会改变影子边缘与 F2 碰撞图 —— 属于「修 CPU/GPU 分叉」,不是零变化。
 */
float wrSampleGroundWorldBilinear(sampler2D groundTex, vec2 texSize, vec2 worldXY,
                                  vec2 sceneExtent, vec2 range) {
    vec2 p = (worldXY / max(sceneExtent, vec2(WR_EPS_SCENE))) * texSize;
    vec2 pc = clamp(p, vec2(0.0), texSize - 1.001);
    vec2 b = floor(pc);
    vec2 f = pc - b;
    ivec2 i00 = ivec2(b);
    float d00 = wrDecodeGroundDepth(texelFetch(groundTex, i00, 0), range);
    float d10 = wrDecodeGroundDepth(texelFetch(groundTex, i00 + ivec2(1, 0), 0), range);
    float d01 = wrDecodeGroundDepth(texelFetch(groundTex, i00 + ivec2(0, 1), 0), range);
    float d11 = wrDecodeGroundDepth(texelFetch(groundTex, i00 + ivec2(1, 1), 0), range);
    return d00 * (1.0 - f.x) * (1.0 - f.y) + d10 * f.x * (1.0 - f.y)
         + d01 * (1.0 - f.x) * f.y + d11 * f.x * f.y;
}

/**
 * 碰撞格采样(现役口径:连续 UV + 纹理默认 linear 过滤 + 阈值 0.5)。
 * 站点:EntityShadow:97-100 / BackgroundDebugFilter:134-141。
 * ⚠ 与 CPU 版 isCollision(floor 定格 + 原始字节 >127)**不是同一条边界**:
 *   linear 过滤会把二值图边界抹圆并整体挪半格(D-12)。P1 落点见下一个函数。
 */
bool wrSampleCollisionCell(sampler2D collisionMap, vec2 cell, vec2 gridSize) {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return texture(collisionMap, cell / gridSize).r > 0.5;
}

/**
 * [P1,现役未启用] 碰撞格采样,与 CPU isCollision 严格同源:floor 定格 + texelFetch。
 * 阈值 0.5 与 CPU 的 `byte > 127` 对整数字节完全等价(127/255=0.498 < 0.5 < 0.502=128/255)。
 * 前提:collisionMap 需设 scaleMode:'nearest'(现役是 Pixi 默认 linear)。
 * ⚠ 启用会让影子裁切边界与 F2 碰撞图整体挪半格并变硬 —— 是「与玩家实际能不能走过去对齐」,
 *   但确实改表现。
 */
bool wrSampleCollisionCellNearest(sampler2D collisionMap, vec2 cell, vec2 gridSize) {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return texelFetch(collisionMap, ivec2(floor(cell)), 0).r > 0.5;
}
//__WR_TEX_END__

//__WR_SPRITE_BEGIN__
// ===========================================================================
// 9. 直立 quad 的完整式(着色路径)+ 精灵法线解码
//    与第 7 节是**同一个几何的两种写法**:第 7 节把 (翻Y + 除ppu + tanθ) 折成一个标量,
//    这里保留三步。二者在 h > 0 的区域代数等价;h 被钳 0 的区域(脚点下方)不等价。
//    ⚠ 本节用的是 **work px + meta.cal**,第 7 节用的是 **native px + depthConfig.M**。
// ===========================================================================

/**
 * 像素相对脚点的直立高度(世界单位),脚点下方**钳 0**。
 * 逐字等价:max((footSyPx − pixelSyPx) / max(cosT * ppu, 1e-6), 0.0)
 * ⚠ 减法顺序是 (脚点 − 本像素),与第 7 节 wrUprightDelta 的 (本像素 − 脚点) **相反**
 *   —— 两者各自正确(输出量的符号约定相反),但并排读极易抄错。
 * 站点:CharacterShadingFilter:367 / CharacterLitSprite:110。
 */
float wrUprightHeight(float pixelSyPx, float footSyPx, float cosT, float ppu) {
    return max((footSyPx - pixelSyPx) / max(cosT * ppu, WR_EPS_COSPP), 0.0);
}

/**
 * 着色路径的最终 q。
 *   q = ( qx , footQy + h·cosθ , footQz − h·sinθ − bulge )
 * bulge 实参传 `ne.a * uBulge`(法线图 alpha 通道的鼓包),这样表达式树 ((a−b)−c) 与原文一致。
 * 恒等:h·cosθ = (footSy − sy)/ppu,故在 h>0 区域 q.y ≡ (cy − sy)/ppu,与 wrQy 契约一致。
 * ⚠ 这里的 q.z **不是** 第 7 节的 spriteDepth:前者含 bulge、不含 floorOffset/footBias,
 *   后者反之。刻意如此(遮挡代理 vs 着色代理),不要"统一"。
 * 站点:CharacterShadingFilter:394-396 / CharacterLitSprite:120。
 */
vec3 wrQFromFoot(float qx, float footQy, float footQz, float h,
                 float cosT, float sinT, float bulge) {
    return vec3(qx, footQy + h * cosT, footQz - h * sinT - bulge);
}

/**
 * 精灵法线解码(两处着色站点逐字相同)。
 *   · rgb 三个分量**全部取负**;b 先 max(·,0.05) 再取负(z 恒指向相机)
 *   · 镜像只翻 n.x
 *   · 向 (0,0,−1) 压平
 * 无法线图时调用方应传 ne = vec4(0.5, 0.5, 1.0, 0.35)(**常量兜底**,
 * 不是去采 Texture.WHITE —— 采白图会得 ne=(1,1,1,1) → n=normalize(−1,−1,−1),完全错的方向)。
 * 站点:CharacterShadingFilter:390-392 / CharacterLitSprite:116-118。
 */
vec3 wrDecodeSpriteNormal(vec4 ne, bool mirrored, float flatten) {
    vec3 n = normalize(vec3(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (mirrored) { n.x = -n.x; }
    return normalize(mix(n, vec3(0., 0., -1.), flatten));
}
//__WR_SPRITE_END__

// ============================================================================
// 尾注:收编后**仍然存在**的差异,别以为统一了源码就统一了口径
//
// D-08  遮挡代理不钳 h、着色代理钳 h≥0 → 脚点下方的像素在两条路上 q.z 不同。
//       现役如此,统一源如实保留(wrUprightDelta 不钳 / wrUprightHeight 钳)。
// D-11  行走面场:GPU nearest vs CPU 双线性,差最多一个 work texel 的地面深度。
//       P1 用 wrSampleGroundWorldBilinear 收敛到 CPU 口径(isCollision 是 audit 裁决基准)。
// D-12  碰撞格:GPU 连续 UV+linear vs CPU floor+>127,差半格且边界被抹圆。
//       P1 用 wrSampleCollisionCellNearest 收敛到 CPU 口径。
// D-DEAD DeferredEntityShadow(死码)的 reconstruct 本体与本文件逐项相同(它按列取 R,
//       展开后等价),被废掉的是它**周围**:光向把 env.key.azimuthDeg(屏幕平面角契约)
//       当 M-world XZ 方位用、脚点深度采的是 depth_map 而非 ground_d、丢了 floorOffset/
//       footBias/tolerance、没有碰撞裁切与 uShadowColor。不适配它;若日后复活,
//       必须把光向先经 R 从 q 空间转到 M-world,并改用 wrSampleGroundWorld*。
// ============================================================================
