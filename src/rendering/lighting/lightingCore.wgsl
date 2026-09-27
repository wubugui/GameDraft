// ============================================================================
// 统一光影系统 · 光照核心（单一真相源）
//
// 本文件是 S(L, 几何) 的**唯一**实现，被多方共用：场景光照 pass（逐像素，写进缓存 RT）、
// 背景合成、角色着色（filter 与 mesh 两条路径）、粒子受光。一份 WGSL 字符串拼进各 shader，
// 消灭镜像漂移——改这里 = 各处同时改，这正是要的。与 master（GLSL 版 lightingCore.glsl）
// 逐像素一致由 tools/render_parity 的「光照片段 /」「场景光照 /」用例钉住，改了必须重跑对照。
//
// ⚠ 铁律 0（制作人 2026-08-30）：**一切光照在世界空间算**（M-world、单位 wu）。本段函数只吃世界量，
//   不做任何空间换算；q 空间的量必须先转到世界空间再喂进来（坐标卡）。唯一例外是阴影 march：
//   沿深度场行进本来就在伪世界 q 空间（坐标卡列的三类豁免之一）。
//
// ⚠ 色温→RGB 在 CPU 侧算好后以 uniform 传入（避免 shader 里的 log/pow）。
//
// 约定：
//   - 一切颜色量在**线性**空间；显示变换是流水线最后一步，且同时作用于场景与角色。
//   - 距离量一律 **wu**，进出都不换算（本项目只有这一个空间单位）
//     （世界单位是逐场景的，实测 1 wu 在不同场景是 2.0–10.0 m）。
//   - 点光/聚光的 intensity 进来时必须已是 **wu 强度**（作者面相对 q 定义，
//     打包处折 I_q × wuPerQUnit²，见 lightPacking.pointIntensityWu）：1/r² 的 r 是 wu，
//     强度的尺必须跟它走。面光的 intensity 是辐亮度、平行光的是照度，与长度单位无关，原样。
//
// 【怎么拼】vite ?raw 引入，切片（wgslChunks.ts 已切好 LC_WGSL / WR_CORE_WGSL）：
//
//     const src = 宿主的 struct / 绑定声明 + WR_CORE_WGSL + LC_WGSL + 入口函数;
//
//   · 本段**一个 uniform / 绑定都不读**：全部输入走形参，宿主怎么分组、怎么起名都行，
//     本文件不要求宿主声明任何东西。
//   · lcMarchVisibility 调 WR_CORE 的 wrQToPixel / wrDecodeSceneDepth，所以 WR_CORE 必须
//     一起拼进同一个模块（WGSL 模块级声明与顺序无关，前后都行）。
//   · WGSL 没有预处理器、没有 include guard：**同一模块只许拼一次**，拼两次是重复定义、编译失败。
//
// 【写法约束（与 master 的 GLSL 版数值不变）】
//   · lcMarchVisibility 的深度图多一个 sampler 形参（纹理与采样器分开），
//     采样用 textureSampleLevel(…, 0.0)：它能在循环 / 分支里调，对单级纹理等价于隐式 LOD
//     （本项目运行时纹理都是单级）。
//   · 形参不可写：改写形参的地方（lcLinearToSrgb 的 x）用局部量，式子不变。
//   · 三元式一律写成 if/else（不用 select：select 两边都求值）。
//   · 字面量与字面量的算术（1.0 / 2.4 这类）写成 f32 后缀，让常量折叠在 32 位里做，避免 1 ulp 的折叠差。
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
// 物理 1/r² + 有限作用半径的高斯截断。
// 截断是必须的：没有它，夜景里一盏灯会把整张图都染暖（实测过）。
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
    // 锥角过渡按规范定义的式子展开写:WGSL 内建 smoothstep 与 master 的 GLSL 内建差几个 ulp(SwiftShader 实测),
    // 锥边附近会被放大成可见的半精度差;展开式两边逐位一致(对照「场景光照 /」「光照片段 /」)
    let coneT = clamp((dot(-L, normalize(spotDir)) - cosOuter) / (cosInner - cosOuter), 0.0, 1.0);
    let cone = coneT * coneT * (3.0 - 2.0 * coneT);
    if (cone <= 0.0) { return vec3<f32>(0.0); }
    let ndl = max(dot(N, L), 0.0);
    return color * (intensity * ndl * cone * lcFalloff(r2, range, softening) * vis);
}

