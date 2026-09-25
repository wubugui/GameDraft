/**
 * 光柱着色核心 {@link BEAM_GLSL_CORE}（`vfxBeamGlsl.ts`）的 **WGSL 孪生**（WebGPU 迁移期并存）。
 *
 * `vfxBeamGlsl.ts` 被粒子工作台原样打包、在它自己的 WebGL2 里编译（核心 + uniform 声明 + 打包函数），
 * 那份文件的内容与导出一个字不动；WGSL 版放这里，同样是纯模块（只引常量，无 Pixi / 无 DOM / 无 `?raw`），
 * Node 里能直接 import。数学逐式照抄（运算顺序不改，常数不合并）：等价由 `tools/render_parity` 的
 * 「粒子 / 光柱」用例逐像素钉住，改一边必须同步改另一边。
 *
 * ## 宿主怎么拼
 *
 * GLSL 核心直接读散装的 `uBeam*` uniform；WGSL 的 uniform 必须活在结构里，所以：
 *
 * - 宿主拼 {@link BEAM_WGSL_UNIFORMS}（结构 `VfxBeamUniforms`），并声明一个**名叫 vfxBeam** 的 uniform 绑定
 *   （名字 = Pixi resources 的键名，`VfxBeamView` 的光柱组就叫这个；组号 / 绑定号宿主自定）；
 *   核心直接读模块作用域的 `vfxBeam`（WGSL 模块级声明不讲先后）。
 * - 宿主提供与 GLSL 同名的三样：`bmSceneDepth(scene) -> f32`（原画深度 q.z、已加容差；无深度返回 1e20）、
 *   `bmToLinear(srgb) -> vec3`、图案遮罩纹理 `uBeamCookie` 与它的采样器 `uBeamCookieSampler`（两个绑定）。
 *
 * ## 结构布局（静默错位点）
 *
 * Pixi 按 JS uniform 组的**声明顺序**、WGSL 对齐规则排缓冲（`createUboElementsWGSL`），WGSL 结构必须逐项对上。
 * 唯一的例外是 `uBeamAlong`（JS 里是 `vec2<f32>` × {@link VFX_BEAM_MAX_CURVE_KEYS}）：uniform 地址空间的数组
 * 步长必须是 16 的倍数，`array<vec2<f32>, N>`（步长 8）编不过，所以这里声明成同一块内存的
 * `array<vec4<f32>, N/2>`，第 i 个关键帧 = 第 i/2 个元素的 xy（偶）/ zw（奇）。前提是它在缓冲里的偏移是 16 的倍数：
 * `VfxBeamView` 把它紧跟在 `uBeamPlanes` 后面声明（GL 侧按名字逐个传 uniform，声明顺序不影响画面）。
 * `vfxWgsl.test.ts` 按两边的布局规则逐项核对偏移。
 *
 * 与 GLSL 的形式差异（数值不变）：三目式写成 if / else（不用 select，两边都求值）；形参不可写，改写形参处用局部量；
 * 常量 `BM_PI` 声明成 f32（与 GLSL `const float` 一样在 32 位里折叠）；smoothstep 写成规范展开式 `bmSmoothstep`
 * （内建与 GLSL 差几个 ulp）；图案遮罩在分支里采样，用
 * `textureSampleLevel(…, 0.0)`（遮罩贴图没有 mip，与 GLSL `texture()` 等价）。
 *
 * ⚠ Pixi 按正则从整段 WGSL 抽 struct 与绑定：struct 体内不许写注释，注释里不许出现「at 号 + group / binding + 括号」。
 */
import { VFX_BEAM_MAX_CURVE_KEYS, VFX_BEAM_MAX_PLANES, VFX_BEAM_MAX_SIDES } from '../../systems/vfx/vfxBeam';

/** `uBeamAlong` 在 WGSL 里的 vec4 个数（两个关键帧一格） */
export const BEAM_WGSL_ALONG_VEC4 = Math.ceil(VFX_BEAM_MAX_CURVE_KEYS / 2);

