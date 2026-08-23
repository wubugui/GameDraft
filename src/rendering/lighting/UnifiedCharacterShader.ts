/**
 * UnifiedCharacterShader —— 角色并入统一光影的 sprite 网格 shader。
 *
 * 为什么存在（2026-08-20，制作人指令「角色照明并入场景照明」）：
 * 旧路径（`CharacterLitSprite` + probe 图集 / 体素卷）是**烘出来的静态光**——
 * 场景光照一动，角色纹丝不动。制作人的要求是「角色最重要的是要符合场景明暗，
 * 而且要吃天光遮蔽」，静态 probe 结构上做不到。
 *
 * 这里走的是同一条链：
 *
 * ```
 * 角色 = 比例基底 × [ 烘焙 GI(网格 GI 通道) + 天光 × 传输基(SH-L1，吃角色自己的法线) ← ①
 *                       + 环境反弹底 ← ②
 *                       + 灯(点/聚/面/平行，与场景同一份打包) ← ③ ]
 *        → 雾（与场景同一组参数、各用自己的深度）
 *        → 显示变换（与场景**同一组**参数）
 * ```
 *
 * 与背景共享的不是"两处写得一样的代码"，而是**同一份数据**：
 * 灯来自 `SceneLightingPass.packedLights` 的同一次打包，
 * 天穹传输来自与场景 `transport.png` 同一次烘焙、同一组方向、同一套归一化的 SH-L1 网格，
 * 烘焙 GI 来自**同一次 final gather**（只是起点从像素换成网格点），
 * 显示变换来自同一个 `def.display`。任一处漂了，两边一起漂 —— 不会分家。
 *
 * ⚠ 这里的「烘焙 GI」**不是**被删掉的那个屏幕空间反弹 pass（`GiBouncePass`）。
 * 它是场景自身的辐照度场，是角色在**未重打光**的场景里唯一的光源
 * （那时 `sky` / `lights` 都是 0）。`charGi` 调到 0 角色会全黑。
 *
 * ★ 铁律 S12：一切光照都在**伪世界空间**求值。这里的 `q` 由顶点几何 + ground 深度场
 * 直出（与 `CharacterLitSprite` 逐字同式），没有任何逐实体逐帧 CPU 驱动。
 */
import {
  GlProgram,
  Shader,
  Texture,
  type TextureSource,
  UniformGroup,
} from 'pixi.js';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import { skyIrradianceSh } from './skySh';
import { MAX_STATIC_LIGHTS, type PackedLights, packShadowBias, sunDirectionOf } from './lightPacking';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import SHADE_CORE_3 from './shadeCore3.glsl?raw';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

const WR_CORE = WORLD_RECONSTRUCT;
const LC = LIGHTING_CORE;
// ⚠ 拼接顺序固定 LC → SC3：shadeCore3 用 lightingCore 的 LC_* 常量与 lc* 函数。
const SC3 = SHADE_CORE_3;

/**
 * 顶点：与 `CharacterLitSprite` 的 VERT **逐字同式**。
 *
 * 两份必须完全一致——否则同一个角色在新旧路径下脚点/镜像判定会差半个像素，
 * 切换路径时会看到跳变。这里不做任何"顺手的改进"。
 */
const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
in vec2 aLocal;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec2  uWCPos;
uniform float uWCScale;

out vec2 vUV;
out vec2 vLocal;
out vec2 vWorld;
out vec2 vFootWorld;
out float vMirror;
out vec4 vColor;

void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vLocal = aLocal;
    float S = max(uWCScale, 1e-6);
    vWorld = (screen - uWCPos) / S;
    vec2 footScreen = (model * vec3(0.0, 0.0, 1.0)).xy;
    vFootWorld = (footScreen - uWCPos) / S;
    float det = model[0][0] * model[1][1] - model[0][1] * model[1][0];
    vMirror = det < 0.0 ? 1.0 : 0.0;
    vColor = uColor;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
in vec2 vLocal;
in vec2 vWorld;
in vec2 vFootWorld;
in float vMirror;
in vec4 vColor;
out vec4 finalColor;