// ---------------------------------------------------------------- 面光（矩形）
// **Lambert 的闭式解，零采样**（Lambert 1760 的多边形辐照度公式）：
//
//     E = (1/2π) Σ_边 acos(p_i·p_j) · ( normalize(p_i × p_j) · N )
//
// p_i 是矩形四顶点投影到着色点单位球上的方向。四条边 = 四次 acos。
// 本项目 Lambert-only（不重建 specular，见理论推导 §16.3），所以**不需要 LTC**
// ——LTC 是为 GGX 高光准备的，我们不做高光，直接吃最便宜的这条。
//
// ⚠ 未做 horizon clip：多边形跨越着色点地平线时本式偏大，靠外层 max(0) 兜底。
//   实测发现问题再补真裁剪（裁到 N·p>0 半空间，最多变 5 边）。
//
// 返回**带符号**值：正 = 着色点在多边形正面（按顶点绕向定的正面）。
// 钳位交给 lcAreaLight —— 双面光要的是 abs 而不是 max(0)。四条边手写展开（不用 4 元素数组）。
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
fn lcAreaLight(P: vec3<f32>, N: vec3<f32>, center: vec3<f32>, halfU: vec3<f32>, halfV: vec3<f32>,
               color: vec3<f32>, intensity: f32, range: f32, twoSided: bool, vis: f32) -> vec3<f32> {
    let d = center - P;
    let r2 = dot(d, d);
    // 作用半径截断：面光同样需要，否则远处也被它抬亮
    let cut = exp(-r2 / max(range * range, 1e-6));
    if (cut < 1e-4) { return vec3<f32>(0.0); }
    // 单面光：着色点在背面则无贡献
    if (!twoSided) {
        let n = normalize(cross(halfU, halfV));
        if (dot(n, -d) <= 0.0) { return vec3<f32>(0.0); }
    }
    // ⚠ 顶点必须按「从正面看是逆时针」绕，否则 Lambert 多边形式给出的符号是反的。
    //   原来写的是 (c−U−V, c+U−V, c+U+V, c−U+V) —— 那个绕向与
    //   cross(halfU, halfV) 定的正面**反着**，于是在**正面**算出负值、被 max(0)
    //   吃成 0，在**背面**反而算出正值。净效果：**面光照亮的是错误的一侧**。
    //
    //   实测（面板在 (950,357,0)、半轴 150×100、地面法线 (0,1,0)）：
    //     面板朝下、地在正下方（该亮）→ 单面判据通过，但 E = −0.1328 ⇒ 0
    //     面板朝上、地在正下方（该黑）→ 单面判据拒绝，E 却 = +0.1328
    //   两者恰好互换。翻转绕向后四种情形（该亮 / 该黑 × 朝下 / 朝前）全部正确。
    var E = lcRectIrradiance(P, N,
                             center - halfU - halfV,
                             center - halfU + halfV,
                             center + halfU + halfV,
                             center + halfU - halfV);
    // 双面光两侧都发光 ⇒ 取绝对值；单面光已被上面的判据挡过，负值只可能是
    // 未做 horizon clip 的数值残差，钳掉。
    if (twoSided) { E = abs(E); } else { E = max(E, 0.0); }
    return color * (intensity * E * cut * vis);
}

// ---------------------------------------------------------------- 线光（落雷那一道雷身，只给运行时灯用）
// 从 a 到 a + seg 的一整条均匀发光线，总强度 intensity（= 同一强度的点光均匀摊在整条线上，
// 离得远时与点光一样；打包处与点光同样 × wuPerQUnit²）。
//
// Lambert（N·L）× 1/(r² + 软化) 沿线的**闭式积分**，零采样（逐点采样在贴近雷身的墙上会是一串亮斑）：
//
//     E = λ ∫ (α + β s) / (s² + b²)^{3/2} ds            λ = intensity / len
//       = λ [ α/b² · s/√(s²+b²) − β/√(s²+b²) ]  从 s0 到 s1
//
// s = 沿线坐标（原点取着色点在这条直线上的垂足），b² = 垂距² + 软化，α = N·(着色点→垂足)，β = N·线方向。
// 作用半径的截断取线上离着色点最近那一点（线远长于截断半径时才有误差）。
// ⚠ 未做 horizon clip：线有一截在着色点地平线以下时那一截贡献负值，本式偏小；外层 max(0) 兜底。
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
// 天光 = 天光色 × 强度 × ( (1−hemi) + hemi × 天穹可见性 )。
// 可见性来自**烘出来的几何场**（逐像素 skyvis.png / 角色用 3D 网格），与光无关，
// 光怎么变都不用重烘。（运行时加光项已删，本函数现役无消费者，照搬留档。）
//
// · hemi = 有多少比例的天光是"从上方来、会被遮住"的；1−hemi 是各向同性的底。
//   hemi 越大，巷道 / 檐下与开阔地的反差越强。
// · aoStrength 是可读性旋钮：1 = 完全吃遮蔽，0 = 完全不吃（mix 把可见性拉回 1）。
//
// ⚠ **本函数已含半球项，调用方不要再乘一遍**。踩过：调用处又乘了
//   (1−hemi)+hemi·skyvis，等于把可见性算了两次，整场景暗到离线口径的 0.6 倍
//   （sky 均值 0.48，比值正好对上）。与 relight.py 的 s_new 逐项对齐即可。
fn lcSkyLight(color: vec3<f32>, intensity: f32, skyvis: f32, hemi: f32, aoStrength: f32) -> vec3<f32> {
    let v = mix(1.0, clamp(skyvis, 0.0, 1.0), clamp(aoStrength, 0.0, 1.0));
    return color * (intensity * ((1.0 - hemi) + hemi * v));
}

