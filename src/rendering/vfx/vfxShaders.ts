/**
 * 世界空间粒子的两套着色程序：
 *
 * - **unlit**：贴图 × 顶点色，只做深度遮挡 / 软边（自发光的萤火、火星走这条；没有照明载荷的场景一切走这条）；
 * - **lit**：在 unlit 之上叠角色那套照明——probe 底光（q 空间查表）+ 场景实体灯（M-world、wu，
 *   与场景 / 角色吃**同一次** packLights）+ 与背景同一组显示变换。公共块 `CHAR_LIGHT_COMMON_GLSL`
 *   与 `charShadeCore` **原样拼接**，不内联重写（character-lighting 硬契约）。
 *
 * ## 遮挡：拿粒子自己的纵深比壳
 *
 * 角色那条是"脚深度 + 直立 quad 代理"（角色没有真 3D 位置），粒子**有**：顶点带着自己的 q，
 * 片元直接拿 `q.z` 与该像素处的壳深度比（同一条 `depth_mapping` 解码、同一个 `depth_tolerance`）。
 * 软粒子（烟贴墙）= 深度差在 `aMisc.x`（q 单位）内线性淡出。
 *
 * ## 法线
 *
 * billboard 朝相机：q 空间法线 (0,0,−1)，按 `uSphere` 混一个球面法线（烟团有体积感）。
 * probe 查表用 nQ（载荷方向基在 q）；灯循环用世界法线 n = R·nQ（铁律 0：世界对世界）。
 *
 * ⚠ 实际编译目标是 GLSL ES 1.00（pixi-v8-traps）：不用数组构造式、不用 first-class 数组。
 * ⚠ 模板字符串里不许出现反引号。
 */
import { GlProgram } from 'pixi.js';

import { CHAR_LIGHT_COMMON_GLSL } from '../CharacterShadingFilter';
import { MAX_STATIC_LIGHTS } from '../lighting/lightPacking';
import LIGHTING_CORE from '../lighting/lightingCore.glsl?raw';
import WORLD_RECONSTRUCT from '../lighting/worldReconstruct.glsl?raw';

function sliceGlsl(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[vfxShaders] GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

const WR_CORE = sliceGlsl(WORLD_RECONSTRUCT, 'WR_CORE');
const LC = sliceGlsl(LIGHTING_CORE, 'LIGHTING_CORE');

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;   // 场景坐标 wu（网格挂在 entityLayer 下，容器变换 = 相机）
in vec2 aUV;
in vec4 aColor;      // 预乘 rgba
in vec3 aQ;          // 粒子中心的伪世界 q（遮挡 / 照明）
in vec2 aLocal;      // 帧内局部 [0,1]²
in vec2 aMisc;       // x = 软边宽（q）；y = 留空

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

out vec2 vUV;
out vec4 vColor;
out vec3 vQ;
out vec2 vWorld;
out vec2 vLocal;
out vec2 vMisc;

void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vColor = aColor * uColor;
    vQ = aQ;
    vWorld = aPosition;
    vLocal = aLocal;
    vMisc = aMisc;
}
`;

/** 遮挡 / 软边共用段（两套片元都拼它）。返回可见度 0..1，-1 = 完全被挡（调用方 discard）。 */
const OCCLUSION_GLSL = /* glsl */ `
uniform sampler2D uDepthMap;
uniform vec2  uSceneSize;
uniform float uHasDepth;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uTolerance;
uniform float uOcclusionBlend;

float vfxVisibility(vec2 world, float qz, float softQ) {
    if (uHasDepth < 0.5) return 1.0;
    vec2 duv = world / uSceneSize;
    if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) return 1.0;
    vec4 ds = texture(uDepthMap, duv);
    float raw = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
    float t = uInvert > 0.5 ? 1.0 - raw : raw;
    float sceneDepth = t * uScale + uOffset;
    if (sceneDepth + uTolerance < qz) return uOcclusionBlend;
    if (softQ > 1e-6) return clamp((sceneDepth + uTolerance - qz) / softQ, 0.0, 1.0);
    return 1.0;
}
`;

const FRAG_UNLIT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
in vec3 vQ;
in vec2 vWorld;
in vec2 vLocal;
in vec2 vMisc;
out vec4 finalColor;

uniform sampler2D uColorTex;
${OCCLUSION_GLSL}

void main(void) {
    vec4 c = texture(uColorTex, vUV) * vColor;
    if (c.a < 0.004) { discard; }
    float vis = vfxVisibility(vWorld, vQ.z, vMisc.x);
    if (vis <= 0.0) { discard; }
    finalColor = c * vis;
}
`;

const FRAG_LIT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
in vec4 vColor;
in vec3 vQ;
in vec2 vWorld;
in vec2 vLocal;
in vec2 vMisc;
out vec4 finalColor;

uniform sampler2D uColorTex;
uniform sampler2D uGround;
uniform vec2 uGroundRange;
uniform vec2 uSceneWorld;

uniform sampler2D uNrm;
uniform sampler2D uPL1;
uniform sampler2D uPL2;
uniform sampler2D uPBin;
uniform sampler2D uValid;
uniform sampler2D uSkyaoTex;
uniform sampler2D uVolRad;
uniform sampler2D uVolEmit;
uniform float uHasNrm;

