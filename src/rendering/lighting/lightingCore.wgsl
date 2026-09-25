// ============================================================================
// 统一光影系统 · 光照核心 —— WGSL 版（WebGPU 迁移期与 lightingCore.glsl 并存）
//
// 本文件是 lightingCore.glsl 的**逐函数等价移植**，数学一个字不改（铁律 0：一切光照在
// 世界空间、单位 wu，函数只吃世界量；本文件不做任何空间换算）。GLSL 版仍是 WebGL 路径
// 的唯一真相源；两边的等价由 tools/render_parity 的「光照片段 /」用例逐像素钉住，
// 改一边必须同步改另一边并重跑对照。
//
// 【怎么拼】与 GLSL 同一套切片标记，vite ?raw 引入，同一行切片器：
//
//     import LC_WGSL_SRC from './lighting/lightingCore.wgsl?raw';
//     import WR_WGSL_SRC from './lighting/worldReconstruct.wgsl?raw';
//     const WR_CORE_WGSL = slice(WR_WGSL_SRC, 'WR_CORE');
//     const LC_WGSL      = slice(LC_WGSL_SRC, 'LIGHTING_CORE');
//     const src = 宿主的 struct / 绑定声明 + WR_CORE_WGSL + LC_WGSL + 入口函数;
//
//   · 本段**一个 uniform / 绑定都不读**：全部输入走形参，宿主怎么分组、怎么起名都行，
//     本文件不要求宿主声明任何东西。
//   · lcMarchVisibility 调 WR_CORE 的 wrQToPixel / wrDecodeSceneDepth，所以 WR_CORE 必须
//     一起拼进同一个模块（WGSL 模块级声明与顺序无关，前后都行；GLSL 那边要求 WR 在前）。
//   · WGSL 没有预处理器：GLSL 的 include guard 在这里没有对应物，**同一模块只许拼一次**，
//     拼两次是重复定义、编译失败。
//
// 【与 GLSL 的形式差异（数值不变）】
//   · LC_POINT … LC_LINE 是 i32 常量（GLSL 是 #define）；灯种判断照写 kind == LC_POINT。
//   · lcMarchVisibility 的深度图多一个 sampler 形参（WGSL 纹理与采样器分开），
//     采样用 textureSampleLevel(…, 0.0)：它能在循环 / 分支里调，且对单级纹理与 GLSL
//     的 texture() 等价（本项目运行时纹理都是单级）。
//   · 形参不可写：GLSL 里改写形参的地方（lcLinearToSrgb 的 x）改成局部量，式子不变。
//   · GLSL 的三元式一律写成 if/else（不用 select：select 两边都求值，照 GLSL 的控制流写更稳）。
//   · 字面量与字面量的算术（1.0 / 2.4 这类）写成 f32 后缀，让常量折叠与 GLSL 一样在
//     32 位里做，避免 1 ulp 的折叠差。
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件（以及任何会被拼进着色器的
//   WGSL 片段）的注释里不许出现「at 号 + group / binding + 括号」字样，struct 体内不许写注释。
// ============================================================================

//__LIGHTING_CORE_BEGIN__

const LC_PI: f32 = 3.14159265358979323846;
const LC_LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

// ---------------------------------------------------------------- 光源类型
// 与 LightDef.kind 对应：0=point 1=spot 2=area 3=directional 4=line
const LC_POINT: i32 = 0;
const LC_SPOT: i32 = 1;
const LC_AREA: i32 = 2;
const LC_DIRECTIONAL: i32 = 3;
const LC_LINE: i32 = 4;

// ---------------------------------------------------------------- 衰减
// 物理 1/r² + 有限作用半径的高斯截断（截断的理由见 GLSL 版同名函数）。
fn lcFalloff(r2: f32, range: f32, softening: f32) -> f32 {
    let cut = exp(-r2 / max(range * range, 1e-6));
    return cut / (r2 + softening);
}

