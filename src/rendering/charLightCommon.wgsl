// ============================================================================
// 角色照明公共块（CHAR_LIGHT_COMMON）—— WGSL 版（WebGPU 迁移期与 GLSL 版并存）
//
// GLSL 版住在 CharacterShadingFilter.ts 的 FRAG 里（__CLC_*__ 标记之间），仍是 WebGL 路径的
// 唯一真相源；本文件是它的逐函数移植，数学一个字不改（probe 查表吃 q 空间法线 nQ、
// skyao 走 det=+1 的 uSkyaoM、两个 M 不许混 —— 全部照 GLSL 版与坐标卡）。等价由
// tools/render_parity 的「光照片段 /」用例逐像素钉住，改一边必须同步改另一边。
//
// 【三份导出（CharacterShadingFilter.ts）】与 GLSL 一一对应：
//   · CHAR_LIGHT_COMMON_WGSL = 本文件 __CLC_*__ 之间，再把 __CHAR_SHADE_CORE_WGSL__ 那一行换成
//     charShadeCore.wgsl（GLSL 那边同一位置注入 charShadeCore.glsl）。
//   · PROBE_SAMPLING_WGSL / SKYAO_SAMPLING_WGSL = 其中的两段切片（场景光照 pass 的 GI 体 /
//     skyao 体调试视图单独拼这两段，与角色吃同一份采样数学）。
//   同一模块里每段只许拼一次（WGSL 没有预处理器，重复定义编译失败）：拼了整个 CLC 就不要再拼
//   PROBE / SKYAO。
//
// 【为什么不照 GLSL 读 uniform】GLSL 版在块里自己声明 uniform（uM、uPN、uSkyao* …），宿主只声明
//   sampler。WGSL 的 uniform 必须活在宿主的 uniform 结构里，而同一批量在各宿主里分在不同的组：
//   角色网格是 sceneShade + frameShade，粒子是 sceneShade + 自己的 frameShade，场景光照 pass
//   全在 sceneLight 一组里。块里写死任何组名 / 绑定都会把这些分叉焊死。所以：
//
//   ① 块里的函数**一个绑定都不读**：uniform 量打成下面几个值结构当形参传，纹理也当形参传
//      （只用 textureLoad，不需要采样器）。形参顺序统一为：几何实参 → 参数结构 → 纹理。
//   ② 宿主从自己的 uniform 组里**按字段名逐个赋值**建结构（别用位置构造式：一串 f32 位置
//      写错不报错），在 main 开头建一次、往下传：
//
//        var pp: ClcProbe;
//        pp.uM = sceneShade.uM;  pp.uWMin = sceneShade.uWMin;  pp.uWScale = sceneShade.uWScale;
//        pp.uPN = sceneShade.uPN;  pp.uProbeT = sceneShade.uProbeT;  pp.uShK = sceneShade.uShK;
//        pp.uBinOb = sceneShade.uBinOb;  pp.uFold = frameShade.uFold;  pp.uAmbSH = sceneShade.uAmbSH;
//        pp.uMode = frameShade.uMode;  pp.uAmbStrength = frameShade.uAmbStrength;
//        let E = probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid);
//
//      结构的字段名 = GLSL 的 uniform 名，字段顺序 = GLSL 的声明顺序；某宿主的 JS uniform 组若
//      恰好按同名同序只装这些量，也可以直接把组绑成这个结构类型（绑定变量名 = resources 键名）。
//   ③ ClcRt 带两个 48 元 vec4 数组，gatherRT 按 ptr<function, ClcRt> 收（按值传会整份拷贝；
//      宿主只在 uMode == 0 那一支里 var 一份）。
//   ④ gatherRT 的随机旋转取片元坐标：GLSL 读 gl_FragCoord，WGSL 由调用方把入口的
//      位置内建量 .xy 传进来（离屏目标上两者行序一致，对照用例钉着）。
//   ⑤ GLSL 块里声明、但只有宿主 main 读的 uniform（uWorkSize / uWorldToWork / uCal / uCosT /
//      uSinT / uBeta / uGiStrength / 三个 factor / uFixedNQ / uEChecker / uBulge / uFlatten /
//      uShowN / uEOnly / uSun* / uEChroma / uAO* / uSkyaoBlend），WGSL 块不管，宿主在自己的
//      uniform 结构里声明、main 里直接读。
//
// 【与 GLSL 的形式差异（数值不变）】
//   · mod(x, y) 写成 x − y·floor(x/y)（GLSL 定义式；WGSL 的 % 向零截断，负数不同）。
//   · texelFetch → textureLoad；GLSL 三元式一律写成 if/else（不用 select：select 两边都求值）；
//     GLSL 按布尔向量逐分量挑的 mix(a, b, bvec) 才写 select(a, b, bvec)（boxEnter，本来就两边都算）。
//   · 形参不可写：GLSL 改写形参的地方改成局部量；GLSL 局部变量名 of 在 WGSL 是保留字，改叫 ofr。
//   · 字面量与字面量的算术写成 f32 后缀，常量折叠与 GLSL 一样在 32 位里做。
//
// ⚠ Pixi 按正则从整段 WGSL 源里抽绑定声明与 struct：本文件注释里不许出现
//   「at 号 + group / binding + 括号」字样；struct 体内不许写注释（注释里的「名: 类型」会被当成成员）。
// ============================================================================

