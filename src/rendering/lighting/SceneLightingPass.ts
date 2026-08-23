import {
  Mesh, MeshGeometry, RenderTexture, Shader,
  type Renderer, type Texture,
} from 'pixi.js';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import { skyIrradianceSh } from './skySh';
import {
  LIGHT_KIND_CODE,
  MAX_STATIC_LIGHTS, type PackedLights, directionFromAngles, packEmissive, packLights, sunDirectionOf,
  packShadowBias,
} from './lightPacking';
import { LIGHTS_PER_SLAB, type PrefixLight, ShadowPrefixPass } from './shadowPrefix';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import SHADE_CORE_3 from './shadeCore3.glsl?raw';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

/**
 * 场景光照 pass —— 把原画重打光成「当前时刻自然光下的样子」，产出**线性 HDR 辐射场**。
 *
 * ## 两级结构（效率的关键）
 *
 * ```
 * ①【脏时重算】原画 × (S_new / S_day) → RGBA16F 缓存 RT
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
 * `S_day` 与 `S_new` 都由**天穹可见性场**（烘出来的几何项）与**定向光的深度场投影**构成；
 * 除/乘只是最后一步算术。
 * ⚠ **被否**（2026-08-20 制作人当场否决）：S 只用法线朝上项、不做任何 march 的写法
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
// ⚠ 拼接顺序固定 LC → SC3：shadeCore3 用 lightingCore 的 LC_* 常量与 lc* 函数。
const SC3 = slice(SHADE_CORE_3, 'SHADE_CORE_3');

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
 * 重打光 shader（v3 / G-buffer）。**只产线性 HDR 辐射，不做雾、不做显示变换**
 * ——那两样在逐帧那一级。一个像素的完整链路：
 *
 *     基底 × ( 烘焙GI + 天光·传输基 + 环境反弹 + 日月 + 灯 )  →  + 自发光
 *
 * ⚠ **没有分母了**。v2 是「原画 ÷ S_day × S_new」，S_day 那一步现在**在烘焙期做完**
 *   （`bake_gbuffer.py` 在伪世界里 final gather 积出 E，直接产出 `lighting3/base.png`）。
 *   运行时只剩一次乘法 —— 这正是角色能走同一条路径的前提：角色没有原画可除，
 *   但它有自己的解析 E_ref，两边除完就进同一个空间。
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

uniform sampler2D uBase;         // lighting3/base.png（sRGB8，× uBaseScale）
uniform sampler2D uNormal;       // lighting3/normal.png
uniform sampler2D uSkyOcc;       // lighting3/sky_occlusion.png（RGB = bent 方向，A = 可见度）
uniform sampler2D uVisLin;       // lighting3/vis_linear.png（RGB = b/(2*bmax)+0.5，A = a）
uniform float uVisBMax;          // 上面那张的 b 缩放
uniform sampler2D uAo;          // lighting3/ao.png（R8 = 局部封闭度，与天穹是两个量）
uniform sampler2D uIrradiance;   // lighting3/irradiance.png（烘焙 GI，from_hdr 编码）
uniform sampler2D uDepth;        // raw_depth_rg.png

uniform vec2  uDepthTexSize;
uniform vec3  uCal;              // ppu, cx, cy（native 分辨率标定）
uniform vec3  uDepthMap;         // invert, scale, offset
// depthConfig.M.R 三行（**det = +1** 的游戏约定矩阵，不是实验室那份 det = −1 的）
uniform vec3  uMRow0;
uniform vec3  uMRow1;
uniform vec3  uMRow2;

uniform float uBaseScale;        // base 的对数编码中心（= 2^(-span/2)）
uniform float uBaseLogSpan;      // base 的对数编码跨度（档）
uniform float uGi;               // 烘焙 GI 的权重。1 = 原样吃（画面≡原画）
uniform float uIrradianceScale;  // 烘焙 GI 的对数编码中心（= 该场景 E 的中位）
uniform float uIrradianceLogSpan;// 烘焙 GI 的对数编码跨度（档）


uniform vec3  uAmbientColor;     // 环境反弹底（多次反弹）
uniform float uAmbientIntensity;

// 世界 AABB —— 只给 SC3_DEBUG_POSITION 归一用，不进光照计算。
// 与角色网格取同一份边界，所以两边的位置视图颜色可以直接对照。
uniform vec3  uGridMin;
uniform vec3  uGridMax;

uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSunDir;           // 指向光源（世界）
uniform vec4  uShadow;           // strength, len, steps, soft(未用于 march)
uniform vec2  uShadowBias;       // bias0, thick

/** 逐 buffer 调试视图。编号见 shadeCore3.glsl 的 SC3_DEBUG_*，**与角色共用一套**。 */
uniform int   uDebug;

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
// 每盏灯在**图像**上的位置 xy 与在 q 里的深度 z;w = 这盏灯有没有前缀解（0 = 回落）
uniform vec4 uLightPx[${MAX_STATIC_LIGHTS}];
// ⚠ v2 的去霾 uniform（uHaze / uHazeColor / HAZE_KEEP）已整体移除。
//   「去掉画里的白天大气散射」现在**在烘焙期做完**，在 final gather 之前。
//   运行时再去一遍等于对同一份散射减两次。夜的雾另在显示级按 σ 加回
//   （LitBackground），那是**加**不是**减**，两者不冲突。


