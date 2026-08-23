// ============================================================================
// 统一着色核心 v3 —— **场景与角色调的是这同一个函数**
//
// 这一版把管线彻底改成 3D 着色那套：先把一切化到 G-buffer（基底 / 法线 /
// 位置 / 天穹传输），再进**一份**光照计算。差别只剩"G-buffer 怎么填"：
//
//   场景：基底 ← lighting3/base.png（原画 ÷ E，烘焙期就除掉了）
//         法线 ← lighting3/normal.png
//         遮蔽 ← lighting3/sky_occlusion.png（RGBA8：RGB = bent 方向，A = 可见度）
//   角色：基底 ← 图集 ÷ E_ref(n_c)（解析式，见 sc3CharBase）
//         法线 ← 法线图集
//         遮蔽 ← lighting3/sky_sh_grid.bin 通道 0 的 SH-L1 三线性 + 自己的法线
//
// ⚠ 两侧的遮蔽是**同一个量**：bent 方向 + 余弦加权可见度，进的是**同一个函数**
//   `sc3SkyIrradiance`。场景侧法线在烘焙期已知所以存的是精确值，角色侧法线
//   运行时才有所以存的是可见度的 L1（`V(N) = a₀ + a₁·N`）—— 表示同一件事，
//   无遮挡时两边都精确回到 `sc3SkyShIrradiance(N)`。
//
// ⚠ **「基底」不是 albedo**。它是比例式 `I_out = I_原画 × E_目标 / E` 里被提
//   出来的中间因子 `I_原画 / E`。数值上落在反射率的量级（因为 E 是真的辐照度，
//   由伪世界 final gather 积出来），但它不是"反解出的材质"。叫它 albedo 会
//   带来错误预期；叫它基底才对得上它的来历。
//
// 到 `sc3Shade` 这一步，两边已经在同一个空间里，后面逐字同一条路径。
//
// ⚠ 与 v2（lightingCore.glsl）的三处**语义**变化，不要混用：
//   1. **没有 hemi / aoStrength 了**。`(1−h)+h·V` 是个凑出来的旋钮；传输基
//      `T_k` 本身就是物理答案，"天穹有多集中于天顶"现在是 `skyProfile`
//      在 4 个通道间选，是个有量纲意义的参数。
//   2. **没有 ratioMax 了**。比例钳位是 v2 那种"原画×比值"才需要的护栏；
//      这里基底已经是显式的量，乘出来多少就是多少，钳位只会掩盖标定错误。
//   3. **基底不再隐含在原画里**。场景与角色的基底都是显式 buffer，
//      所以 F2 能像 UE 一样逐 buffer 看（见 SC3_DEBUG_*）。
//   4. **E 是积出来的，不是拟合的**。烘焙期在伪世界里做 final gather：
//      射线打到表面就取那里的 HDR 原画辐射，逃逸就取天空辐射 —— 画本身
//      就是辐射缓存。天穹遮蔽是同一趟积分的另一个投影，顺带出来的。
//
// ⚠ 本项目 **Lambert-only，不重建高光**（面光走 Lambert 多边形闭式解，
//   见 lcAreaLight 的推导）。所以"反射 buffer"恒为 0 —— 不是没接，是没有。
// ============================================================================

//__SHADE_CORE_3_BEGIN__

#ifndef SHADE_CORE_3_INCLUDED
#define SHADE_CORE_3_INCLUDED

/**
 * 天空的**辐照度 SH-L2**，9 个系数（用 vec4 数组存 vec3，避开 std140 里
 * vec3 数组的对齐坑）。逐帧在 CPU 上从 `sky.intensity / profile / kelvin` 算，
 * **不逐像素预投影** —— 换天空不需要重烘，而且以后能加方位向变化（日头那侧更亮）。
 *
 * ⚠ 卷积系数 Â_l 已经乘进来了，所以这里就是一次朴素的 SH 求值。
 * ⚠ 标定：无遮挡朝上面 = `sky.intensity`（CPU 侧按这条归一），与旧的
 *   「无遮挡水平面 = 1」逐字同一个约定，作者面的旋钮语义一个字没变。
 */
uniform vec4 uSkySh[9];

// π 用 lightingCore 的 LC_PI。
// 亮度权重用 lightingCore 的 LC_LUMA。

