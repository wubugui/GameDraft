// ============================================================================
// 统一光影系统 · 光照核心（单一真相源）
//
// 本文件是 S(L, 几何) 的**唯一**实现，被四方共用：
//   ① 场景光照 pass（逐像素，写进缓存 RT）
//   ② 角色着色 filter 路径
//   ③ 角色着色 mesh 路径
//   ④ 工具预览（tools/scene_relight 的 WebGL viewer，经 HTTP 端点注入）
// 沿用项目既有范式（见 src/rendering/charShadeCore.glsl）：一份 GLSL 字符串拼进
// 各 shader，消灭镜像漂移。改这里 = 四处同时改，这正是要的。
//
// ⚠ 铁律（制作人 2026-08-20）：**一切光照发生在伪世界空间，禁止任何纯屏幕空间光照。**
//   本文件全部函数都吃伪世界坐标 P 与法线 N，不吃屏幕坐标。
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
// ============================================================================

//__LIGHTING_CORE_BEGIN__

#ifndef LIGHTING_CORE_INCLUDED
#define LIGHTING_CORE_INCLUDED

const float LC_PI = 3.14159265358979323846;
const vec3  LC_LUMA = vec3(0.2126, 0.7152, 0.0722);

// ---------------------------------------------------------------- 光源类型
// 与 LightDef.kind 对应：0=point 1=spot 2=area 3=directional
#define LC_POINT       0
#define LC_SPOT        1
#define LC_AREA        2
#define LC_DIRECTIONAL 3

// ---------------------------------------------------------------- 衰减
// 物理 1/r² + 有限作用半径的高斯截断。
// 截断是必须的：没有它，夜景里一盏灯会把整张图都染暖（实测过）。
float lcFalloff(float r2, float range, float softening) {
    float cut = exp(-r2 / max(range * range, 1e-6));
    return cut / (r2 + softening);
}

// ---------------------------------------------------------------- 点光
vec3 lcPointLight(vec3 P, vec3 N, vec3 lightPos, vec3 color,
                  float intensity, float range, float softening, float vis) {
    vec3 v = lightPos - P;
    float r2 = dot(v, v);
    float ndl = max(dot(N, v * inversesqrt(max(r2, 1e-12))), 0.0);
    return color * (intensity * ndl * lcFalloff(r2, range, softening) * vis);
}