/**
 * 光柱 uniform 组的 WGSL 结构。成员**同名同序**对应 `VfxBeamView` 里 `beamGroup` 的声明
 * （含 `uBeamAlong` 挪到 `uBeamPlanes` 之后的那一处），类型除 `uBeamAlong` 外逐项相同。
 */
export const BEAM_WGSL_UNIFORMS = /* wgsl */ `
struct VfxBeamUniforms {
    uBeamMode: f32,
    uBeamS2W0: vec4<f32>,
    uBeamS2W1: vec4<f32>,
    uBeamS2W2: vec4<f32>,
    uBeamPlanes: array<vec4<f32>, ${VFX_BEAM_MAX_PLANES}>,
    uBeamAlong: array<vec4<f32>, ${BEAM_WGSL_ALONG_VEC4}>,
    uBeamPlaneCount: i32,
    uBeamOrigin: vec3<f32>,
    uBeamAxis: vec3<f32>,
    uBeamRight: vec3<f32>,
    uBeamUp: vec3<f32>,
    uBeamLength: f32,
    uBeamSec: vec4<f32>,
    uBeamTan: vec3<f32>,
    uBeam2O: vec2<f32>,
    uBeam2D: vec4<f32>,
    uBeam2W: vec3<f32>,
    uBeamPlaneQ: vec4<f32>,
    uBeamColor0: vec3<f32>,
    uBeamColor1: vec3<f32>,
    uBeamGain: f32,
    uBeamEdgeSoft: f32,
    uBeamThickness: f32,
    uBeamContactSoft: f32,
    uBeamWuPerQ: f32,
    uBeamBlend: i32,
    uBeamAlongCount: i32,
    uBeamNoise: vec4<f32>,
    uBeamNoiseVel: vec3<f32>,
    uBeamTime: f32,
    uBeamCookieOn: f32,
    uBeamCookieXf: vec4<f32>,
    uBeamCookieRot: vec2<f32>,
    uBeamCookieStrength: f32,
}
`;