uniform sampler2D uColorTex;    // 动画图集
uniform sampler2D uNrm;         // 法线图集（与 color 逐 texel 对齐）
uniform sampler2D uGround;      // ground_d.png（RG16：行走面深度场）
// 角色的天穹传输网格：SH-L1，每格每通道存 (a0, a1)。
// 布局：4 个通道**纵向堆叠** —— 宽 = nx*nz，高 = ny*4，通道 c 占 [c*ny,(c+1)*ny) 行。
uniform sampler2D uSkyTransport;
uniform float uGiScale;      // GI 通道的对数编码中心（= 该场景网格 a0 的中位）
uniform float uGiLogSpan;    // GI 通道的对数编码跨度（档）
uniform float uCharGi;       // 角色吃多少烘焙 GI。0 = 完全不吃
uniform sampler2D uDepth;       // raw_depth_rg.png（角色阴影 march 用）

// ---- 场景几何标定（work px 栅格；与 CharacterLitSprite 同一套）----
uniform vec4  uCal;             // ppu, 0, cx, cy
uniform float uCosT;
uniform float uSinT;
uniform vec2  uWorldToWork;
uniform vec2  uGroundRange;     // ground_d min/max
uniform vec2  uSceneWorld;
uniform float uHasNrm;
uniform float uBulge;
uniform float uFlatten;

// ---- 深度场（native px 栅格；与 SceneLightingPass 同一套）----
uniform vec2  uDepthTexSize;
uniform vec3  uDepthCal;        // ppu, cx, cy（native）
uniform vec3  uDepthMap;        // invert, scale, offset

// M 三行（**det = +1** 的游戏约定矩阵）
uniform vec3  uMRow0;
uniform vec3  uMRow1;
uniform vec3  uMRow2;

// ---- 3D 天穹可见性网格 ----
uniform vec3  uGridN;           // nx, ny, nz
uniform vec3  uGridMin;         // 世界 AABB 下界
uniform vec3  uGridMax;

// ---- 光（与场景**同一次打包**）----
uniform vec3  uAmbientColor;    // 环境反弹底
uniform float uAmbientIntensity;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSunDir;
uniform vec4  uShadow;
uniform vec2  uShadowBias;
uniform int   uLightCount;
uniform vec4  uLightA[${MAX_STATIC_LIGHTS}];
uniform vec4  uLightB[${MAX_STATIC_LIGHTS}];
uniform vec4  uLightC[${MAX_STATIC_LIGHTS}];
uniform vec4  uLightD[${MAX_STATIC_LIGHTS}];

// ---- 标定 + 雾 + 显示（与背景同一组参数）----
uniform float uCharRefIntensity;  // 角色图集的参考天穹强度（见 sc3CharBase）
uniform float uFogSigma;
uniform float uFogScaleH;
uniform float uFogBaseY;
uniform vec3  uFogColor;
uniform float uEv;
uniform int   uTonemap;
uniform vec3  uWhiteBalance;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform vec3  uLiftColor;

// ---- 形体 AO（贴片角色拿不到真实自遮蔽，用两条经验项近似）----
uniform float uAOContact;
uniform float uAOForm;

/** 逐 buffer 调试视图。编号见 shadeCore3.glsl 的 SC3_DEBUG_*，**与场景共用一套**。 */
uniform int   uDebug;

${WR_CORE}
${LC}
${SC3}

/**
 * 角色位置上的**天穹传输基**：4 个纬向通道，各自 T_k(N) = a0 + a1·N。
 *
 * ## 为什么是这个形状而不是一个标量
 *
 * 场景侧把法线烘进了传输基（逐像素法线固定，见 lighting3/transport.png）；
 * 角色的法线**逐像素在变**，所以必须存方向性。v2 存的是标量 V(x, up) ——
 * 相当于把角色当成一块朝上的板，实测比它真正需要的量偏高 61%（中位），
 * 身上还完全没有方向性。这一条是「角色和场景走同一套光照」的前提。
 *
 * ## 平铺与插值
 *
 * 网格按 Z 切片横向平铺、4 个通道纵向堆叠：宽 = nx*nz，高 = ny*4，
 * 通道 c 占 [c*ny, (c+1)*ny) 行，行内列 = x + z*nx。
 *
 * ⚠ 必须 texelFetch 不能 texture()：硬件线性过滤会在 Z 切片接缝**和通道边界**
 * 上混样（平铺图集的经典坑，而通道边界这一条比 v2 更致命 —— 混进来的是
 * 另一个纬向通道，不是相邻的空间层）。八个角自己取、自己插。
 */
