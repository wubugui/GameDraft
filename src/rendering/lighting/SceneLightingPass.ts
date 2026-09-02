import {
  Mesh, MeshGeometry, RenderTexture, Shader, Texture,
  type Renderer,
} from 'pixi.js';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import {
  LIGHT_KIND_CODE,
  MAX_STATIC_LIGHTS, type PackedLights, directionFromAngles, packEmissive, packLights,
  packShadowBias,
} from './lightPacking';
import { LIGHTS_PER_SLAB, type PrefixLight, ShadowPrefixPass } from './shadowPrefix';
import { PROBE_SAMPLING_GLSL, SKYAO_SAMPLING_GLSL } from '../CharacterShadingFilter';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

/**
 * 场景光照 pass —— 把实体灯加到原画上，产出**线性 HDR 辐射场**。
 *
 * ## 模型（2026-08-30 制作人定调，取代原先的整体重打光）
 *
 * **原画就是最终的光照结果**，运行时不再动它。灯是加上去的：
 *
 * ```
 * surf = painting + (painting / S_day) × Σ实体灯
 * ```
 *
 * 没有灯时 surf 恒等于 painting，原画分毫不动。`S_day`（原画自带的自然光）
 * 只剩一个用途：把 albedo 反解出来。**不能**直接 painting + 灯 —— 灯返回的是
 * 辐照度、painting 是辐射亮度（已含 albedo），直接加等于不乘反照率，黑石板会
 * 被照成白墙。「夜」不靠调暗天光实现，靠换一张夜原画 + 夜的 probe + 该时段的灯。
 *
 * ## 两级结构（效率的关键）
 *
 * ```
 * ①【脏时重算】原画 + albedo×灯 → RGBA16F 缓存 RT
 * ②【逐帧】    采样① → 雾 → 显示变换 → 屏幕
 * ```
 *
 * 场景是静态的、灯大多也是静态的 ⇒ ① 只在时刻推进 / 灯开关 / F2 调参时跑，
 * **稳态每帧零光照计算**。⚠ 这是**缓存不是烘焙**：运行时算、参数一变就重算。
 *
 * ## 为什么 RT 必须是 RGBA16F
 *
 * 显示变换（曝光/tonemap/调色）**绝不能进 ①**。实测把 `ev` 与 clamp 烤进 8bit：
 * 整张夜景图线性辐射最大值只剩 0.061、全图动态范围 17×——角色拿它 gather 等于没照。
 * 保住 HDR，一盏灯笼才能是地面的几十上百倍。
 *
 * ## 干活的是什么
 *
 * `S_day` 由**天穹可见性场**（烘出来的几何项）与**定向光的 N·L** 构成，只当 albedo 除数。
 * 灯的遮挡走线扫前缀最小（`lightVisibilityPrefix`），不是逐像素 march。
 * ⚠ **被否**（2026-08-20 制作人当场否决）：S 只用法线朝上项、不做任何遮蔽的写法
 * ——那是逐像素调色，画不出巷道与屋檐下的遮蔽结构，看着就是贴滤镜。勿回退。
 */