uniform int  uSceneLightCount;
uniform vec4 uSceneLightA[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightB[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightC[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightD[${MAX_STATIC_LIGHTS}];
uniform vec3 uSMRow0;
uniform vec3 uSMRow1;
uniform vec3 uSMRow2;
uniform float uSMWuPerQUnit;
uniform float uDispEv;
uniform int   uDispTonemap;
uniform vec3  uDispWhite;
uniform float uDispSaturation;
uniform float uDispContrast;
uniform float uDispLift;
uniform vec3  uDispLiftColor;

/** 粒子批自己的参数：球面法线混合度、自发光份额（0 = 全靠场景光；1 = 完全自发光不吃光） */
uniform float uSphere;
uniform float uEmissive;

${OCCLUSION_GLSL}
${CHAR_LIGHT_COMMON_GLSL}
${WR_CORE}
${LC}

void litAreaAxes(vec3 n, float halfW, float halfH, float roll, out vec3 halfU, out vec3 halfV) {
    vec3 up = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 u = normalize(cross(up, n));
    vec3 v = cross(n, u);
    float c = cos(roll), s = sin(roll);
    halfU = (u * c + v * s) * halfW;
    halfV = (v * c - u * s) * halfH;
}

void main(void) {
    vec4 c = texture(uColorTex, vUV) * vColor;
    if (c.a < 0.004) { discard; }
    float vis = vfxVisibility(vWorld, vQ.z, vMisc.x);
    if (vis <= 0.0) { discard; }

    // ---- 法线：q 空间朝相机 + 球面鼓包
    vec2 sl = vec2(vLocal.x - 0.5, 0.5 - vLocal.y) * 2.0;
    vec3 nQ = normalize(vec3(sl.x * uSphere, sl.y * uSphere, -1.0));
    // 世界法线 = R·nQ（纯旋转；灯循环世界对世界）
    vec3 n = normalize(wrQToWorld(uSMRow0, uSMRow1, uSMRow2, nQ));

    vec3 q = vQ;
    vec3 E = ((uMode < 0.5) ? gatherRT(q + nQ * 0.02, nQ) : probeE(q, nQ)) * uGiStrength;
    E *= mix(1.0, skyaoAt(q, nQ), clamp(uSkyaoBlend, 0.0, 1.0));
    if (uSunOn > 0.5) { E += uSunColor * max(dot(nQ, uSunDirQ), 0.0); }

    if (uSceneLightCount > 0) {
        vec3 P = wrQToWorld(uSMRow0, uSMRow1, uSMRow2, q) * uSMWuPerQUnit;
        for (int i = 0; i < ${MAX_STATIC_LIGHTS}; i++) {
            if (i >= uSceneLightCount) break;
            vec4 A = uSceneLightA[i], B = uSceneLightB[i];
            vec4 C = uSceneLightC[i], D = uSceneLightD[i];
            if (B.w <= 0.0) continue;
            int kind = int(A.w + 0.5);
            int flags = int(D.w + 0.5);
            if (kind == LC_POINT) {
                E += lcPointLight(P, n, A.xyz, B.rgb, B.w, C.x, C.y, 1.0);
            } else if (kind == LC_SPOT) {
                E += lcSpotLight(P, n, A.xyz, D.xyz, B.rgb, B.w, C.x, C.y, C.z, C.w, 1.0);
            } else if (kind == LC_AREA) {
                vec3 hu, hv;
                litAreaAxes(normalize(D.xyz), C.z, C.w, C.y, hu, hv);
                E += lcAreaLight(P, n, A.xyz, hu, hv, B.rgb, B.w, C.x, (flags & 2) != 0, 1.0);
            } else {
                E += lcDirectionalLight(n, D.xyz, B.rgb, B.w, 1.0);
            }
        }
    }
    vec3 alb = c.rgb / max(c.a, 1e-4);
    vec3 litLin = shadeCharacterLinear(alb, E, uEChroma, uBeta);
    // 镜面/自发光份额（appearance.emissive）：这一份不吃漫反射着色，按比例混入原色（线性）。
    // 水滴、火星这类靠镜面才看得见的材质用它——漫反射路径没有镜面瓣，只用它画出来是黑疙瘩。
    litLin = mix(litLin, srgb2lin(alb), clamp(uEmissive, 0.0, 1.0));
    vec3 outRgb = clamp(lcDisplayTransform(litLin,
        uDispEv, uDispTonemap, uDispWhite,
        uDispSaturation, uDispContrast, uDispLift, uDispLiftColor), 0.0, 1.0);
    finalColor = vec4(outRgb * c.a, c.a) * vis;
}
`;

let unlitProgram: GlProgram | null = null;
let litProgram: GlProgram | null = null;

export function getVfxUnlitProgram(): GlProgram {
  if (!unlitProgram) unlitProgram = new GlProgram({ vertex: VERT, fragment: FRAG_UNLIT });
  return unlitProgram;
}

export function getVfxLitProgram(): GlProgram {
  if (!litProgram) litProgram = new GlProgram({ vertex: VERT, fragment: FRAG_LIT });
  return litProgram;
}