/**
 * GI 通道（5..7 = R/G/B）的解码。**与 0..4 不是同一套编码**：
 *
 *   R   = a0 的**对数**编码（uGiScale / uGiLogSpan），因为 GI 的动态范围是
 *         400 倍量级（烛火旁 vs 暗角），线性或 from_hdr 都盖不住；
 *   GBA = a1/(4·a0) + 0.5，纯方向量天然有界（单方向光时 |a1/a0| = 2）。
 *
 * ⚠ 幅度与方向分开存是**有理由的**：这样量化误差只作用在幅度上，
 *   方向不会跟着抖 —— 角色走动时最刺眼的正是方向抖动。
 */
float ucGiChannel(int col, int ny, int y, int ch, vec3 N) {
    vec4 px = texelFetch(uSkyTransport, ivec2(col, ch * ny + y), 0);
    float a0 = uGiScale * exp2((px.r - 0.5) * uGiLogSpan);
    vec3 a1 = (px.gba - vec3(0.5)) * 2.0 * 2.0 * a0;
    return max(a0 + dot(a1, N), 0.0);
}

void ucGridFetch(int x, int y, int z, int nx, int ny, vec3 N,
                 out vec4 sky, out float ao, out vec3 gi) {
    // 通道 0 = 天穹遮蔽（y0 传输的 SH-L1），1 = 局部 AO，2..4 = 烘焙 GI 的 RGB。
    // 0/1：R = a0，GBA = a1*0.5+0.5。
    //
    // ⚠ 天穹这一通道**原样带出 (a0, a1)，不在这里求值** —— bent 方向要靠
    //   a1 的**向量**做三线性，先归一化再插值会在格点之间把方向拧歪。
    int col = x + z * nx;
    vec4 px = texelFetch(uSkyTransport, ivec2(col, 0 * ny + y), 0);
    sky = vec4(px.r, (px.gba - vec3(0.5)) * 2.0);
    ao  = sc3SHTransfer(texelFetch(uSkyTransport, ivec2(col, 1 * ny + y), 0), N);
    gi  = vec3(ucGiChannel(col, ny, y, 2, N),
               ucGiChannel(col, ny, y, 3, N),
               ucGiChannel(col, ny, y, 4, N));
}

/**
 * 查这一点的天穹遮蔽（bent 方向 + 可见度）、局部 AO、烘焙 GI。
 *
 * ⚠ 天穹遮蔽与场景侧是**同一个量**：
 *     T0(N) = a0 + a1·N            —— y0 传输，无遮挡朝上 = 1
 *     V(N)  = T0(N) / cap0(N)      —— cap0 = (1+N·up)/2 是无遮挡时的传输（解析闭式）
 *     Bdir  = normalize(a1)        —— 平均未遮挡方向
 *   场景侧法线烘焙期已知，直接存精确的 V 与 Bdir；这边法线运行时才有，
 *   所以存 L1 再当场求值。**两条路都把 (Bdir, V) 交给同一个 sc3SkyIrradiance。**
 *   y0 通道的 L1 截断实测 ≤1.2%，所以两边一致到约 1%（旧的 4 通道阶梯是 10%–15%）。
 */