// ---------------------------------------------------------------- 点光
fn lcPointLight(P: vec3<f32>, N: vec3<f32>, lightPos: vec3<f32>, color: vec3<f32>,
                intensity: f32, range: f32, softening: f32, vis: f32) -> vec3<f32> {
    let v = lightPos - P;
    let r2 = dot(v, v);
    let ndl = max(dot(N, v * inverseSqrt(max(r2, 1e-12))), 0.0);
    return color * (intensity * ndl * lcFalloff(r2, range, softening) * vis);
}

// ---------------------------------------------------------------- 聚光
// spotDir 指向光**射出**的方向；cosInner/cosOuter 为锥体余弦（inner > outer）。
fn lcSpotLight(P: vec3<f32>, N: vec3<f32>, lightPos: vec3<f32>, spotDir: vec3<f32>, color: vec3<f32>,
               intensity: f32, range: f32, softening: f32,
               cosInner: f32, cosOuter: f32, vis: f32) -> vec3<f32> {
    let v = lightPos - P;
    let r2 = dot(v, v);
    let L = v * inverseSqrt(max(r2, 1e-12));
    // 锥角过渡按规范定义的式子展开写:WGSL 内建 smoothstep 与 GLSL 内建差几个 ulp(SwiftShader 实测),
    // 锥边附近会被放大成可见的半精度差;展开式两边逐位一致(对照「场景光照 /」「光照片段 /」)
    let coneT = clamp((dot(-L, normalize(spotDir)) - cosOuter) / (cosInner - cosOuter), 0.0, 1.0);
    let cone = coneT * coneT * (3.0 - 2.0 * coneT);
    if (cone <= 0.0) { return vec3<f32>(0.0); }
    let ndl = max(dot(N, L), 0.0);
    return color * (intensity * ndl * cone * lcFalloff(r2, range, softening) * vis);
}

// ---------------------------------------------------------------- 面光（矩形）
// Lambert 多边形辐照度闭式解，零采样（推导与绕向说明见 GLSL 版）。
// 返回**带符号**值：正 = 着色点在多边形正面；钳位交给 lcAreaLight。
fn lcRectIrradiance(P: vec3<f32>, N: vec3<f32>, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32>, v3: vec3<f32>) -> f32 {
    let p0 = normalize(v0 - P);
    let p1 = normalize(v1 - P);
    let p2 = normalize(v2 - P);
    let p3 = normalize(v3 - P);

    var sum = 0.0;
    var ax: vec3<f32>;
    var ln: f32;

    ax = cross(p0, p1); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p0, p1), -1.0, 1.0)) * dot(ax / ln, N); }
    ax = cross(p1, p2); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p1, p2), -1.0, 1.0)) * dot(ax / ln, N); }
    ax = cross(p2, p3); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p2, p3), -1.0, 1.0)) * dot(ax / ln, N); }
    ax = cross(p3, p0); ln = length(ax);
    if (ln > 1e-6) { sum += acos(clamp(dot(p3, p0), -1.0, 1.0)) * dot(ax / ln, N); }

    return sum * (0.5 / LC_PI);
}

// 面光的四个角由中心 + 两条半轴给出（半轴已是世界单位向量）。
// ⚠ 顶点绕向「从正面看逆时针」，与 GLSL 版逐字相同（绕反了会照亮错误的一侧）。
fn lcAreaLight(P: vec3<f32>, N: vec3<f32>, center: vec3<f32>, halfU: vec3<f32>, halfV: vec3<f32>,
               color: vec3<f32>, intensity: f32, range: f32, twoSided: bool, vis: f32) -> vec3<f32> {
    let d = center - P;
    let r2 = dot(d, d);
    let cut = exp(-r2 / max(range * range, 1e-6));
    if (cut < 1e-4) { return vec3<f32>(0.0); }
    if (!twoSided) {
        let n = normalize(cross(halfU, halfV));
        if (dot(n, -d) <= 0.0) { return vec3<f32>(0.0); }
    }
    var E = lcRectIrradiance(P, N,
                             center - halfU - halfV,
                             center - halfU + halfV,
                             center + halfU + halfV,
                             center + halfU - halfV);
    // 双面取绝对值；单面只剩 horizon clip 的数值残差，钳掉
    if (twoSided) { E = abs(E); } else { E = max(E, 0.0); }
    return color * (intensity * E * cut * vis);
}