// ---------------------------------------------------------------- 聚光
// spotDir 指向光**射出**的方向；cosInner/cosOuter 为锥体余弦（inner > outer）。
vec3 lcSpotLight(vec3 P, vec3 N, vec3 lightPos, vec3 spotDir, vec3 color,
                 float intensity, float range, float softening,
                 float cosInner, float cosOuter, float vis) {
    vec3 v = lightPos - P;
    float r2 = dot(v, v);
    vec3 L = v * inversesqrt(max(r2, 1e-12));
    float cone = smoothstep(cosOuter, cosInner, dot(-L, normalize(spotDir)));
    if (cone <= 0.0) return vec3(0.0);
    float ndl = max(dot(N, L), 0.0);
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
float lcRectIrradiance(vec3 P, vec3 N, vec3 v0, vec3 v1, vec3 v2, vec3 v3) {
    vec3 p0 = normalize(v0 - P);
    vec3 p1 = normalize(v1 - P);
    vec3 p2 = normalize(v2 - P);
    vec3 p3 = normalize(v3 - P);

    float sum = 0.0;
    // 展开循环：GLSL ES 里常量索引的数组访问更省，且避免 4 元素数组的寄存器压力
    vec3 ax;
    float ln;

    ax = cross(p0, p1); ln = length(ax);
    if (ln > 1e-6) sum += acos(clamp(dot(p0, p1), -1.0, 1.0)) * dot(ax / ln, N);
    ax = cross(p1, p2); ln = length(ax);
    if (ln > 1e-6) sum += acos(clamp(dot(p1, p2), -1.0, 1.0)) * dot(ax / ln, N);
    ax = cross(p2, p3); ln = length(ax);
    if (ln > 1e-6) sum += acos(clamp(dot(p2, p3), -1.0, 1.0)) * dot(ax / ln, N);
    ax = cross(p3, p0); ln = length(ax);
    if (ln > 1e-6) sum += acos(clamp(dot(p3, p0), -1.0, 1.0)) * dot(ax / ln, N);

    // 返回**带符号**值:正 = 着色点在多边形正面(按顶点绕向定的正面)。
    // 钳位交给 lcAreaLight —— 双面光要的是 abs 而不是 max(0)。
    return sum * (0.5 / LC_PI);
}

// 面光的四个角由中心 + 两条半轴给出（半轴已是世界单位向量）
vec3 lcAreaLight(vec3 P, vec3 N, vec3 center, vec3 halfU, vec3 halfV,
                 vec3 color, float intensity, float range, bool twoSided, float vis) {
    vec3 d = center - P;
    float r2 = dot(d, d);
    // 作用半径截断：面光同样需要，否则远处也被它抬亮
    float cut = exp(-r2 / max(range * range, 1e-6));
    if (cut < 1e-4) return vec3(0.0);
    // 单面光：着色点在背面则无贡献
    if (!twoSided) {
        vec3 n = normalize(cross(halfU, halfV));
        if (dot(n, -d) <= 0.0) return vec3(0.0);
    }
    // ⚠ 顶点必须按「从正面看是逆时针」绕，否则 Lambert 多边形式给出的符号是反的。
    //   原来写的是 (c−U−V, c+U−V, c+U+V, c−U+V) —— 那个绕向与
    //   `cross(halfU, halfV)` 定的正面**反着**，于是在**正面**算出负值、被 max(0)
    //   吃成 0，在**背面**反而算出正值。净效果:**面光照亮的是错误的一侧**。
    //
    //   实测(面板在 (950,357,0)、半轴 150×100、地面法线 (0,1,0))：
    //     面板朝下、地在正下方(该亮) → 单面判据通过，但 E = −0.1328 ⇒ 0
    //     面板朝上、地在正下方(该黑) → 单面判据拒绝，E 却 = +0.1328
    //   两者恰好互换。翻转绕向后四种情形(该亮/该黑 × 朝下/朝前)全部正确。
    float E = lcRectIrradiance(P, N,
                               center - halfU - halfV,
                               center - halfU + halfV,
                               center + halfU + halfV,
                               center + halfU - halfV);
    // 双面光两侧都发光 ⇒ 取绝对值；单面光已被上面的判据挡过，负值只可能是
    // 未做 horizon clip 的数值残差，钳掉。
    E = twoSided ? abs(E) : max(E, 0.0);
    return color * (intensity * E * cut * vis);
}

// ---------------------------------------------------------------- 平行光（日/月）
vec3 lcDirectionalLight(vec3 N, vec3 toLight, vec3 color, float intensity, float vis) {
    return color * (intensity * max(dot(N, normalize(toLight)), 0.0) * vis);
}

// ---------------------------------------------------------------- 天光
// 天光 = 天光色 × 强度 × ( (1−hemi) + hemi × 天穹可见性 )。
// 可见性来自**烘出来的几何场**（逐像素 skyvis.png / 角色用 3D 网格），与光无关，
// 光怎么变都不用重烘。
//
// · `hemi` = 有多少比例的天光是"从上方来、会被遮住"的；`1−hemi` 是各向同性的底。
//   hemi 越大，巷道/檐下与开阔地的反差越强。
// · `aoStrength` 是可读性旋钮：1=完全吃遮蔽，0=完全不吃（`mix` 把可见性拉回 1）。
//
// ⚠ **本函数已含半球项，调用方不要再乘一遍**。踩过：调用处又乘了
//   `(1−hemi)+hemi·skyvis`，等于把可见性算了两次，整场景暗到离线口径的 0.6 倍
//   （sky 均值 0.48，比值正好对上）。与 `relight.py` 的 `s_new` 逐项对齐即可。
vec3 lcSkyLight(vec3 color, float intensity, float skyvis, float hemi, float aoStrength) {
    float v = mix(1.0, clamp(skyvis, 0.0, 1.0), clamp(aoStrength, 0.0, 1.0));
    return color * (intensity * ((1.0 - hemi) + hemi * v));
}

// ---------------------------------------------------------------- 阴影 march
// 沿光线在**伪世界 q 空间**里 march 深度场：落到可见壳背后、且在 thick 厚度窗内 = 被挡。
// ⚠ 铁律 S12：这是**伪世界空间**的行进，不是屏幕空间的模糊/衰减——
//   每一步都把 q 反投影回像素去取该处的真实表面深度，深度分离是逐步做的。
//   （2026-07-21 决策的被否项「在屏幕空间直接模糊或积分」指的是不做深度分离的那种，
//     与本函数不是一回事；新决策卡必须写明这条区别。）
//
// 依赖 worldReconstruct 的 wrQToPixel / wrDecodeSceneDepth，故拼接时 WR 必须排在前面。
// thick 是厚度窗：太薄会漏挡，太厚会让远处的墙挡住近处（"隔山打影"）。
//
// 返回 [0,1]：1 = 未被挡。定步长、无抖动 ⇒ 同参数必出同结果。
float lcMarchVisibility(sampler2D depthTex, vec2 depthTexSize,
                        float ppu, float cx, float cy,
                        float invert, float dScale, float dOffset,
                        vec3 q0, vec3 dirQ, int steps, float marchLen,
                        float bias0, float thick) {
    float st = marchLen / float(max(steps, 1));
    for (int i = 1; i <= 128; i++) {
        if (i > steps) break;                 // GLSL ES 要求循环上界是常量
        vec3 q = q0 + dirQ * (st * float(i));
        vec2 px = wrQToPixel(q, ppu, cx, cy);
        vec2 uv = px / depthTexSize;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
        float ds = wrDecodeSceneDepth(texture(depthTex, uv), invert, dScale, dOffset);
        float pen = q.z - ds;
        float bias = bias0 + 0.02 * st * float(i);
        if (pen > bias && pen < thick) return 0.0;
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
//   已调好的浓度/高度/颜色全部继续有效（需求 R3 的可扩展性要求）。
float lcOpticalDepth(float dist, float yCam, float ySurf,
                     float sigma0, float scaleH, float baseY) {
    float H = max(scaleH, 1e-4);
    float a = exp(-(yCam - baseY) / H);
    float b = exp(-(ySurf - baseY) / H);
    float dy = ySurf - yCam;
    if (abs(dy) < 1e-5) return sigma0 * a * dist;
    return sigma0 * dist * (a - b) * H / dy;
}

// 应用雾：透射 T 混合场景色与散射色。**场景与角色吃同一组参数、各用自己的深度。**
vec3 lcApplyFog(vec3 lin, float opticalDepth, vec3 scatterColor) {
    float T = exp(-max(opticalDepth, 0.0));
    return lin * T + scatterColor * (1.0 - T);
}

// ---------------------------------------------------------------- 显示变换
// 顺序固定：曝光 → tonemap → 白平衡 → 饱和 → 对比 → 暗部提升 → sRGB
//
// ⚠ **显示变换绝不能烤进辐射场**。当前离线工具把 ev 与 clamp 烤进 PNG，
//   导致导出图动态范围只有 17×，角色 gather 到的光等于没有（2026-08-20 实测）。
// ⚠ tonemap='none'（mode=0）时本函数与 tools/scene_relight/relight.py 的调色段
//   **逐步等价**，已调好的预设参数可直接复用。改这里要同步跑 parity 测试。
vec3 lcTonemap(vec3 x, int mode) {
    if (mode == 1) {                     // reinhard
        return x / (1.0 + x);
    } else if (mode == 2) {              // filmic（ACES 近似，Narkowicz）
        vec3 v = x * 0.6;
        return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
    }
    return x;                            // none
}

vec3 lcLinearToSrgb(vec3 x) {
    x = clamp(x, 0.0, 1.0);
    return mix(x * 12.92, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055,
               step(vec3(0.0031308), x));
}

vec3 lcSrgbToLinear(vec3 x) {
    return mix(x / 12.92, pow((x + 0.055) / 1.055, vec3(2.4)),
               step(vec3(0.04045), x));
}

vec3 lcDisplayTransform(vec3 lin, float ev, int tonemapMode, vec3 whiteBalance,
                        float saturation, float contrast,
                        float lift, vec3 liftColor) {
    vec3 c = lin * exp2(ev);
    c = lcTonemap(c, tonemapMode);
    c *= whiteBalance;
    if (saturation != 1.0) {
        float l = dot(c, LC_LUMA);
        c = vec3(l) + (c - vec3(l)) * saturation;
    }
    if (contrast != 1.0) {
        c = 0.18 * pow(max(c, vec3(0.0)) / 0.18, vec3(contrast));
    }
    if (lift > 0.0) {
        float l = dot(c, LC_LUMA);
        c += liftColor * (lift * 0.08 * exp(-l / 0.06));
    }
    return lcLinearToSrgb(c);
}

// ---------------------------------------------------------------- 场景重打光
// 场景的 albedo 被画进了像素里，拿不出来，所以走「先除掉白天光、再乘上新光」。
// 角色的 albedo 是显式的，直接乘 S —— **两边算的是同一个 S**，这是"完美融合"的根。
//
// ⚠ 干活的是 S_day / S_new 里的天穹可见性与定向光投影；除/乘只是最后一步算术。
//   **被否**（2026-08-20 制作人当场否决）：S 只用法线朝上项、不做任何 march 的写法
//   ——那是逐像素调色，画不出巷道与屋檐下的遮蔽结构，看着就是贴滤镜。勿回退。
vec3 lcRelightScene(vec3 paintingLinear, vec3 sDay, vec3 sNew, float ratioMax) {
    vec3 ratio = clamp(sNew / max(sDay, vec3(1e-4)), vec3(0.0), vec3(ratioMax));
    return paintingLinear * ratio;
}

#endif // LIGHTING_CORE_INCLUDED

//__LIGHTING_CORE_END__