// ---------------------------------------------------------------- 调试视图
// F2 逐 buffer 检视。**两条路径共用这套编号**，所以同一个编号在场景和角色上
// 一定是同一个量 —— 这正是"能拿它定位问题"的前提。
#define SC3_DEBUG_OFF          0
#define SC3_DEBUG_BASE         1   // 比例基底 I/E（**不是 albedo**，见 sc3Shade）
#define SC3_DEBUG_NORMAL       2   // 世界法线，*0.5+0.5
#define SC3_DEBUG_POSITION     3   // 世界位置（按网格 AABB 归一）
#define SC3_DEBUG_SKY_OCC      4   // 天穹可见度 V（余弦加权，无遮挡=1，可与 AO 直接比）
#define SC3_DEBUG_SKY_BENT     5   // bent 方向（平均未遮挡方向），*0.5+0.5
#define SC3_DEBUG_SKY_E        6   // 天光辐照（带颜色）
#define SC3_DEBUG_SUN_E        7   // 日/月辐照
#define SC3_DEBUG_LAMP_E       8   // 灯辐照合计
#define SC3_DEBUG_TOTAL_E      9   // 总辐照 E（不乘基底）—— "纯光照"
#define SC3_DEBUG_GI          10   // 烘焙 GI = final gather 出的 E（角色侧恒 0）
#define SC3_DEBUG_SHADOW      11   // 日/月阴影可见性
#define SC3_DEBUG_EMISSIVE    12   // 自发光合计（烘焙 max(I−E,0) + 灯体）
#define SC3_DEBUG_OVERBRIGHT  13   // 越界指示：基底>1 洋红 / E>4 青
#define SC3_DEBUG_SPECULAR    14   // 反射 —— 本项目 Lambert-only，恒 0
#define SC3_DEBUG_AO          15   // 局部 AO（短程封闭度；与天穹遮蔽是两个量）

// 光源类型编码用 lightingCore 的 LC_POINT / LC_SPOT / LC_AREA / LC_DIRECTIONAL，
// 本文件不另立一套数字（同名不同值是最难查的那类 bug）。

// ------------------------------------------------------- 天穹：遮蔽 × 天空
/**
 * 天空辐照度：一次 SH-L2 求值。基是标准实球谐（Â_l 已并入系数）。
 *
 * ⚠ 这里用的是**世界坐标**里的标准基（Y20 沿 z），而天穹的对称轴是 +y ——
 *   看着"轴不对"，其实无所谓：CPU 侧就是拿这同一组基去投影真实天空辐亮度的，
 *   一致就够了。刻意不做轴对齐，省得两边各拧一次坐标系。
 */
vec3 sc3SkyShIrradiance(vec3 n) {
    float x = n.x, y = n.y, z = n.z;
    vec3 e = uSkySh[0].rgb * 0.2820948;
    e += uSkySh[1].rgb * (0.4886025 * y);
    e += uSkySh[2].rgb * (0.4886025 * z);
    e += uSkySh[3].rgb * (0.4886025 * x);
    e += uSkySh[4].rgb * (1.0925484 * x * y);
    e += uSkySh[5].rgb * (1.0925484 * y * z);
    e += uSkySh[6].rgb * (0.3153916 * (3.0 * z * z - 1.0));
    e += uSkySh[7].rgb * (1.0925484 * x * z);
    e += uSkySh[8].rgb * (0.5462742 * (x * x - y * y));
    return max(e, vec3(0.0));
}

/**
 * 任意方向的可见度：`V(ω) ≈ clamp(a + b·ω, 0, 1)`。
 *
 * `(a, b)` 是烘焙期用**同一批 final gather 光线**做的加权最小二乘 —— 把每根光线
 * 的"逃逸与否"当观测值，对方向做一次线性拟合。**没有任何自由参数**，天生连续。
 *
 * ⚠ **这条定死了，不要再换成"可见锥"。** 锥体那套（bent 方向归一化 + 锥半角
 *   `sin²α = V` + 人为宽度的 smoothstep）错在两点：① 归一化把方向的置信度扔了，
 *   低可见度处 bent 方向方差极大；② 锥对 delta 光源的判据**天生二值**。
 *   实测 `α−θ` 的 std 24.8° 而过渡带 ±9° ⇒ 78% 的像素饱和成 0/1，
 *   V<0.15 区间的孤立黑点密度是 V>0.6 的 **300 倍**。换成线性重建后黑点 0.0000%。
 *   机械契约：directLight.test.ts。
 */
float sc3DirectVisibility(vec4 visLin, vec3 dir) {
    return clamp(visLin.a + dot(visLin.rgb, dir), 0.0, 1.0);
}

