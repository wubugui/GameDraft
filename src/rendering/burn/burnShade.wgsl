// 燃烧场着色：burnShade.glsl 的 WGSL 译本（Pixi WebGPU 渲染器跑这份，WebGL 与燃烧工作台仍跑 GLSL）。
// 数学与 GLSL 版逐句对应——改一边必须同改另一边，再跑像素对照 tools/render_parity/cases/50_burn.ts。
// 燃烧场纹理编码、阶段划分、双线性只混阶段结果的理由，全见 burnShade.glsl 的注释，这里不重复。
//
// 本文件只放函数（WGSL 模块作用域按名引用、不看先后）。拼它的程序必须在同一模块里声明：
//   var<uniform> burnUniforms —— 成员至少含 uBurnGrid … uBurnEmberGlow（名字同 GLSL 的 uniform），
//                                 成员顺序按该程序 JS 侧 uniforms 对象的声明顺序（Pixi 按声明顺序排偏移）；
//   var uBurnField: texture_2d<f32> 与 var uBurnFieldSampler: sampler（燃烧场纹理自带的 NEAREST 采样状态）。
//
// 与 GLSL 的差别只有写法：
//   - out 参数改成 ptr<function, vec3<f32>>；
//   - 燃烧场一律 textureSampleLevel(…, 0.0)：调用点都在「覆盖度太小就提前 return」之后（非一致控制流），
//     WGSL 不许在那里用 textureSample；燃烧场是单级纹理，第 0 级就是 GLSL texture() 的结果；
//   - 三目运算改 if / else（select 两边都求值，smoothstep 两端相等那一边会出 NaN）。
// ⚠ 注释里不许写「@ + group / binding + 括号」：Pixi 按正则扫整份源码（含注释）找绑定，写了就多出一个假绑定。

const BURN_NEVER: f32 = 100000.0;

