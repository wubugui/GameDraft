// ============================================================================
// 角色着色核心 —— 唯一真相源（single source of truth）。
//
// 游戏（CharacterShadingFilter 的滤镜、CharacterLitSprite 的 sprite 网格、粒子受光）与灯光实验室
// （页面画的就是游戏本体）**共用这一份**：不单独拼，由 CHAR_LIGHT_COMMON_WGSL（charLightCommon.wgsl
// 的 CLC 段）在 __CHAR_SHADE_CORE_WGSL__ 那一行原样注入。任何角色着色迭代（尤其 E 的颜色 / 明暗分离）
// 只改此文件——**禁止在任一处内联重写这段逻辑**，否则实验室预览与游戏漂移、在实验室调出的参数到游戏里就是错的。
// 与 master（GLSL 版 charShadeCore.glsl）逐像素一致由 tools/render_parity 的「光照片段 / 着色核心」用例钉住。
//
// 依赖：调用方模块里已定义 srgb2lin()（CLC 段自带）。本段不读任何绑定。
// ============================================================================

// E 分解 + albedo × E。
//   albSrgb  角色 albedo（sRGB，直通图集像素；sprite 本身是着色后的 color）
//   E        场景辐照度（RGB，probe / RT gather；已含太阳等累加）
//   eChroma  E 色度权重：0 = 只借场景明暗（luma）、角色保留自己颜色不被场景色染；1 = 完整彩色 E
//   beta     曝光（已 pow，即 2^β）
// 返回：**线性域** col（未 lin2srgb、未乘实验室 pgain、未 clamp——由各调用方按自身上下文处理）。
fn shadeCharacterLinear(albSrgb: vec3<f32>, EIn: vec3<f32>, eChroma: f32, beta: f32) -> vec3<f32> {
    let lumaE = dot(EIn, vec3<f32>(0.2126, 0.7152, 0.0722));
    let E = mix(vec3<f32>(lumaE), EIn, eChroma);   // sprite 缺的是明暗、颜色自带 → 默认只借明暗
    return srgb2lin(albSrgb) * E / 3.14159265 * beta;
}

// factor 全为 1 时与背景 albedo * lampE 同尺。旧曝光等价折入场景 totalFactor。
// 色度只由各自路径传入；粒子不再读取角色的运行时调色覆盖。
fn shadeEntityLinear(albSrgb: vec3<f32>, indirectE: vec3<f32>, directE: vec3<f32>,
                     indirectFactor: f32, directFactor: f32, totalFactor: f32,
                     eChroma: f32) -> vec3<f32> {
    let E = indirectE * indirectFactor + directE * directFactor;
    let luma = dot(E, vec3<f32>(0.2126, 0.7152, 0.0722));
    return srgb2lin(albSrgb) * mix(vec3<f32>(luma), E, eChroma) * totalFactor;
}