/** GLSL 切片器：与项目既有范式同一行代码（CharacterShadingFilter 的 `__CLC_*__`）。 */
function slice(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[SceneLightingPass] GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

const WR_CORE = slice(WORLD_RECONSTRUCT, 'WR_CORE');
const LC = slice(LIGHTING_CORE, 'LIGHTING_CORE');

/**
 * 进**缓存那一级**的灯数上限（定义在 `lightPacking`，场景与角色共用一份）。
 *
 * 这一级只在脏时跑（时刻推进 / 灯开关 / F2 调参），所以**静态灯可以随便开阴影**
 * ——每盏灯的深度场 march 一次性付掉，稳态零成本。GTX 970 的 4–6 盏带影预算
 * 约束的是**动态灯**（闪烁烛火、玩家手持灯笼），那些走逐帧那一级。
 */
export { MAX_STATIC_LIGHTS, directionFromAngles } from './lightPacking';

/**
 * 全屏 quad。走 Pixi 的标准 mesh 变换链（`uProjectionMatrix * uWorldTransformMatrix
 * * uTransformMatrix`），与 `CharacterLitSprite` 同一套——手写 NDC 会在渲到 RT 时
 * 因 Y 轴约定不同而上下颠倒。
 */
const BAKE_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUv;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

/**
 * 光照 shader。**只产线性 HDR 辐射，不做雾、不做显示变换**——那两样在逐帧那一级。
 * 一个像素的完整链路：
 *   原画 → 线性化 →（去霾）→ + (原画/S_day) × Σ实体灯 → + 灯体自发光 → 输出
 */
// 与 lightingCore.glsl 的 LC_* 宏同值，拼进 shader 时做常量替换
const LC_POINT = 0;
const LC_SPOT = 1;
const LC_AREA = 2;
const LC_DIRECTIONAL = 3;

const BAKE_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPainting;     // 原画（sRGB）
uniform sampler2D uNormal;       // lighting/<背景基名>/normal.png
uniform sampler2D uSkyvis;       // lighting/<背景基名>/skyvis.png（R 通道）
uniform sampler2D uDepth;        // raw_depth_rg.png

uniform vec2  uDepthTexSize;
uniform vec3  uCal;              // ppu, cx, cy（native 分辨率标定）
uniform vec3  uDepthMap;         // invert, scale, offset
// depthConfig.M.R 三行（**det = +1** 的游戏约定矩阵，不是实验室那份 det = −1 的）
uniform vec3  uMRow0;
uniform vec3  uMRow1;
uniform vec3  uMRow2;
/** 1 个 q 单位 = 多少 wu。铁律 0：光照的长度一律 wu，q 进来先乘它。 */
uniform float uWuPerQUnit;

uniform vec3  uSkyColor;
uniform float uSkyIntensity;
uniform float uSkyHemi;
uniform float uAoStrength;

uniform float uDayHemi;
uniform float uDaySunIntensity;
uniform vec3  uDaySunDir;        // 指向光源（世界）

uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSunDir;           // 指向光源（世界）
uniform vec4  uShadow;           // strength, len, steps, soft(未用于 march)
uniform vec2  uShadowBias;       // bias0, thick

uniform float uRatioMax;
/** 0=正常 1=天穹可见性 2=法线 3=S_day 4=灯的辐照度 5=反解 albedo。调试可视化，F2 也用它。 */
uniform int   uDebug;
uniform int   uGiFixedN;         // 诊断·定法线(GI体档):0=正常 1=世界水平 2=世界向上

// ---- 灯（静态的进这一级缓存；动态的在逐帧那级）----
// 打包成四组 vec4，省 uniform 槽位。一盏灯要么是 spot 要么是 area，
// 所以 C.zw 两个位置按 kind 复用：spot 存内外锥余弦，area 存半宽半高（世界单位）。
//   A = pos.xyz,          kind (0=point 1=spot 2=area 3=directional)
//   B = color.rgb,        intensity
//   C = range, softening, [spot: cosInner, cosOuter] | [area: halfW, halfH]
//   D = dir.xyz（spot 射出方向 / area 法线 / directional 来向）, castShadow
/** 灯体自发光：x=增益 y=灯体半径(wu) z=光晕半径(wu) w=光晕相对强度 */
uniform vec4 uCore;
// ---- 阴影:线扫前缀最小（取代逐像素 march，见 shadowPrefix.ts）----
// 每张 slab 打包 4 盏灯;通道 i%4 存该灯的 M = 前缀最小 g。
uniform sampler2D uPrefix0;
uniform sampler2D uPrefix1;

// ---- 「GI体」调试视图(uDebug==7)专用:角色 probe 体的采样面 ----
// 采样数学拼接自角色共用块(PROBE_SAMPLING_GLSL,单一真相源);这四张图集与角色
// shader 绑的是**同一批纹理**(Game 在开启该视图时从 CharacterLightingSystem 现取现喂)。
uniform sampler2D uPL1;
uniform sampler2D uPL2;
uniform sampler2D uPBin;
uniform sampler2D uValid;
uniform sampler2D uSkyaoTex;     // 「skyao体」视图(uDebug==11):与角色绑同一张遮蔽矩图集
uniform float uProbeBeta;        // 2^β,与角色同一个曝光补偿 —— 两边同尺才可比
// 每盏灯在**图像**上的位置 xy 与在 q 里的深度 z;w = 这盏灯有没有前缀解（0 = 回落）
uniform vec4 uLightPx[${MAX_STATIC_LIGHTS}];
/** 画里的大气霾：x=消光 k y=强度 H（去掉白天的散射用），zw 备用 */
uniform vec4 uHaze;
/** 霾的色度（归一） */
uniform vec3 uHazeColor;

/**
 * 去霾时**每个通道至少留下**的比例。
 *
 * 存在的唯一理由：让减法结构上不可能把某个通道钳到 0。霾是**有颜色**的，
 * 绝对量的减法会在暗部逐通道非对称地清零 ⇒ 彩色噪点（见去霾那一段的注释）。
 * 0.1 是实测下来"去霾力度最大、而孤立零点已经归零"的取值——再大只是少去霾，
 * 噪点指标不会更好。
 */
#define HAZE_KEEP 0.1

uniform int  uLightCount;
uniform vec4 uLightA[${MAX_STATIC_LIGHTS}];
uniform vec4 uLightB[${MAX_STATIC_LIGHTS}];
uniform vec4 uLightC[${MAX_STATIC_LIGHTS}];
uniform vec4 uLightD[${MAX_STATIC_LIGHTS}];

${WR_CORE}
${LC}
${PROBE_SAMPLING_GLSL}
${SKYAO_SAMPLING_GLSL}

/**
 * 一盏灯的可见性（0=被挡）。**一次查表 + 一次比较，零步进。**
 *
 * 线扫把「这条径向线上，灯与我之间最"挡"的那个东西有多挡」预解成了 M（前缀最小
 * 斜率，见 shadowPrefix.ts）。于是这里只剩下把自己的斜率与它比一下：
 *
 *     被挡 ⟺ sp > M      其中 sp = (d_我 − z_灯) / k_我
 *
 * 对比原来的做法（沿光线走 N 步逐点查深度场）：那个 N 有多大都躲不开两件事 ——
 * 第 i 步永远落在以灯为圆心的等距壳上（⇒ 网状走样），步长随距离变粗（⇒ 漏挡）。
 * 这里没有步，所以两样都不存在。
 */
float lightVisibilityPrefix(int idx, vec2 fragPx, float myDepth) {
    vec4 lp = uLightPx[idx];
    if (lp.w < 0.5) return 1.0;               // 没解前缀（不投影 / 超出 slab）
    float k = length(fragPx - lp.xy);
    if (k < 1.0) return 1.0;                  // 就在灯上
    vec2 uv = fragPx / uDepthTexSize;
    vec4 slab = idx < 4 ? texture(uPrefix0, uv) : texture(uPrefix1, uv);
    int c = idx - (idx < 4 ? 0 : 4);
    float M = c == 0 ? slab.x : (c == 1 ? slab.y : (c == 2 ? slab.z : slab.w));
    float sp = (myDepth - lp.z) / k;
    return sp > M ? 0.0 : 1.0;
}


/**
 * 面光的两条半轴：法线 + 半宽半高 + **绕法线的自转**。
 *
 * 前两步（up 选轴、两次叉乘）只是先造一组**参考基** —— 它是从法线算出来的，
 * 作者说了不算。真正让作者能摆一扇斜窗、一块转过角度的灯板的是第三步：
 * 在 n 张的平面里把这组基转 roll。少了它，矩形的横竖永远是被推出来的。
 *
 * ⚠ u、v 已经是 n 的正交补里的一组正交基，所以绕 n 转就是平面内的二维旋转，
 *   **不需要 Rodrigues**（那是绕任意轴转任意向量才要的）。
 */
void areaAxes(vec3 n, float halfW, float halfH, float roll, out vec3 halfU, out vec3 halfV) {
    vec3 up = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 u = normalize(cross(up, n));
    vec3 v = cross(n, u);
    float c = cos(roll), s = sin(roll);
    vec3 ru = u * c + v * s;
    vec3 rv = v * c - u * s;
    halfU = ru * halfW;
    halfV = rv * halfH;
}

void main(void) {
    vec3 painting = lcSrgbToLinear(texture(uPainting, vUv).rgb);
    // ---- 场景法线 ----
    // ⚠ **rg 与 b 的编码不是一回事**，不能一起做 *2−1：
    //   bake.py 里 rg 存的是 xy*0.5+0.5（要 *2−1 还原），
    //   b 存的是 **|z| 直存 0..1**（不要 *2−1）。
    //
    //   原来写成 rgb*2−1 再 -abs(z)，等价于 n.z = −|2b−1| —— 一个二对一的 V 形：
    //   b=1 侥幸对（−1），b=0.5 解成 **0**（应为 −0.5），b=0 解成 **−1**（应为 0）。
    //   实测雾津街头 66% 的像素 z 误差 >0.2、法线中位偏 **20.4°**、24% 偏超 30°
    //   （中位 b=0.48 正好踩在 V 的谷底）。normalize 之后 xy 被顶起来，
    //   法线整体被扳向屏幕平面 —— 而 n 同时进 sDay、每盏灯的 N·L 与 march 起点。
    //
    //   同一套编码在角色两条路径里**都解对了**（-max(ne.b, .05)，不对 b 做 *2−1），
    //   这里跟它们对齐。max(...,0.05) 是防 b=0 时法线退化成零长。
    //   这条有机械契约锁着：normalEncoding.test.ts。
    vec3 nrmTex = texture(uNormal, vUv).rgb;
    vec3 n = normalize(vec3(nrmTex.r * 2.0 - 1.0,
                            nrmTex.g * 2.0 - 1.0,
                            -max(nrmTex.b, 0.05)));
    float skyvis = texture(uSkyvis, vUv).r;

    // 该像素的伪世界 q（供 march 起点用）
    vec2 px = vec2(vUv.x, vUv.y) * uDepthTexSize;
    float d = wrDecodeSceneDepth(texture(uDepth, vUv), uDepthMap.x, uDepthMap.y, uDepthMap.z);
    vec3 q = wrPixelToQ(px, uCal.x, uCal.y, uCal.z, d);

    // ---- 铁律 0：光照一律在世界空间、单位 wu ----
    //
    // 场景法线**已经是世界法线**，不要再转：tools/scene_relight/geometry.py:183-190
    // 是拿 pos = q @ R.T（世界位置）的梯度叉积算的，烘出来就在 M-world。
    // 坐标卡硬契约第 3 条也写着这句。
    //
    // ⚠ 2026-08-30 我一度在这里加了 nW = R·n，那是把已是世界的法线**又转了 45°**，
    //   是回归不是修复；当时拿来佐证的「关掉 emissive 就看见受光」那张图是改完之后拍的，
    //   没有改之前的对照，证明不了任何事。已回退。

    // ⛔ 去霾整段停用（2026-08-30）。
    //
    // 它存在的唯一理由写在下面原注释里：「若不除掉，它在夜里照样亮着 —— 远处一片亮灰
    // 正是大脑判定『这是白天』最强的信号」。也就是说，**它是为了把白天原画改造成夜晚**，
    // 是整体重打光那套的配套件。
    //
    // 制作人定调「原画就是最终的光照」之后，夜靠**换一张夜原画**得到，去霾就从"必要的
    // 一环"变成了"凭空篡改原画"——实测表现正是制作人当场指出的那条：不被灯覆盖的地方
    // 与原画对不上（画面发灰发白）。
    //
    // 保留代码不删：uHaze / uHazeColor 仍由 applyParams 填，将来若要做"运行时加雾"
    // 是加法而不是这里的减法，届时另起一段。
    if (false && uHaze.y > 0.0) {
        float dn = clamp((d - uHaze.z) / max(uHaze.w - uHaze.z, 1e-5), 0.0, 1.0);
        float T = exp(-uHaze.x * dn);
        vec3 hazeAmt = uHazeColor * (uHaze.y * (1.0 - T));
        // ★ 逐通道**不许拿走超过该通道自身的 (1−HAZE_KEEP)**。
        //
        // 原来写的是 max(painting - hazeAmt, 0.0) ——绝对量的减法配上**有颜色**的霾
        //（实测雾津街头 hazeColor = (0.835, 1.021, 1.144)，蓝减得最多、红最少），
        // 在暗部会把通道**非对称地钳到 0**：蓝绿先死、红活下来 ⇒ 画面上一片红色噪点。
        // 实测该场景 7.23% 的像素被部分钳零（其中 84% 只剩红通道）、18.87% 三通道全黑，
        // **孤立零点（=肉眼看到的噪点）占 5.02%**。
        //
        // 改成按自身设下限后：孤立零点 5.02% → **0.002%**，部分钳零 → 0.00%，
        // 且钳住时是整体按比例缩小 ⇒ **色度守恒**，不会凭空冒出彩点。
        // 结构上保证非负（结果 ≥ painting × HAZE_KEEP ≥ 0），所以不再需要 max(...,0)。
        //
        // ⚠ 占位场景 dehaze = 0，整段跳过 —— 27 个场景的"背景逐像素零变化"不受影响。
        painting = (painting - min(hazeAmt, painting * (1.0 - HAZE_KEEP))) / max(T, 0.15);
    }

    // ---- S_day：原画自带的自然光。**只用作 albedo 除数**（2026-08-30 起）----
    //
    // 制作人定调：原画就是最终的光照结果，运行时不再重打光。于是这一项不再有
    // 「参考光 vs 当前光」的比值语义，只剩一个用途——把 albedo 从原画里反解出来：
    //
    //     albedo ≈ painting / S_day
    //
    // 为什么非要它：lcPointLight 这些返回的是**辐照度**，而 painting 是**辐射亮度**
    // （已经是 albedo × 光）。直接把灯加到 painting 上就是不乘 albedo——黑石板会
    // 被照得像白墙。反解出 albedo 再乘灯，黑的地方才还是黑。
    //
    // 太阳项的 n 与 uDaySunDir 同为世界量（后者由 directionFromAngles 按 +Y=世界上
    // 构造），点乘合法。半球项 sDayHemi 不吃法线。
    float sDayHemi = (1.0 - uDayHemi) + uDayHemi * skyvis;
    float sDay = sDayHemi + uDaySunIntensity * max(dot(n, uDaySunDir), 0.0);

    // ---- 实体灯的辐照度累加（天光/太阳的运行时项已删）----
    //
    // ⚠ 这里**不再**累加天光与太阳。原画自带自然光，运行时再算一遍就是重复计光。
    // 「夜」不靠调暗天光实现，靠换一张夜原画 + 夜的 probe + 该时段的灯。
    vec3 lampE = vec3(0.0);

    // ---- 灯（点/聚/面/平行）----
    // 铁律 0（制作人 2026-08-30 定死）：光照一律在**世界空间、单位 wu**。
    // 朝向过 R、尺度过 uWuPerQUnit，一次转到底 —— 不许停在「世界朝向 + q 尺度」
    // 那个没有名字的中间态：那会让 range / 软化半径 / 面光尺寸在 shader 里不是 wu，
    // 而作者面明明按 wu 填，读代码的人无法判断某个长度是哪把尺。
    vec3 P = wrQToWorld(uMRow0, uMRow1, uMRow2, q) * uWuPerQUnit;
    // 灯体自发光：灯**本身是看得见的发光体**。这一项不乘 albedo（发光不是反射），
    // 所以单独累加、最后加到结果上。
    // ★ 这是"这是夜晚"最强的视觉信号——白天的原画里根本没有发光体，
    //   只把画整体压暗永远得不到它（那只会得到"低亮度的白天"）。
    vec3 emissive = vec3(0.0);
    for (int i = 0; i < ${MAX_STATIC_LIGHTS}; i++) {
        if (i >= uLightCount) break;
        vec4 A = uLightA[i], B = uLightB[i], C = uLightC[i], D = uLightD[i];
        int kind = int(A.w + 0.5);

        // ---- 两条**可证明无损**的早退：省掉的全是"算了也是零"的 march ----
        //
        // 阴影 march 是这一级最贵的东西(每盏灯每像素上百次深度采样)，而它原来
        // **对每个像素都跑**，不管这盏灯照不照得到这里。实测雾津街头：
        // 6 盏灯里有一盏(lamp_4)的作用范围内**没有一个像素**的照度超过天光的 1%，
        // 却照样跑满 2.36M 像素 × 全部步数。
        //
        // ① 强度为 0 的灯贡献恒等于 0。雾津街头的 moon 就是 intensity 0 还开着，
        //    白跑。这条不是优化是纠错——零乘任何数都是零。
        if (B.w <= 0.0) continue;
        // ② 超出高斯截断的地方贡献低于 1e-4 倍峰值。这个阈值**不是新定的**：
        //    lcAreaLight 里本来就有 "cut < 1e-4 就 return" 这一条，
        //    这里只是把同一条判据提到 march **之前**，免得先花一百多次采样
        //    算出一个随后被丢掉的可见性。
        if (kind != ${LC_DIRECTIONAL}) {
            vec3 dl = A.xyz - P;
            if (exp(-dot(dl, dl) / max(C.x * C.x, 1e-6)) < 1e-4) continue;
        }

        float vis = 1.0;
        // D.w 是位标志：bit0=castShadow bit1=twoSided（见 lightPacking.LIGHT_FLAG_*）
        int flags = int(D.w + 0.5);
        if ((flags & 1) != 0 && kind != ${LC_DIRECTIONAL}) {
            vis = lightVisibilityPrefix(i, px, d);
        }
        if (kind == ${LC_POINT}) {
            lampE += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, vis);
        } else if (kind == ${LC_SPOT}) {
            lampE += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, vis);
        } else if (kind == ${LC_AREA}) {
            vec3 hu, hv;
            areaAxes(normalize(D.xyz), C.z, C.w, C.y, hu, hv);
            lampE += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, vis);
        } else {
            // directional：方向光的遮挡走 uShadow 那条（与日月同一套），这里不再 march
            lampE += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
        }
        // ---- 灯体 + 大气光晕：沿**视线**积分，不是拿表面点到灯的距离 ----
        //
        // ⚠ 原来写的是 dd = dot(P - A.xyz, ...)，即「该像素表面点到灯的三维距离」。
        //   那根本不是大气光晕，是「离灯近的表面会发亮」，后果有两条、都被制作人当场看出来：
        //   ① 一遇到深度断层（屋檐、墙沿、路过的人）光晕就被切一刀 ⇒ **光晕不完整**。
        //      实测雾津街头：离灯等距的圆环上只有 13%–66% 是亮的，也就是说它本来就不是个圆。
        //   ② 阴影区的表面通常在深处、离灯远 ⇒ 那里既没有光也没有光晕。
        //
        // 大气光晕是**空气**散射出来的，与背后是什么表面无关。正确模型是沿视线把
        // 点光源的 1/r² 积起来（airlight）。伪世界 q 里视线恰好就是 z 轴，于是有闭式解：
        //
        //     ∫ dt / (r⊥² + (t − lz)²) = (1/r⊥)·[ atan((t − lz)/r⊥) ]
        //
        // 从近平面积到**该像素的真实表面深度** —— 挡在灯前面的东西会把积分截断，
        // 所以遮挡仍然成立；挡在灯后面的东西不再切光晕。
        //
        // ★ 这不是屏幕空间效果：r⊥ 是伪世界里灯到视线的**垂距**，积分沿真实视线走，
        //   上限是真实表面深度。深度分离是精确的，不是"屏幕上糊一圈"。
        if (kind != ${LC_DIRECTIONAL} && uCore.x > 0.0) {
            // 豁免③：大气光晕积的是**沿视线的路径**，不是表面着色，所以留在
            // q 的朝向里（视线恰好是 q 的 z 轴，闭式解才成立）。但**长度统一成 wu**
            // ——像素乘 uWuPerQUnit、灯位 A.xyz 本来就是 wu（wrWorldToQ 只转朝向不改尺度），
            // 于是 uCore 的灯体/光晕半径就是作者面那把 wu 尺。
            vec3 qw = q * uWuPerQUnit;
            vec3 lq = wrWorldToQ(uMRow0, uMRow1, uMRow2, A.xyz);
            float r2 = dot(qw.xy - lq.xy, qw.xy - lq.xy);
            // 近平面：深度的解码值域是 [offset, offset+scale]，取小的那端
            float dNear = min(uDepthMap.z, uDepthMap.z + uDepthMap.y) * uWuPerQUnit;
            // 灯体半径当软化：视线正穿过灯心时 1/r⊥ 会发散，物理上灯有大小
            float rc = sqrt(r2 + uCore.y * uCore.y);
            float rh = sqrt(r2 + uCore.z * uCore.z);
            float ac = (atan((qw.z - lq.z) / rc) - atan((dNear - lq.z) / rc)) / rc;
            float ah = (atan((qw.z - lq.z) / rh) - atan((dNear - lq.z) / rh)) / rh;
            // 视线积分归一到 0..1。它负责的是**深度正确的截断与遮挡**：
            // 挡在灯前面的东西把积分上限拉到自己那儿，光晕就被压暗。
            float visC = clamp(ac * uCore.y / 3.14159265, 0.0, 1.0);
            float visH = clamp(ah * uCore.z / 3.14159265, 0.0, 1.0);
            // ★ 高斯包络是**必须**的，不是好看：闭式解在 r⊥ ≫ 半径时退化成
            //   Δθ·R/(π·r⊥)，是条 **1/r⊥ 长尾、没有任何衰减**。实测只积分不加包络：
            //   光晕在 2359288/2359296 个像素上非零（≈100%），中位发光亮度是中位
            //   表面亮度的 **277 倍**，整张画被淹；而且「光晕半径」这个旋钮只剩幅度
            //   语义、框不住光了。
            //   同一个教训 lcFalloff 的注释里已经写过一次：
            //   「截断是必须的：没有它，夜景里一盏灯会把整张图都染暖（实测过）」。
            //
            //   分工：**积分管遮挡与深度，包络管范围**。两者相乘。
            float core = visC * exp(-r2 / max(uCore.y * uCore.y, 1e-9));
            float halo = visH * exp(-r2 / max(uCore.z * uCore.z, 1e-9));
            emissive += B.rgb * (B.w * uCore.x * (core + halo * uCore.w));
        }
    }

    if (uDebug == 1) { fragColor = vec4(vec3(skyvis), 1.0); return; }
    if (uDebug == 2) { fragColor = vec4(n * 0.5 + 0.5, 1.0); return; }
    if (uDebug == 3) { fragColor = vec4(vec3(sDay), 1.0); return; }
    if (uDebug == 4) { fragColor = vec4(lampE, 1.0); return; }
    if (uDebug == 5) { fragColor = vec4(clamp(painting / max(sDay, 1e-4), 0.0, 1.0), 1.0); return; }
    if (uDebug == 6) { fragColor = vec4(painting, 1.0); return; }

    // 发光体不乘 albedo（发光不是反射），所以加在重打光结果之外。
    // ★ alpha 存**灯体自发光占该像素的比例**（0..1）：GI gather 据此跳过打在灯本体上
    //   的射线——那是直接光，解析灯已经算过一遍（见 GiBouncePass 头注释）。
    //
    // ⚠ 存**比例**不存绝对亮度。绝对阈值会随灯的强度漂：灯调亮一档，被判成"灯体"
    //   的区域就跟着变大，把本该采到的反弹光一起挡掉——症状是"GI 不跟着灯变"。
    //   比例是尺度无关的，灯怎么调，判据都成立。
    // 显示端（LitBackground）只读 .rgb，不受影响。
    // ---- 合成：原画原样 + 反解 albedo × 实体灯（2026-08-30 起，取代整体重打光）----
    //
    //     surf = painting + (painting / S_day) × lampE
    //
    // 没有灯时 lampE == 0 ⇒ **surf 恒等于 painting**，原画分毫不动——这是制作人
    // 定的口径「原画就是最终的光照」。有灯时 painting / S_day 把 albedo 反解出来，
    // 灯才乘在正确的反照率上：黑石板照样是黑的，不会被照成白墙。
    //
    // ⚠ 反解出的 albedo 要钳。原画暗部除以一个小 sDay 会炸出巨大的假反照率，
    //   一盏灯扫过去就是一片过曝。上限 1.0 = 物理上反照率不可能超过 1。
    vec3 albedo = clamp(painting / max(sDay, 1e-4), 0.0, 1.0);
    // ---- uDebug==7「GI体」:场景与角色吃同一套 probe 体,肉眼对账 GI 数据 ----
    //
    // 场景 = 反解 albedo × probeE(q, n_q) × 2^β;角色本来就是 color × probeE × 2^β
    // (它的常规路径)。两边同一份体、同一把曝光尺 ⇒ 若 GI 体大体正确,此视图下
    // 场景应当**近似回到原画**(E 重建出画里的光),角色与场景浑然一体;
    // 哪里对不上,哪里就是体数据/尺度的问题。这同时是 E 绝对尺度的对账工具
    // (2026-08-31 实测 probe E 偏暗 ~16×,beta 补偿 —— 见 inbox)。
    //
    // ⚠ probeE 查表吃 **q 空间法线**(载荷按 q 烘,铁律 0 的查表豁免);
    //   场景法线 n 是 M-world,过 Rᵀ 转回去(wrWorldToQ,正交阵转置即逆)。
    //   位置实参是**本像素**深度重建的 q(上面 wrPixelToQ 那行,march 用的同一个),
    //   probeE 内部经 uM(det=−1 的 lighting.json world.M,与角色同一份 mCol)
    //   映到 probe 网格做 8 角三线性 —— 逐像素插值,不是每 cell 一个色块。
    if (uDebug >= 7 && uDebug <= 11) {
        vec3 nQ = normalize(wrWorldToQ(uMRow0, uMRow1, uMRow2, n));
        // 诊断·定法线:与角色侧 uFixedNQ 同一约定(0=正常 1=世界水平朝相机 2=世界向上)。
        // 双方同方向后,人与场景的亮度差 100% 是采样位置差。
        // 定法线=朝相机:直接用 q 常量(与角色两条路径同值)。旧写法过 det=-1 的 uMRow,
        // 与角色侧 det=+1 转出来的方向整个相反 —— 「同一档两侧各查各的」(2026-09-01)。
        if (uGiFixedN == 1) nQ = vec3(0., 0., -1.);
        else if (uGiFixedN == 2) nQ = normalize(wrWorldToQ(uMRow0, uMRow1, uMRow2, vec3(0., 1., 0.)));
        // 10=最近邻原始值:无插值,每个像素显示最近那颗 probe 的原始 E,数据糊在
        // 采样它的表面上(固定视角下把点阵投到屏幕会自遮挡,这才是能看的原始值视图)。
        // 与 8 档来回切 = 插值前后对照;invalid 格亮品红。
        // 11=「skyao体」:场景直采**角色的 skyao probe**,只算 AO(V 灰度,不乘画)。
        // 与角色 setCharDebugView(2) 同一份纹理、同一个 skyaoAt —— 灰度在人与
        // 场景之间应无缝续接;对不上就是 AO 数据/装配的问题,与光照无关。
        if (uDebug == 11) { fragColor = vec4(vec3(skyaoAt(q, nQ)), 1.0); return; }
        if (uDebug == 10) { fragColor = vec4(probeENearest(q, nQ) * uProbeBeta, 1.0); return; }
        vec3 Ep = probeE(q, nQ) * uProbeBeta;
        if (uDebug == 7) { fragColor = vec4(albedo * Ep, 1.0); return; }
        // 8=纯E:albedo≡1,直接看 E×2^β 的样子(角色侧同式,见 uEOnly)。
        if (uDebug == 8) { fragColor = vec4(Ep, 1.0); return; }
        // 9=纯E×probe棋盘:按 cell 奇偶压暗一半格子。用途是**校对采样位置**:
        // 格边必须落在相邻 probe 正中间、格子尺寸/走向必须贴着几何透视缩放;
        // 轴序错/尺度错/uM 喂错,棋盘立刻歪给你看。映射与采样共用 probeGridT,零漂移。
        ivec3 cell = ivec3(probeGridT(q));
        float par = float((cell.x + cell.y + cell.z) & 1);
        fragColor = vec4(Ep * mix(0.45, 1.0, par), 1.0);
        return;
    }
    vec3 surf = painting + albedo * lampE;
    float emitLum = dot(emissive, LC_LUMA);
    float emitFrac = emitLum / max(emitLum + dot(surf, LC_LUMA), 1e-6);
    fragColor = vec4(surf + emissive, emitFrac);
}
`;

export interface SceneLightingGeometry {
  /** lighting/<背景基名>/normal.png */
  normal: Texture;
  /** lighting/<背景基名>/skyvis.png */
  skyvis: Texture;
  /** raw_depth_rg.png（与 SceneDepthSystem 同一张） */
  depth: Texture;
  /** 深度图尺寸（native px） */
  depthSize: [number, number];
  /** native 标定：ppu, cx, cy */
  cal: [number, number, number];
  /** 1 个 q 单位 = 多少 wu。作者面 wu → march 的 q，就这一个桥。 */
  wuPerQUnit: number;
  /** depth_mapping：invert(0/1), scale, offset */
  depthMapping: [number, number, number];
  /** `depthConfig.M.R` 三行（**det = +1** 游戏约定）。q → M-world。 */
  mRows: [[number, number, number], [number, number, number], [number, number, number]];
  /** 烘焙期拟合出的**画内白天大气散射**。去掉它，远景才不会在夜里继续发亮。 */
  haze?: {
    k: number;
    strength: number;
    color: [number, number, number];
    depthMin: number;
    depthMax: number;
  };
}

export class SceneLightingPass {
  private readonly geo: SceneLightingGeometry;
  private readonly painting: Texture;
  private rt: RenderTexture | null = null;
  /** 阴影的线扫求解器。脏时先解它，主 pass 再查表。 */
  private prefix: ShadowPrefixPass | null = null;
  /** 上一次解出来的灯（按 packLights 下标），用于填 uLightPx。 */
  private prefixLights: PrefixLight[] = [];
  /** 起步偏置（q 空间），线扫初始化要用。 */
  private prefixBiasQ = 0;
  /** 与 `CharacterLitSprite.LitSpriteQuad` 同一个类型形状（自定义 shader 的 mesh）。 */
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private dirty = true;
  private destroyed = false;
  /** 最近一次 applyParams 打包好的灯。角色 shader 直接复用，保证两边逐位一致。 */
  private packed: PackedLights | null = null;

  get packedLights(): PackedLights | null {
    return this.packed;
  }

  /** 装载期传进来的几何（角色侧要复用同一套标定，别另建一份）。 */
  get geometry(): SceneLightingGeometry {
    return this.geo;
  }

  constructor(painting: Texture, geo: SceneLightingGeometry) {
    this.painting = painting;
    this.geo = geo;
  }

  /** 缓存好的线性 HDR 辐射场。未 update 过时为 null。 */
  get radiance(): RenderTexture | null {
    return this.rt;
  }

  /** 参数或灯变了。下一次 update 会重算。 */
  markDirty(): void {
    this.dirty = true;
  }

  private ensure(): void {
    if (this.rt || this.destroyed) return;
    const [w, h] = this.geo.depthSize;
    // ★ RGBA16F：显示变换绝不能烤进这一级，否则动态范围被毁（实测只剩 17×）
    this.rt = RenderTexture.create({
      width: w, height: h,
      format: 'rgba16float',
      scaleMode: 'linear',
      antialias: false,
    });

    // 顶点用 RT 像素坐标（走标准变换链，见 BAKE_VERT 的注释）
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

    this.shader = Shader.from({
      gl: { vertex: BAKE_VERT, fragment: BAKE_FRAG },
      resources: {
        uPainting: this.painting.source,
        // 线扫前缀的两张 slab。solve() 之前先拿深度纹理占位（尺寸一致，
        // 内容不会被读到 —— uLightPx[i].w = 0 时 lightVisibilityPrefix 直接返回 1）。
        uPrefix0: this.geo.depth.source,
        uPrefix1: this.geo.depth.source,
        uNormal: this.geo.normal.source,
        uSkyvis: this.geo.skyvis.source,
        uDepth: this.geo.depth.source,
        // 「GI体」视图的 probe 图集:创建期占位白图,开启视图时由 setProbeResources 换真图
        uPL1: Texture.WHITE.source,
        uPL2: Texture.WHITE.source,
        uPBin: Texture.WHITE.source,
        uValid: Texture.WHITE.source,
        uSkyaoTex: Texture.WHITE.source,
        sceneLight: {
          uDepthTexSize: { value: new Float32Array(this.geo.depthSize), type: 'vec2<f32>' },
          uCal: { value: new Float32Array(this.geo.cal), type: 'vec3<f32>' },
          uDepthMap: { value: new Float32Array(this.geo.depthMapping), type: 'vec3<f32>' },
          uSkyColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSkyIntensity: { value: 1, type: 'f32' },
          uSkyHemi: { value: 0.35, type: 'f32' },
          uAoStrength: { value: 1, type: 'f32' },
          uDayHemi: { value: 0.35, type: 'f32' },
          uDaySunIntensity: { value: 0, type: 'f32' },
          uDaySunDir: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
          uSunColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSunIntensity: { value: 0, type: 'f32' },
          uSunDir: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
          uShadow: { value: new Float32Array([0.9, 3.5, 48, 2]), type: 'vec4<f32>' },
          uShadowBias: { value: new Float32Array([0.035, 2]), type: 'vec2<f32>' },
          uRatioMax: { value: 8, type: 'f32' },
          uDebug: { value: 0, type: 'i32' },
          uGiFixedN: { value: 0, type: 'i32' },
          uWuPerQUnit: { value: 1, type: 'f32' },
          uMRow0: { value: new Float32Array(3), type: 'vec3<f32>' },
          uMRow1: { value: new Float32Array(3), type: 'vec3<f32>' },
          uMRow2: { value: new Float32Array(3), type: 'vec3<f32>' },
          uCore: { value: new Float32Array([0, 0.05, 0.25, 0.25]), type: 'vec4<f32>' },
          uLightPx: {
            value: new Float32Array(MAX_STATIC_LIGHTS * 4),
            type: 'vec4<f32>', size: MAX_STATIC_LIGHTS,
          },
          uHaze: { value: new Float32Array([0, 0, 0, 1]), type: 'vec4<f32>' },
          uHazeColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uLightCount: { value: 0, type: 'i32' },
          uLightA: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          uLightB: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          uLightC: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          uLightD: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          // ---- 「GI体」视图(uDebug==7) ----
          uM: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), type: 'mat3x3<f32>' },
          uWMin: { value: new Float32Array(3), type: 'vec3<f32>' },
          uWScale: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uPN: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uProbeT: { value: 1, type: 'f32' },
          uShK: { value: 9, type: 'f32' },
          uBinOb: { value: 8, type: 'f32' },
          uFold: { value: 1, type: 'f32' },
          uAmbSH: { value: new Float32Array(27), type: 'vec3<f32>', size: 9 },
          uMode: { value: 2, type: 'f32' },
          uAmbStrength: { value: 1, type: 'f32' },
          uProbeBeta: { value: 1, type: 'f32' },
          // ---- 「skyao体」视图(uDebug==11) ----
          uSkyaoN: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSkyaoTiles: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uSkyaoMin: { value: new Float32Array(3), type: 'vec3<f32>' },
          uSkyaoScale: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSkyaoM: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), type: 'mat3x3<f32>' },
          uSkyaoOn: { value: 0, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });

    // 阴影的线扫求解器与本 pass 同生命周期
    this.prefix = new ShadowPrefixPass({
      depth: this.geo.depth,
      depthSize: this.geo.depthSize,
      depthMapping: this.geo.depthMapping,
      cal: this.geo.cal,
    });
  }

  /**
   * 把场景光照参数写进 uniform。**不触发重算**，调用方随后 markDirty。
   * @param bakedDayHemi 烘焙期拟合出的原画遮蔽响应，`def.day.hemi` 缺省时用它。
   */
  /**
   * `phase` = 当前时段 id，用于按 `LightDef.phases` 过滤灯（缺省全时段）。
   * 传空串 = 不过滤（场景没开日夜，或调用方拿不到时刻）。
   */
  applyParams(def: SceneLightingDef, bakedDayHemi?: number, phase = ''): void {
    this.ensure();
    const u = this.shader?.resources.sceneLight?.uniforms;
    if (!u) return;

    const sky = resolveLightColor(def.sky.color, def.sky.kelvin);
    u.uSkyColor.set(sky);
    u.uSkyIntensity = def.sky.intensity;
    u.uSkyHemi = def.sky.hemi;
    u.uAoStrength = def.aoStrength ?? 1;
    u.uRatioMax = def.ratioMax ?? 8;

    // 缺省用烘焙期拟合值——这个量必须与原画匹配，手填必错（见 DayReferenceDef.hemi）
    u.uDayHemi = def.day.hemi ?? bakedDayHemi ?? 0.9;
    u.uDaySunIntensity = def.day.sunIntensity;
    u.uDaySunDir.set(directionFromAngles(def.day.sunElevationDeg, def.day.sunAzimuthDeg));

    u.uWuPerQUnit = this.geo.wuPerQUnit;
    const M = this.geo.mRows;
    u.uMRow0.set(M[0]);
    u.uMRow1.set(M[1]);
    u.uMRow2.set(M[2]);

    // ★ 灯的打包走 packLights —— 角色侧读的是**同一次调用的结果**（见 this.packed），
    //   所以「角色与场景明暗一致」在构造上就成立，不靠两处代码碰巧写得一样。
    const packed = packLights(def, this.geo.wuPerQUnit, phase);
    this.packed = packed;
    if (packed.dropped > 0) {
      console.warn(
        `[SceneLightingPass] 静态灯超过上限 ${MAX_STATIC_LIGHTS}，丢弃 ${packed.dropped} 盏`
        + ' —— 静默截断会让美术以为灯没生效，这里必须响',
      );
    }
    u.uSunColor.set(packed.sunColor);
    u.uSunIntensity = packed.sunIntensity;
    u.uSunDir.set(packed.sunDir);
    u.uShadow.set(packed.shadow);
    u.uShadowBias.set(packShadowBias(def, 1 / Math.max(this.geo.wuPerQUnit, 1e-9)));

    // ---- 线扫前缀要用的灯位（折进 q）与它们在图像上的落点 ----
    // 世界 → q：M 正交，转置即逆（与 GLSL 的 wrWorldToQ 同式，CPU 上做一次就够）
    const mr = this.geo.mRows;
    const toQ = (w: readonly number[]): [number, number, number] => [
      mr[0][0] * w[0] + mr[1][0] * w[1] + mr[2][0] * w[2],
      mr[0][1] * w[0] + mr[1][1] * w[1] + mr[2][1] * w[2],
      mr[0][2] * w[0] + mr[1][2] * w[1] + mr[2][2] * w[2],
    ];
    const [ppu, cx, cy] = this.geo.cal;
    const lpx = new Float32Array(MAX_STATIC_LIGHTS * 4);
    this.prefixLights = [];
    for (let i = 0; i < packed.count; i++) {
      const o = i * 4;
      const kind = packed.a[o + 3];
      const cast = (packed.d[o + 3] & 1) !== 0;
      // slab 两张 x 4 通道 = 前 8 盏带影灯走线扫；再多的回落成不投影
      //（带影灯预算本来就是 SHADOW_LIGHT_BUDGET=6，超了编辑器会标红）
      const usable = cast && kind !== LIGHT_KIND_CODE.directional
        && i < LIGHTS_PER_SLAB * 2;
      const q = toQ([packed.a[o], packed.a[o + 1], packed.a[o + 2]]);
      this.prefixLights.push({ q, castShadow: usable });
      if (!usable) continue;
      lpx[o] = cx + q[0] * ppu;
      lpx[o + 1] = cy - q[1] * ppu;
      lpx[o + 2] = q[2];
      lpx[o + 3] = 1;
    }
    (u.uLightPx as Float32Array).set(lpx);
    this.prefixBiasQ = packShadowBias(def, 1 / Math.max(this.geo.wuPerQUnit, 1e-9))[0];
    (u.uLightA as Float32Array).set(packed.a);
    (u.uLightB as Float32Array).set(packed.b);
    (u.uLightC as Float32Array).set(packed.c);
    (u.uLightD as Float32Array).set(packed.d);
    u.uLightCount = packed.count;

    // 灯体自发光 + 大气光晕（wu）
    u.uCore.set(packEmissive(def, this.geo.wuPerQUnit));

    // 去掉画里的白天大气散射（由烘焙期拟合出来，见 bake.fit_haze）
    const hz = this.geo.haze;
    if (hz && (def.dehaze ?? 1) > 0) {
      u.uHaze.set([hz.k, hz.strength * (def.dehaze ?? 1), hz.depthMin, hz.depthMax]);
      u.uHazeColor.set(hz.color);
    } else {
      u.uHaze.set([0, 0, 0, 1]);
    }
  }

  /**
   * 调试可视化：0=正常 1=天穹可见性 2=法线 3=S_day 4=S_new 5=比值 6=线性化原画。
   * 会标脏（下一帧重算）。F2 的「显示 skyvis 场」等按钮走这条。
   */
  setDebug(mode: number): void {
    this.ensure();
    const u = this.shader?.resources.sceneLight?.uniforms;
    if (!u) return;
    u.uDebug = mode | 0;
    this.dirty = true;
  }

  /** 诊断·定法线(GI体档):0=正常 1=世界水平 2=世界向上。与角色侧 uFixedNQ 同约定。 */
  setGiFixedN(n: number): void {
    this.ensure();
    const u = this.shader?.resources.sceneLight?.uniforms;
    if (!u) return;
    u.uGiFixedN = n | 0;
    this.dirty = true;
  }

  /**
   * 喂「GI体」调试视图(uDebug==7)要的角色 probe 资源。传 null = 退回占位白图。
   *
   * 与角色 shader 绑**同一批 TextureSource**(单一数据源);probe 图集是按需加载、
   * 可中途整批热替换的(CharacterLightingSystem.ensureProbeAtlas),所以每次**开启**
   * 视图时现取现喂,不做常驻绑定 —— 常驻就得跟着角色系统的纹理生命周期走,
   * 一个调试视图不值得那个耦合。
   */
  setProbeResources(res: {
    atlasL1: import('pixi.js').TextureSource;
    atlasL2: import('pixi.js').TextureSource;
    atlasBin: import('pixi.js').TextureSource;
    valid: import('pixi.js').TextureSource;
    mCol: Float32Array;
    wMin: [number, number, number];
    wScale: [number, number, number];
    pn: [number, number, number];
    probeT: number;
    /** 'l2' 图集每颗的球谐系数数(9=L2 / 25=L4) */
    shK: number;
    /** 八面体边长(8 或 16) */
    binOb: number;
    /** skyao probe(可缺:老载荷没有,视图 11 显示全白) */
    skyao: {
      tex: import('pixi.js').TextureSource;
      n: [number, number, number];
      tiles: [number, number];
      wMin: [number, number, number];
      wScale: [number, number, number];
      mCol: Float32Array;
    } | null;
    ambSH: Float32Array;
    mode: number;
    ambStrength: number;
    beta: number;
    fold: number;
  } | null): void {
    if (!this.shader) return;
    const r = this.shader.resources as Record<string, unknown>;
    r.uPL1 = res ? res.atlasL1 : Texture.WHITE.source;
    r.uPL2 = res ? res.atlasL2 : Texture.WHITE.source;
    r.uPBin = res ? res.atlasBin : Texture.WHITE.source;
    r.uValid = res ? res.valid : Texture.WHITE.source;
    r.uSkyaoTex = res?.skyao ? res.skyao.tex : Texture.WHITE.source;
    const u = this.shader.resources.sceneLight?.uniforms;
    if (!u || !res) return;
    (u.uM as Float32Array).set(res.mCol);
    (u.uWMin as Float32Array).set(res.wMin);
    (u.uWScale as Float32Array).set(res.wScale);
    (u.uPN as Float32Array).set(res.pn);
    u.uProbeT = res.probeT;
    u.uShK = res.shK;
    u.uBinOb = res.binOb;
    (u.uAmbSH as Float32Array).set(res.ambSH);
    // RT(0) 不是查表模式,probeE 里会落到 BIN 分支采到占位图 —— 钳到 L1..BIN
    u.uMode = Math.min(Math.max(res.mode, 1), 3);
    u.uAmbStrength = res.ambStrength;
    u.uFold = res.fold;
    u.uProbeBeta = Math.pow(2, res.beta);
    // skyao:缺载荷 → uSkyaoOn=0,skyaoAt 恒 1(视图 11 全白,与角色降级口径一致)
    u.uSkyaoOn = res.skyao ? 1 : 0;
    if (res.skyao) {
      (u.uSkyaoN as Float32Array).set(res.skyao.n);
      (u.uSkyaoTiles as Float32Array).set(res.skyao.tiles);
      (u.uSkyaoMin as Float32Array).set(res.skyao.wMin);
      (u.uSkyaoScale as Float32Array).set(res.skyao.wScale);
      (u.uSkyaoM as Float32Array).set(res.skyao.mCol);
    }
  }

  /** 脏则重算缓存。返回是否真的重算了（供性能观测与测试断言）。 */
  update(renderer: Renderer): boolean {
    if (this.destroyed) return false;
    this.ensure();
    if (!this.dirty || !this.rt || !this.mesh) return false;

    // ★ 先解阴影的线扫前缀，主 pass 再一次查表取用。
    //   两级都在"脏时"这一档里，稳态每帧仍是零成本。
    if (this.prefix && this.prefixLights.length > 0) {
      this.prefix.solve(renderer, this.prefixLights, this.prefixBiasQ);
      const s0 = this.prefix.slab(0);
      const s1 = this.prefix.slab(1);
      const r = this.shader?.resources;
      if (r) {
        if (s0) r.uPrefix0 = s0.source;
        // 只有一组时把第二张也指向第一张 —— 采样器不许悬空，
        // 而 uLightPx[i].w=0 保证那些通道根本不会被读。
        r.uPrefix1 = (s1 ?? s0 ?? this.geo.depth).source;
      }
    }
    renderer.render({ container: this.mesh, target: this.rt, clear: true });
    this.dirty = false;
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    // ⚠ Pixi 坑②：绑了按场景销毁纹理的对象，卸载必须**先解绑再销毁**，
    //   顺序反了不是泄漏，是把 shader 的 BindGroup 永久烧毁。
    this.mesh?.destroy();
    this.mesh = null;
    this.shader = null;
    this.prefix?.destroy();
    this.prefix = null;
    this.rt?.destroy(true);
    this.rt = null;
  }
}
