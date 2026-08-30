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
 */
import {
  type Buffer,
  GlProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  type TextureSource,
  UniformGroup,
} from 'pixi.js';

import { CHAR_LIGHT_COMMON_GLSL } from './CharacterShadingFilter';
import type { SceneLightingDef } from '../data/types';
import { resolveLightColor } from './lighting/kelvin';
import { MAX_STATIC_LIGHTS, type PackedLights } from './lighting/lightPacking';
import LIGHTING_CORE from './lighting/lightingCore.glsl?raw';
import WORLD_RECONSTRUCT from './lighting/worldReconstruct.glsl?raw';

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

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;   // sprite 局部坐标(帧像素空间,锚点已含)
in vec2 aUV;         // 图集 UV —— 与 color 帧同一套(法线采样直接用它)
in vec2 aLocal;      // 帧内局部 [0,1]²(左上为原点;AO 用)

uniform mat3 uProjectionMatrix;        // Pixi global group(自动绑)
uniform mat3 uWorldTransformMatrix;    // Pixi global group
uniform mat3 uTransformMatrix;         // Pixi local group:mesh 世界变换
uniform vec4 uColor;                   // Pixi local group:world alpha/tint(预乘)
uniform vec2  uWCPos;                  // worldContainer 屏幕位置(共享帧组)
uniform float uWCScale;                // projectionScale(共享帧组)

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
    float S = max(uWCScale, 1e-6);
    vWorld = (screen - uWCPos) / S;
    vec2 footScreen = (model * vec3(0.0, 0.0, 1.0)).xy;   // 锚点(0.5,1) → local 原点=脚底
    vFootWorld = (footScreen - uWCPos) / S;
    // 镜像判定:2x2 行列式。model 不含投影,画到屏幕还是 RT 都不影响符号;
    // sprite.scale.x<0 → det<0。翻转朝向连一个 uniform 都不需要。
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
uniform sampler2D uVolRad;
uniform sampler2D uVolEmit;
uniform float uHasNrm;

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

