/**
 * CharacterLitSprite —— 角色烘焙照明的 **sprite 网格着色**承载。
 *
 * 为什么存在(2026-07-25,替换 filter 的法线反推路径):
 * filter 只能拿到"sprite 已渲染进临时 RT"的结果,图集 UV 在 Pixi 画 sprite 时用完即弃,
 * 于是旧路径被迫**从世界坐标反推法线 UV**(uFootQ/uCharW 每帧驱动)。任何一帧驱动缺席
 * (实测:非 Exploring 态整段驱动被跳过),ul 就整体越界、被 clamp 死在 0/1 —— 全身反复
 * 采同一列边缘像素:通体单色、镜像后换一列(绿↔黄)、随 uniform 跳变闪烁。
 *
 * 现在:一个与 sprite 完全同 quad 的 Mesh 子节点,用**顶点自带的图集 UV** 同时采
 * color 与 normal(两图集布局逐 texel 对齐,天然同步);镜像由变换行列式判定
 * (det<0 = 镜像,几何自身的事实);脚点/世界坐标由顶点变换直接给出。
 * **没有任何逐实体逐帧 CPU 驱动** —— 这类错位在结构上不再存在。
 *
 * 照明数学(probe/体素/RT/SH/着色核心)与 filter 共用 CHAR_LIGHT_COMMON_GLSL,
 * 同一份字符串,零漂移。深度遮挡仍走 DepthOcclusionFilter(那是 filter 的正当用途)。
 *
 * WebGPU 迁移期:同一个网格程序另有 WGSL 版(VERT_WGSL / FRAG_WGSL,逐式对应 GLSL,拼的是
 * 共享片段的 WGSL 版);GLSL 一个字不动,WebGL(含 anim_preview 自建的 Pixi)仍跑它。
 * 等价由 tools/render_parity/cases/80_char_lighting.ts(「角色受光 /」)逐像素钉住。
 */
import {
  type Buffer,
  GlProgram,
  GpuProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  type TextureSource,
  UniformGroup,
} from '../engine2d';

import { CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL } from './CharacterShadingFilter';
import type { SceneLightingDef } from '../data/types';
import { resolveLightColor } from './lighting/kelvin';
import { MAX_STATIC_LIGHTS, type PackedLights } from './lighting/lightPacking';
import LIGHTING_CORE from './lighting/lightingCore.glsl?raw';
import WORLD_RECONSTRUCT from './lighting/worldReconstruct.glsl?raw';
import { LC_WGSL, WR_CORE_WGSL } from './lighting/wgslChunks';
import { samplerOf } from './legacy/gpuSampler';