void ucSkyAt(vec3 world, vec3 N, out vec3 bentDir, out float skyVis,
             out float ao, out vec3 gi) {
    vec3 span = max(uGridMax - uGridMin, vec3(1e-5));
    vec3 t = clamp((world - uGridMin) / span, 0.0, 1.0);
    vec3 f = t * (uGridN - vec3(1.0));
    vec3 i0 = floor(f);
    vec3 fr = f - i0;
    ivec3 nmax = ivec3(uGridN) - ivec3(1);
    ivec3 a = clamp(ivec3(i0), ivec3(0), nmax);
    ivec3 b = min(a + ivec3(1), nmax);
    int nx = int(uGridN.x);
    int ny = int(uGridN.y);

    vec4 s000, s100, s010, s110, s001, s101, s011, s111;
    float o000, o100, o010, o110, o001, o101, o011, o111;
    vec3 g000, g100, g010, g110, g001, g101, g011, g111;
    ucGridFetch(a.x, a.y, a.z, nx, ny, N, s000, o000, g000);
    ucGridFetch(b.x, a.y, a.z, nx, ny, N, s100, o100, g100);
    ucGridFetch(a.x, b.y, a.z, nx, ny, N, s010, o010, g010);
    ucGridFetch(b.x, b.y, a.z, nx, ny, N, s110, o110, g110);
    ucGridFetch(a.x, a.y, b.z, nx, ny, N, s001, o001, g001);
    ucGridFetch(b.x, a.y, b.z, nx, ny, N, s101, o101, g101);
    ucGridFetch(a.x, b.y, b.z, nx, ny, N, s011, o011, g011);
    ucGridFetch(b.x, b.y, b.z, nx, ny, N, s111, o111, g111);

    vec4 sx00 = mix(s000, s100, fr.x);
    vec4 sx10 = mix(s010, s110, fr.x);
    vec4 sx01 = mix(s001, s101, fr.x);
    vec4 sx11 = mix(s011, s111, fr.x);
    vec4 sky = mix(mix(sx00, sx10, fr.y), mix(sx01, sx11, fr.y), fr.z);
    float t0 = max(sky.x + dot(sky.yzw, N), 0.0);
    skyVis  = clamp(t0 / max((1.0 + N.y) * 0.5, 1.0 / 255.0), 0.0, 1.0);
    bentDir = normalize(sky.yzw + vec3(1e-6, 1e-6, 1e-6));

    float a00 = mix(o000, o100, fr.x);
    float a10 = mix(o010, o110, fr.x);
    float a01 = mix(o001, o101, fr.x);
    float a11 = mix(o011, o111, fr.x);
    ao = mix(mix(a00, a10, fr.y), mix(a01, a11, fr.y), fr.z);

    vec3 g00 = mix(g000, g100, fr.x);
    vec3 g10 = mix(g010, g110, fr.x);
    vec3 g01 = mix(g001, g101, fr.x);
    vec3 g11 = mix(g011, g111, fr.x);
    gi = mix(mix(g00, g10, fr.y), mix(g01, g11, fr.y), fr.z);
}