/** 面光两条半轴。与 SceneLightingPass 的同名函数同式（绕法线自转 roll）。 */
void litAreaAxes(vec3 n, float halfW, float halfH, float roll, out vec3 halfU, out vec3 halfV) {
    vec3 up = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 u = normalize(cross(up, n));
    vec3 v = cross(n, u);
    float c = cos(roll), s = sin(roll);
    halfU = (u * c + v * s) * halfW;
    halfV = (v * c - u * s) * halfH;
}

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

    vec3 q = vec3(qx, qyF + h * uCosT, footD - h * uSinT - ne.a * uBulge);

    if (uShowN > 0.5) { finalColor = vec4((n*.5+.5) * color.a, color.a) * vColor; return; }

    // ---------- 法线的两个空间：灯用世界、probe 用 q ----------
    //
    // 上面那个 n **已经是世界法线**。角色是一块**直立 quad**（见下面 q 的构造：
    // 沿精灵上移 h 在世界里就是正上方 h，一点前后偏移都没有），而法线图是
    // tools/animation_pipeline/bake_normal_atlas.py 从剪影 alpha 推的高度场、
    // 在**图像像素空间**取梯度（gx, -gy, -6）—— 那三个轴恰好就是这块直立 quad 的
    // 世界 X / Y / −Z。所以灯直接用 n，**不要再乘 R**。
    //
    // ⚠ 2026-08-30 我一度在这里加了 nW = R·n，等于把每个角色法线整体仰起 45°，
    //   头顶的灯会过亮、水平方向来的灯会偏暗。已回退。
    //
    // 但 **probe 是严格烘在 q 空间的**（图集按 q 法线烘的球谐），所以查表时必须把
    // 世界法线转回 q：n_q = Rᵀ·n。R 正交 ⇒ 转置即逆，按**列**点乘。
    vec3 nQ = normalize(wrWorldToQ(uSMRow0, uSMRow1, uSMRow2, n));

    // ---------- E:RT gather 或 probe 图集(公共块) ----------
    vec3 E = (uMode < 0.5) ? gatherRT(q + nQ*0.02, nQ) : probeE(q, nQ);
    if (uSunOn > 0.5) {
        // 铁律 0：光照一律在世界空间算。uSunDirQ 与 n 原来都是 q，点乘**自洽**、
        // 数值没错 —— 但 R 正交 ⇒ (Rn)·(Rl) = n·l，转过去是**零行为变化**，
        // 转了才能机械审计出「有没有人拿 q 的量去配世界的量」。probeE / gatherRT
        // 不动：那是**查表**不是着色，载荷本来就按 q 烘（见铁律 0 的三类豁免）。
        // 这一项与 probe 同源（同一份 q 空间的烘焙载荷），所以在 q 里点乘。
        E += uSunColor * max(dot(nQ, uSunDirQ), 0.0);
    }

    // ---------- 实体灯：加性叠在 probe 的 GI 底光之上 ----------
    //
    // 模型（2026-08-30 制作人定调）：原画就是被 GI 照亮的结果，probe 是同一份 GI 给
    // 角色的版本；实体灯在这之上**直接加**。场景侧同源（见 SceneLightingPass），
    // 灯来自同一次 packLights ⇒「灯对角色和场景一视同仁」是构造性的，不是两处写得像。
    //
    // 着色在 M-world（q 经 det=+1 的 R 旋过去），不是裸 q —— 裸 q 的 Y 是屏幕上、
    // 不是世界上，灯的仰角与 1/r² 会全错（coordinate-spaces 铁律 4）。
    if (uSceneLightCount > 0) {
    // 铁律 0（制作人 2026-08-30 定死）：光照一律在**世界空间、单位 wu**。
    // 朝向过 R、尺度过 uWuPerQUnit，一次转到底 —— 不许停在「世界朝向 + q 尺度」
    // 那个没有名字的中间态：那会让 range / 软化半径 / 面光尺寸在 shader 里不是 wu，
    // 而作者面明明按 wu 填，读代码的人无法判断某个长度是哪把尺。
        vec3 P = wrQToWorld(uSMRow0, uSMRow1, uSMRow2, q) * uSMWuPerQUnit;
        // ★ **法线也必须转到 M-world**，否则 N 在 q、L 在 M-world，N·L 跨空间（2026-08-30 审查抓到）。
        //
        // 上面那个 n 是**精灵法线**，z 恒指向相机（烘焙侧注释 "z toward camera"），是 q 空间的量 ——
        // probeE / gatherRT / uSunDirQ 三处的载荷都按 q 烘，所以**它们继续用 q 的 n，不能一起换**。
        // 但灯位 A.xyz 经 scene_lights.q_to_world 存的是 M-world（packLights 只折尺度不折朝向），
        // P 也已转过去，于是这里的 N 必须同步转。
        //
        // 实测代价（雾津街头 R = 绕 X 轴 45°）：角色正面 n_q=(0,0,−1) 的真实世界朝向是
        // (0,+0.707,−0.707)；站在头顶灯笼正下方时 L≈(0,1,0)，正确 N·L=0.707，跨空间算出 **0**
        // —— 身体一点灯光都收不到，而脚下地面被同一盏灯正常照亮。
        //
        // R 正交，对方向量再走一次同样的行乘即可（不需要逆转置）。
        for (int i = 0; i < ${MAX_STATIC_LIGHTS}; i++) {
            if (i >= uSceneLightCount) break;
            vec4 A = uSceneLightA[i], B = uSceneLightB[i];
            vec4 C = uSceneLightC[i], D = uSceneLightD[i];
            if (B.w <= 0.0) continue;                 // 强度 0 的灯贡献恒等于 0
            int kind = int(A.w + 0.5);
            int flags = int(D.w + 0.5);               // bit0=castShadow bit1=twoSided
            // 角色不吃灯的阴影：投影解是场景那一级按背景像素栅格解的前缀最小，
            // 角色是动的、不在那张图里。vis 恒 1，宁可多一点光也不要错位的黑块。
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
    vec3 alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    // ★ 与背景同一份显示变换（lcDisplayTransform 收尾自带 sRGB，所以不再 lin2srgb）。
    vec3 outRgb = clamp(lcDisplayTransform(
        shadeCharacterLinear(alb, E, uEChroma, uBeta),
        uDispEv, uDispTonemap, uDispWhite,
        uDispSaturation, uDispContrast, uDispLift, uDispLiftColor), 0.0, 1.0);

    float vy = clamp(vLocal.y, 0.0, 1.0);
    float contact = uAOContact * smoothstep(0.78, 1.0, vy);
    float form = uAOForm * vy;
    outRgb *= clamp(1.0 - contact - form, 0.0, 1.0);

    finalColor = vec4(outRgb * color.a, color.a) * vColor;
}
`;

let litProgram: GlProgram | null = null;
function getLitProgram(): GlProgram {
  if (!litProgram) litProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return litProgram;
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
    uAmbStrength: { value: 1, type: 'f32' },
    uBulge: { value: 0.22, type: 'f32' },
    uFlatten: { value: 0, type: 'f32' },
    uShowN: { value: 0, type: 'f32' },
    uSunOn: { value: 0, type: 'f32' },
    uSunDirQ: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
    uSunColor: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
    uEChroma: { value: 0, type: 'f32' },
    uAOContact: { value: 0, type: 'f32' },
    uAOForm: { value: 0, type: 'f32' },
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
    uAmbSH: { value: s.ambSH, type: 'vec3<f32>', size: 9 },
    uLightQ: { value: s.lightsQ, type: 'vec4<f32>', size: 48 },
    uLightE: { value: s.lightsE, type: 'vec4<f32>', size: 48 },
    uLightCount: { value: s.lightCount, type: 'f32' },
    uGroundRange: { value: new Float32Array([s.groundMin, s.groundMax]), type: 'vec2<f32>' },
    uSceneWorld: { value: new Float32Array([s.sceneWorldW, s.sceneWorldH]), type: 'vec2<f32>' },
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
  return new Shader({
    glProgram: getLitProgram(),
    resources: {
      sceneShade: sceneGroup,
      frameShade: frameGroup,
      charLights: lightGroup,
      entityShade: new UniformGroup({
        uHasNrm: { value: tex.nrm ? 1 : 0, type: 'f32' },
      }),
      uColorTex: tex.colorTex,
      uNrm: tex.nrm ?? Texture.WHITE.source,
      uGround: tex.ground,
      uPL1: tex.atlasL1,
      uPL2: tex.atlasL2,
      uPBin: tex.atlasBin,
      uValid: tex.valid,
      uVolRad: tex.volRad,
      uVolEmit: tex.volEmit,
    },
  });
}

/** 换法线/图集源(图集热替换、体素卷加载时用);同源短路。 */
export function setLitShaderTexture(sh: Shader, key: string, src: TextureSource | null): void {
  const res = sh.resources as Record<string, unknown>;
  const next = src ?? Texture.WHITE.source;
  if (res[key] === next) return;
  res[key] = next;
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