//__CLC_BEGIN__
fn srgb2lin(c: vec3<f32>) -> vec3<f32> { return mix(c / 12.92, pow((c + .055) / 1.055, vec3<f32>(2.4)), step(vec3<f32>(.04045), c)); }
fn lin2srgb(cIn: vec3<f32>) -> vec3<f32> { let c = max(cIn, vec3<f32>(0.)); return mix(c * 12.92, 1.055 * pow(c, vec3<f32>(1.f / 2.4f)) - .055, step(vec3<f32>(.0031308), c)); }
//__CHAR_SHADE_CORE_WGSL__
//__PROBE_SAMPLING_BEGIN__
// probe 采样自足块（shY / ambIrr / octaEnc / probeE …）。场景光照 pass 的「GI体」调试视图拼接
// 同一份（PROBE_SAMPLING_WGSL），与角色吃同一套采样数学 —— 改这里 = 两边同时改。
// ClcProbe 字段 = GLSL 的同名 uniform（含义见 GLSL 版声明处注释）：
//   uM = lighting.json world.M（det=−1，只给 probe 查表）；uWMin / uWScale / uPN = probe 网格；
//   uProbeT = 图集每行多少颗；uShK = l2 槽每颗系数数（9 / 25）；uBinOb = 八面体边长（8 / 16）；
//   uFold = A7 摄像机侧折叠；uAmbSH / uAmbStrength = miss 环境光；uMode = 0 RT / 1 L1 / 2 L2 / 3 BIN。
struct ClcProbe {
    uM: mat3x3<f32>,
    uWMin: vec3<f32>,
    uWScale: vec3<f32>,
    uPN: vec3<f32>,
    uProbeT: f32,
    uShK: f32,
    uBinOb: f32,
    uFold: f32,
    uAmbSH: array<vec3<f32>, 9>,
    uMode: f32,
    uAmbStrength: f32,
}

