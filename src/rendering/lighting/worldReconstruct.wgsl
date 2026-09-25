// ============================================================================
// worldReconstruct.wgsl —— 「世界重建数学」的 WGSL 版（WebGPU 迁移期与 worldReconstruct.glsl 并存）
//
// 本文件是 worldReconstruct.glsl 的**逐函数等价移植**。四条设计铁律（不读 uniform、表达式
// 逐字照抄不化简、两个 M 不许混、两套像素栅格不许混）与各函数的站点、口径、已知分叉
// (D-08 / D-11 / D-12)全部照 GLSL 版，正文只在那边维护一份，这里不复述。
// CPU 镜像 worldReconstruct.ts 与 WR_CONTRACT 的约定同样适用：改 GLSL 语义 = 同步改本文件、
// TS 镜像并 bump WR_CONTRACT（wgslChunks.test.ts 钉两边的 WR_CONTRACT 相等）。
//
// 【怎么拼】与 GLSL 同一套三段切片，vite ?raw 引入，同一行切片器：
//
//     import WR_WGSL_SRC from './lighting/worldReconstruct.wgsl?raw';
//     const WR_CORE_WGSL   = slice(WR_WGSL_SRC, 'WR_CORE');    // 纯数学，无纹理
//     const WR_TEX_WGSL    = slice(WR_WGSL_SRC, 'WR_TEX');     // 采样封装，依赖 CORE
//     const WR_SPRITE_WGSL = slice(WR_WGSL_SRC, 'WR_SPRITE');  // 直立 quad + 精灵法线，依赖 CORE
//
//   · 三段都**不读任何绑定**：纹理、采样器与全部标量都走形参，宿主的 uniform 怎么分组都行。
//   · WGSL 模块级声明与顺序无关，三段谁前谁后都行；但每段在同一模块里只许拼一次。
//   · 整个文件（含三段）等价于 GLSL 的整份 worldReconstruct.glsl（已停用的统一角色路径那样
//     整份拼的用法），切片标记之外只有注释。
//
// 【与 GLSL 的形式差异（数值不变）】
//   · WR_CONTRACT 是 i32 常量（GLSL 是 #define），值与 GLSL 相同。
//   · WR_TEX 里凡是 GLSL 用 texture() 采样的函数，多一个 sampler 形参（紧跟纹理之后），
//     采样用 textureSampleLevel(…, 0.0)：能在分支 / 循环里调，对单级纹理与 texture() 等价。
//     texelFetch 一律 textureLoad(…, 0)，不需要采样器。
//   · GLSL 的三元式一律写成 if/else（不用 select：select 两边都求值，照 GLSL 的控制流写更稳）。
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件的注释里不许出现
//   「at 号 + group / binding + 括号」字样。
// ============================================================================

//__WR_CORE_BEGIN__
// 契约版本。与 worldReconstruct.glsl 的 #define WR_CONTRACT 同值（测试比对）。
const WR_CONTRACT: i32 = 2;

// 各站点原文里的三种下限守卫，数值与 GLSL 版逐一相同（改了就是行为变化）。
const WR_EPS_PROJ: f32 = 1e-6;
const WR_EPS_COSPP: f32 = 1e-6;
const WR_EPS_SCENE: f32 = 1e-3;
const WR_EPS_TIGHT: f32 = 1e-5;

// ===========================================================================
// 1. 屏幕/几何 → 场景世界坐标（Y 仍向下，翻 Y 只在 wrQy）
// ===========================================================================

fn wrScreenToWorld(screenPos: vec2<f32>, worldContainerPos: vec2<f32>, projectionScale: f32) -> vec2<f32> {
    let S = max(projectionScale, WR_EPS_PROJ);
    return (screenPos - worldContainerPos) / S;
}

// 场景归一化 UV；无除零守卫（与 GLSL 相同）。
fn wrSceneUv(p: vec2<f32>, extent: vec2<f32>) -> vec2<f32> {
    return p / extent;
}

fn wrSceneUvGuarded(p: vec2<f32>, extent: vec2<f32>, eps: f32) -> vec2<f32> {
    return clamp(p / max(extent, vec2<f32>(eps)), vec2<f32>(0.0), vec2<f32>(1.0));
}