/** 一盏灯对角色的可见性。与 SceneLightingPass.lightVisibility 同式（同一条 march）。 */
float ucLightVisibility(vec3 q, vec3 lightPosWorld) {
    vec3 lq = vec3(
        uMRow0.x * lightPosWorld.x + uMRow1.x * lightPosWorld.y + uMRow2.x * lightPosWorld.z,
        uMRow0.y * lightPosWorld.x + uMRow1.y * lightPosWorld.y + uMRow2.y * lightPosWorld.z,
        uMRow0.z * lightPosWorld.x + uMRow1.z * lightPosWorld.y + uMRow2.z * lightPosWorld.z);
    vec3 d = lq - q;
    float len = length(d);
    if (len < 1e-5) return 1.0;
    return lcMarchVisibility(uDepth, uDepthTexSize, uDepthCal.x, uDepthCal.y, uDepthCal.z,
                             uDepthMap.x, uDepthMap.y, uDepthMap.z,
                             q, d / len, 16, len * 0.92,
                             uShadowBias.x, uShadowBias.y);
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
    vec4 color = texture(uColorTex, vUV);
    if (color.a < 0.03) { discard; }

    // ---------- 脚点 q（几何直出 + ground 场采样，零 CPU 驱动）----------
    // 与 CharacterLitSprite 逐字同式：两条路径下角色站的位置必须一模一样。
    float ppu = uCal.x;
    vec2 fw = vFootWorld * uWorldToWork;
    float qxF = (fw.x - uCal.z) / ppu;
    float qyF = (uCal.w - fw.y) / ppu;
    vec2 guv = clamp(vFootWorld / max(uSceneWorld, vec2(1e-5)), 0.0, 1.0);
    vec4 gs = texture(uGround, guv);
    float footD = uGroundRange.x
      + ((gs.r * 255.0 * 256.0 + gs.g * 255.0) / 65535.0) * (uGroundRange.y - uGroundRange.x);

    // ---------- 像素高度（世界 → 直立 quad）----------
    vec2 pw = vWorld * uWorldToWork;
    float h = max((fw.y - pw.y) / max(uCosT * ppu, 1e-6), 0.0);
    float qx = (pw.x - uCal.z) / ppu;

    // ---------- 法线：与 color **同一个 vUV** 采样，镜像只翻方向分量 ----------
    vec4 ne = vec4(0.5, 0.5, 1.0, 0.35);
    if (uHasNrm > 0.5) { ne = texture(uNrm, vUV); }
    vec3 n = normalize(vec3(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (vMirror > 0.5) n.x = -n.x;
    n = normalize(mix(n, vec3(0., 0., -1.), uFlatten));

    vec3 q = vec3(qx, qyF + h * uCosT, footD - h * uSinT - ne.a * uBulge);
    vec3 P = wrQToWorld(uMRow0, uMRow1, uMRow2, q);

    // ---------- ① 天光 × 天穹可见性：决定角色"该多暗" ----------
    // ★ 这一项承重。制作人的原话是「角色首要目标是与场景明暗一致，必须吃天光遮蔽」——
    //   走进巷子该跟着暗下来，站到开阔地该跟着亮起来，靠的就是这个逐点查出来的遮蔽。
    // ★ 遮蔽按**角色自己的法线**求值 —— 与场景侧同一个量、同一个归一化约定
    //   （无遮挡朝上 = 1），所以两边同尺度、可直接比。
    vec3 bentDir; float skyVis; float ao; vec3 giE;
    ucSkyAt(P, n, bentDir, skyVis, ao, giE);
    giE *= uCharGi;
    // 与场景**同一个函数**：bent 方向 + 可见度。角色这侧法线运行时才有，
    // 所以网格存的是可见度的 SH-L1，V(N) = a0 + a1·N、Bdir = normalize(a1)。
    vec3 skyE = sc3SkyIrradiance(bentDir, skyVis, n);
    vec3 ambientE = uAmbientColor * (uAmbientIntensity * sc3AmbientTerm(ao));
    vec3 sunE = vec3(0.0);
    vec3 lampE = vec3(0.0);
    float sunVis = 1.0;

    // ---------- ② 灯：与场景**同一份**打包，同样的解析式 ----------
    if (uSunIntensity > 0.0) {
        if (uShadow.x > 0.0) {
            vec3 dirQ = normalize(uSunDir);
            float blocked = lcMarchVisibility(
                uDepth, uDepthTexSize, uDepthCal.x, uDepthCal.y, uDepthCal.z,
                uDepthMap.x, uDepthMap.y, uDepthMap.z,
                q, dirQ, int(uShadow.z), uShadow.y,
                uShadowBias.x, uShadowBias.y);
            sunVis = 1.0 - uShadow.x * (1.0 - blocked);
        }
        sunE = lcDirectionalLight(n, uSunDir, uSunColor, uSunIntensity, sunVis);
    }
    for (int i = 0; i < ${MAX_STATIC_LIGHTS}; i++) {
        if (i >= uLightCount) break;
        vec4 A = uLightA[i], B = uLightB[i], C = uLightC[i], D = uLightD[i];
        int kind = int(A.w + 0.5);
        float vis = 1.0;
        // kind 常量直接用 lightingCore 的 #define（LC_POINT/LC_SPOT/…），
        // 不在 TS 侧插值——插值就有两处数字对不上的可能。
        // D.w 是位标志：bit0=castShadow bit1=twoSided（见 lightPacking.LIGHT_FLAG_*）
        int flags = int(D.w + 0.5);
        if ((flags & 1) != 0 && kind != LC_DIRECTIONAL) {
            vis = ucLightVisibility(q, A.xyz);
        }
        if (kind == LC_POINT) {
            lampE += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, vis);
        } else if (kind == LC_SPOT) {
            lampE += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, vis);
        } else if (kind == LC_AREA) {
            vec3 hu, hv;
            areaAxes(normalize(D.xyz), C.z, C.w, C.y, hu, hv);
            lampE += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, vis);
        } else {
            lampE += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
        }
    }

    // ---------- ③ 比例基底：把角色送进和场景同一个空间 ----------
    // 图集也是美术在某种隐含光照下画的，所以它同样要除掉自己的 E_ref。
    // 括号里正是无遮挡、均匀阴天下的传输（与场景侧同一归一化），
    // 于是两边出来的基底是**同一个量纲** —— 这才叫"和角色对齐"。
    //
    // ⚠ 取代了 v2 的 uRadianceScale：那是个标量总增益，补不上一个逐像素的场。
    vec3 alb = sc3CharBase(lcSrgbToLinear(color.rgb / max(color.a, 1e-4)), n, uCharRefIntensity);

    // ★ 场景与角色的**唯一会合点**：两边都走 sc3Shade，第四个参数都是烘焙 GI。
    //
    // ⚠ 这里的 GI **不是**被删掉的那个屏幕空间反弹 pass（GiBouncePass，已删）。
    //   它是烘焙期在伪世界里 final gather 积出的**场景自身辐照度**，角色从
    //   同一份网格里按自己的世界位置和法线查出来 —— 这正是"融入场景"要的东西。
    //   缺了它角色会**全黑**：未重打光的场景 sky/ambient 都是 0，
    //   而场景本体靠的就是这一份 GI。uCharGi 可以调到 0，但那时必须自己摆灯。
    vec3 lin = sc3Shade(alb, skyE + ambientE, sunE + lampE, giE);

    // ---------- 逐 buffer 调试视图 ----------
    // ⚠ 走 sc3DebugView，与**场景用的是同一套编号、同一个函数**。
    if (uDebug != SC3_DEBUG_OFF) {
        vec3 span = max(uGridMax - uGridMin, vec3(1e-5));
        vec3 posNorm = (P - uGridMin) / span;
        vec3 dbg = sc3DebugView(uDebug, alb, n, posNorm, bentDir, skyVis, ao,
                                skyE + ambientE, sunE, lampE, giE, sunVis, vec3(0.0));
        // 辐射量走完整显示变换（才和真实画面对得上）；其余 buffer 只做 sRGB 编码
        // —— 把法线乘上 2^ev 再 tonemap 就是一片白，那种视图是在骗人。
        vec3 dbgOut = sc3DebugIsRadiometric(uDebug)
            ? lcDisplayTransform(dbg, uEv, uTonemap, uWhiteBalance,
                                 uSaturation, uContrast, uLift, uLiftColor)
            : lcLinearToSrgb(dbg);
        finalColor = vec4(dbgOut * color.a, color.a) * vColor;
        return;
    }

    // ---------- 雾：与场景**同一组参数**，各用自己的深度 ----------
    if (uFogSigma > 0.0) {
        float worldY = wrQToWorldRow(uMRow1, q);
        float dist = max(q.z - uDepthMap.z, 0.0);
        float yCam = worldY - uMRow1.z * dist;
        float od = lcOpticalDepth(dist, yCam, worldY, uFogSigma, uFogScaleH, uFogBaseY);
        lin = lcApplyFog(lin, od, uFogColor);
    }

    // ---------- 形体 AO（经验项；贴片角色没有真实自遮蔽可算）----------
    float vy = clamp(vLocal.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    lin *= clamp(1.0 - contact - form, 0.0, 1.0);

    // ---------- 显示变换：与背景**同一组参数** ----------
    // 背景在 LitBackground 里过一遍，角色在这里过同样的一遍。
    // 这是"两者亮度永远一致"的结构性保证——不是碰巧调得像。
    vec3 outRgb = lcDisplayTransform(lin, uEv, uTonemap, uWhiteBalance,
                                     uSaturation, uContrast, uLift, uLiftColor);
    finalColor = vec4(outRgb * color.a, color.a) * vColor;
}
`;

let program: GlProgram | null = null;
function getProgram(): GlProgram {
  if (!program) program = new GlProgram({ vertex: VERT, fragment: FRAG });
  return program;
}

/** 场景静态几何组：进场景建一次，整场不变。 */
export interface UnifiedCharGeometry {
  worldToWork: [number, number];
  /** work px 栅格标定：ppu, cx, cy, theta */
  cal: { ppu: number; cx: number; cy: number; theta: number };
  groundRange: [number, number];
  sceneWorld: [number, number];
  /** native px 栅格（深度图自己的）：宽高、ppu/cx/cy、invert/scale/offset */
  depthSize: [number, number];
  depthCal: [number, number, number];
  depthMapping: [number, number, number];
  mRows: [number[], number[], number[]];
  grid: { n: [number, number, number]; min: [number, number, number]; max: [number, number, number] };
}

export function createUnifiedCharGeometryGroup(g: UnifiedCharGeometry): UniformGroup {
  return new UniformGroup({
    uCal: { value: new Float32Array([g.cal.ppu, 0, g.cal.cx, g.cal.cy]), type: 'vec4<f32>' },
    uCosT: { value: Math.cos(g.cal.theta), type: 'f32' },
    uSinT: { value: Math.sin(g.cal.theta), type: 'f32' },
    uWorldToWork: { value: new Float32Array(g.worldToWork), type: 'vec2<f32>' },
    uGroundRange: { value: new Float32Array(g.groundRange), type: 'vec2<f32>' },
    uSceneWorld: { value: new Float32Array(g.sceneWorld), type: 'vec2<f32>' },
    uDepthTexSize: { value: new Float32Array(g.depthSize), type: 'vec2<f32>' },
    uDepthCal: { value: new Float32Array(g.depthCal), type: 'vec3<f32>' },
    uDepthMap: { value: new Float32Array(g.depthMapping), type: 'vec3<f32>' },
    uMRow0: { value: new Float32Array(g.mRows[0]), type: 'vec3<f32>' },
    uMRow1: { value: new Float32Array(g.mRows[1]), type: 'vec3<f32>' },
    uMRow2: { value: new Float32Array(g.mRows[2]), type: 'vec3<f32>' },
    uGridN: { value: new Float32Array(g.grid.n), type: 'vec3<f32>' },
    uGridMin: { value: new Float32Array(g.grid.min), type: 'vec3<f32>' },
    uGridMax: { value: new Float32Array(g.grid.max), type: 'vec3<f32>' },
  });
}

/**
 * 光照 + 显示组。**全场角色共用同一个实例**——改一次参数，所有角色一起变，
 * 且与背景读的是同一份 `def`。
 */
export function createUnifiedCharLightGroup(): UniformGroup {
  return new UniformGroup({
    uWCPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uWCScale: { value: 1, type: 'f32' },
    uSkySh: { value: new Float32Array(9 * 4), type: 'vec4<f32>', size: 9 },
    uSkyProfile: { value: 1, type: 'f32' },
    uAmbientColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uAmbientIntensity: { value: 0, type: 'f32' },
    uSunColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uSunIntensity: { value: 0, type: 'f32' },
    uSunDir: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
    uShadow: { value: new Float32Array([0, 3.5, 48, 2]), type: 'vec4<f32>' },
    uShadowBias: { value: new Float32Array([0.035, 2]), type: 'vec2<f32>' },
    uLightCount: { value: 0, type: 'i32' },
    uLightA: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uLightB: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uLightC: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uLightD: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uCharRefIntensity: { value: 1, type: 'f32' },
    uGiScale: { value: 1, type: 'f32' },
    uGiLogSpan: { value: 16, type: 'f32' },
    uCharGi: { value: 1, type: 'f32' },
    uFogSigma: { value: 0, type: 'f32' },
    uFogScaleH: { value: 1, type: 'f32' },
    uFogBaseY: { value: 0, type: 'f32' },
    uFogColor: { value: new Float32Array([0.5, 0.55, 0.6]), type: 'vec3<f32>' },
    uEv: { value: 0, type: 'f32' },
    uTonemap: { value: 0, type: 'i32' },
    uWhiteBalance: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uSaturation: { value: 1, type: 'f32' },
    uContrast: { value: 1, type: 'f32' },
    uLift: { value: 0, type: 'f32' },
    uLiftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uBulge: { value: 0.22, type: 'f32' },
    uFlatten: { value: 0, type: 'f32' },
    uAOContact: { value: 0, type: 'f32' },
    uAOForm: { value: 0, type: 'f32' },
    uDebug: { value: 0, type: 'i32' },
  });
}

const TONEMAP_CODE = { none: 0, reinhard: 1, filmic: 2 } as const;

/**
 * 把光照参数写进角色组。**灯直接用场景那次打包的结果**（`packed` 形参），
 * 不重新打一遍——重打就有漂的可能，传进来就没有。
 */
export function applyUnifiedCharLight(
  group: UniformGroup,
  def: SceneLightingDef,
  packed: PackedLights,
  wuPerQUnit: number,
  charRefIntensity: number,
  giScale: number,
  giLogSpan: number,
): void {
  const bag = group.uniforms as Record<string, unknown>;
  const num = (k: string, v: number): void => { bag[k] = v; };
  const vec = (k: string, v: ArrayLike<number>): void => { (bag[k] as Float32Array).set(v); };

  vec('uSkySh', skyIrradianceSh(def.sky, sunDirectionOf(def)));
  vec('uAmbientColor', resolveLightColor(def.ambient?.color, def.ambient?.kelvin));
  num('uAmbientIntensity', def.ambient?.intensity ?? 0);

  vec('uSunColor', packed.sunColor);
  num('uSunIntensity', packed.sunIntensity);
  vec('uSunDir', packed.sunDir);
  vec('uShadow', packed.shadow);
  // 与场景 pass 读同一个函数：同一堵墙的厚度窗对地面和对角色必须是一个数
  vec('uShadowBias', packShadowBias(def, 1 / Math.max(wuPerQUnit, 1e-9)));
  vec('uLightA', packed.a);
  vec('uLightB', packed.b);
  vec('uLightC', packed.c);
  vec('uLightD', packed.d);
  num('uLightCount', packed.count);

  // ⚠ 用传进来的解析值，不用直接读 def —— 缺省要由系统层统一决定，
  //   两处各写一份 `?? 1` 迟早有一处漏掉。
  num('uCharRefIntensity', charRefIntensity);
  // ⚠ GI 通道的对数编码参数**逐场景不同**（scale = 该场景网格 a0 的中位）。
  //   写错这个不会报错，只是角色整体偏亮/偏暗一个常数倍 —— 所以由系统层
  //   从 meta 直接传进来，不给缺省。
  num('uGiScale', giScale);
  num('uGiLogSpan', giLogSpan);
  // ★ 角色吃多少烘焙 GI。缺省**跟随场景的 `gi`**，不是恒 1。
  //
  //   ⚠ 缺省写死 1 是个坑，真机验过：把 `gi` 调到 0.3 重打光时背景暗下来了，
  //     角色纹丝不动 —— 两个旋钮各管一边，作者得记住同时调两个。
  //     跟随之后「调 gi」就是一件事，`charGi` 只在**故意**要角色与背景吃得
  //     不一样多时才显式填（比如让角色比环境亮一点好认）。
  num('uCharGi', def.charGi ?? def.gi ?? 1);
  // 形体参数是**作者参数**不是逐帧状态，所以在这里写而不是 syncFrame。
  // ⚠ 缺省 flatten=0（用真实法线）。**不要**从旧 probe 载荷继承同名值——
  //   那是给旧着色模型调的，新模型里 flatten=1 会让所有灯的 N·L 相同、方向性全丢
  //   （见 SceneLightingDef.characterShape 的注释）。
  num('uFlatten', def.characterShape?.flatten ?? 0);
  num('uBulge', def.characterShape?.bulge ?? 0.22);
  // 雾全程 wu：σ 的量纲是 1/wu，两个高度是 wu。与 `LitBackground.applyParams`
  // 逐位一致——两边分家会让角色与背景的雾在同一深度处浓度不同，穿帮得很难查。
  const f = def.fog;
  if (f && f.sigma > 0) {
    num('uFogSigma', f.sigma);
    num('uFogScaleH', f.scaleHeight);
    num('uFogBaseY', f.baseHeight);
    const c = resolveLightColor(f.color, f.kelvin);
    vec('uFogColor', [c[0] * f.scatter, c[1] * f.scatter, c[2] * f.scatter]);
  } else {
    num('uFogSigma', 0);
  }

  const d = def.display;
  num('uEv', d.ev);
  num('uTonemap', TONEMAP_CODE[d.tonemap] ?? 0);
  vec('uWhiteBalance', resolveLightColor(undefined, d.whiteKelvin));
  num('uSaturation', d.saturation);
  num('uContrast', d.contrast);
  num('uLift', d.lift);
  vec('uLiftColor', resolveLightColor(undefined, d.liftKelvin));
  group.update();
}

export interface UnifiedCharTextures {
  colorTex: TextureSource;
  nrm: TextureSource | null;
  ground: TextureSource;
  /** SH-L1 天穹传输网格（RGBA8，4 通道纵向堆叠）。 */
  skyTransport: TextureSource;
  depth: TextureSource;
}

export function createUnifiedCharShader(
  geometryGroup: UniformGroup,
  lightGroup: UniformGroup,
  tex: UnifiedCharTextures,
): Shader {
  return new Shader({
    glProgram: getProgram(),
    resources: {
      charGeom: geometryGroup,
      charLight: lightGroup,
      charEntity: new UniformGroup({
        uHasNrm: { value: tex.nrm ? 1 : 0, type: 'f32' },
      }),
      uColorTex: tex.colorTex,
      uNrm: tex.nrm ?? Texture.WHITE.source,
      uGround: tex.ground,
      uSkyTransport: tex.skyTransport,
      uDepth: tex.depth,
    },
  });
}

/** 换动画图集 / 法线图集（帧切换、图集热替换用）。同源短路。 */
export function swapUnifiedCharTextures(
  sh: Shader,
  colorTex: TextureSource,
  nrm: TextureSource | null,
): void {
  const res = sh.resources as Record<string, unknown>;
  if (res.uColorTex !== colorTex) res.uColorTex = colorTex;
  const next = nrm ?? Texture.WHITE.source;
  if (res.uNrm !== next) res.uNrm = next;
  const ent = (sh.resources.charEntity as UniformGroup | undefined)?.uniforms;
  if (ent) ent.uHasNrm = nrm ? 1 : 0;
}