fn burnHash(p0: vec2<f32>) -> f32 {
    var p = fract(p0 * vec2<f32>(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

fn burnValueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = burnHash(i);
    let b = burnHash(i + vec2<f32>(1.0, 0.0));
    let c = burnHash(i + vec2<f32>(0.0, 1.0));
    let d = burnHash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 一个格（整数格号）的 (点着时刻, 燃料, 熄灭定格)
fn burnTexel(cell: vec2<f32>) -> vec3<f32> {
    let c = clamp(cell, vec2<f32>(0.0), burnUniforms.uBurnGrid - 1.0);
    let s = textureSampleLevel(uBurnField, uBurnFieldSampler, (c + 0.5) / burnUniforms.uBurnGrid, 0.0);
    let q = floor(s.r * 255.0 + 0.5) * 256.0 + floor(s.g * 255.0 + 0.5);
    var t = q * burnUniforms.uBurnStep;
    if (q >= 65535.0) { t = BURN_NEVER; }
    return vec3<f32>(t, s.b, s.a);
}

// 一格此刻的阶段：vec4(焦黑, 烤黄, 成灰, 不透明度倍率)，发光写进 *emit
fn burnStage(s: vec3<f32>, n: f32, uv: vec2<f32>, emit: ptr<function, vec3<f32>>) -> vec4<f32> {
    *emit = vec3<f32>(0.0);
    let tau = burnUniforms.uBurnNow - (s.x + n);
    let flameDur = max(burnUniforms.uBurnFlame * s.y, 1e-3);
    var scorch: f32;
    if (burnUniforms.uBurnScorch > 0.0) {
        scorch = smoothstep(-burnUniforms.uBurnScorch, 0.0, tau);
    } else {
        scorch = step(0.0, tau);
    }
    if (tau < 0.0) { return vec4<f32>(0.0, scorch, 0.0, 1.0); }
    // 熄灭定格：焦黑、不发光、不成灰
    if (s.z > 0.5) { return vec4<f32>(1.0, 1.0, 0.0, 1.0); }
    let charAmt = smoothstep(0.0, flameDur * 0.35, tau);
    if (tau < flameDur) {
        let rise = smoothstep(0.0, flameDur * 0.12, tau);
        let fall = sqrt(max(0.0, 1.0 - tau / flameDur));
        *emit = burnUniforms.uBurnGlow * (rise * fall);
        return vec4<f32>(charAmt, 1.0, 0.0, 1.0);
    }
    let emberEnd = flameDur + burnUniforms.uBurnEmber;
    if (tau < emberEnd) {
        let k = 1.0 - (tau - flameDur) / max(burnUniforms.uBurnEmber, 1e-3);
        let flick = 0.75 + 0.25 * burnValueNoise(uv * burnUniforms.uBurnGrid * 3.0
            + vec2<f32>(burnUniforms.uBurnNow * 1.7, burnUniforms.uBurnNow * 0.9));
        *emit = burnUniforms.uBurnEmberGlow * (k * k * flick);
        return vec4<f32>(1.0, 1.0, 0.0, 1.0);
    }
    var ash: f32 = 1.0;
    if (burnUniforms.uBurnAshFade > 0.0) {
        ash = smoothstep(emberEnd, emberEnd + burnUniforms.uBurnAshFade, tau);
    }
    return vec4<f32>(1.0, 1.0, ash, mix(1.0, burnUniforms.uBurnAshAlpha, ash));
}

// 采样燃烧场：返回 vec4(焦黑, 烤黄, 成灰, 不透明度倍率)，发光写进 *emit（线性，已乘强度）
fn burnSample(uv: vec2<f32>, emit: ptr<function, vec3<f32>>) -> vec4<f32> {
    *emit = vec3<f32>(0.0);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    let p = uv * burnUniforms.uBurnGrid - 0.5;
    let i0 = floor(p);
    let f = p - i0;
    let a = burnTexel(i0);
    let b = burnTexel(i0 + vec2<f32>(1.0, 0.0));
    let c = burnTexel(i0 + vec2<f32>(0.0, 1.0));
    let d = burnTexel(i0 + vec2<f32>(1.0, 1.0));
    let wa = (1.0 - f.x) * (1.0 - f.y) * step(0.02, a.y);
    let wb = f.x * (1.0 - f.y) * step(0.02, b.y);
    let wc = (1.0 - f.x) * f.y * step(0.02, c.y);
    let wd = f.x * f.y * step(0.02, d.y);
    let W = wa + wb + wc + wd;
    if (W < 1e-4) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    // 毛边：点着时刻按网格两倍频率的值噪声前后错开
    let n = (burnValueNoise(uv * burnUniforms.uBurnGrid * 2.0) - 0.5) * 2.0 * burnUniforms.uBurnEdgeNoise;
    var ea: vec3<f32>;
    var eb: vec3<f32>;
    var ec: vec3<f32>;
    var ed: vec3<f32>;
    let r = burnStage(a, n, uv, &ea) * wa + burnStage(b, n, uv, &eb) * wb
          + burnStage(c, n, uv, &ec) * wc + burnStage(d, n, uv, &ed) * wd;
    *emit = (ea * wa + eb * wb + ec * wc + ed * wd) / W;
    return r / W;
}

// 材质：直通色 rgb + 覆盖度 a、burnSample 的结果 b → vec4(直通色, 覆盖度)
fn burnMaterial(rgb0: vec3<f32>, a: f32, b: vec4<f32>) -> vec4<f32> {
    var rgb = mix(rgb0, rgb0 * burnUniforms.uBurnScorchColor, b.y * (1.0 - b.x));
    let lum = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
    rgb = mix(rgb, burnUniforms.uBurnCharColor * (0.6 + 0.4 * lum), b.x);
    rgb = mix(rgb, burnUniforms.uBurnAshColor * (0.8 + 0.2 * lum), b.z);
    return vec4<f32>(rgb, a * b.w);
}

// 自发光：线性发光 → 显示域加量（与受光输出同一约定）
fn burnGlowAdd(emit: vec3<f32>) -> vec3<f32> {
    return pow(max(emit, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}
