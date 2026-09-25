/**
 * 雷片元核 {@link BOLT_GLSL_KERNEL}（`vfxBoltGlsl.ts`）的 **WGSL 孪生**（WebGPU 迁移期并存）。
 *
 * `vfxBoltGlsl.ts` 被粒子工作台原样打包、在它自己的 WebGL2 里编译，那份文件的内容与导出一个字不动；
 * WGSL 版放这里，同样是纯模块（无 Pixi / 无 DOM / 无 `?raw`），Node 里能直接 import。
 * 数学逐式照抄（运算顺序不改，常数不合并）：两边等价由 `tools/render_parity` 的「粒子 / 雷」用例逐像素钉住，
 * 改一边必须同步改另一边。
 *
 * 与 GLSL 的形式差异（数值不变）：三目式写成 if / else（不用 select，两边都求值）。
 * 本段不读任何绑定。
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
