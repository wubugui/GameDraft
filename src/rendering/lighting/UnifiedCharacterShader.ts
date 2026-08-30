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
 * 角色 = albedo × [ 天光×天穹可见性(3D 网格) ← ① 决定该多暗
 *                  + 灯(点/聚/面/平行，与场景同一份打包) ← ②
 *                 ] × radianceScale
 *        → 雾（与场景同一组参数、各用自己的深度）
 *        → 显示变换（与场景**同一组**参数）
 * ```
 *
 * 与背景共享的不是"两处写得一样的代码"，而是**同一份数据**：
 * 灯来自 `SceneLightingPass.packedLights` 的同一次打包，
 * 天穹可见性来自烘焙期与逐像素 `skyvis.png` 同源、同方向、同 march 的 3D 网格，
 * 显示变换来自同一个 `def.display`。三者任一漂了，两边一起漂 —— 不会分家。
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
import { MAX_STATIC_LIGHTS, type PackedLights, packShadowBias } from './lightPacking';
import LIGHTING_CORE from './lightingCore.glsl?raw';
import WORLD_RECONSTRUCT from './worldReconstruct.glsl?raw';

const WR_CORE = WORLD_RECONSTRUCT;
const LC = LIGHTING_CORE;

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
uniform sampler2D uSkyGrid;     // 3D 天穹可见性，Z 切片横向平铺（r8）
uniform sampler2D uGiBounce;    // 反弹辐照网格（与 uSkyGrid 同平铺，RGBA16F）
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
/** 1 个 q 单位 = 多少 wu。铁律 0：光照的长度一律 wu，q 进来先乘它。 */
uniform float uWuPerQUnit;
uniform vec3  uMRow1;
uniform vec3  uMRow2;

// ---- 3D 天穹可见性网格 ----
uniform vec3  uGridN;           // nx, ny, nz
uniform vec3  uGridMin;         // 世界 AABB 下界
uniform vec3  uGridMax;

// ---- 光（与场景**同一次打包**）----
uniform vec3  uSkyColor;
uniform float uSkyIntensity;
uniform float uSkyHemi;
uniform float uAoStrength;
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
uniform float uRadianceScale;
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

/** GI 反弹增益。0 = 关（画面只是少一层反弹光，不会崩）。 */
uniform float uGiGain;

// 调试：0=正常 1=天穹可见性 2=法线 3=光照(无 albedo) 4=albedo 5=GI 反弹
uniform int   uDebug;

${WR_CORE}
${LC}

/**
 * 3D 天穹可见性的三线性采样。
 *
 * 网格按 Z 切片横向平铺成 2D：宽 = nx·nz，列 = x + z·nx，行 = y。
 * ⚠ 必须用 texelFetch 不能用 texture()——硬件线性过滤会在切片接缝上把
 * 相邻 Z 层混进来（平铺图集的经典坑），八个角自己取、自己插。
 */
float ucGridFetch(int x, int y, int z, int nx) {
    return texelFetch(uSkyGrid, ivec2(x + z * nx, y), 0).r;
}

float ucSkyvisAt(vec3 world) {
    vec3 span = max(uGridMax - uGridMin, vec3(1e-5));
    vec3 t = clamp((world - uGridMin) / span, 0.0, 1.0);
    vec3 f = t * (uGridN - vec3(1.0));
    vec3 i0 = floor(f);
    vec3 fr = f - i0;
    ivec3 nmax = ivec3(uGridN) - ivec3(1);
    ivec3 a = clamp(ivec3(i0), ivec3(0), nmax);
    ivec3 b = min(a + ivec3(1), nmax);
    int nx = int(uGridN.x);

    float c000 = ucGridFetch(a.x, a.y, a.z, nx);
    float c100 = ucGridFetch(b.x, a.y, a.z, nx);
    float c010 = ucGridFetch(a.x, b.y, a.z, nx);
    float c110 = ucGridFetch(b.x, b.y, a.z, nx);
    float c001 = ucGridFetch(a.x, a.y, b.z, nx);
    float c101 = ucGridFetch(b.x, a.y, b.z, nx);
    float c011 = ucGridFetch(a.x, b.y, b.z, nx);
    float c111 = ucGridFetch(b.x, b.y, b.z, nx);

    float x00 = mix(c000, c100, fr.x);
    float x10 = mix(c010, c110, fr.x);
    float x01 = mix(c001, c101, fr.x);
    float x11 = mix(c011, c111, fr.x);
    return mix(mix(x00, x10, fr.y), mix(x01, x11, fr.y), fr.z);
}

/**
 * GI 反弹辐照的三线性采样。与 ucSkyvisAt **同一套平铺与插值**，只是取 RGB。
 *
 * 网格内容 = 「沿 16 个烘好的方向撞到的那面墙，**当前**有多亮」的平均
 * （由 GiBouncePass 在脏时算好）。这就是制作人给 GI 下的定义：
 * 角色如何被 relighting 后的场景照亮 —— 不需要真的多次反弹。
 */
vec3 ucBounceAt(vec3 world) {
    vec3 span = max(uGridMax - uGridMin, vec3(1e-5));
    vec3 t = clamp((world - uGridMin) / span, 0.0, 1.0);
    vec3 f = t * (uGridN - vec3(1.0));
    vec3 i0 = floor(f);
    vec3 fr = f - i0;
    ivec3 nmax = ivec3(uGridN) - ivec3(1);
    ivec3 a = clamp(ivec3(i0), ivec3(0), nmax);
    ivec3 b = min(a + ivec3(1), nmax);
    int nx = int(uGridN.x);

    vec3 c000 = texelFetch(uGiBounce, ivec2(a.x + a.z * nx, a.y), 0).rgb;
    vec3 c100 = texelFetch(uGiBounce, ivec2(b.x + a.z * nx, a.y), 0).rgb;
    vec3 c010 = texelFetch(uGiBounce, ivec2(a.x + a.z * nx, b.y), 0).rgb;
    vec3 c110 = texelFetch(uGiBounce, ivec2(b.x + a.z * nx, b.y), 0).rgb;
    vec3 c001 = texelFetch(uGiBounce, ivec2(a.x + b.z * nx, a.y), 0).rgb;
    vec3 c101 = texelFetch(uGiBounce, ivec2(b.x + b.z * nx, a.y), 0).rgb;
    vec3 c011 = texelFetch(uGiBounce, ivec2(a.x + b.z * nx, b.y), 0).rgb;
    vec3 c111 = texelFetch(uGiBounce, ivec2(b.x + b.z * nx, b.y), 0).rgb;

    vec3 x00 = mix(c000, c100, fr.x);
    vec3 x10 = mix(c010, c110, fr.x);
    vec3 x01 = mix(c001, c101, fr.x);
    vec3 x11 = mix(c011, c111, fr.x);
    return mix(mix(x00, x10, fr.y), mix(x01, x11, fr.y), fr.z);
}

/** 一盏灯对角色的可见性。与 SceneLightingPass.lightVisibility 同式（同一条 march）。 */
float ucLightVisibility(vec3 q, vec3 lightPosWorld) {
    vec3 lq = vec3(
        uMRow0.x * lightPosWorld.x + uMRow1.x * lightPosWorld.y + uMRow2.x * lightPosWorld.z,
        uMRow0.y * lightPosWorld.x + uMRow1.y * lightPosWorld.y + uMRow2.y * lightPosWorld.z,
        uMRow0.z * lightPosWorld.x + uMRow1.z * lightPosWorld.y + uMRow2.z * lightPosWorld.z)
        / max(uWuPerQUnit, 1e-9);   // 灯位是 wu，march 在 q ⇒ 除回 q（豁免①：深度域）
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
    // 铁律 0（制作人 2026-08-30 定死）：光照一律在**世界空间、单位 wu**。
    // 朝向过 R、尺度过 uWuPerQUnit，一次转到底 —— 不许停在「世界朝向 + q 尺度」
    // 那个没有名字的中间态：那会让 range / 软化半径 / 面光尺寸在 shader 里不是 wu，
    // 而作者面明明按 wu 填，读代码的人无法判断某个长度是哪把尺。
    vec3 P = wrQToWorld(uMRow0, uMRow1, uMRow2, q) * uWuPerQUnit;
    // 角色法线**已经是世界法线**（直立 quad + 图像空间烘的剪影法线，轴向恰好是
    // 世界 X/Y/−Z），灯直接用 n。probe/体素查表那一侧才需要转回 q。

    // ---------- ① 天光 × 天穹可见性：决定角色"该多暗" ----------
    // ★ 这一项承重。制作人的原话是「角色首要目标是与场景明暗一致，必须吃天光遮蔽」——
    //   走进巷子该跟着暗下来，站到开阔地该跟着亮起来，靠的就是这个逐点查出来的遮蔽。
    float skyvis = ucSkyvisAt(P);
    vec3 S = lcSkyLight(uSkyColor, uSkyIntensity, skyvis, uSkyHemi, uAoStrength);

    // ---------- ② 灯：与场景**同一份**打包，同样的解析式 ----------
    if (uSunIntensity > 0.0) {
        float vis = 1.0;
        if (uShadow.x > 0.0) {
            vec3 dirQ = normalize(uSunDir);
            float blocked = lcMarchVisibility(
                uDepth, uDepthTexSize, uDepthCal.x, uDepthCal.y, uDepthCal.z,
                uDepthMap.x, uDepthMap.y, uDepthMap.z,
                q, dirQ, int(uShadow.z), uShadow.y,
                uShadowBias.x, uShadowBias.y);
            vis = 1.0 - uShadow.x * (1.0 - blocked);
        }
        S += lcDirectionalLight(n, uSunDir, uSunColor, uSunIntensity, vis);
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
            S += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, vis);
        } else if (kind == LC_SPOT) {
            S += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, vis);
        } else if (kind == LC_AREA) {
            vec3 hu, hv;
            areaAxes(normalize(D.xyz), C.z, C.w, C.y, hu, hv);
            S += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, vis);
        } else {
            S += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
        }
    }

    // ---------- ③ GI：被 relight 后的场景反弹照亮（加分项，关掉只是少一层）----------
    // ⚠ 反弹项**在 radianceScale 之外**加：它已经是场景辐射尺度的量
    //   （直接取自重打光结果），再乘一次标定就等于把尺度算两遍。
    //
    // ⚠ 这一项是**各向同性**的：网格里存的是 16 个方向的平均，这里不再按 N·d 加权。
    //   所以它给的是"周围有多亮"而不是"光从哪边来"——间接光本就低频，这个近似
    //   看不出来；但**别指望它做出方向感**，那是解析灯的活。
    //   实测（雾津街头灯下）：贡献 +35.6%，纯 GI 项 rgb(164,132,85) 明显偏暖
    //   ——2200K 灯光打在石板上反弹回来的颜色。离灯 15 m 外降到 2.4%。
    vec3 bounce = uGiGain > 0.0 ? ucBounceAt(P) * uGiGain : vec3(0.0);

    // ---------- albedo × (S × 标定 + 反弹) ----------
    // 场景那边 albedo 被画进像素里拿不出来，所以走「先除白天光再乘新光」；
    // 角色的 albedo 是显式的，直接乘。**两边算的是同一个 S**，这是"融进去"的根。
    // uRadianceScale 把「S 的尺度」对齐到「重打光后的场景辐射尺度」——
    // 缺它角色会**系统性**偏亮或偏暗，且怎么调灯都对不上。
    vec3 alb = lcSrgbToLinear(color.rgb / max(color.a, 1e-4));
    vec3 lin = alb * (S * uRadianceScale + bounce);

    if (uDebug == 1) { finalColor = vec4(vec3(skyvis) * color.a, color.a) * vColor; return; }
    if (uDebug == 2) { finalColor = vec4((n * .5 + .5) * color.a, color.a) * vColor; return; }
    if (uDebug == 3) { lin = S * uRadianceScale; }
    if (uDebug == 4) { lin = alb; }
    if (uDebug == 5) { lin = bounce; }

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
  /** 1 个 q 单位 = 多少 wu。铁律 0：光照的长度一律 wu（P = R·q × 它）。 */
  wuPerQUnit: number;
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
    uWuPerQUnit: { value: g.wuPerQUnit, type: 'f32' },
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
    uSkyColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uSkyIntensity: { value: 1, type: 'f32' },
    uSkyHemi: { value: 0.35, type: 'f32' },
    uAoStrength: { value: 1, type: 'f32' },
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
    uRadianceScale: { value: 1, type: 'f32' },
    uGiGain: { value: 1, type: 'f32' },
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
  radianceScale: number,
  giGain: number,
): void {
  const bag = group.uniforms as Record<string, unknown>;
  const num = (k: string, v: number): void => { bag[k] = v; };
  const vec = (k: string, v: ArrayLike<number>): void => { (bag[k] as Float32Array).set(v); };

  vec('uSkyColor', resolveLightColor(def.sky.color, def.sky.kelvin));
  num('uSkyIntensity', def.sky.intensity);
  num('uSkyHemi', def.sky.hemi);
  num('uAoStrength', def.aoStrength ?? 1);

  vec('uSunColor', packed.sunColor);
  num('uSunIntensity', packed.sunIntensity);
  vec('uSunDir', packed.sunDir);
  vec('uShadow', packed.shadow);
  // 与场景 pass 读同一个函数：同一堵墙的厚度窗对地面和对角色必须是一个数
  vec('uShadowBias', packShadowBias(def, 1 / Math.max(wuPerQUnit, 1e-9)));
  // 铁律 0：光照的长度一律 wu ⇒ shader 里 P = R·q × wuPerQUnit。
  num('uWuPerQUnit', wuPerQUnit > 0 ? wuPerQUnit : 1);
  vec('uLightA', packed.a);
  vec('uLightB', packed.b);
  vec('uLightC', packed.c);
  vec('uLightD', packed.d);
  num('uLightCount', packed.count);

  // ⚠ 用传进来的解析值，不用 def.radianceScale —— 它缺省时要由烘焙期反解的
  //   反射率推出来（见 SceneLightingSystem.radianceScale），这里读 def 会拿到 undefined。
  num('uRadianceScale', radianceScale);
  // 形体参数是**作者参数**不是逐帧状态，所以在这里写而不是 syncFrame。
  // ⚠ 缺省 flatten=0（用真实法线）。**不要**从旧 probe 载荷继承同名值——
  //   那是给旧着色模型调的，新模型里 flatten=1 会让所有灯的 N·L 相同、方向性全丢
  //   （见 SceneLightingDef.characterShape 的注释）。
  num('uFlatten', def.characterShape?.flatten ?? 0);
  num('uBulge', def.characterShape?.bulge ?? 0.22);
  // 没烘 gi_hitmap 的场景传 0：白图占位不会被读进结果
  num('uGiGain', giGain);

  // 雾全程 wu：σ 的量纲是 1/wu，两个高度是 wu。与 LitBackground.applyParams
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
  skyGrid: TextureSource;
  /** GI 反弹网格。没烘 `gi_hitmap` 的场景传 null → 增益自动置 0，画面只是少一层。 */
  giBounce: TextureSource | null;
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
      uSkyGrid: tex.skyGrid,
      // 缺 GI 网格时绑白图占位保采样器合法；增益由 applyUnifiedCharLight 置 0，永不读进结果
      uGiBounce: tex.giBounce ?? Texture.WHITE.source,
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
