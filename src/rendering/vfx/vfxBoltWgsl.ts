/**
 * 雷的片元核（唯一一份）：`boltSeg(p, a, b, sigma)` = 从 a 到 b 的一段均匀发光线与 σ 的圆形高斯卷积，
 * 无穷长直线的峰值归一为 1。erf 用 Abramowitz–Stegun 7.1.26（误差 1.5e-7）。为什么是卷积、段与段为什么直接相加，
 * 见 `vfxBoltGlsl.ts`（历史文件名：逐段发射 `emitBoltSegments` 住那里）头注释。
 *
 * 纯模块（无 Pixi / 无 DOM / 无 `?raw`），Node 里能直接 import。数学逐式照抄 master 的 GLSL 版（运算顺序不改，常数不合并）：
 * 等价由 `tools/render_parity` 的「粒子 / 雷」用例逐像素钉住。与 GLSL 版的形式差异（数值不变）：三目式写成 if / else
 * （不用 select，两边都求值）。本段不读任何绑定。
 */

export const BOLT_WGSL_KERNEL = /* wgsl */ `
fn boltErf(x: f32) -> f32 {
    var s = 1.0;
    if (x < 0.0) { s = -1.0; }
    let ax = abs(x);
    let t = 1.0 / (1.0 + 0.3275911 * ax);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-ax * ax);
    return s * y;
}
fn boltSeg(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, sigma: f32) -> f32 {
    let d = b - a;
    let len = length(d);
    // 零长的段没有线可积（折线里重复的点），贡献 0
    if (sigma <= 0.0 || len < 1e-5) { return 0.0; }
    let q = p - a;
    let t = d / len;
    let along = dot(q, t);
    let perp = q.x * t.y - q.y * t.x;
    let k = 0.70710678 / sigma;
    return exp(-0.5 * perp * perp / (sigma * sigma)) * 0.5 * (boltErf((len - along) * k) + boltErf(along * k));
}
`;