// ---------------------------------------------------------------- 线光（落雷那一道雷身，只给运行时灯用）
// 从 a 到 a + seg 的均匀发光线：Lambert × 1/(r² + 软化) 沿线的闭式积分（推导见 GLSL 版）。
fn lcLineLight(P: vec3<f32>, N: vec3<f32>, a: vec3<f32>, seg: vec3<f32>, color: vec3<f32>,
               intensity: f32, range: f32, softening: f32, vis: f32) -> vec3<f32> {
    let len = length(seg);
    if (len < 1e-3) { return lcPointLight(P, N, a, color, intensity, range, softening, vis); }
    let u = seg / len;
    let w = a - P;
    let s0 = dot(w, u);
    let perp = w - s0 * u;
    let b2 = dot(perp, perp) + softening;
    let s1 = s0 + len;
    let r0 = inverseSqrt(s0 * s0 + b2);
    let r1 = inverseSqrt(s1 * s1 + b2);
    let I = (dot(N, perp) / b2) * (s1 * r1 - s0 * r0) - dot(N, u) * (r1 - r0);
    let nearest = w + clamp(-s0, 0.0, len) * u;
    let cut = exp(-dot(nearest, nearest) / max(range * range, 1e-6));
    return color * (intensity / len * max(I, 0.0) * cut * vis);
}

// ---------------------------------------------------------------- 平行光（日/月）
fn lcDirectionalLight(N: vec3<f32>, toLight: vec3<f32>, color: vec3<f32>, intensity: f32, vis: f32) -> vec3<f32> {
    return color * (intensity * max(dot(N, normalize(toLight)), 0.0) * vis);
}

// ---------------------------------------------------------------- 天光
// ⚠ 本函数已含半球项，调用方不要再乘一遍（见 GLSL 版）。
fn lcSkyLight(color: vec3<f32>, intensity: f32, skyvis: f32, hemi: f32, aoStrength: f32) -> vec3<f32> {
    let v = mix(1.0, clamp(skyvis, 0.0, 1.0), clamp(aoStrength, 0.0, 1.0));
    return color * (intensity * ((1.0 - hemi) + hemi * v));
}

// ---------------------------------------------------------------- 阴影 march
// 沿光线在**伪世界 q 空间**里 march 深度场（march 是 q 空间的三类豁免之一，见坐标卡）。
// 依赖 WR_CORE 的 wrQToPixel / wrDecodeSceneDepth。返回 [0,1]：1 = 未被挡。
fn lcMarchVisibility(depthTex: texture_2d<f32>, depthSmp: sampler, depthTexSize: vec2<f32>,
                     ppu: f32, cx: f32, cy: f32,
                     invert: f32, dScale: f32, dOffset: f32,
                     q0: vec3<f32>, dirQ: vec3<f32>, steps: i32, marchLen: f32,
                     bias0: f32, thick: f32) -> f32 {
    let st = marchLen / f32(max(steps, 1));
    for (var i = 1; i <= 128; i++) {
        if (i > steps) { break; }                  // 与 GLSL 同一个常量上界 + 提前 break
        let q = q0 + dirQ * (st * f32(i));
        let px = wrQToPixel(q, ppu, cx, cy);
        let uv = px / depthTexSize;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { continue; }
        let ds = wrDecodeSceneDepth(textureSampleLevel(depthTex, depthSmp, uv, 0.0), invert, dScale, dOffset);
        let pen = q.z - ds;
        let bias = bias0 + 0.02 * st * f32(i);
        if (pen > bias && pen < thick) { return 0.0; }
    }
    return 1.0;
}