/**
 * 天光辐照 = **遮蔽 × 天空**，两者到这一步才相乘。
 *
 *     w = 1 − (1−V)²
 *     n = normalize(mix(bentDir, N, w))
 *     E = sc3SkyShIrradiance(n) · V
 *
 * 遮蔽的表示只有**一个方向 + 一个标量**（bent normal + 可见度），与 UE
 * `SkyLighting.usf` 同一套：遮蔽轻时用表面法线（细节多），遮蔽重时偏向
 * bent 方向（那才是光真正进来的方向）。
 *
 * ⚠ 无遮挡时 V=1 ⇒ w=1 ⇒ n=N ⇒ `E = sc3SkyShIrradiance(N)`，**构造性精确**，
 *   场景与角色都落在这一条上。这是"两边吃同一个量"唯一靠得住的保证方式。
 * ⚠ 这一套**否掉了**先前那个「4 个纬向通道逐像素预投影」的设计：那是把天空
 *   烤死在载荷里，既要 4 倍存储，又让场景（精确求积）与角色（SH-L1）落在两个
 *   不同的参数化上 —— 实测在角色典型法线处两边差 10%–15%、竖直面差一倍。
 *   一个量、一段代码，才不会分家。
 */
vec3 sc3SkyIrradiance(vec3 bentDir, float vis, vec3 N) {
    float v = clamp(vis, 0.0, 1.0);
    float w = 1.0 - (1.0 - v) * (1.0 - v);
    vec3 n = normalize(mix(bentDir, N, w) + vec3(1e-6, 1e-6, 1e-6));
    return sc3SkyShIrradiance(n) * v;
}

/**
 * 环境反弹的遮蔽项：`0.28 + 0.72·AO`，**吃遮蔽但不归零**。
 *
 * ⚠ 参数是**局部 AO**，不是天穹传输 `T₀`。这两个是不同的问题：
 *   `T₀` 问「你能看见多少天」，`AO` 问「你有多封闭」。
 *   拿 T₀ 当封闭度用，在**室内直接失效**（那里 T₀ 处处≈0，等于没有信号），
 *   而多次反弹恰恰是室内唯一的光。这正是我批评 v2 拿一个量当两个用的同一个错误
 *   —— v3 的头几版自己也犯了，2026-08-23 补上 AO 通道才分开。
 *
 * 为什么不能用纯常数、也不能直接用 AO：
 * - 纯常数 ⇒ 全黑角落和开阔地拿到一样多的底，遮蔽结构被这一项冲平；
 * - 直接用 AO ⇒ 完全封闭处归零，而多次反弹本来就能绕进去，墙根会黑得不合理。
 *
 * 0.28 这个下限是"绕进来的那部分"，与烘焙侧同式。上限 1.2 允许开阔地略超 1。
 */
float sc3AmbientTerm(float ao) {
    return clamp(0.28 + 0.72 * ao, 0.0, 1.2);
}

/**
 * SH-L1 传输求值：`T_k(N) = a₀ + a₁·N`。
 *
 * 角色侧的网格存的就是 (a₀, a₁)，这里把它和法线合成。对钳位余弦做 L1 展开
 * `(N·ω)₊ ≈ ¼ + ½(N·ω)` 得到本式。
 *
 * ⚠ 烘焙侧已按**通道常数**归一，所以**无遮挡朝上面每个通道都恰好给 1**，
 *   与场景侧同一约定。但 L1 表达不了窄瓣：越往天顶集中的通道（y²/y⁴），
 *   倾斜面的响应误差越大。y⁰ 通道是精确的（朝上 1.0 / 45° 0.854 / 竖直 0.5），
 *   而角色的天光主项本来就走 y⁰ —— 误差落在次要通道上，是刻意的取舍。
 */
float sc3SHTransfer(vec4 sh, vec3 N) {
    float a0 = sh.r;                          // R 存 a₀ ∈ [0,1]
    vec3  a1 = (sh.gba - vec3(0.5)) * 2.0;    // GBA 存 a₁·½+½（a₁ ∈ [−1,1]）
    return max(a0 + dot(a1, N), 0.0);
}

