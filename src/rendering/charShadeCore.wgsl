// ============================================================================
// 角色着色核心 —— WGSL 版（WebGPU 迁移期与 charShadeCore.glsl 并存）。
//
// charShadeCore.glsl 仍是唯一真相源（运行时 WebGL 路径与灯光实验室都读那一份，那份文件
// 一个字节都不许动）；本文件是它的逐式移植，等价由 tools/render_parity 的
// 「光照片段 / 着色核心」用例钉住。改着色公式 = 两份同改、重跑对照。
//
// 用法：不单独拼，由 CHAR_LIGHT_COMMON_WGSL（charLightCommon.wgsl 的 CLC 段）原样注入，
// 与 GLSL 那边 CLC 注入 charShadeCore.glsl 同一个位置、同一个依赖：
// 调用方模块里必须已有 srgb2lin（CLC 段自带）。本段不读任何绑定。
// ============================================================================

// E 分解 + albedo × E（参数含义见 GLSL 版）。返回线性域，未 clamp。
fn shadeCharacterLinear(albSrgb: vec3<f32>, EIn: vec3<f32>, eChroma: f32, beta: f32) -> vec3<f32> {
    let lumaE = dot(EIn, vec3<f32>(0.2126, 0.7152, 0.0722));
    let E = mix(vec3<f32>(lumaE), EIn, eChroma);   // sprite 缺的是明暗、颜色自带 → 默认只借明暗
    return srgb2lin(albSrgb) * E / 3.14159265 * beta;
}

// factor 全为 1 时与背景 albedo * lampE 同尺。
fn shadeEntityLinear(albSrgb: vec3<f32>, indirectE: vec3<f32>, directE: vec3<f32>,
                     indirectFactor: f32, directFactor: f32, totalFactor: f32,
                     eChroma: f32) -> vec3<f32> {
    let E = indirectE * indirectFactor + directE * directFactor;
    let luma = dot(E, vec3<f32>(0.2126, 0.7152, 0.0722));
    return srgb2lin(albSrgb) * mix(vec3<f32>(luma), E, eChroma) * totalFactor;
}