uniform int  uLightCount;
uniform vec4 uLightA[${MAX_STATIC_LIGHTS}];
uniform vec4 uLightB[${MAX_STATIC_LIGHTS}];
uniform vec4 uLightC[${MAX_STATIC_LIGHTS}];
uniform vec4 uLightD[${MAX_STATIC_LIGHTS}];

${WR_CORE}
${LC}
${SC3}

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
    // ---- G-buffer 取样 ----
    // base 是**原生分辨率**的（它替代 background.png 进渲染路径），
    // 其余几何量是 work 分辨率的低频量，由硬件线性过滤升采样。
    // ⚠ 对数编码（一侧对齐：base=1 钉在编码上端）。吃**原始字节**，
    //   绝不能先过 lcSrgbToLinear —— sRGB 的线性趾部在 base ~3e-4 处每档跳
    //   100%，而那正是暗物体逆光剪影的量级。
    //   字节 0 表示**精确的 0**（天空、以及真值低于编码下限的近黑像素）——
    //   少了这条，那些像素的 base 会被抬到下限、base·E 超过原画，自发光钳成 0
    //   之后本该全黑的地方会发灰（实测某场景往返 p99 12.1/255）。
    vec3 basePx = texture(uBase, vUv).rgb;
    vec3 base = sc3DecodeLogHdr(basePx, uBaseScale, uBaseLogSpan)
              * step(vec3(0.5 / 255.0), basePx);

    // ---- 场景法线 ----
    // 三通道**同一条** n*0.5+0.5，解码统一 *2−1（bake_gbuffer.bake 写的就是这个）。
    //
    // ⚠ 这里存的是**世界法线**，不是视空间法线 —— z 两头都有。实测 28 个场景
    //   n.z > 0 的像素占 10.6%–39.8%（最高 +0.74）。所以角色那套「b 存 |z|、
    //   解码时强制取负」的约定**表达不了这张图**：那是给视空间法线贴图用的，
    //   视空间下法线必然朝相机、z 恒为负，这里不是。
    //
    // ⚠ 曾经这一处就是照抄角色那套写的（-max(nrmTex.b, 0.05)），而 v3 烘焙侧
    //   已经改成全值域编码 —— 实测着色器拿到的法线**中位偏 23°–33°、25%–57%
    //   的像素偏超 30°**。默认画面看不出来（gi=1 时只走 base·E，不过法线），
    //   一重打光就每盏灯的 N·L 全歪。机械契约：normalEncoding.test.ts。
    //   ⚠ 这一段在 GLSL 模板串里，**不许出现反引号**（glslTemplateLint 锁着）。
    vec3 nrmTex = texture(uNormal, vUv).rgb;
    vec3 n = normalize(nrmTex * 2.0 - 1.0);

    // ---- 天穹遮蔽：bent 方向 + 余弦加权可见度 ----
    // 场景侧法线在烘焙期就已知，所以这里的可见度是**精确**的（不是 L1 估计）。
    // 角色侧存的是同一个量的 SH-L1，两边进同一个 sc3SkyIrradiance。
    vec4 visLinPx = texture(uVisLin, vUv);
    // 任意方向的可见度：a 在 alpha，b 在 rgb（乘回 2*bmax）
    vec4 visLin = vec4((visLinPx.rgb * 2.0 - 1.0) * uVisBMax, visLinPx.a);
    vec4 occPx = texture(uSkyOcc, vUv);
    vec3 bentDir = normalize(occPx.rgb * 2.0 - 1.0 + vec3(1e-6));
    float skyVis = occPx.a;
    float ao = texture(uAo, vUv).r;

    // ---- 烘焙 GI 与自发光 ----
    // giE 是烘焙期在伪世界里 final gather 积出来的辐照度 —— **原画自身的照明**。
    // uGi = 1 时 base·giE ≡ min(原画, E)（精确到量化，烘焙期有断言）。
    // ⚠ 2026-08-23 起载荷里**没有自发光**（制作人：「光都是单独打」）。画里
    //   发出的比收到的多的像素（灶口、灯笼、天）被 base 的上限 1 钳住，
    //   gi=1 时会比原画暗 —— 那儿该由作者摆一盏真灯。
    // 重打光就是把 uGi 调低、把下面的天光/灯加上去：这是一条**连续**的路，
    // 不是"要么原画要么全新"的开关。
    // ⚠ 对数编码：直接吃**原始字节**，绝不能先过 lcSrgbToLinear（见 sc3DecodeLogHdr）。
    vec3 giE = sc3DecodeLogHdr(texture(uIrradiance, vUv).rgb,
                               uIrradianceScale, uIrradianceLogSpan) * uGi;
    // 自发光不乘任何 E —— 它不反射光，它就是光（灶口、灯笼、天）。

    // 该像素的伪世界 q（供 march 起点用）
    vec2 px = vec2(vUv.x, vUv.y) * uDepthTexSize;
    float d = wrDecodeSceneDepth(texture(uDepth, vUv), uDepthMap.x, uDepthMap.y, uDepthMap.z);
    vec3 q = wrPixelToQ(px, uCal.x, uCal.y, uCal.z, d);

    // ---- ① 天光：传输基 × 当前天穹 ----
    vec3 skyE = sc3SkyIrradiance(bentDir, skyVis, n);

    // ---- ② 环境反弹底：吃遮蔽但不归零 ----
    // 与烘焙侧 E_est 的常数项 c₀ 同一个角色。少了它巷道会黑得不合理 ——
    // 那不是打光风格，是漏了一项（实测 c₀ 在多数场景比天光项还大）。
    vec3 ambientE = uAmbientColor * (uAmbientIntensity * sc3AmbientTerm(ao));

    // ---- ③ 日/月 ----
    vec3 sunE = vec3(0.0);
    float sunVis = 1.0;
    if (uSunIntensity > 0.0) {
        // ⚠ 遮蔽走**线性重建**，不 march。烘焙期与运行时是同一条式子，
        //   所以换太阳方向不用重烘。旧的 lcMarchVisibility 那条已废弃 ——
        //   它对 delta 光源给出的是硬边二值图，配上软深度图就是锯齿黑块。
        sunVis = 1.0 - uShadow.x * (1.0 - sc3DirectVisibility(visLin, normalize(uSunDir)));
        sunE = lcDirectionalLight(n, uSunDir, uSunColor, uSunIntensity, sunVis);
    }
    vec3 lampE = vec3(0.0);

    // ---- 灯（点/聚/面/平行）。全在**伪世界空间**求值（铁律 S12）----
    vec3 P = wrQToWorld(uMRow0, uMRow1, uMRow2, q);
    // 灯体自发光：灯**本身是看得见的发光体**。这一项不乘基底（发光不是反射），
    // 所以单独累加、最后加到结果上。
    // ★ 这是"这是夜晚"最强的视觉信号——白天的原画里根本没有发光体，
    //   只把画整体压暗永远得不到它（那只会得到"低亮度的白天"）。
    vec3 lampEmissive = vec3(0.0);
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
            vec3 lq = wrWorldToQ(uMRow0, uMRow1, uMRow2, A.xyz);
            float r2 = dot(q.xy - lq.xy, q.xy - lq.xy);
            // 近平面：深度的解码值域是 [offset, offset+scale]，取小的那端
            float dNear = min(uDepthMap.z, uDepthMap.z + uDepthMap.y);
            // 灯体半径当软化：视线正穿过灯心时 1/r⊥ 会发散，物理上灯有大小
            float rc = sqrt(r2 + uCore.y * uCore.y);
            float rh = sqrt(r2 + uCore.z * uCore.z);
            float ac = (atan((q.z - lq.z) / rc) - atan((dNear - lq.z) / rc)) / rc;
            float ah = (atan((q.z - lq.z) / rh) - atan((dNear - lq.z) / rh)) / rh;
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
            lampEmissive += B.rgb * (B.w * uCore.x * (core + halo * uCore.w));
        }
    }

    // ---- 逐 buffer 调试视图 ----
    // ⚠ 走 sc3DebugView，与**角色用的是同一套编号、同一个函数** —— 同一个编号
    //   在场景和角色上必是同一个量，F2 里两边对照才有意义。
    if (uDebug != SC3_DEBUG_OFF) {
        vec3 span = max(uGridMax - uGridMin, vec3(1e-5));
        vec3 posNorm = (wrQToWorld(uMRow0, uMRow1, uMRow2, q) - uGridMin) / span;
        vec3 dbg = sc3DebugView(uDebug, base, n, posNorm, bentDir, skyVis, ao,
                                skyE + ambientE, sunE, lampE, giE, sunVis,
                                lampEmissive);
        // ⚠ 本 pass 写的是**线性 HDR 辐射场**，显示变换在 LitBackground 那一级。
        //   所以辐射量直接原样写进 RT（下游会做变换），非辐射量则先编码成
        //   显示域再写 —— 否则它会被下游的 2^ev 再乘一次，烧成一片白。
        fragColor = vec4(sc3DebugIsRadiometric(uDebug) ? dbg : lcSrgbToLinear(lcLinearToSrgb(dbg)), 1.0);
        return;
    }

    // 发光体不乘基底（发光不是反射），所以加在重打光结果之外。
    //
    // ⚠ alpha 曾经存"灯体自发光占该像素的比例"，供 GiBouncePass 跳过打在灯本体
    //   上的射线。那个 pass 在 v3 删掉了（场景的反弹现在是烘焙期 final gather 积出
    //   的 irradiance.png），于是这个值**再没有任何消费端** —— LitBackground
    //   只读 rgb。留着一个没人读的通道 + 一段指向已删模块的注释，比删掉更贵：
    //   下一个人会以为它有用。要重新用的话重算一次就是两行。
    // ★ 场景与角色的**唯一会合点**：两边都走 sc3Shade。
    //   场景把烘焙 GI 传进第四个槽；角色按要求当前传 0（"角色暂时不考虑 gi"）。
    vec3 surf = sc3Shade(base, skyE + ambientE, sunE + lampE, giE);
    fragColor = vec4(surf + lampEmissive, 1.0);
}
`;

export interface SceneLightingGeometry {
  /**
   * `lighting3/base.png` —— **比例基底（`I_原画 / E`），原生分辨率**。
   *
   * ⚠ 它**不是 albedo**：是比例式 `I_out = I_原画 × E_目标 / E` 里被提出来的
   * 中间因子。数值上落在反射率量级（因为 `E` 是伪世界 final gather 积出的
   * 真辐照度），但它不是"反解出的材质"。
   *
   * ⚠ 它**替代 background.png 进渲染路径**，不是辅助图。所以它必须是原生分辨率：
   * 烘在 work 分辨率等于把背景降采样，画面直接糊。其余几何量（法线/传输/GI）
   * 是低频的，work 分辨率由硬件线性过滤升采样即可。
   */
  base: Texture;
  /**
   * base 的**对数编码**参数。一侧对齐：`base ≤ 1` 是物理上界，1.0 钉在编码
   * 上端、往下覆盖 2^-span，于是 `scale = 2^(-span/2)`。
   *
   * ⚠ 不能用 sRGB8。sRGB 暗端那段线性趾部的绝对步长恒为 3.0e-4，而暗物体
   * 逆光剪影的 base 实测就在 3e-4 —— 一档 100% 相对误差，乘上巨大的 `E`
   * 之后是肉眼可见的偏差（实测某场景往返 p99 22.2/255）。
   */
  baseScale: number;
  baseLogSpan: number;
  /**
   * `lighting3/irradiance.png` —— **烘焙 GI**：伪世界 final gather 积出的
   * 原画自身辐照度。编码 `x/(1+x)` 再 sRGB8（无需 scale，见 sc3ToHdr）。
   *
   * ⚠ 这是正式载荷不是调试图。`gi = 1` 时 `base·E + emissive ≡ 原画`。
   */
  irradiance: Texture;
  /**
   * 烘焙 GI 的**对数编码**参数（逐场景不同，`scale` = 该场景 `E` 的中位）。
   *
   * ⚠ 没有合理缺省。填错不会报错，只是整个场景的亮度沿一条幂曲线歪掉 ——
   * 所以由 `SceneLightingSystem` 从 meta 直读传进来，绝不在着色器侧兜底。
   */
  irradianceScale: number;
  irradianceLogSpan: number;
  /** `lighting3/normal.png` */
  normal: Texture;
  /** `lighting3/sky_occlusion.png` —— RGBA8：RGB = bent 方向·½+½，A = 余弦加权可见度 */
  skyOcc: Texture;
  /** `lighting3/vis_linear.png` —— RGBA8：可见度的线性重建 V(ω)=clamp(a+b·ω,0,1) */
  visLin: Texture;
  /** 上面那张 rgb 的缩放：b = (rgb*2−1)·visBMax */
  visBMax: number;
  /** `lighting3/ao.png` —— 局部封闭度（短程全球面余弦可见性），R8、值域 [0,1]。 */
  ao: Texture;
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
  /** 角色网格的世界 AABB。只给位置调试视图归一用，两边取同一份才能对照。 */
  gridMin: [number, number, number];
  gridMax: [number, number, number];
}

export class SceneLightingPass {
  private readonly geo: SceneLightingGeometry;
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

  // ⚠ v3 起**不再接收原画**：渲染路径上的背景本体是 `geo.base`
  //   （原画 ÷ E_est，烘焙期算好）。原画只在没有 lighting3 载荷时由
  //   SceneManager 当普通 Sprite 兜底，不进这一级。
  constructor(geo: SceneLightingGeometry) {
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
        uBase: this.geo.base.source,
        // 线扫前缀的两张 slab。solve() 之前先拿深度纹理占位（尺寸一致，
        // 内容不会被读到 —— uLightPx[i].w = 0 时 lightVisibilityPrefix 直接返回 1）。
        uPrefix0: this.geo.depth.source,
        uPrefix1: this.geo.depth.source,
        uNormal: this.geo.normal.source,
        uSkyOcc: this.geo.skyOcc.source,
        uVisLin: this.geo.visLin.source,
        uAo: this.geo.ao.source,
        uIrradiance: this.geo.irradiance.source,
        uDepth: this.geo.depth.source,
        sceneLight: {
          uDepthTexSize: { value: new Float32Array(this.geo.depthSize), type: 'vec2<f32>' },
          uCal: { value: new Float32Array(this.geo.cal), type: 'vec3<f32>' },
          uDepthMap: { value: new Float32Array(this.geo.depthMapping), type: 'vec3<f32>' },
          uBaseScale: { value: this.geo.baseScale, type: 'f32' },
          uBaseLogSpan: { value: this.geo.baseLogSpan, type: 'f32' },
          uGi: { value: 1, type: 'f32' },
          uIrradianceScale: { value: this.geo.irradianceScale, type: 'f32' },
          uIrradianceLogSpan: { value: this.geo.irradianceLogSpan, type: 'f32' },
          uSkySh: { value: new Float32Array(9 * 4), type: 'vec4<f32>', size: 9 },
          uVisBMax: { value: 1, type: 'f32' },
          uAmbientColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uAmbientIntensity: { value: 0, type: 'f32' },
          uGridMin: { value: new Float32Array(this.geo.gridMin), type: 'vec3<f32>' },
          uGridMax: { value: new Float32Array(this.geo.gridMax), type: 'vec3<f32>' },
          uSunColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uSunIntensity: { value: 0, type: 'f32' },
          uSunDir: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
          uShadow: { value: new Float32Array([0.9, 3.5, 48, 2]), type: 'vec4<f32>' },
          uShadowBias: { value: new Float32Array([0.035, 2]), type: 'vec2<f32>' },
          uDebug: { value: 0, type: 'i32' },
          uMRow0: { value: new Float32Array(3), type: 'vec3<f32>' },
          uMRow1: { value: new Float32Array(3), type: 'vec3<f32>' },
          uMRow2: { value: new Float32Array(3), type: 'vec3<f32>' },
          uCore: { value: new Float32Array([0, 0.05, 0.25, 0.25]), type: 'vec4<f32>' },
          uLightPx: {
            value: new Float32Array(MAX_STATIC_LIGHTS * 4),
            type: 'vec4<f32>', size: MAX_STATIC_LIGHTS,
          },
          uLightCount: { value: 0, type: 'i32' },
          uLightA: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          uLightB: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          uLightC: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
          uLightD: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
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
   */
  applyParams(def: SceneLightingDef): void {
    this.ensure();
    const u = this.shader?.resources.sceneLight?.uniforms;
    if (!u) return;

    // 天空色、强度、纬向分布全部并进这 9 个 SH 系数（CPU 侧按
    // 「无遮挡朝上 = intensity·color」归一，作者面语义不变）。
    (u.uSkySh as Float32Array).set(skyIrradianceSh(def.sky, sunDirectionOf(def)));
    u.uVisBMax = this.geo.visBMax;

    const amb = def.ambient;
    u.uAmbientColor.set(resolveLightColor(amb?.color, amb?.kelvin));
    u.uAmbientIntensity = amb?.intensity ?? 0;

    // ★ 烘焙 GI 的权重。缺省 1 = 原样吃 ⇒ 画面精确等于原画。
    //   ⚠ 这个缺省是**有意**的，而且和 v2 那个 `placeholder` 开关不是一回事：
    //     那个是"整条链绕过去"，角色被一起挡在门外（27 个场景摆灯零响应）；
    //     这个是光照方程里一个有物理含义的项，值为 1 只是说"这个场景还没重打光"。
    //     作者把 gi 调低、把天光/灯加上去，是一条连续的路。
    u.uGi = def.gi ?? 1;

    const M = this.geo.mRows;
    u.uMRow0.set(M[0]);
    u.uMRow1.set(M[1]);
    u.uMRow2.set(M[2]);

    // ★ 灯的打包走 `packLights` —— 角色侧读的是**同一次调用的结果**（见 `this.packed`），
    //   所以「角色与场景明暗一致」在构造上就成立，不靠两处代码碰巧写得一样。
    const packed = packLights(def, this.geo.wuPerQUnit);
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

  }

  /**
   * 逐 buffer 调试视图。编号见 `shadeCore3.glsl` 的 `SC3_DEBUG_*`，
   * **与角色路径共用同一套** —— 同一个编号在两边必是同一个量。
   * 会标脏（下一帧重算）。
   */
  setDebug(mode: number): void {
    this.ensure();
    const u = this.shader?.resources.sceneLight?.uniforms;
    if (!u) return;
    u.uDebug = mode | 0;
    this.dirty = true;
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