// ------------------------------------------------------------------ 角色基底
/**
 * 角色图集 → 比例基底（与场景侧同一个空间）。
 *
 * 图集也是美术在某种隐含光照下画的，所以它同样要**除掉自己的 E**，才能和
 * 场景的基底进同一个空间 —— 这是"和角色对齐"落到式子上的地方。
 *
 * 参考环境取**均匀阴天且无遮挡**（sprite 拿不到自遮蔽，只有剪影鼓包法线）：
 *
 *     E_ref(N) = (1 + N·up) / 2 × refIntensity
 *
 * 这正是 `sc3SHTransfer` 在 V≡1 时的取值 —— 与场景侧同一个归一化约定，
 * 不是另立一套。`refIntensity` 是唯一剩下的标定量，含义明确：
 * 「美术把角色当成被强度多少的天穹照亮来画的」。
 *
 * ⚠ 这一步取代了 v2 的 `radianceScale`。那个是拿"图集平均亮度 ÷ 场景平均反射率"
 *   凑出来的**标量**，补不上一个逐像素的场；这里是逐像素解析除。
 */
vec3 sc3CharBase(vec3 atlasLinear, vec3 N, float refIntensity) {
    float eRef = max((1.0 + N.y) * 0.5 * refIntensity, 1e-4);
    return atlasLinear / eRef;
}

// ---------------------------------------------------------------- 解析光源
// ⚠ **不在这里重写**。点/聚/面/平行光的解析式在 `lightingCore.glsl` 的 lc* 系列，
//   那部分本来就是对的，v3 改的是天光与基底那条链。拼接顺序：
//
//       lightingCore.glsl  →  shadeCore3.glsl
//
//   两份都拼进同一个 shader，调用方直接用 `lcPointLight` / `lcSpotLight` /
//   `lcAreaLight` / `lcDirectionalLight` / `lcMarchVisibility` / `lcApplyFog` /
//   `lcDisplayTransform` / `lcSrgbToLinear`。
//   在本文件里再实现一遍 = 两个真相源，改一处漏一处 —— 这个项目为此付过账
//   （见 charShadeCore.glsl 头注释的"单一真相源"条款）。

// --------------------------------------------------------------------- 合成
/**
 * G-buffer → 线性辐射。**这是场景与角色唯一的会合点。**
 *
 * @param base     比例基底（两边都已各自除掉自己的 E / E_ref）
 * @param skyE     天光辐照（由 sc3SkyIrradiance 给，两边同一个函数、各用自己的遮蔽）
 * @param directE  日/月 + 全部灯的辐照合计
 * @param gi       场景烘出的反弹。**角色可选、场景传 0**
 *                 （场景的反弹已经在原画里，再加一遍就是算两次）
 */
vec3 sc3Shade(vec3 base, vec3 skyE, vec3 directE, vec3 gi) {
    return base * (skyE + directE + gi);
}

// ------------------------------------------------------------- HDR 编解码
/**
 * 8-bit 载荷里 HDR 量的编解码。存的是 `x/(1+x)` ∈ [0,1]（再走 sRGB），
 * 于是**不需要 scale**，而且精度分布跟显示域一致（亮的地方本来就压缩）。
 *
 * ⚠ 与烘焙侧 `bake_gbuffer.to_hdr` / `from_hdr` 是同一条曲线。两边任一处改了
 *   形状，`base·E + emissive ≡ 原画` 这条恒等式立刻不成立 —— 而且不会报错，
 *   只是画面整体偏掉。`hdrCodec.test.ts` 锁着这一对。
 */
vec3 sc3ToHdr(vec3 y) {
    return y / max(vec3(1.0) - y, vec3(1.0 / 200.0));
}

vec3 sc3FromHdr(vec3 x) {
    return x / (vec3(1.0) + x);
}

/**
 * 8-bit **对数**编码的 HDR 解码：`x = scale · 2^((px − ½)·span)`。
 *
 * 辐照度与角色 GI 用这条而不是 `sc3ToHdr`：它们的动态范围是 400 倍量级
 * （烛火旁 vs 暗角），而 `from_hdr` + sRGB8 的甜区只有 0.1–3
 * （到 10 就 5% 误差、30 就 9%、200 直接截断）。对数编码的相对精度**全程恒定**。
 *
 * ⚠ 输入是**原始字节** —— 不要先过 `lcSrgbToLinear`。这一条错了不会报错，
 *   只是整个场景的亮度沿一条幂曲线歪掉。`gatherPipeline.test.ts` 锁着。
 * ⚠ 与烘焙侧 `bake_gbuffer.encode_log_hdr` 是同一条式子的逆。
 */
vec3 sc3DecodeLogHdr(vec3 px, float scale, float span) {
    return scale * exp2((px - vec3(0.5)) * span);
}