// UV 是否落在 [0,1]²（NaN → false = 出界，推荐口径）。
fn wrUvInside(uv: vec2<f32>) -> bool {
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

// 反向写法，NaN 语义与 wrUvInside 不同（见 GLSL 版说明），只为逐字复刻旧站点保留。
fn wrUvOutside(uv: vec2<f32>) -> bool {
    return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0;
}

// ===========================================================================
// 2. 世界 → 像素栅格（两个函数体一样，名字就是类型系统：native 配 depthConfig.M，work 配 meta.cal）
// ===========================================================================

fn wrWorldToNativePx(worldXY: vec2<f32>, worldToNativePx: vec2<f32>) -> vec2<f32> {
    return worldXY * worldToNativePx;
}

fn wrWorldToWorkPx(worldXY: vec2<f32>, worldToWorkPx: vec2<f32>) -> vec2<f32> {
    return worldXY * worldToWorkPx;
}

// ===========================================================================
// 3. 像素栅格 → 伪世界 q：q = ((sx − cx)/ppu, (cy − sy)/ppu, d)
// ===========================================================================

fn wrQx(sxPx: f32, ppu: f32, cx: f32) -> f32 {
    return (sxPx - cx) / ppu;
}

// q.y（翻 Y 就在这里）
fn wrQy(syPx: f32, ppu: f32, cy: f32) -> f32 {
    return (cy - syPx) / ppu;
}

fn wrPixelToQ(pxXY: vec2<f32>, ppu: f32, cx: f32, cy: f32, d: f32) -> vec3<f32> {
    return vec3<f32>(wrQx(pxXY.x, ppu, cx), wrQy(pxXY.y, ppu, cy), d);
}

fn wrQxToPx(qx: f32, ppu: f32, cx: f32) -> f32 {
    return cx + qx * ppu;
}

fn wrQyToPx(qy: f32, ppu: f32, cy: f32) -> f32 {
    return cy - qy * ppu;
}

fn wrQToPixel(q: vec3<f32>, ppu: f32, cx: f32, cy: f32) -> vec2<f32> {
    return vec2<f32>(wrQxToPx(q.x, ppu, cx), wrQyToPx(q.y, ppu, cy));
}

// ===========================================================================
// 4. 伪世界 q → M-world（depthConfig.M.R，det = +1；R 行主，刻意不用 mat3）
// ===========================================================================

// (R·q) 的一个分量，表达式树与站点原文 R00*px + R01*py + R02*d 一致（不用 dot）。
fn wrQToWorldRow(row: vec3<f32>, q: vec3<f32>) -> f32 {
    return row.x * q.x + row.y * q.y + row.z * q.z;
}

fn wrQToWorldXZ(r0: vec3<f32>, r2: vec3<f32>, q: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(wrQToWorldRow(r0, q), wrQToWorldRow(r2, q));
}

fn wrQToWorld(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, q: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(wrQToWorldRow(r0, q), wrQToWorldRow(r1, q), wrQToWorldRow(r2, q));
}

// 上者的逆：M-world → q（R 正交，转置即逆，按列取）。
fn wrWorldToQ(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, w: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        r0.x * w.x + r1.x * w.y + r2.x * w.z,
        r0.y * w.x + r1.y * w.y + r2.y * w.z,
        r0.z * w.x + r1.z * w.y + r2.z * w.z);
}

// ⚠⚠ 另一个 M：实验室 lighting.json 的 world.M（det = −1），只服务 probe/体素晶格查表。
// mat3x3 在 WGSL 与 GLSL 一样是列主，上传的 mCol 同一份，M * q 语义相同。
fn wrQToProbeWorld(labWorldM: mat3x3<f32>, q: vec3<f32>) -> vec3<f32> {
    return labWorldM * q;
}

// ===========================================================================
// 5. M-world 水平面 → 碰撞格（连续格坐标，半开区间 [0, grid)）
// ===========================================================================

fn wrWorldXZToCell(worldXZ: vec2<f32>, cellMinXZ: vec2<f32>, cellSize: f32) -> vec2<f32> {
    return (worldXZ - cellMinXZ) / cellSize;
}

fn wrCellInside(cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    return cell.x >= 0.0 && cell.x < gridSize.x && cell.y >= 0.0 && cell.y < gridSize.y;
}

fn wrCellOutside(cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    return cell.x < 0.0 || cell.x >= gridSize.x || cell.y < 0.0 || cell.y >= gridSize.y;
}

// ===========================================================================
// 6. RG16 解码 —— 两族（depth_map / ground_d），不可混用
// ===========================================================================

fn wrDecodeRG16Unit(texel: vec4<f32>) -> f32 {
    return (texel.r * 255.0 * 256.0 + texel.g * 255.0) / 65535.0;
}

// depth_map 族。invert 作用在归一化 t 上，先于 scale/offset。
fn wrDecodeSceneDepth(texel: vec4<f32>, invert: f32, scale: f32, offset: f32) -> f32 {
    let rawDepth = wrDecodeRG16Unit(texel);
    var d_raw = rawDepth;
    if (invert > 0.5) { d_raw = 1.0 - rawDepth; }
    return d_raw * scale + offset;
}

// ground_d 族。range = vec2(min, max)，不吃 invert / scale / offset。
fn wrDecodeGroundDepth(texel: vec4<f32>, range: vec2<f32>) -> f32 {
    return range.x + wrDecodeRG16Unit(texel) * (range.y - range.x);
}

// ===========================================================================
// 7. 精灵深度代理（遮挡判据）—— 直立 quad
// ===========================================================================