// 实球谐基 l<=4（k=0..24），与 estimators.sh_basis 逐行同值同序（改一处必须改两处）。
fn shY(k: i32, n: vec3<f32>) -> f32 {
    if (k == 0) { return .282095; }
    if (k == 1) { return .488603 * n.y; }  if (k == 2) { return .488603 * n.z; }  if (k == 3) { return .488603 * n.x; }
    if (k == 4) { return 1.092548 * n.x * n.y; } if (k == 5) { return 1.092548 * n.y * n.z; }
    if (k == 6) { return .315392 * (3. * n.z * n.z - 1.); }
    if (k == 7) { return 1.092548 * n.x * n.z; } if (k == 8) { return .546274 * (n.x * n.x - n.y * n.y); }
    let x2 = n.x * n.x;
    let y2 = n.y * n.y;
    let z2 = n.z * n.z;
    if (k == 9)  { return .590044 * n.y * (3. * x2 - y2); }
    if (k == 10) { return 2.890611 * n.x * n.y * n.z; }
    if (k == 11) { return .457046 * n.y * (5. * z2 - 1.); }
    if (k == 12) { return .373176 * n.z * (5. * z2 - 3.); }
    if (k == 13) { return .457046 * n.x * (5. * z2 - 1.); }
    if (k == 14) { return 1.445306 * n.z * (x2 - y2); }
    if (k == 15) { return .590044 * n.x * (x2 - 3. * y2); }
    if (k == 16) { return 2.503343 * n.x * n.y * (x2 - y2); }
    if (k == 17) { return 1.770131 * n.y * n.z * (3. * x2 - y2); }
    if (k == 18) { return .946175 * n.x * n.y * (7. * z2 - 1.); }
    if (k == 19) { return .669047 * n.y * n.z * (7. * z2 - 3.); }
    if (k == 20) { return .105786 * (35. * z2 * z2 - 30. * z2 + 3.); }
    if (k == 21) { return .669047 * n.x * n.z * (7. * z2 - 3.); }
    if (k == 22) { return .473087 * (x2 - y2) * (7. * z2 - 1.); }
    if (k == 23) { return 1.770131 * n.x * n.z * (x2 - 3. * y2); }
    return .625836 * (x2 * x2 - 6. * x2 * y2 + y2 * y2);
}
fn ambIrr(n: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    var A = array<f32, 9>(3.141593, 2.094395, 2.094395, 2.094395, .785398, .785398, .785398, .785398, .785398);
    var E = vec3<f32>(0.);
    for (var k = 0; k < 9; k++) { E += P.uAmbSH[k] * A[k] * shY(k, n); }
    return max(E, vec3<f32>(0.)) * P.uAmbStrength;
}
// 八面体图的接缝环绕（先 x 后 y，角落落到对角；与 estimators.octa_wrap 同一套规则）。
fn octaIdx(cIn: vec2<i32>, ob: i32) -> i32 {
    var c = cIn;
    if (c.x < 0) { c.x = 0; c.y = ob - 1 - c.y; } else if (c.x > ob - 1) { c.x = ob - 1; c.y = ob - 1 - c.y; }
    if (c.y < 0) { c.y = 0; c.x = ob - 1 - c.x; } else if (c.y > ob - 1) { c.y = ob - 1; c.x = ob - 1 - c.x; }
    return c.y * ob + c.x;
}
fn octaEnc(nIn: vec3<f32>) -> vec2<f32> {
    let n = nIn / (abs(nIn.x) + abs(nIn.y) + abs(nIn.z));
    var p = n.xy;
    if (n.z < 0.) {
        var sx = -1.;
        if (n.x >= 0.) { sx = 1.; }
        var sy = -1.;
        if (n.y >= 0.) { sy = 1.; }
        p = (1. - abs(n.yx)) * vec2<f32>(sx, sy);
    }
    return p * .5 + .5;
}
// q → probe 网格连续坐标（调试视图的棋盘格与采样共用这一份映射）。
fn probeGridT(q: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    let Xw = P.uM * q;                              // → 世界，插值轴为世界轴
    return clamp((Xw - P.uWMin) * P.uWScale, vec3<f32>(0.), P.uPN - 1.001);
}
// flat probe 索引 → 平铺图集 texel（每行 uProbeT 颗、每颗 ncol 个 texel；valid 图 ncol=1）。
fn probeTexel(flat_: i32, ncol: i32, k: i32, P: ClcProbe) -> vec2<i32> {
    let T = i32(P.uProbeT + .5);
    let r = flat_ / T;
    return vec2<i32>((flat_ - r * T) * ncol + k, r);
}
// A7（摄像机侧折叠）的 probe 版：E(n) ≈ E(折叠 n)（理由见 GLSL 版）。
fn probeQueryN(nIn: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    var n = nIn;
    if (P.uFold > .5 && n.z < 0.) { n.z = -n.z; }
    return normalize(n);
}
fn probeEvalFlat(flat_: i32, nIn: vec3<f32>, P: ClcProbe,
                 uPL1: texture_2d<f32>, uPL2: texture_2d<f32>, uPBin: texture_2d<f32>) -> vec3<f32> {
    let n = probeQueryN(nIn, P);
    let mode = i32(P.uMode + .5);
    var E = vec3<f32>(0.);
    if (mode == 1) {
        // L1 = Geomerics/Enlighten 非线性重建（与 estimators.probe_eval_l1_geomerics 逐行同一公式）
        let c0 = textureLoad(uPL1, probeTexel(flat_, 4, 0, P), 0).rgb;
        let c1 = textureLoad(uPL1, probeTexel(flat_, 4, 1, P), 0).rgb;   // y
        let c2 = textureLoad(uPL1, probeTexel(flat_, 4, 2, P), 0).rgb;   // z
        let c3 = textureLoad(uPL1, probeTexel(flat_, 4, 3, P), 0).rgb;   // x
        for (var ch = 0; ch < 3; ch++) {
            let R0 = max(c0[ch] * .282095, 1e-12);
            let R1 = .5 * .488603 * vec3<f32>(c3[ch], c1[ch], c2[ch]);
            let lenR1 = length(R1) + 1e-12;
            let q = clamp(.5 * (1. + dot(R1 / lenR1, n)), 0., 1.);
            let r = min(lenR1 / R0, .9999);
            let p = 1. + 2. * r;
            let a = (1. - r) / (1. + r);
            E[ch] = R0 * (a + (1. - a) * (p + 1.) * pow(q, p));
        }
        return E;
    } else if (mode == 2) {
        // l2 槽的列数 = uShK（L2=9 / L4=25），循环上限动态
        let K = i32(P.uShK + .5);
        for (var k = 0; k < 25; k++) { if (k >= K) { break; } E += textureLoad(uPL2, probeTexel(flat_, K, k, P), 0).rgb * shY(k, n); }
    } else {
        // 八面体分辨率由载荷 probes.bin_ob 决定（8=64 方向 / 16=256 方向）
        let ob = i32(P.uBinOb + .5);
        let B = ob * ob;
        let ouv = octaEnc(n) * f32(ob) - .5;
        let ob0 = vec2<i32>(floor(ouv));                 // 可为 -1/ob-1，越界交给 octaIdx
        let ofr = clamp(ouv - vec2<f32>(ob0), vec2<f32>(0.), vec2<f32>(1.));
        let b00 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(0, 0), ob), P);
        let b10 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(1, 0), ob), P);
        let b01 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(0, 1), ob), P);
        let b11 = probeTexel(flat_, B, octaIdx(ob0 + vec2<i32>(1, 1), ob), P);
        E = mix(mix(textureLoad(uPBin, b00, 0).rgb, textureLoad(uPBin, b10, 0).rgb, ofr.x),
                mix(textureLoad(uPBin, b01, 0).rgb, textureLoad(uPBin, b11, 0).rgb, ofr.x), ofr.y);
    }
    return max(E, vec3<f32>(0.));
}
// 查询点沿法线偏 0.525 × 最小格距（DDGI self-shadow bias 的 N 项；与 const.PROBE_QUERY_NORMAL_BIAS 同值）。
fn probeE(q: vec3<f32>, n: vec3<f32>, P: ClcProbe,
          uPL1: texture_2d<f32>, uPL2: texture_2d<f32>, uPBin: texture_2d<f32>, uValid: texture_2d<f32>) -> vec3<f32> {
    let cellMin = min(min(1. / P.uWScale.x, 1. / P.uWScale.y), 1. / P.uWScale.z);
    let t = probeGridT(q + n * (0.525 * cellMin), P);
    let b0 = vec3<i32>(t);
    let f = t - vec3<f32>(b0);
    var wsum = 0.;
    var Esum = vec3<f32>(0.);
    let pn = vec3<i32>(P.uPN + .5);
    for (var c = 0; c < 8; c++) {
        let off = vec3<i32>(c & 1, (c >> 1u) & 1, (c >> 2u) & 1);
        let pi = min(b0 + off, pn - 1);
        var w = mix(1. - f.x, f.x, f32(off.x)) * mix(1. - f.y, f.y, f32(off.y)) * mix(1. - f.z, f.z, f32(off.z));
        let flat_ = pi.x * (pn.y * pn.z) + pi.y * pn.z + pi.z;
        w *= step(.002, textureLoad(uValid, probeTexel(flat_, 1, 0, P), 0).r);
        if (w < 1e-5) { continue; }
        Esum += probeEvalFlat(flat_, n, P, uPL1, uPL2, uPBin) * w;
        wsum += w;
    }
    if (wsum < 1e-4) { return ambIrr(n, P); }
    return Esum / wsum;
}
// 最近邻原始值（场景调试视图「无插值」档）；invalid 格刻意亮品红。
fn probeENearest(q: vec3<f32>, n: vec3<f32>, P: ClcProbe,
                 uPL1: texture_2d<f32>, uPL2: texture_2d<f32>, uPBin: texture_2d<f32>, uValid: texture_2d<f32>) -> vec3<f32> {
    let t = probeGridT(q, P);
    let pn = vec3<i32>(P.uPN + .5);
    let pi = min(vec3<i32>(t + .5), pn - 1);
    let flat_ = pi.x * (pn.y * pn.z) + pi.y * pn.z + pi.z;
    if (textureLoad(uValid, probeTexel(flat_, 1, 0, P), 0).r < .002) { return vec3<f32>(1., 0., 1.); }
    return probeEvalFlat(flat_, n, P, uPL1, uPL2, uPBin);
}
//__PROBE_SAMPLING_END__