// ---------------------------------------------------------------- 阴影 march
// 沿光线在**伪世界 q 空间**里 march 深度场：落到可见壳背后、且在 thick 厚度窗内 = 被挡
// （march 是 q 空间的三类豁免之一，见坐标卡）。
// ⚠ 这是**伪世界空间**的行进，不是屏幕空间的模糊 / 衰减——
//   每一步都把 q 反投影回像素去取该处的真实表面深度，深度分离是逐步做的。
//   （2026-07-21 决策的被否项「在屏幕空间直接模糊或积分」指的是不做深度分离的那种，
//     与本函数不是一回事。）
//
// 依赖 WR_CORE 的 wrQToPixel / wrDecodeSceneDepth，要一起拼进同一模块。
// thick 是厚度窗：太薄会漏挡，太厚会让远处的墙挡住近处（"隔山打影"）。
//
// 返回 [0,1]：1 = 未被挡。定步长、无抖动 ⇒ 同参数必出同结果。
fn lcMarchVisibility(depthTex: texture_2d<f32>, depthSmp: sampler, depthTexSize: vec2<f32>,
                     ppu: f32, cx: f32, cy: f32,
                     invert: f32, dScale: f32, dOffset: f32,
                     q0: vec3<f32>, dirQ: vec3<f32>, steps: i32, marchLen: f32,
                     bias0: f32, thick: f32) -> f32 {
    let st = marchLen / f32(max(steps, 1));
    for (var i = 1; i <= 128; i++) {
        if (i > steps) { break; }                  // 常量上界 + 提前 break（与 master 的 GLSL 版同一个循环形状）
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
// 正交相机 ⇒ **每像素视线方向恒定** ⇒ 指数高度雾的积分有闭式解，无需 march。
//
//     σ(y) = σ₀ · exp( −(y − baseY) / H )
//     ∫σ ds = σ₀ · dist · (a − b) · H / (ySurf − yCam)，  a=exp(−(yCam−baseY)/H)
//                                                        b=exp(−(ySurf−baseY)/H)
//
// dist 为沿视线的行程（世界单位）。ySurf≈yCam 时退化为常数介质。
//
// ⚠ 参数按**消光系数 σ** 定义，不按"最终混合系数"——将来上体积雾时，
//   已调好的浓度 / 高度 / 颜色全部继续有效（需求 R3 的可扩展性要求）。
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
// 顺序固定：曝光 → tonemap → 白平衡 → 饱和 → 对比 → 暗部提升 → sRGB
//
// ⚠ **显示变换绝不能烤进辐射场**。当前离线工具把 ev 与 clamp 烤进 PNG，
//   导致导出图动态范围只有 17×，角色 gather 到的光等于没有（2026-08-20 实测）。
// ⚠ tonemap='none'（mode=0）时本函数与 tools/scene_relight/relight.py 的调色段
//   **逐步等价**，已调好的预设参数可直接复用。改这里要同步跑 parity 测试。
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
// 场景的 albedo 被画进了像素里，拿不出来，所以走「先除掉白天光、再乘上新光」。
// 角色的 albedo 是显式的，直接乘 S —— **两边算的是同一个 S**，这是"完美融合"的根。
// （2026-08-30 起光影改成「原画 + 加性实体灯」，运行时不再重打光，本函数无消费者。）
//
// ⚠ 干活的是 S_day / S_new 里的天穹可见性与定向光投影；除 / 乘只是最后一步算术。
//   **被否**（2026-08-20 制作人当场否决）：S 只用法线朝上项、不做任何 march 的写法
//   ——那是逐像素调色，画不出巷道与屋檐下的遮蔽结构，看着就是贴滤镜。勿回退。
fn lcRelightScene(paintingLinear: vec3<f32>, sDay: vec3<f32>, sNew: vec3<f32>, ratioMax: f32) -> vec3<f32> {
    let ratio = clamp(sNew / max(sDay, vec3<f32>(1e-4)), vec3<f32>(0.0), vec3<f32>(ratioMax));
    return paintingLinear * ratio;
}

//__LIGHTING_CORE_END__
