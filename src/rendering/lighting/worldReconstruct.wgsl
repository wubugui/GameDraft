// ============================================================================
// worldReconstruct.wgsl —— 「世界重建数学」唯一真相源 (single source of truth)
//
// 收编范围：屏幕/几何 → 场景世界 → 像素栅格 → 伪世界 q → M-world → 碰撞格，
// 以及深度图/行走面场的 RG16 解码与「直立 quad」精灵深度代理。
// 收编前这套数学在 9 处各写一份（3 个角色滤镜 + mesh 着色 + 2 个影子 + 调试滤镜
// + 2 个 CPU 版），口径已经漂出 20 条差异。**任何一处再内联重写都算回归。**
// 与 master（GLSL 版 worldReconstruct.glsl，本文件由它逐函数移植而来）逐像素一致由
// tools/render_parity 的「光照片段 / WR」用例钉住。下文「站点」「原文」指收编时各处的 GLSL 原文位置（历史出处）。
//
// ---------------------------------------------------------------------------
// 【设计铁律 1】本文件里的函数**一个 uniform / 绑定都不读**。
//   全部输入走形参（纹理、采样器与全部标量都是形参）。理由不是洁癖：9 处站点的 uniform
//   名/类型/单位互不相同（uSceneSize 在遮挡路是世界单位、在 BackgroundDebugFilter 是屏幕像素；
//    R 在影子里是 6 个标量、在调试滤镜里是另外 6 个同义标量、在 CPU 里是 9 个字段；
//    uM 更是**另一个矩阵**），读 uniform 就等于把这些分叉焊死。
//   纯函数 = 可以逐行替换而字节级不变，控制流（早退/门闸/discard）留在站点。
//
// 【设计铁律 2】表达式按站点原文逐字照抄，**不化简、不用 dot()、不用 mat3*vec3**。
//   a.x*b.x + a.y*b.y + a.z*b.z 与 dot(a,b) 不保证同一棵表达式树
//   （后者允许 FMA/重结合）。验收是「表现零变化」，所以宁可啰嗦。
//
// 【设计铁律 3】两个「M」永远不许混。
//   · depthConfig.M.R  —— **det = +1**（游戏约定）。q → M-world。
//     用途：碰撞格反投影、planar 影子、F2 碰撞可视化、CPU isCollision。
//     本文件用 wrQToWorld*(r0, r1, r2, …) 一族。
//   · lighting.json world.M —— **det = −1**（实验室 GL 右手，Z 轴反号）。q → probe 晶格世界。
//     用途：**只有** probe/体素查表（Xw = uM * q）。
//     本文件用 wrQToProbeWorld(mat3x3, vec3)，名字与类型都不一样，防手滑。
//     实测 bridge_underpass：R.row2 = [0, +0.7071, +0.7071]，M.row2 = [0, −0.7071, −0.7071]，
//     即 M_lab = diag(1,1,−1) · R_game。把任一个喂给另一个的消费者 = Z 轴整体翻号。
//
// 【设计铁律 4】两套像素栅格永远不许混。
//   · native px  = 背景原生分辨率（background.png / raw_depth_rg.png，实测 2048×1143）
//     配 depthConfig.M 的 {ppu, cx, cy}（实测 450.56 / 1024 / 571.5）。
//     换算比例 = SceneManager 的 worldToPixelX/Y。
//   · work px    = 照明载荷工作分辨率（lighting.json work，实测 512×286）
//     配 meta.cal 的 {ppu, cx, cy}（雾津街头 112.64 / 256 / 144）。
//     ⚠ **比例不是恒定的 1/4**：28 个场景实测 native/work 从 1.95 到 4.0，
//       只有 19 个恰好是 4。任何「反正是 4 倍」的假设都会在其余 9 个场景上错。
//       但两套各自自洽——尺寸比与 ppu 比在每个场景上都逐位相等（实测）。
//     换算比例 = CharacterLightingSystem 的 worldToWorkX/Y。
//   两套各自自洽，**跨用即错一个整数倍**。本文件把换算拆成两个同体不同名的函数
//   （wrWorldToNativePx / wrWorldToWorkPx），让 code review 一眼能看出配对是否正确。
//
// ---------------------------------------------------------------------------
// 【怎么拼】三段切片，vite ?raw 引入，同一行切片器（wgslChunks.ts 已切好）：
//
//     import WR_WGSL_SRC from './lighting/worldReconstruct.wgsl?raw';
//     const WR_CORE_WGSL   = slice(WR_WGSL_SRC, 'WR_CORE');    // 纯数学，无纹理
//     const WR_TEX_WGSL    = slice(WR_WGSL_SRC, 'WR_TEX');     // 采样封装，依赖 CORE
//     const WR_SPRITE_WGSL = slice(WR_WGSL_SRC, 'WR_SPRITE');  // 直立 quad + 精灵法线，依赖 CORE
//
//   · WGSL 模块级声明与顺序无关，三段谁前谁后都行；但每段在同一模块里只许拼一次。
//   · 整个文件（含三段）也能整份拼（WORLD_RECONSTRUCT_WGSL），切片标记之外只有注释；
//     整份与切片不能在同一模块里同时拼。
//
// 【写法约束（与 master 的 GLSL 版数值不变）】
//   · WR_CONTRACT 是 i32 常量。
//   · WR_TEX 里取样的函数，采样器紧跟它服务的纹理作形参，采样用 textureSampleLevel(…, 0.0)：
//     能在分支 / 循环里调，对单级纹理等价于隐式 LOD。按整数纹素取一律 textureLoad(…, 0)，不需要采样器。
//   · 三元式一律写成 if/else（不用 select：select 两边都求值）。
//   · 精度：RG16 解码要在 [0,65535] 上分辨 1，WGSL 的 f32 天然满足（master 的 GLSL 那边为此要求宿主 highp）。
//
// 【CPU 镜像】src/utils/worldReconstruct.ts 是本文件的逐函数严格镜像，
//   供 SceneDepthSystem.isCollision / CharacterLightingSystem.driveFilter /
//   resolveShadowLights / groundDepthField 使用。两侧共用 worldReconstruct.fixtures.json
//   金标向量；WR_CONTRACT 常量必须两边一致，改了本文件而没改 TS 会让 parity 测试红。
//   >>> 改本文件 = 必须同步改 worldReconstruct.ts，并 bump WR_CONTRACT。<<<
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件的注释里不许出现
//   「at 号 + group / binding + 括号」字样。
// ============================================================================