// ---------------------------------------------------------------- 调试出图
/**
 * 按编号取 buffer。两条路径都调它 ⇒ 同一个编号在场景与角色上必是同一个量。
 * 返回**线性**值，由各调用方送进自己的显示变换（保持与正常路径同一条尾巴，
 * 否则调试视图和真实画面对不上，那就白看了）。
 */
/**
 * 这一档 buffer 是**辐射量**吗？
 *
 * ⚠ 这条分得清清楚楚很重要：辐射量（各种 E、GI、自发光）该走完整显示变换，
 *   才能和真实画面对得上；而 基底 / 法线 / 位置 / 遮蔽 / 传输 / 阴影
 *   **不是辐射量**，把它们乘上 2^ev 再 tonemap 只会烧成一片白 ——
 *   工具就此开始骗人。实测 ev=3.32 时法线视图直接全白（×10）。
 *   UE 的 buffer visualizer 同理：base color 与 normal 是原样出图的。
 */
bool sc3DebugIsRadiometric(int mode) {
    return mode == SC3_DEBUG_SKY_E || mode == SC3_DEBUG_SUN_E
        || mode == SC3_DEBUG_LAMP_E || mode == SC3_DEBUG_TOTAL_E
        || mode == SC3_DEBUG_GI || mode == SC3_DEBUG_EMISSIVE;
}

vec3 sc3DebugView(int mode, vec3 base, vec3 N, vec3 posNorm, vec3 bentDir, float skyVis,
                  float ao, vec3 skyE, vec3 sunE, vec3 lampE, vec3 gi, float shadowVis,
                  vec3 emissive) {
    if (mode == SC3_DEBUG_AO)           return vec3(ao);
    if (mode == SC3_DEBUG_BASE)         return base;
    if (mode == SC3_DEBUG_NORMAL)       return N * 0.5 + 0.5;
    if (mode == SC3_DEBUG_POSITION)     return clamp(posNorm, 0.0, 1.0);
    if (mode == SC3_DEBUG_SKY_OCC)      return vec3(clamp(skyVis, 0.0, 1.0));
    if (mode == SC3_DEBUG_SKY_BENT)     return bentDir * 0.5 + 0.5;
    if (mode == SC3_DEBUG_SKY_E)        return skyE;
    if (mode == SC3_DEBUG_SUN_E)        return sunE;
    if (mode == SC3_DEBUG_LAMP_E)       return lampE;
    // ⚠ 必须含 gi。未重打光的场景 sky/sun/lamp **全是 0**，照明整个来自烘焙 GI；
    //   漏掉它这个视图会显示一片黑，而画面明明是亮的 —— 那种工具比没有还坏。
    if (mode == SC3_DEBUG_TOTAL_E)      return skyE + sunE + lampE + gi;
    if (mode == SC3_DEBUG_GI)           return gi;
    if (mode == SC3_DEBUG_SHADOW)       return vec3(shadowVis);
    if (mode == SC3_DEBUG_EMISSIVE)     return emissive;
    if (mode == SC3_DEBUG_SPECULAR)     return vec3(0.0);   // Lambert-only
    if (mode == SC3_DEBUG_OVERBRIGHT) {
        // 定位标定错误：基底超 1 = 洋红，**解析光**辐照超 4 = 青。
        //
        // ⚠ 阈值两处都刻意躲开"合法情况"，否则这个视图会一直喊狼来了：
        //   1) 场景侧 `base = min(I/E, 1)` 本来就会**钳到 1.0**（teahouse 实测
        //      5.47% 的像素恰好 =1.0，而真正 >1 的是 0.0000%）。用 step(1.0,·)
        //      即 `>=`，会把全部钳住的像素标成越界。所以留 1e-3 的余量。
        //   2) 总辐照里**不算烘焙 GI**。gi=1 时 E 就是原画自己的辐照度，灶口
        //      附近合法地超过 4（实测 5.19% 的像素），那不是标定错误。这一档
        //      要抓的是"灯的量纲填错"，所以只看 sky/sun/lamp 这三项。
        vec3 E = skyE + sunE + lampE;
        float aHot = step(1.001, max(max(base.r, base.g), base.b));
        float eHot = step(4.0, max(max(E.r, E.g), E.b));
        return vec3(aHot, eHot * 0.5, max(aHot, eHot));
    }
    return vec3(0.0);
}

#endif // SHADE_CORE_3_INCLUDED

//__SHADE_CORE_3_END__