// ---------------------------------------------------------------- 高度雾
// 正交相机 ⇒ 每像素视线方向恒定 ⇒ 指数高度雾有闭式解（推导见 GLSL 版）。
fn lcOpticalDepth(dist: f32, yCam: f32, ySurf: f32,
                  sigma0: f32, scaleH: f32, baseY: f32) -> f32 {
    let H = max(scaleH, 1e-4);
    let a = exp(-(yCam - baseY) / H);
    let b = exp(-(ySurf - baseY) / H);
    let dy = ySurf - yCam;
    if (abs(dy) < 1e-5) { return sigma0 * a * dist; }
    return sigma0 * dist * (a - b) * H / dy;
}

// 应用雾：透射 T 混合场景色与散射色。场景与角色吃同一组参数、各用自己的深度。
fn lcApplyFog(lin: vec3<f32>, opticalDepth: f32, scatterColor: vec3<f32>) -> vec3<f32> {
    let T = exp(-max(opticalDepth, 0.0));
    return lin * T + scatterColor * (1.0 - T);
}

// ---------------------------------------------------------------- 显示变换
// 顺序固定：曝光 → tonemap → 白平衡 → 饱和 → 对比 → 暗部提升 → sRGB。
// ⚠ 显示变换绝不能烤进辐射场（见 GLSL 版）。
fn lcTonemap(x: vec3<f32>, mode: i32) -> vec3<f32> {
    if (mode == 1) {                     // reinhard
        return x / (1.0 + x);
    } else if (mode == 2) {              // filmic（ACES 近似，Narkowicz）
        let v = x * 0.6;
        return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    return x;                            // none
}

fn lcLinearToSrgb(xIn: vec3<f32>) -> vec3<f32> {
    let x = clamp(xIn, vec3<f32>(0.0), vec3<f32>(1.0));
    return mix(x * 12.92, 1.055 * pow(x, vec3<f32>(1.0f / 2.4f)) - 0.055,
               step(vec3<f32>(0.0031308), x));
}

fn lcSrgbToLinear(x: vec3<f32>) -> vec3<f32> {
    return mix(x / 12.92, pow((x + 0.055) / 1.055, vec3<f32>(2.4)),
               step(vec3<f32>(0.04045), x));
}

fn lcDisplayTransform(lin: vec3<f32>, ev: f32, tonemapMode: i32, whiteBalance: vec3<f32>,
                      saturation: f32, contrast: f32,
                      lift: f32, liftColor: vec3<f32>) -> vec3<f32> {
    var c = lin * exp2(ev);
    c = lcTonemap(c, tonemapMode);
    c *= whiteBalance;
    if (saturation != 1.0) {
        let l = dot(c, LC_LUMA);
        c = vec3<f32>(l) + (c - vec3<f32>(l)) * saturation;
    }
    if (contrast != 1.0) {
        c = 0.18 * pow(max(c, vec3<f32>(0.0)) / 0.18, vec3<f32>(contrast));
    }
    if (lift > 0.0) {
        let l = dot(c, LC_LUMA);
        c += liftColor * (lift * 0.08 * exp(-l / 0.06));
    }
    return lcLinearToSrgb(c);
}

// ---------------------------------------------------------------- 场景重打光（已停用路径的遗留函数，照搬）
fn lcRelightScene(paintingLinear: vec3<f32>, sDay: vec3<f32>, sNew: vec3<f32>, ratioMax: f32) -> vec3<f32> {
    let ratio = clamp(sNew / max(sDay, vec3<f32>(1e-4)), vec3<f32>(0.0), vec3<f32>(ratioMax));
    return paintingLinear * ratio;
}

//__LIGHTING_CORE_END__