//__WR_CORE_BEGIN__
// ---------------------------------------------------------------------------
// 契约版本。TS 镜像里有同名同值常量；parity 测试比对两者。
// 语义变更必须 bump，纯注释/纯新增可不 bump。
// ---------------------------------------------------------------------------
const WR_CONTRACT: i32 = 2;

// 各站点原文里的三种下限守卫，原样保留为具名常量（数值不许改，改了就是行为变化）：
//   WR_EPS_PROJ  = max(projectionScale, ·)  —— 4 处站点原文
//   WR_EPS_COSPP = max(cosT * ppu, ·)       —— 2 处着色站点原文
//   WR_EPS_SCENE = max(sceneExtent, ·)      —— EntityShadow.groundDepthAt 原文
//   WR_EPS_TIGHT = max(sceneExtent, ·)      —— CharacterLitSprite ground 原文
//   （两个 extent epsilon 只在 sceneExtent≈0 时才有分别，现役 28 张场景的 worldWidth/Height
//    都在 1e3 量级 → 统一成谁都是零行为变化。P1 收敛到 WR_EPS_SCENE。）
const WR_EPS_PROJ: f32 = 1e-6;
const WR_EPS_COSPP: f32 = 1e-6;
const WR_EPS_SCENE: f32 = 1e-3;
const WR_EPS_TIGHT: f32 = 1e-5;

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
fn wrScreenToWorld(screenPos: vec2<f32>, worldContainerPos: vec2<f32>, projectionScale: f32) -> vec2<f32> {
    let S = max(projectionScale, WR_EPS_PROJ);
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
fn wrSceneUv(p: vec2<f32>, extent: vec2<f32>) -> vec2<f32> {
    return p / extent;
}

/** 带下限守卫 + 钳制的版本(行走面场寻址用)。eps 传 WR_EPS_SCENE 或 WR_EPS_TIGHT。 */
fn wrSceneUvGuarded(p: vec2<f32>, extent: vec2<f32>, eps: f32) -> vec2<f32> {
    return clamp(p / max(extent, vec2<f32>(eps)), vec2<f32>(0.0), vec2<f32>(1.0));
}

/**
 * UV 是否落在 [0,1]²(**NaN → false = 出界**,推荐口径)。
 * 原文:EntityLightingFilter:124 / CharacterShadingFilter:333 / BackgroundDebugFilter:138
 *       (碰撞格版)全部是这个正向写法。
 */
fn wrUvInside(uv: vec2<f32>) -> bool {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

/**
 * 反向写法,**仅为逐字复刻 DepthOcclusionFilter:78 与 EntityShadow:99 保留**。
 * 与 wrUvInside 在有限输入下互为补集,但 **NaN 时两者都返回 false** —— 即
 * `!wrUvOutside(NaN)` = true(继续采样,踩 NaN 陷阱),而 `wrUvInside(NaN)` = false(跳过)。
 * 新代码一律用 wrUvInside;这个函数只在需要"字节级不变"的迁移期用。
 */
fn wrUvOutside(uv: vec2<f32>) -> bool {
    return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
}

// ===========================================================================
// 2. 世界 → 像素栅格
//    两个函数体完全一样,**名字就是类型系统**:选错名字 = 选错标定 = 错一个整数倍。
// ===========================================================================

/** 世界 → **native px**(背景原生分辨率)。必须配 depthConfig.M 的 {ppu,cx,cy}。 */
fn wrWorldToNativePx(worldXY: vec2<f32>, worldToNativePx: vec2<f32>) -> vec2<f32> {
    return worldXY * worldToNativePx;
}

/** 世界 → **work px**(照明载荷分辨率)。必须配 meta.cal 的 {ppu,cx,cy}。 */
fn wrWorldToWorkPx(worldXY: vec2<f32>, worldToWorkPx: vec2<f32>) -> vec2<f32> {
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
fn wrQx(sxPx: f32, ppu: f32, cx: f32) -> f32 {
    return (sxPx - cx) / ppu;
}

/** q.y(**翻 Y 就在这里**)。站点:EntityShadow:94 / BackgroundDebugFilter:129 /
 *  CharacterLitSprite:102 / SceneDepthSystem.isCollision:373(CPU) /
 *  CharacterLightingSystem.driveFilter:916(CPU)。 */
fn wrQy(syPx: f32, ppu: f32, cy: f32) -> f32 {
    return (cy - syPx) / ppu;
}

/** 完整 q。d 原样进 z。 */
fn wrPixelToQ(pxXY: vec2<f32>, ppu: f32, cx: f32, cy: f32, d: f32) -> vec3<f32> {
    return vec3<f32>(wrQx(pxXY.x, ppu, cx), wrQy(pxXY.y, ppu, cy), d);
}

// ---- 逆变换（q → 像素）。收编前只在 probeViz / lightsQ 两处内联手写过，
//      而那两处恰恰最容易把 lab M(det=−1)与 native/work 两套栅格搞串。
//      沿光线 march 深度场时每一步都要用，所以必须在这里，不能再散出去。----

/** `wrQx` 的逆。 */
fn wrQxToPx(qx: f32, ppu: f32, cx: f32) -> f32 {
    return cx + qx * ppu;
}

/** `wrQy` 的逆（同样翻 Y）。 */
fn wrQyToPx(qy: f32, ppu: f32, cy: f32) -> f32 {
    return cy - qy * ppu;
}

/** q → 像素坐标。 */
fn wrQToPixel(q: vec3<f32>, ppu: f32, cx: f32, cy: f32) -> vec2<f32> {
    return vec2<f32>(wrQxToPx(q.x, ppu, cx), wrQyToPx(q.y, ppu, cy));
}

// ===========================================================================
// 4. 伪世界 q → M-world  (depthConfig.M.R,**det = +1**)
//    world = R · q,R 行主。这里刻意不用 mat3:6 处站点里有 3 处只上传了 R 的
//    第 0 行与第 2 行(世界 Y 高度它们根本不用),硬凑 mat3 会逼人补上没有的数据。
// ===========================================================================

/** (R·q).x —— 表达式树与站点原文 `R00*px + R01*py + R02*d` 完全一致。 */
fn wrQToWorldRow(row: vec3<f32>, q: vec3<f32>) -> f32 {
    return row.x * q.x + row.y * q.y + row.z * q.z;
}

/** 只要水平面 (X, Z):碰撞格反投影用。站点:EntityShadow:95-96 /
 *  BackgroundDebugFilter:131-132 / SceneDepthSystem.isCollision:375-376(CPU)。 */
fn wrQToWorldXZ(r0: vec3<f32>, r2: vec3<f32>, q: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(wrQToWorldRow(r0, q), wrQToWorldRow(r2, q));
}

/** 完整 M-world。现役无消费者(DeferredEntityShadow 是死码;它按**列**取 R,
 *  展开后与本函数逐项相同,但它把 lab 的角度约定当 M-world 用 —— 见文件尾注 D-DEAD)。 */
fn wrQToWorld(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, q: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(wrQToWorldRow(r0, q), wrQToWorldRow(r1, q), wrQToWorldRow(r2, q));
}

/**
 * 上者的逆:M-world → 伪世界 q。R 正交(实测 |RᵀR−I| ≤ 1.11e-16,28/28 场景),
 * 所以转置即逆 —— 按**列**取,即 (Rᵀ·w)[i] = r0[i]·w.x + r1[i]·w.y + r2[i]·w.z。
 *
 * ⚠ 这个方向一度**只有 CPU 侧有**(worldReconstruct.ts 的 wrWorldToQComponent),
 *   着色器侧(当时的 GLSL)全是单向的。于是 2026-08-22 有人在场景 pass 里内联写了个 lightToQ,
 *   随后清理死代码时被一并删掉 —— 调用还在、定义没了,**整个重打光 shader 编译失败**,
 *   28 个场景的背景全黑。而全部门都绿:lint 只做字符串包含,没有一处真编译 GLSL。
 *   补在这里,两个方向就都有唯一真源了。
 *
 * 用途:把灯位从 M-world 折回 q(阴影的线扫前缀、光晕的视线积分都要)。
 */
fn wrWorldToQ(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, w: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        r0.x * w.x + r1.x * w.y + r2.x * w.z,
        r0.y * w.x + r1.y * w.y + r2.y * w.z,
        r0.z * w.x + r1.z * w.y + r2.z * w.z);
}

/**
 * ⚠⚠ **另一个 M**:实验室 lighting.json 的 world.M,**det = −1**(GL 右手,Z 反号)。
 * 只服务 probe/体素晶格查表(CharacterShadingFilter.ts:282 的 `vec3 Xw = uM * q;`)。
 * 与上面 wrQToWorld* 一族**不可互换**:把它的结果喂进碰撞格 = Z 轴整体翻号。
 * mat3x3 是列主(WGSL 与 master 的 GLSL 相同),CPU 侧上传的 mCol 已按列展开(CharacterLightingSystem),
 * 故 `M * q` 等于「meta.world.M 行 · q」。
 */
fn wrQToProbeWorld(labWorldM: mat3x3<f32>, q: vec3<f32>) -> vec3<f32> {
    return labWorldM * q;
}

// ===========================================================================
// 5. M-world 水平面 → 碰撞格
//    连续格坐标(**不 floor、不加半格**),边界判据是半开区间 [0, grid)。
// ===========================================================================

/** 站点:EntityShadow:97-98 / BackgroundDebugFilter:134-135 / isCollision:378-379(CPU,后接 floor)。 */
fn wrWorldXZToCell(worldXZ: vec2<f32>, cellMinXZ: vec2<f32>, cellSize: f32) -> vec2<f32> {
    return (worldXZ - cellMinXZ) / cellSize;
}

/** 格坐标是否在网格内(**NaN → false**,推荐口径;BackgroundDebugFilter:138 原文就是这个)。 */
fn wrCellInside(cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    return cell.x >= 0.0 && cell.x < gridSize.x && cell.y >= 0.0 && cell.y < gridSize.y;
}

/** 反向写法,仅为逐字复刻 EntityShadow:99。NaN 语义与 wrCellInside 不同,见 wrUvOutside 的说明。 */
fn wrCellOutside(cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
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
fn wrDecodeRG16Unit(texel: vec4<f32>) -> f32 {
    return (texel.r * 255.0 * 256.0 + texel.g * 255.0) / 65535.0;
}

/** depth_map 族。invert 作用在**归一化 t** 上,先于 scale/offset。 */
fn wrDecodeSceneDepth(texel: vec4<f32>, invert: f32, scale: f32, offset: f32) -> f32 {
    let rawDepth = wrDecodeRG16Unit(texel);
    var d_raw = rawDepth;
    if (invert > 0.5) { d_raw = 1.0 - rawDepth; }
    return d_raw * scale + offset;
}

/** ground_d 族。range = vec2(min, max)。**不吃 invert / scale / offset。** */
fn wrDecodeGroundDepth(texel: vec4<f32>, range: vec2<f32>) -> f32 {
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
fn wrUprightDelta(worldY: f32, footWorldY: f32, worldToNativePxY: f32, depthPerSy: f32) -> f32 {
    let syTexFoot = footWorldY * worldToNativePxY;
    let syTex = worldY * worldToNativePxY;
    return depthPerSy * (syTex - syTexFoot);
}

/**
 * 精灵深度代理。加法顺序即三处站点原文顺序,不许重排(浮点结合律)。
 *   footDepthQ + upright + floorOffset + floorOffsetExtra − footBias
 * 语义:floorOffset / floorOffsetExtra 为正 = 推远 = 更易被遮;footBias 为正 = 拉近 = 更不易被遮。
 * 影子路径只有 (ground + floorOffset),用 wrSpriteDepth(g, 0.0, floorOffset, 0.0, 0.0) 精确复现
 * (x+0.0 与 x−0.0 对非 −0 的 x 都是恒等)。
 */
fn wrSpriteDepth(footDepthQ: f32, upright: f32, floorOffset: f32,
                 floorOffsetExtra: f32, footBias: f32) -> f32 {
    return footDepthQ + upright + floorOffset + floorOffsetExtra - footBias;
}

/**
 * 遮挡判据。容差加在**场景**一侧,严格小于。
 * true = 场景几何比精灵更靠近相机 = 精灵被前景挡住。
 */
fn wrIsOccluded(sceneDepth: f32, spriteDepth: f32, tolerance: f32) -> bool {
    return sceneDepth + tolerance < spriteDepth;
}

/**
 * 遮挡像素的预乘输出。**rgb 与 a 必须同乘同一系数** —— 只乘 a 会让预乘合成按完整 rgb
 * 参与 blend,画面发白(DepthOcclusionFilter.ts:108-109 的实证注释)。
 * blend < 1e-5 的 discard 分支留在站点(本文件不做控制流)。
 */
fn wrApplyOcclusionBlend(premultipliedColor: vec4<f32>, blend: f32) -> vec4<f32> {
    return vec4<f32>(premultipliedColor.rgb * blend, premultipliedColor.a * blend);
}
//__WR_CORE_END__

//__WR_TEX_BEGIN__
// ===========================================================================
// 8. 采样封装(依赖 CORE,要一起拼进同一模块)。纹理与采样器都是形参;采样器紧跟它服务的那张纹理。
// ===========================================================================

/** 深度图直采 + 解码。站点:三个遮挡滤镜、EntityShadow:132-135、BackgroundDebugFilter:109-112。 */
fn wrSampleSceneDepth(depthMap: texture_2d<f32>, depthSmp: sampler, uv: vec2<f32>,
                      invert: f32, scale: f32, offset: f32) -> f32 {
    return wrDecodeSceneDepth(textureSampleLevel(depthMap, depthSmp, uv, 0.0), invert, scale, offset);
}

/** 行走面场按**已算好的 UV** 直采(BackgroundDebugFilter:125-127 复用外层 uv)。 */
fn wrSampleGroundAtUv(groundTex: texture_2d<f32>, groundSmp: sampler, uv: vec2<f32>, range: vec2<f32>) -> f32 {
    return wrDecodeGroundDepth(textureSampleLevel(groundTex, groundSmp, uv, 0.0), range);
}

/**
 * 行走面场按**世界坐标**直采(带守卫 + 钳制)。
 * eps 传 WR_EPS_SCENE 复现 EntityShadow:83-86,传 WR_EPS_TIGHT 复现 CharacterLitSprite:103-106。
 * ⚠ 纹理是 scaleMode:'nearest'(CharacterLightingSystem.ts:712),所以这是**最近邻**;
 *   而 CPU 侧 sampleGroundField 是**双线性** —— 这是 GPU/CPU 之间最实的一条数值分叉(D-11)。
 *   P1 的收敛落点是下面的 wrSampleGroundWorldBilinear。
 */
fn wrSampleGroundWorld(groundTex: texture_2d<f32>, groundSmp: sampler, worldXY: vec2<f32>, sceneExtent: vec2<f32>,
                       range: vec2<f32>, eps: f32) -> f32 {
    return wrSampleGroundAtUv(groundTex, groundSmp, wrSceneUvGuarded(worldXY, sceneExtent, eps), range);
}

/**
 * [P1,现役未启用] 行走面场双线性 —— 与 CPU 版 sampleGroundField 严格同源。
 * 逐行复刻 src/utils/groundDepthField.ts:29-37,包括:
 *   · 钳制在插值**之前**,上界是 (size − 1.001) 不是 (size − 1);
 *   · i11 写作 i01 + 1(CPU 原文如此;因 x0 ≤ w−2,不会跨行,合法)。
 * 前提:groundTex 必须是 nearest 且未预乘(现役已满足),否则 textureLoad 之外的路径会二次插值。
 * ⚠ 启用它会改变影子边缘与 F2 碰撞图 —— 属于「修 CPU/GPU 分叉」,不是零变化。
 */
fn wrSampleGroundWorldBilinear(groundTex: texture_2d<f32>, texSize: vec2<f32>, worldXY: vec2<f32>,
                               sceneExtent: vec2<f32>, range: vec2<f32>) -> f32 {
    let p = (worldXY / max(sceneExtent, vec2<f32>(WR_EPS_SCENE))) * texSize;
    let pc = clamp(p, vec2<f32>(0.0), texSize - 1.001);
    let b = floor(pc);
    let f = pc - b;
    let i00 = vec2<i32>(b);
    let d00 = wrDecodeGroundDepth(textureLoad(groundTex, i00, 0), range);
    let d10 = wrDecodeGroundDepth(textureLoad(groundTex, i00 + vec2<i32>(1, 0), 0), range);
    let d01 = wrDecodeGroundDepth(textureLoad(groundTex, i00 + vec2<i32>(0, 1), 0), range);
    let d11 = wrDecodeGroundDepth(textureLoad(groundTex, i00 + vec2<i32>(1, 1), 0), range);
    return d00 * (1.0 - f.x) * (1.0 - f.y) + d10 * f.x * (1.0 - f.y)
         + d01 * (1.0 - f.x) * f.y + d11 * f.x * f.y;
}

/**
 * 碰撞格采样(现役口径:连续 UV + 纹理默认 linear 过滤 + 阈值 0.5)。
 * 站点:EntityShadow:97-100 / BackgroundDebugFilter:134-141。
 * ⚠ 与 CPU 版 isCollision(floor 定格 + 原始字节 >127)**不是同一条边界**:
 *   linear 过滤会把二值图边界抹圆并整体挪半格(D-12)。P1 落点见下一个函数。
 */
fn wrSampleCollisionCell(collisionMap: texture_2d<f32>, collisionSmp: sampler, cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return textureSampleLevel(collisionMap, collisionSmp, cell / gridSize, 0.0).r > 0.5;
}

/**
 * [P1,现役未启用] 碰撞格采样,与 CPU isCollision 严格同源:floor 定格 + textureLoad。
 * 阈值 0.5 与 CPU 的 `byte > 127` 对整数字节完全等价(127/255=0.498 < 0.5 < 0.502=128/255)。
 * 前提:collisionMap 需设 scaleMode:'nearest'(现役是 Pixi 默认 linear)。
 * ⚠ 启用会让影子裁切边界与 F2 碰撞图整体挪半格并变硬 —— 是「与玩家实际能不能走过去对齐」,
 *   但确实改表现。
 */
fn wrSampleCollisionCellNearest(collisionMap: texture_2d<f32>, cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return textureLoad(collisionMap, vec2<i32>(floor(cell)), 0).r > 0.5;
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
fn wrUprightHeight(pixelSyPx: f32, footSyPx: f32, cosT: f32, ppu: f32) -> f32 {
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
fn wrQFromFoot(qx: f32, footQy: f32, footQz: f32, h: f32,
               cosT: f32, sinT: f32, bulge: f32) -> vec3<f32> {
    return vec3<f32>(qx, footQy + h * cosT, footQz - h * sinT - bulge);
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
fn wrDecodeSpriteNormal(ne: vec4<f32>, mirrored: bool, flatten: f32) -> vec3<f32> {
    var n = normalize(vec3<f32>(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (mirrored) { n.x = -n.x; }
    return normalize(mix(n, vec3<f32>(0., 0., -1.), flatten));
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