/** 核心（读模块作用域的 `vfxBeam` 绑定；宿主函数见文件头） */
export const BEAM_WGSL_CORE = /* wgsl */ `
const BM_PI: f32 = 3.14159265358979;

fn bmHash(pIn: vec3<f32>) -> f32 {
    var p = fract(pIn * 0.3183099 + vec3<f32>(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

fn bmValueNoise(x: vec3<f32>) -> f32 {
    let i = floor(x);
    var f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    let n000 = bmHash(i);
    let n100 = bmHash(i + vec3<f32>(1.0, 0.0, 0.0));
    let n010 = bmHash(i + vec3<f32>(0.0, 1.0, 0.0));
    let n110 = bmHash(i + vec3<f32>(1.0, 1.0, 0.0));
    let n001 = bmHash(i + vec3<f32>(0.0, 0.0, 1.0));
    let n101 = bmHash(i + vec3<f32>(1.0, 0.0, 1.0));
    let n011 = bmHash(i + vec3<f32>(0.0, 1.0, 1.0));
    let n111 = bmHash(i + vec3<f32>(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

fn bmFbm(x: vec3<f32>) -> f32 {
    return 0.62 * bmValueNoise(x) + 0.38 * bmValueNoise(x * 2.03 + vec3<f32>(17.1, 3.7, 9.2));
}

// GLSL smoothstep 的规范展开式:WGSL 内建 smoothstep 与 GLSL 内建差几个 ulp(SwiftShader 实测),
// 边缘 / 贴地软收尾乘在亮度上会被放大;展开式与 GLSL 内建逐位一致(同 lightingCore.wgsl 的聚光锥角)
fn bmSmoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// 与 vfxBeam.ts beamEdgeMask 同式
fn bmEdgeMask(edge: f32) -> f32 {
    if (edge < 0.0) { return 0.0; }
    if (vfxBeam.uBeamEdgeSoft > 1e-4) { return bmSmoothstep(0.0, vfxBeam.uBeamEdgeSoft, edge); }
    return 1.0;
}

// 第 i 个沿长度关键帧（结构里两个一格，见文件头）
fn bmAlongKey(i: i32) -> vec2<f32> {
    let v = vfxBeam.uBeamAlong[i / 2];
    if ((i & 1) == 0) { return v.xy; }
    return v.zw;
}

// 与 vfxCurve.ts sampleCurve 同一口径：空 = 恒 1，超出两端取端点
fn bmAlong(t: f32) -> f32 {
    if (vfxBeam.uBeamAlongCount <= 0) { return 1.0; }
    let k0 = bmAlongKey(0);
    if (t <= k0.x) { return k0.y; }
    for (var i = 1; i < ${VFX_BEAM_MAX_CURVE_KEYS}; i++) {
        if (i >= vfxBeam.uBeamAlongCount) { break; }
        let b = bmAlongKey(i);
        if (t <= b.x) {
            let a = bmAlongKey(i - 1);
            var k = 1.0;
            if (b.x > a.x) { k = (t - a.x) / (b.x - a.x); }
            return a.y + (b.y - a.y) * k;
        }
    }
    return bmAlongKey(vfxBeam.uBeamAlongCount - 1).y;
}

// 亮度 × 颜色（线性）；u / v = 截面归一化坐标（-1..1），noisePos = 取噪声的位置
fn bmShade(t01: f32, u: f32, v: f32, noisePos: vec3<f32>, weight: f32) -> vec4<f32> {
    var amount = vfxBeam.uBeamGain * bmAlong(t01) * weight;
    if (vfxBeam.uBeamNoise.x > 0.0) {
        let np = (noisePos - vfxBeam.uBeamNoiseVel * vfxBeam.uBeamTime) * vfxBeam.uBeamNoise.y;
        amount *= max(0.0, 1.0 + vfxBeam.uBeamNoise.x * (2.0 * bmFbm(np) - 1.0));
    }
    if (vfxBeam.uBeamCookieOn > 0.5) {
        var c = vec2<f32>(u, v) * 0.5;
        let rot = vfxBeam.uBeamCookieRot;
        c = vec2<f32>(c.x * rot.x - c.y * rot.y, c.x * rot.y + c.y * rot.x);
        c = c * vfxBeam.uBeamCookieXf.xy + 0.5 + vfxBeam.uBeamCookieXf.zw;
        let cv = textureSampleLevel(uBeamCookie, uBeamCookieSampler, fract(c), 0.0).r;
        amount *= mix(1.0, cv, vfxBeam.uBeamCookieStrength);
    }
    // 颜色（线性）与亮度分开交给宿主：亮度乘在显示空间（理由见 GLSL 版）
    let col = bmToLinear(mix(vfxBeam.uBeamColor0, vfxBeam.uBeamColor1, clamp(t01, 0.0, 1.0)));
    return vec4<f32>(col, amount);
}

fn bmEval3d(s: vec2<f32>) -> vec4<f32> {
    let h = vec4<f32>(s, 0.0, 1.0);
    let P0 = vec3<f32>(dot(vfxBeam.uBeamS2W0, h), dot(vfxBeam.uBeamS2W1, h), dot(vfxBeam.uBeamS2W2, h));
    let d = vec3<f32>(vfxBeam.uBeamS2W0.z, vfxBeam.uBeamS2W1.z, vfxBeam.uBeamS2W2.z);
    var qa = -1e20;
    var qb = 1e20;
    for (var i = 0; i < ${VFX_BEAM_MAX_PLANES}; i++) {
        if (i >= vfxBeam.uBeamPlaneCount) { break; }
        let pl = vfxBeam.uBeamPlanes[i];
        let num = dot(pl.xyz, P0) + pl.w;
        let den = dot(pl.xyz, d);
        if (abs(den) < 1e-12) {
            if (num > 0.0) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
        } else {
            let q = -num / den;
            if (den > 0.0) { qb = min(qb, q); } else { qa = max(qa, q); }
        }
    }
    if (qb <= qa) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    var clipped = false;
    let sd = bmSceneDepth(s);
    if (sd < qb) { qb = sd; clipped = true; }
    if (qb <= qa) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    let dl = length(d);
    let chordWu = (qb - qa) * dl;
    let P = P0 + d * (0.5 * (qa + qb));
    let rel = P - vfxBeam.uBeamOrigin;
    let t = dot(rel, vfxBeam.uBeamAxis);
    let lx = dot(rel, vfxBeam.uBeamRight);
    let ly = dot(rel, vfxBeam.uBeamUp);
    var edge: f32;
    var u: f32;
    var v: f32;
    var refThick: f32;
    if (vfxBeam.uBeamSec.x < 0.5) {
        let hw = max(1e-4, vfxBeam.uBeamSec.z + t * vfxBeam.uBeamTan.x);
        let hh = max(1e-4, vfxBeam.uBeamSec.w + t * vfxBeam.uBeamTan.y);
        u = lx / hw;
        v = ly / hh;
        edge = min(1.0 - abs(u), 1.0 - abs(v));
        refThick = hw + hh;
    } else {
        let n = i32(vfxBeam.uBeamSec.y + 0.5);
        let r = max(1e-4, vfxBeam.uBeamSec.z + t * vfxBeam.uBeamTan.x);
        let ap = r * cos(BM_PI / f32(n));
        edge = 1e20;
        for (var k = 0; k < ${VFX_BEAM_MAX_SIDES}; k++) {
            if (k >= n) { break; }
            let phi = BM_PI * 0.5 + 2.0 * BM_PI * f32(k) / f32(n);
            edge = min(edge, (ap - (lx * cos(phi) + ly * sin(phi))) / ap);
        }
        u = lx / r;
        v = ly / r;
        refThick = 2.0 * ap;
    }
    let thick = mix(1.0, min(chordWu / max(refThick, 1e-3), 3.0), clamp(vfxBeam.uBeamThickness, 0.0, 1.0));
    var contact = 1.0;
    if (clipped && vfxBeam.uBeamContactSoft > 0.0) { contact = bmSmoothstep(0.0, vfxBeam.uBeamContactSoft, chordWu); }
    return bmShade(t / vfxBeam.uBeamLength, u, v, P, bmEdgeMask(edge) * thick * contact);
}

fn bmEval2d(s: vec2<f32>) -> vec4<f32> {
    let p = s - vfxBeam.uBeam2O;
    let along = dot(p, vfxBeam.uBeam2D.xy) / vfxBeam.uBeam2W.x;
    if (along < 0.0 || along > 1.0) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    let hw = mix(vfxBeam.uBeam2W.y, vfxBeam.uBeam2W.z, along);
    if (hw <= 1e-4) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    let u = dot(p, vfxBeam.uBeam2D.zw) / hw;
    let edge = 1.0 - abs(u);
    if (edge < 0.0) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
    var contact = 1.0;
    if (vfxBeam.uBeamPlaneQ.w > 0.5) {
        let sd = bmSceneDepth(s);
        if (sd < 1e19) {
            let gap = sd - dot(vfxBeam.uBeamPlaneQ.xyz, vec3<f32>(s, 1.0));
            if (gap < 0.0) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
            if (vfxBeam.uBeamContactSoft > 0.0) { contact = bmSmoothstep(0.0, vfxBeam.uBeamContactSoft, gap * vfxBeam.uBeamWuPerQ); }
        }
    }
    return bmShade(along, u, along * 2.0 - 1.0, vec3<f32>(s, 0.0), bmEdgeMask(edge) * contact);
}

fn bmEval(s: vec2<f32>) -> vec4<f32> {
    if (vfxBeam.uBeamMode < 0.5) { return bmEval3d(s); }
    return bmEval2d(s);
}
`;