// ---- 体素卷：平铺 2D 图集上的手写三线性（≡ GL LINEAR + CLAMP_TO_EDGE 3D）----
// ClcVol 字段 = GLSL 的同名 uniform：uVolN = 体素维度（float），uVolTiles = Z 切片平铺列数/行数，
// uQMin / uQMax = 体素盒的 q 范围（gatherRT 用）。
struct ClcVol {
    uVolN: vec3<f32>,
    uVolTiles: vec2<f32>,
    uQMin: vec3<f32>,
    uQMax: vec3<f32>,
}
fn volTap(t: texture_2d<f32>, xi: f32, yi: f32, zi: f32, V: ClcVol) -> vec4<f32> {
    let tx = zi - V.uVolTiles.x * floor(zi / V.uVolTiles.x);   // GLSL mod(zi, uVolTiles.x)
    let ty = floor(zi / V.uVolTiles.x);
    return textureLoad(t, vec2<i32>(i32(tx * V.uVolN.x + xi), i32(ty * V.uVolN.y + yi)), 0);
}
fn sampleVol3(t: texture_2d<f32>, c01: vec3<f32>, V: ClcVol) -> vec4<f32> {
    let vp = c01 * V.uVolN - 0.5;
    let v0 = floor(vp);
    let f = clamp(vp - v0, vec3<f32>(0.0), vec3<f32>(1.0));
    let x0 = clamp(v0.x, 0.0, V.uVolN.x - 1.0);
    let x1 = clamp(v0.x + 1.0, 0.0, V.uVolN.x - 1.0);
    let y0 = clamp(v0.y, 0.0, V.uVolN.y - 1.0);
    let y1 = clamp(v0.y + 1.0, 0.0, V.uVolN.y - 1.0);
    let z0 = clamp(v0.z, 0.0, V.uVolN.z - 1.0);
    let z1 = clamp(v0.z + 1.0, 0.0, V.uVolN.z - 1.0);
    let c000 = volTap(t, x0, y0, z0, V); let c100 = volTap(t, x1, y0, z0, V);
    let c010 = volTap(t, x0, y1, z0, V); let c110 = volTap(t, x1, y1, z0, V);
    let c001 = volTap(t, x0, y0, z1, V); let c101 = volTap(t, x1, y0, z1, V);
    let c011 = volTap(t, x0, y1, z1, V); let c111 = volTap(t, x1, y1, z1, V);
    let a = mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y);
    let b = mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y);
    return mix(a, b, f.z);
}