/** GLSL 切片器：与 SceneLightingPass 同一行代码（两处都从 `//__TAG_BEGIN__` 取到 `_END__`）。 */
function sliceGlsl(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[CharacterLitSprite] GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

const WR_CORE = sliceGlsl(WORLD_RECONSTRUCT, 'WR_CORE');
const LC = sliceGlsl(LIGHTING_CORE, 'LIGHTING_CORE');

/**
 * 场景实体灯的加性照度 —— 角色 mesh 路径与粒子受光**共用这一份**（逐字拼接，不内联重写；
 * 与 `charShadeCore` 同一待遇）。两处各写一份循环，"粒子与角色吃同一套灯"就只是写得像。
 *
 * 宿主要先声明 `uSceneLightCount / uSceneLightA..D / uSMRow0..2 / uSMWuPerQUnit`（`charLights` 组），
 * 并拼好 `WR_CORE` 与 `LC`；本段放在它们之后。
 */
export const ENTITY_SCENE_LIGHTS_GLSL = /* glsl */ `
/** 面光两条半轴。与 SceneLightingPass 的同名函数同式（绕法线自转 roll）。 */
void litAreaAxes(vec3 n, float halfW, float halfH, float roll, out vec3 halfU, out vec3 halfV) {
    vec3 up = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 u = normalize(cross(up, n));
    vec3 v = cross(n, u);
    float c = cos(roll), s = sin(roll);
    halfU = (u * c + v * s) * halfW;
    halfV = (v * c - u * s) * halfH;
}

/**
 * q = 伪世界点；n = **世界**法线（已在 M-world）。返回各盏灯的照度之和。
 *
 * 铁律 0（制作人 2026-08-30 定死）：光照一律在**世界空间、单位 wu**。
 * 朝向过 R、尺度过 uWuPerQUnit，一次转到底 —— 不许停在「世界朝向 + q 尺度」
 * 那个没有名字的中间态：那会让 range / 软化半径 / 面光尺寸在 shader 里不是 wu，
 * 而作者面明明按 wu 填，读代码的人无法判断某个长度是哪把尺。
 * 法线直接用 n：调用方交进来的**已经是世界法线** —— 世界对世界，谁都不用转。
 */
vec3 entitySceneLightsE(vec3 q, vec3 n) {
    vec3 E = vec3(0.0);
    if (uSceneLightCount <= 0) return E;
    vec3 P = wrQToWorld(uSMRow0, uSMRow1, uSMRow2, q) * uSMWuPerQUnit;
    for (int i = 0; i < ${MAX_STATIC_LIGHTS}; i++) {
        if (i >= uSceneLightCount) break;
        vec4 A = uSceneLightA[i], B = uSceneLightB[i];
        vec4 C = uSceneLightC[i], D = uSceneLightD[i];
        if (B.w <= 0.0) continue;                 // 强度 0 的灯贡献恒等于 0
        int kind = int(A.w + 0.5);
        int flags = int(D.w + 0.5);               // bit0=castShadow bit1=twoSided
        // 实体不吃灯的阴影：投影解是场景那一级按背景像素栅格解的前缀最小，
        // 角色 / 粒子是动的、不在那张图里。vis 恒 1，宁可多一点光也不要错位的黑块。
        if (kind == LC_POINT) {
            E += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, 1.0);
        } else if (kind == LC_SPOT) {
            E += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, 1.0);
        } else if (kind == LC_AREA) {
            vec3 hu, hv;
            litAreaAxes(normalize(D.xyz), C.z, C.w, C.y, hu, hv);
            E += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, 1.0);
        } else if (kind == LC_LINE) {
            // 落雷的雷身（运行时线光）：雷旁边的人与粒子被沿着整道雷身照亮
            E += lcLineLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, 1.0);
        } else {
            E += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
        }
    }
    return E;
}
`;

/**
 * `charLights` 组（{@link createCharLightUniforms}）的 WGSL 结构 —— WebGPU 迁移期用，WebGL 路径不读。
 *
 * 成员**同名同序**对应 `createCharLightUniforms` 的声明顺序（Pixi 按 JS 声明顺序、WGSL 对齐规则排
 * uniform 缓冲；顺序一错整组错位且不报错，`wgslChunks.test.ts` 钉着两边一致）。
 * 宿主在自己的着色器里拼它，再声明一个**名叫 charLights** 的 uniform 绑定变量（名字 = resources 键名，
 * 角色网格与粒子都是这个键；组号 / 绑定号宿主自定，自定义组从 2 起）：
 *
 *     var<uniform> charLights: CharLights;      // 前面加上宿主自己的组号 / 绑定号属性
 *
 * 只要显示变换（uDisp*）的宿主（光柱）同样拼这一段就行，不必拼灯循环。
 * ⚠ struct 体内不许写注释：Pixi 按正则抽 struct，注释里的「名: 类型」会被当成成员。
 */
export const CHAR_LIGHTS_WGSL = /* wgsl */ `
struct CharLights {
    uSceneLightCount: i32,
    uSceneLightA: array<vec4<f32>, ${MAX_STATIC_LIGHTS}>,
    uSceneLightB: array<vec4<f32>, ${MAX_STATIC_LIGHTS}>,
    uSceneLightC: array<vec4<f32>, ${MAX_STATIC_LIGHTS}>,
    uSceneLightD: array<vec4<f32>, ${MAX_STATIC_LIGHTS}>,
    uSMWuPerQUnit: f32,
    uSMRow0: vec3<f32>,
    uSMRow1: vec3<f32>,
    uSMRow2: vec3<f32>,
    uDispEv: f32,
    uDispTonemap: i32,
    uDispWhite: vec3<f32>,
    uDispSaturation: f32,
    uDispContrast: f32,
    uDispLift: f32,
    uDispLiftColor: vec3<f32>,
}
`;

/**
 * {@link ENTITY_SCENE_LIGHTS_GLSL} 的 WGSL 版：角色网格与粒子受光共用的实体灯循环（WebGPU 迁移期并存，
 * 数学逐式相同，等价由 render_parity「光照片段 / 实体灯循环」钉住；改一边必须同步改另一边）。
 *
 * 宿主要拼好 {@link CHAR_LIGHTS_WGSL} 并声明 `charLights` 绑定（见上），再拼 WGSL 版的 WR_CORE 与 LC
 * （lighting/worldReconstruct.wgsl、lighting/lightingCore.wgsl 的切片）。与其余 WGSL 片段不同，本段
 * **直接读 charLights 绑定**而不是走形参：那是所有宿主共用的同一个 UniformGroup 对象、名字与布局
 * 处处一样，而四个 24 元灯数组按值当形参传会在每个片元里整份拷贝。
 * 面光两条半轴经函数指针形参带回（GLSL 的 out 形参）。
 */
export const ENTITY_SCENE_LIGHTS_WGSL = /* wgsl */ `
/** 面光两条半轴。与 SceneLightingPass 的同名函数同式（绕法线自转 roll）。 */
fn litAreaAxes(n: vec3<f32>, halfW: f32, halfH: f32, roll: f32,
               halfU: ptr<function, vec3<f32>>, halfV: ptr<function, vec3<f32>>) {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(n.y) > 0.95) { up = vec3<f32>(1.0, 0.0, 0.0); }
    let u = normalize(cross(up, n));
    let v = cross(n, u);
    let c = cos(roll);
    let s = sin(roll);
    *halfU = (u * c + v * s) * halfW;
    *halfV = (v * c - u * s) * halfH;
}

/**
 * q = 伪世界点；n = **世界**法线（已在 M-world）。返回各盏灯的照度之和。
 * 铁律 0：P 朝向过 R、尺度过 uSMWuPerQUnit，一次转到底；法线直接用 n（世界对世界）。
 */
fn entitySceneLightsE(q: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    var E = vec3<f32>(0.0);
    if (charLights.uSceneLightCount <= 0) { return E; }
    let P = wrQToWorld(charLights.uSMRow0, charLights.uSMRow1, charLights.uSMRow2, q) * charLights.uSMWuPerQUnit;
    for (var i = 0; i < ${MAX_STATIC_LIGHTS}; i++) {
        if (i >= charLights.uSceneLightCount) { break; }
        let A = charLights.uSceneLightA[i];
        let B = charLights.uSceneLightB[i];
        let C = charLights.uSceneLightC[i];
        let D = charLights.uSceneLightD[i];
        if (B.w <= 0.0) { continue; }             // 强度 0 的灯贡献恒等于 0
        let kind = i32(A.w + 0.5);
        let flags = i32(D.w + 0.5);               // bit0=castShadow bit1=twoSided
        // 实体不吃灯的阴影（理由见 GLSL 版）：vis 恒 1
        if (kind == LC_POINT) {
            E += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, 1.0);
        } else if (kind == LC_SPOT) {
            E += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, 1.0);
        } else if (kind == LC_AREA) {
            var hu: vec3<f32>;
            var hv: vec3<f32>;
            litAreaAxes(normalize(D.xyz), C.z, C.w, C.y, &hu, &hv);
            E += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, 1.0);
        } else if (kind == LC_LINE) {
            E += lcLineLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, 1.0);
        } else {
            E += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
        }
    }
    return E;
}
`;

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;   // sprite 局部坐标(帧像素空间,锚点已含)
in vec2 aUV;         // 图集 UV —— 与 color 帧同一套(法线采样直接用它)
in vec2 aLocal;      // 帧内局部 [0,1]²(左上为原点;AO 用)

uniform mat3 uProjectionMatrix;        // Pixi global group(自动绑)
uniform mat3 uWorldTransformMatrix;    // Pixi global group
uniform mat3 uTransformMatrix;         // Pixi local group:mesh 世界变换
uniform vec4 uColor;                   // Pixi local group:world alpha/tint(预乘)
uniform vec2  uWCPos;                  // worldContainer 屏幕位置(共享帧组;世界重建已不用,留给别处)
uniform float uWCScale;                // projectionScale(共享帧组;同上)
uniform vec3  uL2W0;                   // local→sceneWorld 仿射第一行 (a, c, tx)(entityShade,CPU 每帧喂)
uniform vec3  uL2W1;                   // local→sceneWorld 仿射第二行 (b, d, ty)

out vec2 vUV;
out vec2 vLocal;
out vec2 vWorld;       // 像素的场景世界坐标
out vec2 vFootWorld;   // 脚点(local 原点)的场景世界坐标
out float vMirror;     // 1 = 几何被镜像(scale.x<0),由行列式判定
out vec4 vColor;

void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vLocal = aLocal;
    // ---- 世界坐标:CPU 喂的 local→sceneWorld 仿射,**不再从 screen 反推** ----
    //
    // ⚠ 2026-09-01 根因修复:mesh 挂在带滤镜(DepthOcclusionFilter)的 container 里,
    //   Pixi 滤镜先把子树渲进**按包围盒对齐的临时 RT** —— 那一趟里 screen 是
    //   临时 RT 局部坐标,不是真屏幕。gl_Position 不受影响(画面位置一直是对的),
    //   但 (screen-uWCPos)/uWCScale 的世界重建被整体平移:实测雾津街头脚点世界坐标
    //   错出 500+ wu,probe 全在错的位置采样,且误差随镜头/包围盒漂——"强度怎么调
    //   都对不齐"的全部来历。世界坐标只能由 CPU 按场景图真值喂(见 setWorldTransform)。
    vWorld = vec2(uL2W0.x * aPosition.x + uL2W0.y * aPosition.y + uL2W0.z,
                  uL2W1.x * aPosition.x + uL2W1.y * aPosition.y + uL2W1.z);
    vFootWorld = vec2(uL2W0.z, uL2W1.z);                  // local 原点(锚点=脚底)的世界坐标
    // 镜像判定:仿射 2x2 行列式,scale.x<0 → det<0(语义与旧 model 判定一致)
    float det = uL2W0.x * uL2W1.y - uL2W1.x * uL2W0.y;
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

uniform sampler2D uColorTex;   // 动画图集(与 sprite 同一张)
uniform sampler2D uGround;     // ground_d.png(RG16:行走面深度场)
uniform vec2 uGroundRange;     // ground_d min/max
uniform vec2 uSceneWorld;      // 场景世界尺寸(ground uv 归一化)

// 与公共块同名的采样器/开关(公共块内函数引用;filter 侧另有同名声明)
uniform sampler2D uNrm;
uniform sampler2D uPL1;
uniform sampler2D uPL2;
uniform sampler2D uPBin;
uniform sampler2D uValid;
uniform sampler2D uSkyaoTex;   // skyao probe(共用块里用,sampler 由宿主声明)
uniform sampler2D uVolRad;
uniform sampler2D uVolEmit;
uniform float uHasNrm;
uniform float uBodyWidthWu; // 当前精灵格宽（场景 wu），厚度随实体而不是场景标尺缩放

// ---- 场景实体灯（2026-08-30：原画 + 加性灯模型）----
//
// ⚠ **与公共块里的 uLightQ/uLightE/uLightCount 不是一回事**，所以另起一组名字。
//   那一组是 lighting.json 里烘焙期反解出来的光源（7 盏），只给 RT gather 的 NEE 用；
//   这一组是作者在场景里摆的实体灯，与 SceneLightingPass 读的是**同一次 packLights**。
//
// ⚠ 两个 M 不许混（coordinate-spaces 铁律 3）：公共块的 uM 是 lighting.json 的
//   det=−1 矩阵，**只**给 probe/体素查表；着色要的是 depthConfig.M.R（det=+1），
//   所以这里另传三行，与 SceneLightingPass / UnifiedCharacterShader 同一份。
uniform int  uSceneLightCount;
uniform vec4 uSceneLightA[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightB[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightC[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightD[${MAX_STATIC_LIGHTS}];
uniform vec3 uSMRow0;
uniform vec3 uSMRow1;
uniform vec3 uSMRow2;
/** 1 个 q 单位 = 多少 wu。铁律 0：光照的长度一律 wu，q 进来先乘它。 */
uniform float uSMWuPerQUnit;

// ---- 显示变换（与背景 LitBackground 用**同一份** lcDisplayTransform 和同一组参数）----
//
// 为什么角色也要过：背景走 displayTransform(辐射 RT)，角色是独立 sprite。两边不套同一个
// 变换，角色就只在"显示恒等"的场景里才对得上 —— 雾津街头 ev=3.32 时背景被提亮 10 倍、
// 角色纹丝不动，表现就是"背景很亮、角色漆黑"（2026-08-30 制作人当场抓到）。
uniform float uDispEv;
uniform int   uDispTonemap;
uniform vec3  uDispWhite;
uniform float uDispSaturation;
uniform float uDispContrast;
uniform float uDispLift;
uniform vec3  uDispLiftColor;

${CHAR_LIGHT_COMMON_GLSL}
${WR_CORE}
${LC}
${ENTITY_SCENE_LIGHTS_GLSL}

void main(void) {
    vec4 color = texture(uColorTex, vUV);
    if (color.a < 0.03) { discard; }

    // ---------- 脚点 q(几何直出 + ground 场采样,零 CPU 驱动) ----------
    float ppu = uCal.x;
    vec2 fw = vFootWorld * uWorldToWork;               // 脚点 → work px
    float qxF = (fw.x - uCal.z) / ppu;
    float qyF = (uCal.w - fw.y) / ppu;
    vec2 guv = clamp(vFootWorld / max(uSceneWorld, vec2(1e-5)), 0.0, 1.0);
    vec4 gs = texture(uGround, guv);
    float footD = uGroundRange.x
      + ((gs.r * 255.0 * 256.0 + gs.g * 255.0) / 65535.0) * (uGroundRange.y - uGroundRange.x);

    // ---------- 像素高度(世界 → 直立 quad) ----------
    vec2 pw = vWorld * uWorldToWork;
    float h = max((fw.y - pw.y) / max(uCosT * ppu, 1e-6), 0.0);
    float qx = (pw.x - uCal.z) / ppu;

    // ---------- 法线:与 color **同一个 vUV** 采样,镜像只翻方向分量 ----------
    vec4 ne = vec4(0.5, 0.5, 1.0, 0.35);
    if (uHasNrm > 0.5) { ne = texture(uNrm, vUV); }
    vec3 n = normalize(vec3(-(ne.r*2.-1.), -(ne.g*2.-1.), -max(ne.b,.05)));
    if (vMirror > 0.5) n.x = -n.x;
    n = normalize(mix(n, vec3(0.,0.,-1.), uFlatten));

    float bulgeQ = uBulge * uBodyWidthWu / max(uSMWuPerQUnit, 1e-6);
    vec3 q = vec3(qx, qyF + h * uCosT, footD - h * uSinT - ne.a * bulgeQ);

    // 法线档必须是**独占区间**:uShowN=2 是 skyao 档,写成 >0.5 会被这条
    // 先接住并 return,于是「看 skyao」看到的是法线(2026-09-01 踩过)。
    if (uShowN > 0.5 && uShowN < 1.5) { finalColor = vec4((n*.5+.5) * color.a, color.a) * vColor; return; }

    // ---------- 法线有两种用法，各自的空间都是定死的 ----------
    //
    // 上面那个 n 是**世界法线**，而且中性法线是**水平的**（制作人 2026-08-31
    // 点破的几何事实）：角色是一块直立 quad，直立面的面法线只能水平。法线图是
    // bake_normal_atlas.py 在图像像素空间取梯度（gx, -gy, -6），贴上直立 quad 后
    // 那三个轴恰好就是世界 X / Y / −Z —— 中性 (0,0,-1) = 水平朝相机。
    //
    // · **灯循环直接用 n**（世界对世界，铁律 0）——乘 R 等于把法线整体仰起 45°，
    //   头顶的灯过亮、水平来的灯偏暗（2026-08-30 踩过）。
    // · **probe / RT / 太阳查表用 nQ = R^T·n**：SH 载荷的方向基是 q 空间
    //   （pipeline.py _trace 明文 "dirs in q-space"，且逐轴各向异性缩放坐实），
    //   查表方向必须转到同一基。与场景侧 SceneLightingPass 的 GI 体视图同口径。
    //
    // ⚠ 2026-08-31 曾以"实验室查看器原样传"为由把这里改成 probeE(q, n)，当天
    //   被审计钉死为回归：同一个 probeE，场景侧转 R^T、角色侧不转，两种读法
    //   各取一半；实测把角色底光压暗 23%（55→43）。实验室 CHAR_FS 把图集法线
    //   当 q 用是**实验室侧的既有分歧**（inbox 立案，改实验室不改这里），
    //   不构成运行时改约定的依据。beta=4.2 是在 R^T 口径下标定的。
    vec3 nQ = normalize(wrWorldToQ(uSMRow0, uSMRow1, uSMRow2, n));
    // 诊断·定法线(F2 GI体档的诊断组):双方强制同一查表方向后,人与场景的亮度差
    // 100% 是**位置**差——把方向变量归零,专查采样位置。只改 probe/RT 查表,不碰灯循环。
    if (uFixedNQ > 0.5) {
        // 定法线一律用 **q 空间常量**:1=朝相机 q(0,0,-1),2=世界向上 q(0,cosT,-sinT)。
        // 旧写法把 world(0,0,-1) 各自过自家矩阵 —— det=+1(角色)与 det=-1(场景)两个
        // 世界里это两个**相反**的方向,「定法线=朝相机」两侧各查各的,一亮一黑还以为
        // 是数据坏了(2026-09-01 复盘)。q 是两侧共用的约定,常量即构造性同值。
        nQ = uFixedNQ > 1.5 ? normalize(vec3(0., uCosT, -uSinT)) : vec3(0., 0., -1.);
    }

    // ---------- E:RT gather 或 probe 图集(公共块) ----------
    // 间接 / 直接两路保留到着色末端，分别乘当前场景的 factor，再乘总 factor。
    vec3 E = ((uMode < 0.5) ? gatherRT(q + nQ*0.02, nQ) : probeE(q, nQ));
    vec3 EgiPure = E * uGiStrength; // 历史 GI 诊断尺；正常受光的三项 factor 在末端计算
    // ---- skyao:**乘在 GI 上**,与全白 blend(制作人 2026-09-01)----
    // 天穹遮蔽是几何项,只该衰减 GI 底光;太阳是独立解析直射,不吃它
    // (太阳自己的遮蔽将来要走 V_dir(w) 那条闭式,不是这个各向同性的 V)。
    E *= mix(1.0, skyaoAt(q, nQ), clamp(uSkyaoBlend, 0.0, 1.0));
    // 调试档:uShowN==2 => 直接把 skyao 的 V 画成灰度(1=不遮蔽 0=全遮)。
    // 判「这一项到底生没生效」只能看它 —— 角色在 800x450 里只有几十像素,
    // 靠肉眼比两张截图分不出 3 倍的 GI 差异(2026-09-01 实测走过这个弯路)。
    if (uShowN > 4.5) { finalColor = vec4(skyaoBand(q, nQ) * color.a, color.a); return; }
    if (uShowN > 3.5) { finalColor = vec4(skyaoRaw(q) * color.a, color.a); return; }
    if (uShowN > 2.5) { finalColor = vec4(skyaoBox(q) * color.a, color.a); return; }
    if (uShowN > 1.5) {
      // 同 eOnly 那课:必须过与场景同一条显示链,否则与 uDebug==11 对看时角色凭空
      // 暗一档、半透明边缘一圈黑边(2026-09-01)。3/4/5 取证子档刻意保持裸值(读数用)。
      float v = skyaoAt(q, nQ);
      vec3 vd = clamp(lcDisplayTransform(vec3(v),
          uDispEv, uDispTonemap, uDispWhite,
          uDispSaturation, uDispContrast, uDispLift, uDispLiftColor), 0.0, 1.0);
      finalColor = vec4(vd * color.a, color.a);
      return;
    }
    vec3 directE = vec3(0.0);
    if (uSunOn > 0.5) {
        // F2 的测试太阳（实验室没有这一项）。uSunDirQ 是 q 空间方向，与 nQ 同基。
        directE += uSunColor * max(dot(nQ, uSunDirQ), 0.0);
    }

    // ---------- 实体灯：加性叠在 probe 的 GI 底光之上 ----------
    //
    // 模型（2026-08-30 制作人定调）：原画就是被 GI 照亮的结果，probe 是同一份 GI 给
    // 角色的版本；实体灯在这之上**直接加**。场景侧同源（见 SceneLightingPass），
    // 灯来自同一次 packLights ⇒「灯对角色和场景一视同仁」是构造性的，不是两处写得像。
    //
    // 着色在 M-world（q 经 det=+1 的 R 旋过去），不是裸 q —— 裸 q 的 Y 是屏幕上、
    // 不是世界上，灯的仰角与 1/r² 会全错（coordinate-spaces 铁律 4）。循环本体在
    // ENTITY_SCENE_LIGHTS_GLSL（粒子受光拼的是同一段）。
    //
    // 法线直接用 n：它**已经是世界法线**（中性=水平，见上面"法线只有一个约定"段），
    // 灯位/P 也在世界 wu —— 世界对世界，谁都不用转。
    //
    // ⚠ 这里曾留过一段相反的注释（"n 是 q 空间的量、必须转到 M-world、正面的
    //   世界朝向是 (0,+0.707,−0.707)"）—— 那是错的：把中性法线说成上仰 45° 意味着
    //   直立的人像躺着的地面一样迎接头顶光、又拒收水平来的灯光。直立 quad 的
    //   面法线是**水平**的（制作人 2026-08-31 点破），worldSpaceShading 测试锁的
    //   就是这一约定。那段错注释误导过一整轮排查（照它摆的"贴脸灯"全在法线
    //   背面），删除防再骗。几何推论：**低于人的灯照不亮躯干正面是错觉**——
    //   水平法线下只要灯在 quad 平面靠相机一侧，脚边的火同样照亮胸口。
    directE += entitySceneLightsE(q, n);
    // ---- 「GI体·纯E」调试(F2 循环 8/9 档):albedo≡1,输出 E×2^β ----
    // 与场景侧 uDebug==8 逐字同式(不走 /π、eChroma 与显示变换):这是校验 probe 体
    // 的尺子,不是美术视图 —— 两边同式,人与地面的 E 才能逐像素直接比。
    if (uEOnly > 0.5) {
        // ---- 取证子档(2026-09-01 单点双管线对测,console 直设 eOnlyDebug=2/3/4) ----
        // 2=raw probeE(线性直出,无β无显示链) 3=probeGridT/PN 染色 4=valid 角数/8
        if (uEOnly > 1.5 && uEOnly < 2.5) {
            finalColor = vec4(probeE(q, nQ) * color.a, color.a) * vColor; return;
        }
        if (uEOnly > 2.5 && uEOnly < 3.5) {
            finalColor = vec4((probeGridT(q) / uPN) * color.a, color.a) * vColor; return;
        }
        // 5=脚点q((q-uQMin)/(uQMax-uQMin),整quad同值,采哪都行) 6=vFootWorld/uSceneWorld
        if (uEOnly > 4.5 && uEOnly < 5.5) {
            vec3 qF = vec3(qxF, qyF, footD);
            finalColor = vec4(clamp((qF - uQMin) / max(uQMax - uQMin, vec3(1e-5)), 0., 1.) * color.a, color.a) * vColor;
            return;
        }
        if (uEOnly > 5.5) {
            finalColor = vec4(vec3(clamp(vFootWorld / max(uSceneWorld, vec2(1e-5)), 0., 1.), 0.5) * color.a, color.a) * vColor;
            return;
        }
        if (uEOnly > 3.5) {
            vec3 tv = probeGridT(q);
            ivec3 b0v = ivec3(tv);
            ivec3 pnv = ivec3(uPN + .5);
            float cnt = 0.;
            for (int c = 0; c < 8; c++) {
                ivec3 off = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
                ivec3 pi = min(b0v + off, pnv - 1);
                int fl = pi.x * (pnv.y * pnv.z) + pi.y * pnv.z + pi.z;
                cnt += step(.002, texelFetch(uValid, probeTexel(fl, 1, 0), 0).r);
            }
            finalColor = vec4(vec3(cnt / 8.) * color.a, color.a) * vColor; return;
        }
        // ⚠ 用**乘 skyao 之前**的 E:场景侧 uDebug==8 是纯 E,这边拿乘过 V 的 E 去比
        // 就是双重衰减 —— 白天开阔处 V≈0.9 看不出,夜里墙边直接把人压黑(2026-09-01)。
        vec3 pe = EgiPure * uBeta;
        // 诊断:角色也画 probe 棋盘(cell 奇偶与场景 uDebug==9 同一套 probeGridT)。
        // 判据:格边必须笔直穿过脚点、走动时与地面棋盘同帧翻转、竖向格高与邻墙一致。
        if (uEChecker > 0.5) {
            ivec3 cc = ivec3(probeGridT(q));
            pe *= mix(0.45, 1.0, float((cc.x + cc.y + cc.z) & 1));
        }
        // ⚠ 必须过与场景**同一条显示链**:场景的调试输出写进 RT 后仍要被 LitBackground
        //   做显示变换(EV/tonemap/sRGB 收尾),角色直出线性值会平白暗一大截——
        //   2026-09-01 实测这口"假位置差"就有 ~3×(sRGB)+tonemap 的成分。
        vec3 peDisp = clamp(lcDisplayTransform(pe,
            uDispEv, uDispTonemap, uDispWhite,
            uDispSaturation, uDispContrast, uDispLift, uDispLiftColor), 0.0, 1.0);
        finalColor = vec4(peDisp * color.a, color.a) * vColor;
        return;
    }
    vec3 alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    // ★ 与背景同一份显示变换（lcDisplayTransform 收尾自带 sRGB，所以不再 lin2srgb）。
    vec3 outRgb = clamp(lcDisplayTransform(
        shadeEntityLinear(alb, E, directE, uIndirectFactor, uDirectFactor, uTotalFactor, uEChroma),
        uDispEv, uDispTonemap, uDispWhite,
        uDispSaturation, uDispContrast, uDispLift, uDispLiftColor), 0.0, 1.0);

    float vy = clamp(vLocal.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    outRgb *= clamp(1.0 - contact - form, 0.0, 1.0);

    finalColor = vec4(outRgb * color.a, color.a) * vColor;
}
`;

// ───────────────────────────── WGSL(WebGPU 路径;上面的 GLSL 一个字不动,WebGL 仍跑它)
//
// 与 VERT / FRAG 逐式对应,差别只在语言(约定见 agent_docs 的 pixi-shader-wgsl-port 配方卡):
// - 组 0 / 1 是 Pixi 网格约定(globalUniforms / localUniforms,声明了 Pixi 才自动绑);自己的资源全在组 2,
//   变量名 = resources 的键名;四个 uniform 组的 struct 成员同名同序对应各自的 create*Uniforms。
// - 纹理的声明顺序与 createLitShader 的 resources 表相对顺序一致(WebGL 按组号 / 绑定号升序分纹理单元)。
// - 用 texture() 采样的三张(uColorTex / uNrm / uGround)各配一个「纹理名 + Sampler」,值是该纹理自己的 style;
//   其余全走 textureLoad,不要采样器。换纹理时采样器跟着换(setLitShaderTexture)。
// - 共享片段(CLC / WR_CORE / LC / 实体灯循环)拼 WGSL 版,每段一个模块只拼一次;CLC 的函数一个绑定都不读,
//   main 开头按字段名逐个赋值建 ClcProbe / ClcSkyao / ClcVol(ClcRt 只在 RT 那一支里建)。
// - 只有 uColorTex 在一致控制流里(discard 之前)用 textureSample;discard 之后的 uNrm / uGround 用
//   textureSampleLevel(.., 0.0) —— 两张都没有 mip,与 GLSL 的 texture() 等价。
// - gatherRT 的随机旋转吃片元坐标:GLSL 读 gl_FragCoord,这里把入口的位置内建量 .xy 传进去
//   (离屏目标上两者行序一致;直接画到画布时 y 相反,只影响 RT 诊断档的噪声图样)。
// - 结构体里不写注释:Pixi 用正则解析 WGSL 的 struct 与 group 声明,注释里的「名: 类型」会被当成成员。

/**
 * `sceneShade` 组({@link createSceneLitUniforms})的 WGSL 结构:成员**同名同序**对应 JS 声明
 * (Pixi 按 JS 声明顺序、WGSL 对齐规则排 uniform 缓冲;错位不报错)。粒子受光共用同一个组,拼这一段即可。
 */
export const SCENE_SHADE_WGSL = /* wgsl */ `
struct SceneShade {
    uWorkSize: vec2<f32>,
    uWorldToWork: vec2<f32>,
    uCal: vec4<f32>,
    uCosT: f32,
    uSinT: f32,
    uQMin: vec3<f32>,
    uQMax: vec3<f32>,
    uVolN: vec3<f32>,
    uVolTiles: vec2<f32>,
    uM: mat3x3<f32>,
    uWMin: vec3<f32>,
    uWScale: vec3<f32>,
    uPN: vec3<f32>,
    uProbeT: f32,
    uShK: f32,
    uBinOb: f32,
    uAmbSH: array<vec3<f32>, 9>,
    uLightQ: array<vec4<f32>, 48>,
    uLightE: array<vec4<f32>, 48>,
    uLightCount: f32,
    uGroundRange: vec2<f32>,
    uSceneWorld: vec2<f32>,
    uSkyaoN: vec3<f32>,
    uSkyaoTiles: vec2<f32>,
    uSkyaoMin: vec3<f32>,
    uSkyaoScale: vec3<f32>,
    uSkyaoM: mat3x3<f32>,
    uSkyaoOn: f32,
}
`;

/**
 * `frameShade` 组({@link createFrameLitUniforms})的 WGSL 结构,同上(同名同序)。
 * 角色网格与粒子各有一份这个组(粒子是 vfxFrameLit),布局相同。
 */
export const FRAME_SHADE_WGSL = /* wgsl */ `
struct FrameShade {
    uWCPos: vec2<f32>,
    uWCScale: f32,
    uMode: f32,
    uSpp: f32,
    uMSteps: f32,
    uFold: f32,
    uMissMode: f32,
    uNEE: f32,
    uStep: f32,
    uBeta: f32,
    uIndirectFactor: f32,
    uDirectFactor: f32,
    uTotalFactor: f32,
    uAmbStrength: f32,
    uBulge: f32,
    uFlatten: f32,
    uShowN: f32,
    uEOnly: f32,
    uGiStrength: f32,
    uFixedNQ: f32,
    uEChecker: f32,
    uSunOn: f32,
    uSunDirQ: vec3<f32>,
    uSunColor: vec3<f32>,
    uEChroma: f32,
    uAOContact: f32,
    uAOForm: f32,
    uSkyaoBlend: f32,
}
`;

/** 宿主声明:两个 Pixi 网格组 + 组 2 的全部资源(顺序见上面的约定)。 */
const LIT_DECLS_WGSL = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}

struct EntityShade {
    uHasNrm: f32,
    uBodyWidthWu: f32,
    uL2W0: vec3<f32>,
    uL2W1: vec3<f32>,
}
${SCENE_SHADE_WGSL}
${FRAME_SHADE_WGSL}
${CHAR_LIGHTS_WGSL}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

@group(2) @binding(0) var<uniform> sceneShade: SceneShade;
@group(2) @binding(1) var<uniform> frameShade: FrameShade;
@group(2) @binding(2) var<uniform> charLights: CharLights;
@group(2) @binding(3) var<uniform> entityShade: EntityShade;
@group(2) @binding(4) var uColorTex: texture_2d<f32>;
@group(2) @binding(5) var uColorTexSampler: sampler;
@group(2) @binding(6) var uNrm: texture_2d<f32>;
@group(2) @binding(7) var uNrmSampler: sampler;
@group(2) @binding(8) var uGround: texture_2d<f32>;
@group(2) @binding(9) var uGroundSampler: sampler;
@group(2) @binding(10) var uPL1: texture_2d<f32>;
@group(2) @binding(11) var uPL2: texture_2d<f32>;
@group(2) @binding(12) var uPBin: texture_2d<f32>;
@group(2) @binding(13) var uValid: texture_2d<f32>;
@group(2) @binding(14) var uVolRad: texture_2d<f32>;
@group(2) @binding(15) var uVolEmit: texture_2d<f32>;
@group(2) @binding(16) var uSkyaoTex: texture_2d<f32>;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vLocal: vec2<f32>,
    @location(2) vWorld: vec2<f32>,
    @location(3) vFootWorld: vec2<f32>,
    @location(4) vMirror: f32,
    @location(5) vColor: vec4<f32>,
}
`;

/** 对应 GLSL VERT(世界坐标只由 CPU 喂的 local→sceneWorld 仿射给出,不从 screen 反推;理由见 VERT 注释)。 */
const VERT_WGSL = /* wgsl */ `
@vertex
fn mainVertex(
    @location(0) aPosition: vec2<f32>,
    @location(1) aUV: vec2<f32>,
    @location(2) aLocal: vec2<f32>,
) -> VSOutput {
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
    var out: VSOutput;
    out.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
    out.vUV = aUV;
    out.vLocal = aLocal;
    let r0 = entityShade.uL2W0;
    let r1 = entityShade.uL2W1;
    out.vWorld = vec2<f32>(r0.x * aPosition.x + r0.y * aPosition.y + r0.z,
                           r1.x * aPosition.x + r1.y * aPosition.y + r1.z);
    out.vFootWorld = vec2<f32>(r0.z, r1.z);                  // local 原点(锚点=脚底)的世界坐标
    // 镜像判定:仿射 2x2 行列式,scale.x<0 → det<0
    let det = r0.x * r1.y - r1.x * r0.y;
    out.vMirror = 0.0;
    if (det < 0.0) { out.vMirror = 1.0; }
    out.vColor = localUniforms.uColor;
    return out;
}
`;

/** 对应 GLSL FRAG,分支与提前返回逐条同序(各段的来历与坑见 FRAG 里的注释,这里不重复)。 */
const FRAG_WGSL = /* wgsl */ `
@fragment
fn mainFragment(
    @builtin(position) fragPos: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vLocal: vec2<f32>,
    @location(2) vWorld: vec2<f32>,
    @location(3) vFootWorld: vec2<f32>,
    @location(4) vMirror: f32,
    @location(5) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
    let color = textureSample(uColorTex, uColorTexSampler, vUV);
    if (color.a < 0.03) { discard; }

    // 公共块的参数结构:按字段名逐个赋值(同为 f32 的字段位置构造会静默错位)
    var pp: ClcProbe;
    pp.uM = sceneShade.uM;
    pp.uWMin = sceneShade.uWMin;
    pp.uWScale = sceneShade.uWScale;
    pp.uPN = sceneShade.uPN;
    pp.uProbeT = sceneShade.uProbeT;
    pp.uShK = sceneShade.uShK;
    pp.uBinOb = sceneShade.uBinOb;
    pp.uFold = frameShade.uFold;
    pp.uAmbSH = sceneShade.uAmbSH;
    pp.uMode = frameShade.uMode;
    pp.uAmbStrength = frameShade.uAmbStrength;
    var sk: ClcSkyao;
    sk.uSkyaoN = sceneShade.uSkyaoN;
    sk.uSkyaoTiles = sceneShade.uSkyaoTiles;
    sk.uSkyaoMin = sceneShade.uSkyaoMin;
    sk.uSkyaoScale = sceneShade.uSkyaoScale;
    sk.uSkyaoM = sceneShade.uSkyaoM;
    sk.uSkyaoOn = sceneShade.uSkyaoOn;

    // ---------- 脚点 q(几何直出 + ground 场采样,零 CPU 驱动) ----------
    let ppu = sceneShade.uCal.x;
    let fw = vFootWorld * sceneShade.uWorldToWork;               // 脚点 → work px
    let qxF = (fw.x - sceneShade.uCal.z) / ppu;
    let qyF = (sceneShade.uCal.w - fw.y) / ppu;
    let guv = clamp(vFootWorld / max(sceneShade.uSceneWorld, vec2<f32>(1e-5)), vec2<f32>(0.0), vec2<f32>(1.0));
    let gs = textureSampleLevel(uGround, uGroundSampler, guv, 0.0);
    let footD = sceneShade.uGroundRange.x
      + ((gs.r * 255.0 * 256.0 + gs.g * 255.0) / 65535.0) * (sceneShade.uGroundRange.y - sceneShade.uGroundRange.x);

    // ---------- 像素高度(世界 → 直立 quad) ----------
    let pw = vWorld * sceneShade.uWorldToWork;
    let h = max((fw.y - pw.y) / max(sceneShade.uCosT * ppu, 1e-6), 0.0);
    let qx = (pw.x - sceneShade.uCal.z) / ppu;

    // ---------- 法线:与 color 同一个 vUV 采样,镜像只翻方向分量 ----------
    var ne = vec4<f32>(0.5, 0.5, 1.0, 0.35);
    if (entityShade.uHasNrm > 0.5) { ne = textureSampleLevel(uNrm, uNrmSampler, vUV, 0.0); }
    var n = normalize(vec3<f32>(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (vMirror > 0.5) { n.x = -n.x; }
    n = normalize(mix(n, vec3<f32>(0., 0., -1.), frameShade.uFlatten));

    let bulgeQ = frameShade.uBulge * entityShade.uBodyWidthWu / max(charLights.uSMWuPerQUnit, 1e-6);
    let q = vec3<f32>(qx, qyF + h * sceneShade.uCosT, footD - h * sceneShade.uSinT - ne.a * bulgeQ);

    // 法线档是独占区间(uShowN=2 是 skyao 档)
    if (frameShade.uShowN > 0.5 && frameShade.uShowN < 1.5) {
        return vec4<f32>((n * .5 + .5) * color.a, color.a) * vColor;
    }

    // 灯循环直接用 n(世界法线);probe / RT / 太阳查表用 nQ = Rᵀ·n(SH 载荷的方向基是 q)
    var nQ = normalize(wrWorldToQ(charLights.uSMRow0, charLights.uSMRow1, charLights.uSMRow2, n));
    // 诊断·定法线:一律用 q 空间常量(1=朝相机 2=世界向上),只改查表,不碰灯循环
    if (frameShade.uFixedNQ > 0.5) {
        if (frameShade.uFixedNQ > 1.5) {
            nQ = normalize(vec3<f32>(0., sceneShade.uCosT, -sceneShade.uSinT));
        } else {
            nQ = vec3<f32>(0., 0., -1.);
        }
    }

    // ---------- E:RT gather 或 probe 图集(公共块) ----------
    var E: vec3<f32>;
    if (frameShade.uMode < 0.5) {
        var vv: ClcVol;
        vv.uVolN = sceneShade.uVolN;
        vv.uVolTiles = sceneShade.uVolTiles;
        vv.uQMin = sceneShade.uQMin;
        vv.uQMax = sceneShade.uQMax;
        var rt: ClcRt;
        rt.uSpp = frameShade.uSpp;
        rt.uMSteps = frameShade.uMSteps;
        rt.uMissMode = frameShade.uMissMode;
        rt.uNEE = frameShade.uNEE;
        rt.uStep = frameShade.uStep;
        rt.uLightCount = sceneShade.uLightCount;
        rt.uLightQ = sceneShade.uLightQ;
        rt.uLightE = sceneShade.uLightE;
        E = gatherRT(q + nQ * 0.02, nQ, fragPos.xy, pp, vv, &rt, uVolRad, uVolEmit);
    } else {
        E = probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid);
    }
    let EgiPure = E * frameShade.uGiStrength;   // 历史 GI 诊断尺;正常受光的三项 factor 在末端计算
    // skyao 乘在 GI 上,与全白 blend
    E *= mix(1.0, skyaoAt(q, nQ, sk, uSkyaoTex), clamp(frameShade.uSkyaoBlend, 0.0, 1.0));
    if (frameShade.uShowN > 4.5) { return vec4<f32>(skyaoBand(q, nQ, sk, uSkyaoTex) * color.a, color.a); }
    if (frameShade.uShowN > 3.5) { return vec4<f32>(skyaoRaw(q, sk, uSkyaoTex) * color.a, color.a); }
    if (frameShade.uShowN > 2.5) { return vec4<f32>(skyaoBox(q, sk) * color.a, color.a); }
    if (frameShade.uShowN > 1.5) {
        // 与场景同一条显示链(3/4/5 取证子档刻意保持裸值)
        let v = skyaoAt(q, nQ, sk, uSkyaoTex);
        let vd = clamp(lcDisplayTransform(vec3<f32>(v),
            charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
            charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor),
            vec3<f32>(0.0), vec3<f32>(1.0));
        return vec4<f32>(vd * color.a, color.a);
    }
    var directE = vec3<f32>(0.0);
    if (frameShade.uSunOn > 0.5) {
        // F2 的测试太阳:uSunDirQ 是 q 空间方向,与 nQ 同基
        directE += frameShade.uSunColor * max(dot(nQ, frameShade.uSunDirQ), 0.0);
    }

    // ---------- 实体灯:加性叠在 probe 的 GI 底光之上(循环本体在 ENTITY_SCENE_LIGHTS_WGSL) ----------
    directE += entitySceneLightsE(q, n);
    // ---- 「GI体·纯E」调试(F2 循环 8/9 档):albedo≡1,输出 E×2^β ----
    if (frameShade.uEOnly > 0.5) {
        // 取证子档:2=raw probeE 3=probeGridT/PN 染色 4=valid 角数/8 5=脚点 q 6=vFootWorld/uSceneWorld
        if (frameShade.uEOnly > 1.5 && frameShade.uEOnly < 2.5) {
            return vec4<f32>(probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 2.5 && frameShade.uEOnly < 3.5) {
            return vec4<f32>((probeGridT(q, pp) / sceneShade.uPN) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 4.5 && frameShade.uEOnly < 5.5) {
            let qF = vec3<f32>(qxF, qyF, footD);
            return vec4<f32>(clamp((qF - sceneShade.uQMin) / max(sceneShade.uQMax - sceneShade.uQMin, vec3<f32>(1e-5)),
                                   vec3<f32>(0.), vec3<f32>(1.)) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 5.5) {
            return vec4<f32>(vec3<f32>(clamp(vFootWorld / max(sceneShade.uSceneWorld, vec2<f32>(1e-5)),
                                             vec2<f32>(0.), vec2<f32>(1.)), 0.5) * color.a, color.a) * vColor;
        }
        if (frameShade.uEOnly > 3.5) {
            let tv = probeGridT(q, pp);
            let b0v = vec3<i32>(tv);
            let pnv = vec3<i32>(sceneShade.uPN + .5);
            var cnt = 0.;
            for (var c = 0; c < 8; c++) {
                let off = vec3<i32>(c & 1, (c >> 1u) & 1, (c >> 2u) & 1);
                let pi = min(b0v + off, pnv - 1);
                let fl = pi.x * (pnv.y * pnv.z) + pi.y * pnv.z + pi.z;
                cnt += step(.002, textureLoad(uValid, probeTexel(fl, 1, 0, pp), 0).r);
            }
            return vec4<f32>(vec3<f32>(cnt / 8.) * color.a, color.a) * vColor;
        }
        // 用乘 skyao 之前的 E(与场景 uDebug==8 同式)
        var pe = EgiPure * frameShade.uBeta;
        if (frameShade.uEChecker > 0.5) {
            let cc = vec3<i32>(probeGridT(q, pp));
            pe *= mix(0.45, 1.0, f32((cc.x + cc.y + cc.z) & 1));
        }
        // 与场景同一条显示链
        let peDisp = clamp(lcDisplayTransform(pe,
            charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
            charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor),
            vec3<f32>(0.0), vec3<f32>(1.0));
        return vec4<f32>(peDisp * color.a, color.a) * vColor;
    }
    let alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    // 与背景同一份显示变换(lcDisplayTransform 收尾自带 sRGB)
    var outRgb = clamp(lcDisplayTransform(
        shadeEntityLinear(alb, E, directE, frameShade.uIndirectFactor, frameShade.uDirectFactor,
                          frameShade.uTotalFactor, frameShade.uEChroma),
        charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
        charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor),
        vec3<f32>(0.0), vec3<f32>(1.0));

    let vy = clamp(vLocal.y, 0.0, 1.0);
    let contact = frameShade.uAOContact * smoothstep(0.78, 1.0, vy);
    let form = frameShade.uAOForm * vy;
    outRgb *= clamp(1.0 - contact - form, 0.0, 1.0);

    return vec4<f32>(outRgb * color.a, color.a) * vColor;
}
`;

/** 顶点与片元拼成一个模块(两个入口);共享片段每段只拼一次。 */
const LIT_WGSL = [
  LIT_DECLS_WGSL, CHAR_LIGHT_COMMON_WGSL, WR_CORE_WGSL, LC_WGSL, ENTITY_SCENE_LIGHTS_WGSL, VERT_WGSL, FRAG_WGSL,
].join('\n');

let litProgram: GlProgram | null = null;
function getLitProgram(): GlProgram {
  if (!litProgram) litProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return litProgram;
}

let litGpuProgram: GpuProgram | null = null;
function getLitGpuProgram(): GpuProgram {
  if (!litGpuProgram) {
    litGpuProgram = GpuProgram.from({
      vertex: { source: LIT_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: LIT_WGSL, entryPoint: 'mainFragment' },
    });
  }
  return litGpuProgram;
}

/** 共享帧组(uWCPos/uWCScale + 全部照明参数):CharacterLightingSystem 每帧更新一次。 */
export function createFrameLitUniforms(): UniformGroup {
  return new UniformGroup({
    uWCPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uWCScale: { value: 1, type: 'f32' },
    uMode: { value: 2, type: 'f32' },
    uSpp: { value: 64, type: 'f32' },
    uMSteps: { value: 160, type: 'f32' },
    uFold: { value: 1, type: 'f32' },
    uMissMode: { value: 0, type: 'f32' },
    uNEE: { value: 0, type: 'f32' },
    uStep: { value: 0.9, type: 'f32' },
    uBeta: { value: 1, type: 'f32' },
    uIndirectFactor: { value: 1, type: 'f32' },
    uDirectFactor: { value: 1, type: 'f32' },
    uTotalFactor: { value: 1, type: 'f32' },
    uAmbStrength: { value: 1, type: 'f32' },
    uBulge: { value: 0.22, type: 'f32' },
    uFlatten: { value: 0, type: 'f32' },
    uShowN: { value: 0, type: 'f32' },
    uEOnly: { value: 0, type: 'f32' },
    uGiStrength: { value: 1, type: 'f32' },
    uFixedNQ: { value: 0, type: 'f32' },
    uEChecker: { value: 0, type: 'f32' },
    uSunOn: { value: 0, type: 'f32' },
    uSunDirQ: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
    uSunColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uEChroma: { value: 0, type: 'f32' },
    uAOContact: { value: 0, type: 'f32' },
    uAOForm: { value: 0, type: 'f32' },
    // skyao 与全白的 blend:0=完全不遮蔽 1=完整遮蔽。运行时可调。
    uSkyaoBlend: { value: 1, type: 'f32' },
  });
}

/** 场景静态组的输入(与 filter 的 CharShadingSceneResources 字段同源)。 */
export interface LitSceneStatics {
  worldToWorkX: number;
  worldToWorkY: number;
  cal: { ppu: number; cx: number; cy: number; theta: number };
  vol: {
    nx: number; ny: number; nz: number; tilesX: number; tilesY: number;
    qMin: [number, number, number]; qMax: [number, number, number];
  };
  mCol: Float32Array;
  wMin: [number, number, number];
  wScale: [number, number, number];
  pn: [number, number, number];
  /** probe 图集平铺:每行多少颗(与 filter 侧 probeT 同值同义) */
  probeT: number;
  /** 'l2' 图集每颗的球谐系数数(9=L2 / 25=L4) */
  shK: number;
  /** 八面体边长(8 或 16) */
  binOb: number;
  ambSH: Float32Array;
  lightsQ: Float32Array;
  lightsE: Float32Array;
  lightCount: number;
  groundMin: number;
  groundMax: number;
  sceneWorldW: number;
  sceneWorldH: number;
  workW: number;
  workH: number;
  /**
   * skyao probe(`lighting/<背景基名>/skyao_probe.bin`):天穹遮蔽矩,乘在 GI 上。
   *
   * ⚠ `mCol` 是 **depthConfig 的 det=+1 世界系**(矩就是用它烘的),
   *   与 probe 图集那套 `lighting.json.world.M`(det=-1)**不是一个矩阵**。
   *   混用不报错,只是 `a1·N` 的方向整个镜像。
   */
  skyao?: {
    tex: TextureSource;
    n: [number, number, number];
    tiles: [number, number];
    wMin: [number, number, number];
    wScale: [number, number, number];
    mCol: Float32Array;
  } | null;
}

export function createSceneLitUniforms(s: LitSceneStatics): UniformGroup {
  return new UniformGroup({
    uWorkSize: { value: new Float32Array([s.workW, s.workH]), type: 'vec2<f32>' },
    uWorldToWork: { value: new Float32Array([s.worldToWorkX, s.worldToWorkY]), type: 'vec2<f32>' },
    uCal: { value: new Float32Array([s.cal.ppu, 0, s.cal.cx, s.cal.cy]), type: 'vec4<f32>' },
    uCosT: { value: Math.cos(s.cal.theta), type: 'f32' },
    uSinT: { value: Math.sin(s.cal.theta), type: 'f32' },
    uQMin: { value: new Float32Array(s.vol.qMin), type: 'vec3<f32>' },
    uQMax: { value: new Float32Array(s.vol.qMax), type: 'vec3<f32>' },
    uVolN: { value: new Float32Array([s.vol.nx, s.vol.ny, s.vol.nz]), type: 'vec3<f32>' },
    uVolTiles: { value: new Float32Array([s.vol.tilesX, s.vol.tilesY]), type: 'vec2<f32>' },
    uM: { value: s.mCol, type: 'mat3x3<f32>' },
    uWMin: { value: new Float32Array(s.wMin), type: 'vec3<f32>' },
    uWScale: { value: new Float32Array(s.wScale), type: 'vec3<f32>' },
    uPN: { value: new Float32Array(s.pn), type: 'vec3<f32>' },
    uProbeT: { value: s.probeT, type: 'f32' },
    uShK: { value: s.shK, type: 'f32' },
    uBinOb: { value: s.binOb, type: 'f32' },
    uAmbSH: { value: s.ambSH, type: 'vec3<f32>', size: 9 },
    uLightQ: { value: s.lightsQ, type: 'vec4<f32>', size: 48 },
    uLightE: { value: s.lightsE, type: 'vec4<f32>', size: 48 },
    uLightCount: { value: s.lightCount, type: 'f32' },
    uGroundRange: { value: new Float32Array([s.groundMin, s.groundMax]), type: 'vec2<f32>' },
    uSceneWorld: { value: new Float32Array([s.sceneWorldW, s.sceneWorldH]), type: 'vec2<f32>' },
    // ---- skyao probe。没有载荷时 uSkyaoOn=0,shader 里恒返回 1(不遮蔽)----
    uSkyaoN: { value: new Float32Array(s.skyao?.n ?? [1, 1, 1]), type: 'vec3<f32>' },
    uSkyaoTiles: { value: new Float32Array(s.skyao?.tiles ?? [1, 1]), type: 'vec2<f32>' },
    uSkyaoMin: { value: new Float32Array(s.skyao?.wMin ?? [0, 0, 0]), type: 'vec3<f32>' },
    uSkyaoScale: { value: new Float32Array(s.skyao?.wScale ?? [0, 0, 0]), type: 'vec3<f32>' },
    uSkyaoM: { value: s.skyao?.mCol ?? new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
               type: 'mat3x3<f32>' },
    uSkyaoOn: { value: s.skyao ? 1 : 0, type: 'f32' },
  });
}

/**
 * 场景实体灯的 uniform 组（角色侧）。**独立于 sceneShade**：灯会被 F2、灯光编辑器
 * 双向同步、以及后面的时段切换改动，而 sceneShade 是按场景载荷建一次的。分开就能
 * 就地改数组、不必为动一盏灯重建整组。
 *
 * ⚠ 数组按 `MAX_STATIC_LIGHTS` 定长分配（Pixi 的 uniform 数组要定长），
 *   实际生效条数由 `uSceneLightCount` 截断。
 */
export function createCharLightUniforms(): UniformGroup {
  const z4 = () => new Float32Array(MAX_STATIC_LIGHTS * 4);
  return new UniformGroup({
    uSceneLightCount: { value: 0, type: 'i32' },
    uSceneLightA: { value: z4(), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uSceneLightB: { value: z4(), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uSceneLightC: { value: z4(), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uSceneLightD: { value: z4(), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    // 缺省 1 = 「q 就是 wu」，即没有场景标定时行为与旧版逐位一致。
    uSMWuPerQUnit: { value: 1, type: 'f32' },
    uSMRow0: { value: new Float32Array([1, 0, 0]), type: 'vec3<f32>' },
    uSMRow1: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
    uSMRow2: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
    // 显示变换缺省=恒等（ev 0 / tonemap none / 白平衡与提升色为白）——
    // 没有场景数据时角色与"直接 lin2srgb"逐位一致，旧行为零变化。
    uDispEv: { value: 0, type: 'f32' },
    uDispTonemap: { value: 0, type: 'i32' },
    uDispWhite: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uDispSaturation: { value: 1, type: 'f32' },
    uDispContrast: { value: 1, type: 'f32' },
    uDispLift: { value: 0, type: 'f32' },
    uDispLiftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
  });
}

/**
 * 把场景的显示变换参数写进角色组 —— 与 `LitBackground.applyParams` **同一组数**。
 *
 * 背景是 displayTransform(辐射 RT)、角色是独立 sprite，两边不套同一个变换，角色就只在
 * 「显示恒等」的场景里对得上。雾津街头 ev=3.32 时背景被提亮 10 倍而角色纹丝不动，
 * 表现就是「背景很亮、角色漆黑」（2026-08-30 制作人当场抓到）。
 */
export function applyCharDisplay(group: UniformGroup, d: SceneLightingDef['display'] | null): void {
  const u = group.uniforms as Record<string, unknown>;
  if (!d) {
    u['uDispEv'] = 0; u['uDispTonemap'] = 0;
    u['uDispSaturation'] = 1; u['uDispContrast'] = 1; u['uDispLift'] = 0;
    (u['uDispWhite'] as Float32Array).set([1, 1, 1]);
    (u['uDispLiftColor'] as Float32Array).set([1, 1, 1]);
    group.update();
    return;
  }
  u['uDispEv'] = d.ev;
  u['uDispTonemap'] = d.tonemap === 'reinhard' ? 1 : d.tonemap === 'filmic' ? 2 : 0;
  (u['uDispWhite'] as Float32Array).set(resolveLightColor(undefined, d.whiteKelvin));
  u['uDispSaturation'] = d.saturation;
  u['uDispContrast'] = d.contrast;
  u['uDispLift'] = d.lift;
  (u['uDispLiftColor'] as Float32Array).set(resolveLightColor(undefined, d.liftKelvin));
  group.update();
}

/**
 * 把打包好的灯与 q→M-world 的三行写进上面那个组。
 *
 * `packed` 必须是 `SceneLightingPass` 用的**同一次** `packLights` 结果 ——
 * 角色与场景吃同一份数据是「一视同仁」的构造性保证，不是两处各算一遍。
 * `mRows` 取 `depthConfig.M.R`（det=+1），**不是** lighting.json 里那个 det=−1 的。
 */
export function applyCharLights(
  group: UniformGroup,
  packed: PackedLights | null,
  mRows: readonly [readonly number[], readonly number[], readonly number[]] | null,
  /**
   * 1 个 q 单位 = 多少 wu。铁律 0：光照的长度一律 wu，所以 shader 里
   * `P = R·q × wuPerQUnit`。**必须与打包灯位时用的是同一个场景的值** ——
   * 灯位是 wu、P 也是 wu，两者才能相减。传 0/undefined 按 1 处理（= q 即 wu）。
   */
  wuPerQUnit = 1,
): void {
  const u = group.uniforms as Record<string, unknown>;
  if (!packed || !mRows) {
    u['uSceneLightCount'] = 0;
    group.update();
    return;
  }
  (u['uSceneLightA'] as Float32Array).set(packed.a);
  (u['uSceneLightB'] as Float32Array).set(packed.b);
  (u['uSceneLightC'] as Float32Array).set(packed.c);
  (u['uSceneLightD'] as Float32Array).set(packed.d);
  u['uSceneLightCount'] = packed.count;
  u['uSMWuPerQUnit'] = wuPerQUnit > 0 ? wuPerQUnit : 1;
  (u['uSMRow0'] as Float32Array).set(mRows[0]);
  (u['uSMRow1'] as Float32Array).set(mRows[1]);
  (u['uSMRow2'] as Float32Array).set(mRows[2]);
  group.update();
}

export interface LitShaderTextures {
  /**
   * skyao probe(天穹遮蔽矩)。**必须绑** —— `uSkyaoOn` 由 sceneShade 决定,
   * 载荷在而 sampler 没绑,着色器就会去采一个未绑定的 sampler:采回 (0,0,0,1)
   * ⇒ V=0 ⇒ GI 被整段乘成 0,角色全黑,而**没有任何报错**。
   * 2026-09-01 接线时就漏过一次(uSkyaoOn 置了 1,这张表没跟上)。
   */
  skyao?: TextureSource | null;
  colorTex: TextureSource;
  nrm: TextureSource | null;      // null = 无法线图集 → 平面法线兜底
  ground: TextureSource;
  atlasL1: TextureSource;
  atlasL2: TextureSource;
  atlasBin: TextureSource;
  valid: TextureSource;
  volRad: TextureSource;
  volEmit: TextureSource;
}

export function createLitShader(
  sceneGroup: UniformGroup,
  frameGroup: UniformGroup,
  lightGroup: UniformGroup,
  tex: LitShaderTextures,
): Shader {
  const nrm = tex.nrm ?? Texture.WHITE.source;
  return new Shader({
    glProgram: getLitProgram(),
    gpuProgram: getLitGpuProgram(),
    resources: {
      sceneShade: sceneGroup,
      frameShade: frameGroup,
      charLights: lightGroup,
      entityShade: new UniformGroup({
        uHasNrm: { value: tex.nrm ? 1 : 0, type: 'f32' },
        uBodyWidthWu: { value: 0, type: 'f32' },
        // local→sceneWorld 仿射(setWorldTransform 每帧喂;缺省恒等防黑屏)
        uL2W0: { value: new Float32Array([1, 0, 0]), type: 'vec3<f32>' },
        uL2W1: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
      }),
      uColorTex: tex.colorTex,
      // WGSL 的采样器(「纹理名 + Sampler」):该纹理自己的 style,与 WebGL 用纹理自带采样状态一致;
      // WebGL 不认这些键。换纹理走 setLitShaderTexture,采样器跟着换。
      uColorTexSampler: samplerOf(tex.colorTex),
      uNrm: nrm,
      uNrmSampler: samplerOf(nrm),
      uGround: tex.ground,
      uGroundSampler: samplerOf(tex.ground),
      uPL1: tex.atlasL1,
      uPL2: tex.atlasL2,
      uPBin: tex.atlasBin,
      uValid: tex.valid,
      uVolRad: tex.volRad,
      uVolEmit: tex.volEmit,
      // ⚠ 漏绑 = 采未绑定 sampler = V 恒 0 = 角色全黑且不报错(2026-09-01 踩过)
      uSkyaoTex: tex.skyao ?? Texture.WHITE.source,
    },
  });
}

/**
 * 场景卸载前必须**逐个退回白图**的 sampler 槽位(见
 * `CharacterLightingSystem.parkLitShaders`)。
 *
 * 为什么必须与上面 `createLitShader` 的 resources 表**同处维护**:这些槽位绑的是
 * 按场景销毁的纹理,而 lit shader 挂在**跨场景长活**的角色(玩家)身上,不在任何
 * unload 名单里。Pixi 的 BindGroup 见到所绑资源 `destroyed` 会当场把自己作废
 * (`resources = null`),此后这个 shader 每次被渲染都抛 —— 而异常从 `Ticker._tick`
 * 逃出去就再也不排下一帧,整局定格(2026-09-01:`uSkyaoTex` 接线时漏进这张表,
 * dev 模式跳场景必卡死)。
 *
 * ⚠ 新增场景纹理槽位 = 同时加进这张表。`uColorTex` 故意不在表内 —— 那是角色自己的
 * 图集,不随场景销毁,退成白图只会把角色刷白。
 * WGSL 的「纹理名 + Sampler」槽位不必进表:`setLitShaderTexture` 换纹理时顺手换它。
 * (纹理销毁时它的 style 一起销毁,BindGroup 同样当场作废 —— 采样器漏换与纹理漏换一样致命,
 * 而且 WebGL 下也一样:有了 WGSL 程序,采样器与纹理同住一个 BindGroup。)
 */
export const LIT_SHADER_SCENE_TEXTURE_SLOTS = [
  'uPL1', 'uPL2', 'uPBin', 'uValid', 'uVolRad', 'uVolEmit', 'uGround', 'uNrm', 'uSkyaoTex',
] as const;

/**
 * 换法线/图集源(图集热替换、体素卷加载时用);同源短路。
 * shader 声明了「纹理名 + Sampler」(WGSL 采样器)时一并换成新纹理自己的 style —— 粒子受光的
 * shader 也在同一张注册表里,按「声明了才换」处理,不要求各宿主布局相同。
 */
export function setLitShaderTexture(sh: Shader, key: string, src: TextureSource | null): void {
  const res = sh.resources as Record<string, unknown>;
  const next = src ?? Texture.WHITE.source;
  if (res[key] === next) return;
  res[key] = next;
  const samplerKey = `${key}Sampler`;
  if (samplerKey in res) res[samplerKey] = samplerOf(next);
  if (key === 'uNrm') {
    (res['entityShade'] as UniformGroup).uniforms['uHasNrm'] = src ? 1 : 0;
  }
}

/**
 * 与 sprite 同 quad 的网格。作为 sprite 的**子节点**挂载:继承 sprite 的全部变换
 * (含镜像与透视缩放),几何与帧 UV 在换帧时由 SpriteEntity 同步(那是本就存在的
 * 换帧代码路径,任何游戏状态下都在跑 —— 不是新增的"驱动")。
 */
export class LitSpriteQuad {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly geometry: MeshGeometry;
  private readonly pos = new Float32Array(8);
  private readonly uv = new Float32Array(8);
  private readonly posBuf: Buffer;
  private readonly uvBuf: Buffer;

  constructor(shader: Shader) {
    this.geometry = new MeshGeometry({
      positions: this.pos,
      uvs: this.uv,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.geometry.addAttribute('aLocal', {
      buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),   // TL TR BR BL
      format: 'float32x2',
    });
    // MeshGeometry 用我们传入的数组建 Buffer(data 同引用):留 buffer 句柄,写完 update()
    this.posBuf = this.geometry.getAttribute('aPosition').buffer as Buffer;
    this.uvBuf = this.geometry.getAttribute('aUV').buffer as Buffer;
    this.mesh = new Mesh({ geometry: this.geometry, shader });
  }

  /**
   * 喂 local→sceneWorld 仿射(uL2W0/uL2W1)。**世界坐标唯一真相源**——VERT 不再从
   * screen 反推(滤镜的临时 RT 会把 screen 变成局部坐标,见 VERT 内 2026-09-01 注释)。
   *
   * 参数:容器场景坐标 (cx,cy) 与缩放 (csx,csy);mesh 局部 position/scale/rotation。
   * 组合:world = (cx,cy) + cs·( R(rot)·(scale·p) + (px,py) )。
   */
  setWorldTransform(cx: number, cy: number, csx: number, csy: number,
                    px: number, py: number, sx: number, sy: number, rot: number): void {
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const a = cosR * sx, b = sinR * sx, c = -sinR * sy, d = cosR * sy;
    const u = (this.mesh.shader as Shader).resources.entityShade.uniforms as Record<string, Float32Array>;
    u.uL2W0[0] = a * csx; u.uL2W0[1] = c * csx; u.uL2W0[2] = cx + px * csx;
    u.uL2W1[0] = b * csy; u.uL2W1[1] = d * csy; u.uL2W1[2] = cy + py * csy;
    ((this.mesh.shader as Shader).resources.entityShade.uniforms as Record<string, unknown>).uBodyWidthWu
      = Math.abs(this.pos[2] - this.pos[0]) * Math.hypot(a * csx, b * csy);
  }

  /** 换帧同步:帧像素尺寸 + 锚点 → 顶点;texture.uvs → 图集 UV(与 color 同源)。 */
  sync(tex: Texture, frameW: number, frameH: number, anchorX: number, anchorY: number): void {
    const p = this.pos;
    const x0 = -anchorX * frameW, x1 = (1 - anchorX) * frameW;
    const y0 = -anchorY * frameH, y1 = (1 - anchorY) * frameH;
    p[0] = x0; p[1] = y0;   // TL
    p[2] = x1; p[3] = y0;   // TR
    p[4] = x1; p[5] = y1;   // BR
    p[6] = x0; p[7] = y1;   // BL
    this.posBuf.update();
    const u = this.uv;
    const uvs = tex.uvs as { x0: number; y0: number; x1: number; y1: number;
      x2: number; y2: number; x3: number; y3: number };
    u[0] = uvs.x0; u[1] = uvs.y0; u[2] = uvs.x1; u[3] = uvs.y1;
    u[4] = uvs.x2; u[5] = uvs.y2; u[6] = uvs.x3; u[7] = uvs.y3;
    this.uvBuf.update();
  }

  destroy(): void {
    this.mesh.removeFromParent();
    this.mesh.destroy();            // 含 geometry;shader 由所有者(照明系统)回收
  }
}