// 不钳非负（与 wrUprightHeight 相反，见 GLSL 版 D-08）。
fn wrUprightDelta(worldY: f32, footWorldY: f32, worldToNativePxY: f32, depthPerSy: f32) -> f32 {
    let syTexFoot = footWorldY * worldToNativePxY;
    let syTex = worldY * worldToNativePxY;
    return depthPerSy * (syTex - syTexFoot);
}

// 加法顺序即站点原文顺序，不许重排（浮点结合律）。
fn wrSpriteDepth(footDepthQ: f32, upright: f32, floorOffset: f32,
                 floorOffsetExtra: f32, footBias: f32) -> f32 {
    return footDepthQ + upright + floorOffset + floorOffsetExtra - footBias;
}

// true = 场景几何比精灵更靠近相机 = 精灵被前景挡住。
fn wrIsOccluded(sceneDepth: f32, spriteDepth: f32, tolerance: f32) -> bool {
    return sceneDepth + tolerance < spriteDepth;
}

// rgb 与 a 必须同乘同一系数（只乘 a 会让预乘合成发白）。
fn wrApplyOcclusionBlend(premultipliedColor: vec4<f32>, blend: f32) -> vec4<f32> {
    return vec4<f32>(premultipliedColor.rgb * blend, premultipliedColor.a * blend);
}
//__WR_CORE_END__

//__WR_TEX_BEGIN__
// ===========================================================================
// 8. 采样封装（依赖 CORE）。纹理与采样器都是形参；采样器紧跟它服务的那张纹理。
// ===========================================================================

fn wrSampleSceneDepth(depthMap: texture_2d<f32>, depthSmp: sampler, uv: vec2<f32>,
                      invert: f32, scale: f32, offset: f32) -> f32 {
    return wrDecodeSceneDepth(textureSampleLevel(depthMap, depthSmp, uv, 0.0), invert, scale, offset);
}

fn wrSampleGroundAtUv(groundTex: texture_2d<f32>, groundSmp: sampler, uv: vec2<f32>, range: vec2<f32>) -> f32 {
    return wrDecodeGroundDepth(textureSampleLevel(groundTex, groundSmp, uv, 0.0), range);
}

// 行走面场按世界坐标直采（带守卫 + 钳制）。纹理现役 nearest，所以是最近邻（D-11）。
fn wrSampleGroundWorld(groundTex: texture_2d<f32>, groundSmp: sampler, worldXY: vec2<f32>, sceneExtent: vec2<f32>,
                       range: vec2<f32>, eps: f32) -> f32 {
    return wrSampleGroundAtUv(groundTex, groundSmp, wrSceneUvGuarded(worldXY, sceneExtent, eps), range);
}

// [P1,现役未启用] 行走面场双线性，与 CPU sampleGroundField 严格同源（逐行照 GLSL 版）。
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

// 碰撞格采样（现役口径：连续 UV + 纹理自带过滤 + 阈值 0.5；与 CPU 差半格，D-12）。
fn wrSampleCollisionCell(collisionMap: texture_2d<f32>, collisionSmp: sampler, cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return textureSampleLevel(collisionMap, collisionSmp, cell / gridSize, 0.0).r > 0.5;
}

// [P1,现役未启用] 碰撞格采样，与 CPU isCollision 严格同源：floor 定格 + textureLoad。
fn wrSampleCollisionCellNearest(collisionMap: texture_2d<f32>, cell: vec2<f32>, gridSize: vec2<f32>) -> bool {
    if (!wrCellInside(cell, gridSize)) { return false; }
    return textureLoad(collisionMap, vec2<i32>(floor(cell)), 0).r > 0.5;
}
//__WR_TEX_END__

//__WR_SPRITE_BEGIN__
// ===========================================================================
// 9. 直立 quad 的完整式（着色路径）+ 精灵法线解码（work px + meta.cal 那一套）
// ===========================================================================

// 像素相对脚点的直立高度（世界单位），脚点下方钳 0。
fn wrUprightHeight(pixelSyPx: f32, footSyPx: f32, cosT: f32, ppu: f32) -> f32 {
    return max((footSyPx - pixelSyPx) / max(cosT * ppu, WR_EPS_COSPP), 0.0);
}

// 着色路径的最终 q：(qx, footQy + h·cosθ, footQz − h·sinθ − bulge)。
fn wrQFromFoot(qx: f32, footQy: f32, footQz: f32, h: f32,
               cosT: f32, sinT: f32, bulge: f32) -> vec3<f32> {
    return vec3<f32>(qx, footQy + h * cosT, footQz - h * sinT - bulge);
}

// 精灵法线解码：rgb 全取负（b 先 max 0.05），镜像只翻 x，向 (0,0,−1) 压平。
fn wrDecodeSpriteNormal(ne: vec4<f32>, mirrored: bool, flatten: f32) -> vec3<f32> {
    var n = normalize(vec3<f32>(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (mirrored) { n.x = -n.x; }
    return normalize(mix(n, vec3<f32>(0., 0., -1.), flatten));
}
//__WR_SPRITE_END__