// ================================ skyao probe：天穹遮蔽，乘在 GI 上 =========
// ⚠⚠ 坐标系不是 uM：矩是用 depthConfig.M.R（det=+1）烘的，所以单独走 uSkyaoM（两个 M 不许混）。
// ⚠ 必须除 cap0，与场景侧 skyvis.png 的口径相反（理由见 GLSL 版）。
//__SKYAO_SAMPLING_BEGIN__
// ClcSkyao 字段 = GLSL 的同名 uniform：uSkyaoN = 网格维度；uSkyaoTiles = Z 切片平铺；
// uSkyaoMin / uSkyaoScale = 世界 AABB 下角与 1/尺寸（det=+1 世界系）；uSkyaoM = q → 世界（det=+1）；
// uSkyaoOn = 0 没有载荷、恒不遮蔽。uSkyaoBlend 只有宿主 main 读，不在这里。
struct ClcSkyao {
    uSkyaoN: vec3<f32>,
    uSkyaoTiles: vec2<f32>,
    uSkyaoMin: vec3<f32>,
    uSkyaoScale: vec3<f32>,
    uSkyaoM: mat3x3<f32>,
    uSkyaoOn: f32,
}
fn skyaoTap(xi: f32, yi: f32, zi: f32, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec4<f32> {
    let tx = zi - S.uSkyaoTiles.x * floor(zi / S.uSkyaoTiles.x);   // GLSL mod(zi, uSkyaoTiles.x)
    let ty = floor(zi / S.uSkyaoTiles.x);
    return textureLoad(uSkyaoTex, vec2<i32>(i32(tx * S.uSkyaoN.x + xi),
                                            i32(ty * S.uSkyaoN.y + yi)), 0);
}
fn sampleSkyao(c01: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec4<f32> {
    // ⚠ 节点口径：烘焙格点是 linspace(x0,x1,n)（端点在盒边界），不是体素卷的格心口径。
    let vp = c01 * (S.uSkyaoN - 1.0);
    let v0 = floor(vp);
    let f = clamp(vp - v0, vec3<f32>(0.0), vec3<f32>(1.0));
    let lo = clamp(v0, vec3<f32>(0.), S.uSkyaoN - 1.0);
    let hi = clamp(v0 + 1.0, vec3<f32>(0.), S.uSkyaoN - 1.0);
    // 平铺图集手写三线性：硬件过滤会跨 Z 切片串色
    let c000 = skyaoTap(lo.x, lo.y, lo.z, S, uSkyaoTex); let c100 = skyaoTap(hi.x, lo.y, lo.z, S, uSkyaoTex);
    let c010 = skyaoTap(lo.x, hi.y, lo.z, S, uSkyaoTex); let c110 = skyaoTap(hi.x, hi.y, lo.z, S, uSkyaoTex);
    let c001 = skyaoTap(lo.x, lo.y, hi.z, S, uSkyaoTex); let c101 = skyaoTap(hi.x, lo.y, hi.z, S, uSkyaoTex);
    let c011 = skyaoTap(lo.x, hi.y, hi.z, S, uSkyaoTex); let c111 = skyaoTap(hi.x, hi.y, hi.z, S, uSkyaoTex);
    let a = mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y);
    let b = mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y);
    return mix(a, b, f.z);
}
/** q 空间位置 + q 空间法线 → 天穹遮蔽 V ∈ [0,1]。无载荷时恒 1（不遮蔽）。 */
fn skyaoAt(q: vec3<f32>, n: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> f32 {
    if (S.uSkyaoOn < 0.5) { return 1.0; }
    let Xw = S.uSkyaoM * q;                                   // q → 世界（det=+1 那套）
    let c01 = clamp((Xw - S.uSkyaoMin) * S.uSkyaoScale, vec3<f32>(0.0), vec3<f32>(1.0));
    let m = sampleSkyao(c01, S, uSkyaoTex);
    let nw = normalize(S.uSkyaoM * n);
    let cap = max((1.0 + nw.y) * 0.5, 1.0f / 255.0f);          // 无遮挡时的解析上限
    return clamp((m.x + dot(m.yzw, nw)) / cap, 0.0, 1.0);
}
//__SKYAO_SAMPLING_END__
/** 临时诊断（uShowN==3）：把查表落点画成盒内归一化坐标 RGB。 */
fn skyaoBox(q: vec3<f32>, S: ClcSkyao) -> vec3<f32> {
    if (S.uSkyaoOn < 0.5) { return vec3<f32>(1.0, 0.0, 1.0); }           // 品红 = 根本没载荷
    return clamp((S.uSkyaoM * q - S.uSkyaoMin) * S.uSkyaoScale, vec3<f32>(0.0), vec3<f32>(1.0));
}
/** 临时诊断（uShowN==5）：把 V 编成色带。红<0.15 橙<0.35 黄<0.55 绿<0.75 蓝>=0.75 */
fn skyaoBand(q: vec3<f32>, n: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec3<f32> {
    if (S.uSkyaoOn < 0.5) { return vec3<f32>(1.0, 0.0, 1.0); }
    let v = skyaoAt(q, n, S, uSkyaoTex);
    if (v < 0.15) { return vec3<f32>(1.0, 0.0, 0.0); }
    if (v < 0.35) { return vec3<f32>(1.0, 0.45, 0.0); }
    if (v < 0.55) { return vec3<f32>(1.0, 1.0, 0.0); }
    if (v < 0.75) { return vec3<f32>(0.0, 1.0, 0.0); }
    return vec3<f32>(0.0, 0.55, 1.0);
}
/** 临时诊断（uShowN==4）：把采样到的原始矩 a0 画成灰度。 */
fn skyaoRaw(q: vec3<f32>, S: ClcSkyao, uSkyaoTex: texture_2d<f32>) -> vec3<f32> {
    if (S.uSkyaoOn < 0.5) { return vec3<f32>(1.0, 0.0, 1.0); }
    let m = sampleSkyao(clamp((S.uSkyaoM * q - S.uSkyaoMin) * S.uSkyaoScale, vec3<f32>(0.0), vec3<f32>(1.0)), S, uSkyaoTex);
    return vec3<f32>(m.x);
}

fn ambRad(d: vec3<f32>, P: ClcProbe) -> vec3<f32> {
    let m = vec3<f32>(d.xy, abs(d.z));
    var L = vec3<f32>(0.);
    for (var k = 0; k < 9; k++) { L += P.uAmbSH[k] * shY(k, m); }
    return max(L, vec3<f32>(0.)) * P.uAmbStrength;
}
fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 射线-体素盒求交：把起点推进到盒入口（与实验室 pipeline._ray_box_enter 同式）。
// 返回 x = 进盒距离，y < 0 = 这条射线进不去。
fn boxEnter(p0: vec3<f32>, dn: vec3<f32>, hi: vec3<f32>) -> vec2<f32> {
    let d = select(dn, vec3<f32>(1e-6), abs(dn) < vec3<f32>(1e-6));
    let t0 = (vec3<f32>(0.) - p0) / d;
    let t1 = (hi - p0) / d;
    let lo3 = min(t0, t1);
    let hi3 = max(t0, t1);
    let tn = max(0., max(max(lo3.x, lo3.y), lo3.z));
    return vec2<f32>(tn, min(min(hi3.x, hi3.y), hi3.z) - tn);
}

// ClcRt 字段 = GLSL 的同名 uniform：uSpp / uMSteps = 每像素射线数 / 每射线步数；uMissMode（0 = miss 记
// J̄×强度，1 = 不计入再归一）；uNEE（1 = 灯走下面的确定性直射）；uStep = 步长（体素单位）；
// uLightCount / uLightQ / uLightE = 烘焙期反解的光源 surfel（q 位置 + 面积 / 发光辐射）。
struct ClcRt {
    uSpp: f32,
    uMSteps: f32,
    uMissMode: f32,
    uNEE: f32,
    uStep: f32,
    uLightCount: f32,
    uLightQ: array<vec4<f32>, 48>,
    uLightE: array<vec4<f32>, 48>,
}
// RT gather（uMode == 0 的诊断档）。fragCoord = 入口的位置内建量 .xy（GLSL 读 gl_FragCoord.xy）。
fn gatherRT(q0: vec3<f32>, n: vec3<f32>, fragCoord: vec2<f32>, P: ClcProbe, V: ClcVol, R: ptr<function, ClcRt>,
            uVolRad: texture_2d<f32>, uVolEmit: texture_2d<f32>) -> vec3<f32> {
    let spp = i32((*R).uSpp + .5);
    let msteps = i32((*R).uMSteps + .5);
    let lightCount = i32((*R).uLightCount + .5);
    var tRaw: vec3<f32>;
    if (abs(n.z) < .95) { tRaw = cross(n, vec3<f32>(0., 0., 1.)); } else { tRaw = cross(n, vec3<f32>(1., 0., 0.)); }
    let t = normalize(tRaw);
    let b = cross(n, t);
    let scaleIdx = vec3<f32>(V.uVolN - 1.) / max(V.uQMax - V.uQMin, vec3<f32>(1e-5));
    let invN = 1. / V.uVolN;
    let p0 = (q0 - V.uQMin) * scaleIdx;
    let rot = hash12(fragCoord) * 6.2831853;
    let GA = 2.399963;
    var acc = vec3<f32>(0.);
    var nHit = 0.;
    for (var i = 0; i < 192; i++) {
        if (i >= spp) { break; }
        let u1 = (f32(i) + .5) / f32(spp);
        let ph = f32(i) * GA + rot;
        let r = sqrt(u1);
        let ld = vec3<f32>(r * cos(ph), r * sin(ph), sqrt(max(0., 1. - u1)));
        var dir = normalize(t * ld.x + b * ld.y + n * ld.z);
        if (P.uFold > .5 && dir.z < 0.) { dir.z = -dir.z; }      // A7：摄像机侧折叠进观测半空间
        let dn = normalize(dir * scaleIdx);
        let dIdx = dn * (*R).uStep;
        let be = boxEnter(p0, dn, V.uVolN - 1.);
        var hit = false;
        var Li = vec3<f32>(0.);
        if (be.y < 0.) {                                           // 进不去体素盒 → 当 miss 记账
            if ((*R).uMissMode < .5) { acc += ambRad(dir, P); }
            continue;
        }
        var p = p0 + dn * be.x + dIdx * 1.5;                       // 先推进到入口，再留 1.5 步自碰撞余量
        for (var s = 0; s < 256; s++) {
            if (s >= msteps) { break; }
            p += dIdx;
            if (any(p < vec3<f32>(0.)) || any(p > V.uVolN - 1.)) { break; }
            let v = sampleVol3(uVolRad, (p + .5) * invN, V);
            if (v.a > .45) {
                Li = v.rgb;                                        // base only（画作）
                if ((*R).uNEE < .5) { Li += sampleVol3(uVolEmit, (p + .5) * invN, V).rgb; }   // NEE 关：emit 走射线
                hit = true;
                break;
            }
        }
        if (hit) { acc += Li; nHit += 1.; }
        else if ((*R).uMissMode < .5) { acc += ambRad(dir, P); }   // J̄ × 强度（0 = miss 记黑）
    }
    var E: vec3<f32>;
    if ((*R).uMissMode > .5) { E = acc * (3.14159265 / max(nHit, 1.)); } else { E = acc * (3.14159265 / f32(spp)); }
    if ((*R).uNEE > .5) {
        // 精确确定性直射：遍历全部光源 surfel + 阴影 march（各向同性，无发射端余弦）
        for (var i = 0; i < 48; i++) {
            if (i >= lightCount) { break; }
            let lq = (*R).uLightQ[i].xyz;
            let dl = lq - q0;
            let r2 = max(dot(dl, dl), 0.04);
            let r = sqrt(r2);
            let d = dl / r;
            let cr = max(dot(n, d), 0.);
            if (cr <= 0.) { continue; }
            let pi0 = (q0 - V.uQMin) * scaleIdx;
            let pi1 = (lq - V.uQMin) * scaleIdx;
            let dli = pi1 - pi0;
            let li_ = length(dli);
            let sd = dli / max(li_, 1e-5) * 1.6;
            let nst = max((li_ - 1.8) / 1.6, 0.);
            var p = pi0 + sd * 1.2;
            var vis = 1.;
            for (var s = 0; s < 160; s++) {
                if (f32(s) >= nst) { break; }
                p += sd;
                if (any(p < vec3<f32>(0.)) || any(p > V.uVolN - 1.)) { break; }
                if (sampleVol3(uVolRad, (p + .5) * (1. / V.uVolN), V).a > .45) { vis = 0.; break; }
            }
            E += (*R).uLightE[i].rgb * (vis * cr * (*R).uLightQ[i].w / r2);
        }
    }
    return E;
}

//__CLC_END__
