import { lightFactor } from '../data/lightFactors';
import { Filter, GpuProgram, Texture, type TextureSource } from '../engine2d';
// 角色着色核心的唯一真相源(与灯光实验室共用同一份,消灭 shader 镜像漂移)与角色照明公共块
import CHAR_SHADE_CORE_WGSL from './charShadeCore.wgsl?raw';
import CLC_WGSL_SRC from './charLightCommon.wgsl?raw';
import type { SceneDepthConfig } from '../data/types';
import type { IEntityShadingFilter } from './EntityLightingFilter';
import { samplerOf } from './legacy/gpuSampler';
import { FG_OCCLUSION_WGSL, fgCoverageBindingsWgsl } from './foreground/foregroundMaskWgsl';

/**
 * 角色物理着色滤镜:character_lighting_lab 查看器 CHAR_FS 的逐像素移植。
 * 假设 sprite 颜色 = albedo,最终色 = srgb2lin(albedo) × E / π × β × 增益。
 * E 来源四模式:0=实时RT gather(A7折叠+miss策略+NEE解析直射),1/2/3=L1/L2/BIN probe
 * 图集三线性(base+cov|amb|emit|nee 四分账,与实验室烘焙同源)。
 *
 * 与实验室的三处刻意差异(非算法差异):
 * 1. 遮挡沿用游戏 depthConfig 契约(P2a 已与实验室深度同源,billboard 语义一致);
 * 2. 法线不用贴图:spriteNormalAtlas 运行时按实验室 stage_character 同数学现算;
 * 3. 体素卷 sampler3D → Z 切片平铺 2D 图集 + 手写三线性(数学等价,Pixi 无 3D 纹理)。
 * 实验室接触阴影不进游戏(用户拍板);游戏自有接触 AO / 投影阴影保留。
 *
 * 着色器只有 WGSL(FILTER_WGSL,公共块拼 CHAR_LIGHT_COMMON_WGSL)。与 master 的 GLSL 版逐像素一致由
 * tools/render_parity/cases/80_char_lighting.ts(「角色受光 /」)钉住。
 */

/**
 * 直立 quad 的深度梯度 tanθ/ppu（`depth_per_sy` 缺字段时从 depthConfig 的 M 现推,R 第二行 = [0, cosθ, −sinθ]）；
 * 场景前景层的前景面深度用同一个数
 */
export function uprightGradientFromM(cfg?: SceneDepthConfig | null): number {
  const R = cfg?.M?.R, ppu = cfg?.M?.ppu;
  if (!R || !ppu) return 0;
  const cosT = R[1]?.[1] ?? 0, sinT = -(R[1]?.[2] ?? 0);
  return Math.abs(cosT) < 1e-6 ? 0 : (sinT / cosT) / ppu;
}

/** 逐帧可调照明参数(F2 全量;与实验室查看器同名同义,默认值同实验室) */
export interface CharShadingParams {
  indirectFactor?: number;
  directFactor?: number;
  totalFactor?: number;
  mode: number;          // 0=RT 1=L1 2=L2 3=BIN
  spp: number;
  step: number;
  msteps: number;
  fold: boolean;
  missMode: boolean;     // true = miss 不计入(renormalize)
  nee: boolean;
  beta: number;          // 曝光指数,上传 2^beta(角色曝光唯一旋钮;实验室 pgain 不进游戏)
  giStrength: number;    // GI 底光增益(0~10):只乘 probe/RT 的 E,不乘实体灯与测试太阳
  ambStrength: number;
  bulge: number;
  flatten: number;
  heightScale: number;
  showNormals: boolean;
  sunEnabled: boolean;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunIntensity: number;
  sunColor: [number, number, number];
}

// ---------------------------------------------------------------------------
// 照明数学公共块(标定 / 伪世界量 + 体素三线性 + SH + gatherRT + probeE + 着色核心):filter 与
// CharacterLitSprite(sprite 网格着色)、粒子受光**共用同一段**——同一份数学只写一遍,改一处各处同步
// (与实验室 LIGHT_FNS 同一纪律)。源在 charLightCommon.wgsl,设计(uniform 打成值结构
// ClcProbe / ClcSkyao / ClcVol / ClcRt 当形参传、纹理也走形参)与宿主怎么建结构写在那个文件头。
// 三份导出:CLC 整段(注入 charShadeCore.wgsl);PROBE 段(不含标记,shY / ambIrr / octaEnc / probeE +
// ClcProbe)——场景光照 pass 的「GI体」调试视图拼接它,角色与场景吃**同一份**采样数学,不是两处写得像;
// SKYAO 段(含标记)——场景侧「skyao体」对账视图(SceneLightingPass uDebug==11)与角色共用这一份。
// 同一模块里每段只许拼一次。

/** CLC_WGSL_SRC 里 `//__${tag}_BEGIN__` 到 `_END__` 之间(不含标记)。 */
function sliceClcWgsl(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[CharacterShadingFilter] charLightCommon.wgsl 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

export const CHAR_LIGHT_COMMON_WGSL: string = (() => {
  const body = sliceClcWgsl(CLC_WGSL_SRC, 'CLC');
  const inc = '//__CHAR_SHADE_CORE_WGSL__';
  if (!body.includes(inc)) throw new Error('[CharacterShadingFilter] charLightCommon.wgsl 缺着色核心注入点');
  return body.replace(inc, () => CHAR_SHADE_CORE_WGSL);   // 函数式替换:不解释源里的 $ 序列
})();

export const SKYAO_SAMPLING_WGSL: string = (() => {
  const b = '//__SKYAO_SAMPLING_BEGIN__';
  const e = '//__SKYAO_SAMPLING_END__';
  const i = CHAR_LIGHT_COMMON_WGSL.indexOf(b);
  const j = CHAR_LIGHT_COMMON_WGSL.indexOf(e);
  if (i < 0 || j < 0) throw new Error('[CharacterShadingFilter] 缺 SKYAO_SAMPLING 切片标记(WGSL)');
  return CHAR_LIGHT_COMMON_WGSL.slice(i, j + e.length);
})();

export const PROBE_SAMPLING_WGSL: string = sliceClcWgsl(CHAR_LIGHT_COMMON_WGSL, 'PROBE_SAMPLING');

// ───────────────────────────── 滤镜本体(WGSL)
//
// 约定(见 agent_docs 的 pixi-shader-wgsl-port 配方卡):
// - 组 0 是 Pixi 滤镜约定(gfu + uTexture + uSampler);自己的资源全在组 1,变量名 = resources 的键名,
//   纹理声明顺序与构造里的 resources 表相对顺序一致(与 master 的 GLSL 版分纹理单元的顺序一致)。
// - ShadeUniforms 的成员**同名同序**对应构造里 shadeUniforms 的 JS 声明(Pixi 按声明顺序排偏移)。
// - 用 texture() 采样的三张(uDepthMap / uFgCoverage / uNrm)各配一个「纹理名 + Sampler」(该纹理自己的 style;
//   setForegroundCoverage / setNormalTexture 换图时跟着换);都在分支里采,用 textureSampleLevel(.., 0.0)(单级纹理,等价)。
//   前景覆盖图的取样 fgSample 是 foregroundMaskWgsl 的共用段,uHasFgCoverage 作参数传进去。
//   其余全走 textureLoad(公共块)。uTexture 在 discard 之前的一致控制流里用 textureSample。
// - 片元阶段绑定数(WebGPU 默认上限 16 张取样纹理 / 16 个采样器 / 12 个 uniform 缓冲;charLightingWgsl.test 钉着):
//   纹理 11 张(uTexture + uDepthMap / uFgCoverage / uNrm / uPL1 / uPL2 / uPBin / uValid / uSkyaoTex / uVolRad / uVolEmit),
//   采样器 4 个(uSampler + uDepthMapSampler / uFgCoverageSampler / uNrmSampler),uniform 缓冲 2 个(gfu + shadeUniforms)。
// - 公共块拼 CHAR_LIGHT_COMMON_WGSL(函数不读绑定),main 开头按字段名逐个赋值建 ClcProbe / ClcSkyao;
//   ClcVol / ClcRt 只在 RT 那一支里建。gatherRT 的片元坐标 = 入口的位置内建量 .xy。
// - 结构体里不写注释:Pixi 用正则解析 WGSL 的 struct 与 group 声明。成员含义写在这里:
//   · 场景 / 相机(SceneDepthSystem 逐帧驱动):uSceneSize … uEntityFootWorldY。
//   · 遮挡(与 DepthOcclusionFilter 同契约):uDepthEnabled … uOcclusionBlendFactor;uHasFootDepth = 0 ⇒ 本帧没拿到
//     脚深度、整段遮挡跳过;uFootBias = 实验室 0.045;uHasFgCoverage = 场景前景层覆盖图开关(没有前景层时 0,
//     逐像素与没有这一段时相同)。
//   · 标定 / 伪世界(实验室 manifest 同源):uWorkSize = 载荷工作分辨率;uWorldToWork = 场景世界坐标 → work px;
//     uCal = (ppu, _, cx, cy)(work px);uVolN / uVolTiles = 体素维度 / Z 切片平铺列行数;uLightQ / uLightE =
//     光源 surfel 的 q 位置 + 面积 / 发光辐射;probe / skyao 那几项见 charLightCommon.wgsl 的 ClcProbe / ClcSkyao。
//   · 角色 quad(逐帧驱动,**filter 专用**——mesh 路径的 UV / 翻转 / 脚点全部来自几何,无此依赖):uFootQ、
//     uCharH / uCharW = 直立 quad 高 / 宽(wu)、uNrmRect = 法线图集内当前帧 uv rect(x,y,w,h)、uFlipX、
//     uSpriteWorldRect、uHasNrm。
//   · 照明参数(F2 全量可调,与实验室同名同义):uMode(0 RT / 1 L1 / 2 L2 / 3 BIN)、uSpp、uMSteps、uFold、
//     uMissMode(0 = miss→J̄×强度,1 = miss 不计入再归一)、uNEE、uStep;uBeta = 旧曝光 2^β(CPU 已 pow),
//     uGiStrength = 旧 GI 底光增益,两者只留给 GI 诊断,正常着色用 uIndirectFactor / uDirectFactor / uTotalFactor;
//     uFixedNQ = 诊断·定法线;uEChecker = 纯E 视图叠 probe 棋盘(与场景 uDebug==9 同一套 cell 奇偶);
//     uEOnly = 「GI体·纯E」调试(1 = albedo≡1,输出 E×2^β,F2 的 8/9 档)。
//   · 太阳(独立解析直射,方位与投影阴影解耦):uSunOn、uSunDirQ = q 空间指向光源方向、uSunColor = 颜色×强度。
//   · uEChroma = E 明暗 / 色度权重(F2 测试旋钮):0 = 只借场景明暗(luma)、角色保留自己颜色;1 = 完整彩色 E。
//   · uAOContact / uAOForm = 保留的游戏侧 sprite AO。
const FILTER_WGSL = /* wgsl */ `
struct GlobalFilterUniforms {
    uInputSize: vec4<f32>,
    uInputPixel: vec4<f32>,
    uInputClamp: vec4<f32>,
    uOutputFrame: vec4<f32>,
    uGlobalFrame: vec4<f32>,
    uOutputTexture: vec4<f32>,
}

struct ShadeUniforms {
    uSceneSize: vec2<f32>,
    uProjectionScale: f32,
    uWorldToPixelX: f32,
    uWorldToPixelY: f32,
    uWorldContainerPos: vec2<f32>,
    uEntityFootWorldX: f32,
    uEntityFootWorldY: f32,
    uDepthEnabled: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uDepthPerSy: f32,
    uFloorOffset: f32,
    uFloorOffsetExtra: f32,
    uTolerance: f32,
    uOcclusionBlendFactor: f32,
    uHasFootDepth: f32,
    uFootBias: f32,
    uHasFgCoverage: f32,
    uDebug: f32,
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
    uSkyaoN: vec3<f32>,
    uSkyaoTiles: vec2<f32>,
    uSkyaoMin: vec3<f32>,
    uSkyaoScale: vec3<f32>,
    uSkyaoM: mat3x3<f32>,
    uSkyaoOn: f32,
    uSkyaoBlend: f32,
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
    uFootQ: vec3<f32>,
    uCharH: f32,
    uCharW: f32,
    uNrmRect: vec4<f32>,
    uFlipX: f32,
    uSpriteWorldRect: vec4<f32>,
    uHasNrm: f32,
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
}

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> shadeUniforms: ShadeUniforms;
@group(1) @binding(1) var uDepthMap: texture_2d<f32>;
@group(1) @binding(2) var uDepthMapSampler: sampler;
${fgCoverageBindingsWgsl(1, 3)}@group(1) @binding(5) var uNrm: texture_2d<f32>;
@group(1) @binding(6) var uNrmSampler: sampler;
@group(1) @binding(7) var uPL1: texture_2d<f32>;
@group(1) @binding(8) var uPL2: texture_2d<f32>;
@group(1) @binding(9) var uPBin: texture_2d<f32>;
@group(1) @binding(10) var uValid: texture_2d<f32>;
@group(1) @binding(11) var uSkyaoTex: texture_2d<f32>;
@group(1) @binding(12) var uVolRad: texture_2d<f32>;
@group(1) @binding(13) var uVolEmit: texture_2d<f32>;

${CHAR_LIGHT_COMMON_WGSL}
${FG_OCCLUSION_WGSL}

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
}

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
    var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
    return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
    return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
    var out: VSOutput;
    out.position = filterVertexPosition(aPosition);
    out.vTextureCoord = filterTextureCoord(aPosition);
    out.vScreenPos = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    return out;
}

@fragment
fn mainFragment(
    @builtin(position) fragPos: vec4<f32>,
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let color = textureSample(uTexture, uSampler, vTextureCoord);
    if (color.a < 0.03) { discard; }

    // 公共块的参数结构:按字段名逐个赋值(同为 f32 的字段位置构造会静默错位)
    var pp: ClcProbe;
    pp.uM = shadeUniforms.uM;
    pp.uWMin = shadeUniforms.uWMin;
    pp.uWScale = shadeUniforms.uWScale;
    pp.uPN = shadeUniforms.uPN;
    pp.uProbeT = shadeUniforms.uProbeT;
    pp.uShK = shadeUniforms.uShK;
    pp.uBinOb = shadeUniforms.uBinOb;
    pp.uFold = shadeUniforms.uFold;
    pp.uAmbSH = shadeUniforms.uAmbSH;
    pp.uMode = shadeUniforms.uMode;
    pp.uAmbStrength = shadeUniforms.uAmbStrength;
    var sk: ClcSkyao;
    sk.uSkyaoN = shadeUniforms.uSkyaoN;
    sk.uSkyaoTiles = shadeUniforms.uSkyaoTiles;
    sk.uSkyaoMin = shadeUniforms.uSkyaoMin;
    sk.uSkyaoScale = shadeUniforms.uSkyaoScale;
    sk.uSkyaoM = shadeUniforms.uSkyaoM;
    sk.uSkyaoOn = shadeUniforms.uSkyaoOn;

    let S = max(shadeUniforms.uProjectionScale, 1e-6);
    let wx = (vScreenPos.x - shadeUniforms.uWorldContainerPos.x) / S;
    let wy = (vScreenPos.y - shadeUniforms.uWorldContainerPos.y) / S;

    var occluded = false;
    // ---------- 深度遮挡(P2a 契约;缺行走面场就不遮挡) ----------
    if (shadeUniforms.uDepthEnabled > 0.5 && shadeUniforms.uHasFootDepth > 0.5) {
        let depthUV = vec2<f32>(wx / shadeUniforms.uSceneSize.x, wy / shadeUniforms.uSceneSize.y);
        if (depthUV.x >= 0.0 && depthUV.x <= 1.0 && depthUV.y >= 0.0 && depthUV.y <= 1.0) {
            let depthSample = textureSampleLevel(uDepthMap, uDepthMapSampler, depthUV, 0.0);
            let rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
            var d_raw = rawDepth;
            if (shadeUniforms.uInvert > 0.5) { d_raw = 1.0 - rawDepth; }
            let sceneDepth = d_raw * shadeUniforms.uScale + shadeUniforms.uOffset;
            // 遮挡与着色用**同一个**代理:立在伪世界里的直立 quad。
            // uDepthPerSy = tanθ/ppu 正是直立 quad 的深度梯度(往上越靠近相机)。
            // 脚点深度只认行走面场实测值(uFootQ.z,与着色同源)——floor 拟合直线已废除
            // (多层街巷可偏出 200+ 行地面),没有场就整段不遮挡,绝不退回旧模型顶上。
            let syTexFoot = shadeUniforms.uEntityFootWorldY * shadeUniforms.uWorldToPixelY;
            let syTex = wy * shadeUniforms.uWorldToPixelY;
            let upright = shadeUniforms.uDepthPerSy * (syTex - syTexFoot);
            let spriteDepth = shadeUniforms.uFootQ.z + upright + shadeUniforms.uFloorOffset
                + shadeUniforms.uFloorOffsetExtra - shadeUniforms.uFootBias;
            // 场景前景层(三份遮挡实现同一段,见 foregroundMaskWgsl):前景面按接地深度立起来的直立面比,
            // 与脚点同源、两块直立面同一个梯度——不加脚点偏置 / 容差 / floor 偏移;外沿(深度图糊的那圈)不判
            var fgDepth: f32;
            let fgKind = fgSample(depthUV, shadeUniforms.uHasFgCoverage, &fgDepth);
            if (fgKind > 1.5) {
                occluded = false;
            } else if (fgKind > 0.5) {
                occluded = fgDepth < shadeUniforms.uFootQ.z + upright - 1e-4;
            } else {
                occluded = sceneDepth + shadeUniforms.uTolerance < spriteDepth;
            }
        }
    }

    if (shadeUniforms.uDebug > 0.5) {
        if (occluded) { return vec4<f32>(1.0, 0.0, 0.0, 0.7); }
        return vec4<f32>(0.0, 0.0, 1.0, 0.7);
    }

    if (occluded) {
        if (shadeUniforms.uOcclusionBlendFactor < 1e-5) { discard; }
        return vec4<f32>(color.rgb * shadeUniforms.uOcclusionBlendFactor, color.a * shadeUniforms.uOcclusionBlendFactor);
    }

    // ---------- 像素几何:世界坐标 → work px → 直立 quad q ----------
    let ppu = shadeUniforms.uCal.x;
    let sxw = wx * shadeUniforms.uWorldToWork.x;
    let syw = wy * shadeUniforms.uWorldToWork.y;
    let footSy = shadeUniforms.uEntityFootWorldY * shadeUniforms.uWorldToWork.y;
    let qx = (sxw - shadeUniforms.uCal.z) / ppu;
    let h = max((footSy - syw) / max(shadeUniforms.uCosT * ppu, 1e-6), 0.0);

    // ---------- 法线(运行时鼓包图集;无图集 → 平面朝相机) ----------
    // ⚠⚠ 法线 local UV **只**取自像素在 sprite 世界 AABB(uSpriteWorldRect)里的比例,与 color 帧同一套 local UV,
    //    镜像只翻 local u;绝不从脚点 / 角色宽反推。
    //
    // 老写法是 ul = 0.5 + (qx - uFootQ.x)/uCharW、vl = 1 - h/uCharH —— 绕世界坐标
    // 回来,依赖 uFootQ / uCharW 两个**每帧驱动**的 uniform。任何一帧没喂上,ul 就整体
    // 越界、被 clamp 死在 0 或 1,全身反复采**同一列边缘像素**:
    //   · 通体单色;翻转时 ul=1-ul 从另一端夹住 → 另一个颜色(实测的绿↔黄);
    //   · uNrmRect / uHasNrm 在默认值与真值间跳变 → 角色不动也逐帧闪。
    // 实测触发条件:非 Exploring 态(如 Cutscene)整段着色驱动被跳过,而滤镜仍挂着,
    // uniform 停在构造缺省(charW=0.6 / foot=(0,0,0) / hasNrm=0)。
    var ne = vec4<f32>(0.5, 0.5, 1.0, 0.35);
    if (shadeUniforms.uHasNrm > 0.5) {
        var luv = (vec2<f32>(wx, wy) - shadeUniforms.uSpriteWorldRect.xy) / max(shadeUniforms.uSpriteWorldRect.zw, vec2<f32>(1e-5));
        if (shadeUniforms.uFlipX > 0.5) { luv.x = 1.0 - luv.x; }      // 镜像:只翻 local u
        let uvn = shadeUniforms.uNrmRect.xy + clamp(luv, vec2<f32>(0.0), vec2<f32>(1.0)) * shadeUniforms.uNrmRect.zw;
        ne = textureSampleLevel(uNrm, uNrmSampler, uvn, 0.0);
    }
    var n = normalize(vec3<f32>(-(ne.r * 2. - 1.), -(ne.g * 2. - 1.), -max(ne.b, .05)));
    if (shadeUniforms.uFlipX > 0.5) { n.x = -n.x; }
    n = normalize(mix(n, vec3<f32>(0., 0., -1.), shadeUniforms.uFlatten));

    let q = vec3<f32>(qx,
                      shadeUniforms.uFootQ.y + h * shadeUniforms.uCosT,
                      shadeUniforms.uFootQ.z - h * shadeUniforms.uSinT - ne.a * shadeUniforms.uBulge * shadeUniforms.uCharW);

    // 法线档必须是**独占区间**:uShowN=2 是 skyao 档,写成 > 0.5 会被这条
    // 先接住并 return,于是「看 skyao」看到的是法线(2026-09-01 踩过)。
    if (shadeUniforms.uShowN > 0.5 && shadeUniforms.uShowN < 1.5) { return vec4<f32>((n * .5 + .5) * color.a, color.a); }

    // 诊断·定法线:0 = 正常 1 = 强制世界水平朝相机 2 = 强制世界向上(只改查表方向;与 mesh 路径同一组 q 常量)
    if (shadeUniforms.uFixedNQ > 0.5) {
        if (shadeUniforms.uFixedNQ > 1.5) {
            n = normalize(vec3<f32>(0., shadeUniforms.uCosT, -shadeUniforms.uSinT));
        } else {
            n = vec3<f32>(0., 0., -1.);
        }
    }
    // ---------- E:RT gather 或 probe 图集 ----------
    var E: vec3<f32>;
    if (shadeUniforms.uMode < 0.5) {
        var vv: ClcVol;
        vv.uVolN = shadeUniforms.uVolN;
        vv.uVolTiles = shadeUniforms.uVolTiles;
        vv.uQMin = shadeUniforms.uQMin;
        vv.uQMax = shadeUniforms.uQMax;
        var rt: ClcRt;
        rt.uSpp = shadeUniforms.uSpp;
        rt.uMSteps = shadeUniforms.uMSteps;
        rt.uMissMode = shadeUniforms.uMissMode;
        rt.uNEE = shadeUniforms.uNEE;
        rt.uStep = shadeUniforms.uStep;
        rt.uLightCount = shadeUniforms.uLightCount;
        rt.uLightQ = shadeUniforms.uLightQ;
        rt.uLightE = shadeUniforms.uLightE;
        E = gatherRT(q + n * 0.02, n, fragPos.xy, pp, vv, &rt, uVolRad, uVolEmit);
    } else {
        E = probeE(q, n, pp, uPL1, uPL2, uPBin, uValid);
    }
    let EgiPure = E * shadeUniforms.uGiStrength;   // 历史 GI 诊断尺,与正常受光的 factor 分开
    // ---- skyao:**乘在 GI 上**,与全白 blend(制作人 2026-09-01)----
    // 天穹遮蔽是几何项,只该衰减 GI 底光;太阳是独立解析直射,不吃它
    // (太阳自己的遮蔽将来要走 V_dir(w) 那条闭式,不是这个各向同性的 V)。
    E *= mix(1.0, skyaoAt(q, n, sk, uSkyaoTex), clamp(shadeUniforms.uSkyaoBlend, 0.0, 1.0));
    // 调试档:uShowN==2 ⇒ 直接把 skyao 的 V 画成灰度(1 = 不遮蔽 0 = 全遮)。
    // 判「这一项到底生没生效」只能看它 —— 角色在 800x450 里只有几十像素,
    // 靠肉眼比两张截图分不出 3 倍的 GI 差异(2026-09-01 实测走过这个弯路)。
    if (shadeUniforms.uShowN > 4.5) { return vec4<f32>(skyaoBand(q, n, sk, uSkyaoTex) * color.a, color.a); }
    if (shadeUniforms.uShowN > 3.5) { return vec4<f32>(skyaoRaw(q, sk, uSkyaoTex) * color.a, color.a); }
    if (shadeUniforms.uShowN > 2.5) { return vec4<f32>(skyaoBox(q, sk) * color.a, color.a); }
    if (shadeUniforms.uShowN > 1.5) {
        // 与场景 uDebug==11 同看时必须同显示链:场景 V 写进 RT 后被 LitBackground 做
        // 显示变换,角色裸值直出就凭空暗一档 + 半透明边缘一圈黑边(2026-09-01 实测,
        // 与 eOnly 分支同一类)。此路径无 uDisp*,用 lin2srgb 同 eOnly 口径。
        let v = skyaoAt(q, n, sk, uSkyaoTex);
        return vec4<f32>(clamp(lin2srgb(vec3<f32>(v)), vec3<f32>(0.0), vec3<f32>(1.0)) * color.a, color.a);
    }

    // 太阳:独立解析直射(与投影阴影方位解耦)
    var directE = vec3<f32>(0.0);
    if (shadeUniforms.uSunOn > 0.5) {
        let ndl = max(dot(n, shadeUniforms.uSunDirQ), 0.0);
        directE += shadeUniforms.uSunColor * ndl;
    }
    // ---- 「GI体·纯E」调试(F2 的 8/9/10 档):albedo≡1,输出 E×2^β ----
    // 与 mesh 路径(CharacterLitSprite)同式。此路径没有场景显示变换参数,收尾用
    // lin2srgb —— 与缺省显示链(EV0 / 无 tonemap)等价;display 非缺省的场景会有偏差。
    // ⚠ 2026-09-01 之前这条分支只有 mesh 路径有:GI体 档下 mesh 角色正确变白融进
    //   场景,filter 角色仍按 albedo 渲 —— 同一份 E,一个白一个黑,像数据坏了。
    if (shadeUniforms.uEOnly > 0.5 && shadeUniforms.uEOnly < 1.5) {
        var pe = EgiPure * shadeUniforms.uBeta;   // 乘 skyao 之前的 E,与场景 uDebug==8 同式
        if (shadeUniforms.uEChecker > 0.5) {
            let cc = vec3<i32>(probeGridT(q, pp));
            pe *= mix(0.45, 1.0, f32((cc.x + cc.y + cc.z) & 1));
        }
        return vec4<f32>(clamp(lin2srgb(pe), vec3<f32>(0.0), vec3<f32>(1.0)) * color.a, color.a);
    }
    // ---------- 角色着色核心(共享:charShadeCore 的 shadeEntityLinear) ----------
    // E 分解 + albedo×E 在唯一真相源里;游戏不乘实验室 pgain,直接 lin2srgb + clamp。
    let alb = color.rgb / max(color.a, 1e-4);   // Pixi 预乘 → 直通 albedo
    var outRgb = clamp(lin2srgb(shadeEntityLinear(alb, E, directE, shadeUniforms.uIndirectFactor,
        shadeUniforms.uDirectFactor, shadeUniforms.uTotalFactor, shadeUniforms.uEChroma)), vec3<f32>(0.0), vec3<f32>(1.0));

    // ---------- 保留:游戏侧 sprite 空间 AO ----------
    let vy = clamp(vTextureCoord.y, 0.0, 1.0);
    let contact = shadeUniforms.uAOContact * smoothstep(0.78, 1.0, vy);
    let form = shadeUniforms.uAOForm * vy;
    let ao = clamp(1.0 - contact - form, 0.0, 1.0);
    outRgb *= ao;

    return vec4<f32>(outRgb * color.a, color.a);
}
`;

let sharedGpuProgram: GpuProgram | null = null;
function getSharedGpuProgram(): GpuProgram {
  if (!sharedGpuProgram) {
    sharedGpuProgram = GpuProgram.from({
      vertex: { source: FILTER_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: FILTER_WGSL, entryPoint: 'mainFragment' },
    });
  }
  return sharedGpuProgram;
}

/** 场景级静态资源(CharacterLightingSystem 载入并共享给所有滤镜) */
export interface CharShadingSceneResources {
  atlasL1: TextureSource;
  atlasL2: TextureSource;
  atlasBin: TextureSource;
  valid: TextureSource;
  volRad: TextureSource;
  volEmit: TextureSource;
  workW: number;
  workH: number;
  /** 场景世界坐标 → work px */
  worldToWorkX: number;
  worldToWorkY: number;
  cal: { ppu: number; cx: number; cy: number; theta: number };
  vol: {
    nx: number; ny: number; nz: number; tilesX: number; tilesY: number;
    qMin: [number, number, number]; qMax: [number, number, number];
  };
  /** q→world 矩阵,列主序 9 元素(GL 布局) */
  mCol: Float32Array;
  wMin: [number, number, number];
  wScale: [number, number, number];
  pn: [number, number, number];
  /** probe 图集平铺:每行多少颗(见 charLightCommon.wgsl 的 probeTexel;valid 图共用) */
  probeT: number;
  /** 'l2' 图集每颗的球谐系数数(9=L2 / 25=L4),与着色器 uShK 同义 */
  shK: number;
  /** 八面体边长(8 或 16),与着色器 uBinOb 同义 */
  binOb: number;
  ambSH: Float32Array;           // 27
  lightsQ: Float32Array;         // 48×4
  lightsE: Float32Array;         // 48×4
  lightCount: number;
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

export interface CharacterShadingFilterOptions {
  depthTexture: Texture | null;
  cfg: SceneDepthConfig | null;
  scene: CharShadingSceneResources;
}

export class CharacterShadingFilter extends Filter implements IEntityShadingFilter {
  readonly _isDepthOcclusion = true;
  /** 类型判别(Game 逐帧驱动循环用,instanceof 之外的快速判断) */
  readonly _isCharacterShading = true;

  private constructor(opts: CharacterShadingFilterOptions) {
    const { cfg, depthTexture, scene } = opts;
    const depthOn = !!(cfg && depthTexture);
    const dm = cfg?.depth_mapping;
    const sh = cfg?.shader;
    const depthSrc = depthTexture?.source ?? Texture.WHITE.source;
    const nrmSrc = Texture.WHITE.source;

    super({
      gpuProgram: getSharedGpuProgram(),
      resources: {
        shadeUniforms: {
          uSceneSize: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uProjectionScale: { value: 1, type: 'f32' },
          uWorldToPixelX: { value: 1, type: 'f32' },
          uWorldToPixelY: { value: 1, type: 'f32' },
          uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uEntityFootWorldX: { value: 0, type: 'f32' },
          uEntityFootWorldY: { value: 0, type: 'f32' },

          uDepthEnabled: { value: depthOn ? 1 : 0, type: 'f32' },
          uInvert: { value: dm?.invert ? 1.0 : 0.0, type: 'f32' },
          uScale: { value: dm?.scale ?? 1, type: 'f32' },
          uOffset: { value: dm?.offset ?? 0, type: 'f32' },
          // 直立 quad 的深度梯度 tanθ/ppu。缺字段时**从 M 现推**——退成 0 等于
          // 悄悄变回 billboard(整张 sprite 一个深度),那正是已废除的口径。
          uDepthPerSy: { value: sh?.depth_per_sy ?? uprightGradientFromM(cfg), type: 'f32' },
          uFloorOffset: { value: cfg?.floor_offset ?? 0, type: 'f32' },
          uFloorOffsetExtra: { value: 0, type: 'f32' },
          uTolerance: { value: cfg?.depth_tolerance ?? 0, type: 'f32' },
          uOcclusionBlendFactor: { value: 0, type: 'f32' },
          uHasFootDepth: { value: 0, type: 'f32' },
          uFootBias: { value: 0.045, type: 'f32' },
          uHasFgCoverage: { value: 0, type: 'f32' },
          uDebug: { value: 0, type: 'f32' },

          uWorkSize: { value: new Float32Array([scene.workW, scene.workH]), type: 'vec2<f32>' },
          uWorldToWork: { value: new Float32Array([scene.worldToWorkX, scene.worldToWorkY]), type: 'vec2<f32>' },
          uCal: { value: new Float32Array([scene.cal.ppu, 0, scene.cal.cx, scene.cal.cy]), type: 'vec4<f32>' },
          uCosT: { value: Math.cos(scene.cal.theta), type: 'f32' },
          uSinT: { value: Math.sin(scene.cal.theta), type: 'f32' },
          uQMin: { value: new Float32Array(scene.vol.qMin), type: 'vec3<f32>' },
          uQMax: { value: new Float32Array(scene.vol.qMax), type: 'vec3<f32>' },
          uVolN: { value: new Float32Array([scene.vol.nx, scene.vol.ny, scene.vol.nz]), type: 'vec3<f32>' },
          uVolTiles: { value: new Float32Array([scene.vol.tilesX, scene.vol.tilesY]), type: 'vec2<f32>' },
          uM: { value: scene.mCol, type: 'mat3x3<f32>' },
          // ---- skyao probe。无载荷时 uSkyaoOn=0,shader 恒返回 1(不遮蔽)----
          uSkyaoN: { value: new Float32Array(scene.skyao?.n ?? [1, 1, 1]), type: 'vec3<f32>' },
          uSkyaoTiles: { value: new Float32Array(scene.skyao?.tiles ?? [1, 1]), type: 'vec2<f32>' },
          uSkyaoMin: { value: new Float32Array(scene.skyao?.wMin ?? [0, 0, 0]), type: 'vec3<f32>' },
          uSkyaoScale: { value: new Float32Array(scene.skyao?.wScale ?? [0, 0, 0]), type: 'vec3<f32>' },
          uSkyaoM: { value: scene.skyao?.mCol ?? new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
                     type: 'mat3x3<f32>' },
          uSkyaoOn: { value: scene.skyao ? 1 : 0, type: 'f32' },
          uSkyaoBlend: { value: 1, type: 'f32' },
          uWMin: { value: new Float32Array(scene.wMin), type: 'vec3<f32>' },
          uWScale: { value: new Float32Array(scene.wScale), type: 'vec3<f32>' },
          uPN: { value: new Float32Array(scene.pn), type: 'vec3<f32>' },
          uProbeT: { value: scene.probeT, type: 'f32' },
          uShK: { value: scene.shK, type: 'f32' },
          uBinOb: { value: scene.binOb, type: 'f32' },
          uAmbSH: { value: scene.ambSH, type: 'vec3<f32>', size: 9 },
          uLightQ: { value: scene.lightsQ, type: 'vec4<f32>', size: 48 },
          uLightE: { value: scene.lightsE, type: 'vec4<f32>', size: 48 },
          uLightCount: { value: scene.lightCount, type: 'f32' },

          uFootQ: { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' },
          uCharH: { value: 1.5, type: 'f32' },
          uCharW: { value: 0.6, type: 'f32' },
          uNrmRect: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
          uFlipX: { value: 0, type: 'f32' },
          uSpriteWorldRect: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
          uHasNrm: { value: 0, type: 'f32' },

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
        },
        uDepthMap: depthSrc,
        // WGSL 的采样器(「纹理名 + Sampler」):该纹理自己的 style
        uDepthMapSampler: samplerOf(depthSrc),
        uFgCoverage: Texture.EMPTY.source,
        uFgCoverageSampler: samplerOf(Texture.EMPTY.source),
        uNrm: nrmSrc,
        uNrmSampler: samplerOf(nrmSrc),
        uPL1: scene.atlasL1,
        uPL2: scene.atlasL2,
        uPBin: scene.atlasBin,
        uValid: scene.valid,
        uSkyaoTex: scene.skyao?.tex ?? Texture.EMPTY.source,
        uVolRad: scene.volRad,
        uVolEmit: scene.volEmit,
      },
    });
  }

  static createForEntity(opts: CharacterShadingFilterOptions): CharacterShadingFilter {
    return new CharacterShadingFilter(opts);
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['shadeUniforms']
      ?.uniforms;
  }

  // ---- IEntityShadingFilter 驱动接口(遮挡/场景几何) ----
  setSceneSize(w: number, h: number): void {
    const u = this._u;
    if (u) { const a = u['uSceneSize'] as Float32Array; a[0] = w; a[1] = h; }
  }
  setWorldToPixel(tx: number, ty: number): void {
    const u = this._u;
    if (u) { u['uWorldToPixelX'] = tx; u['uWorldToPixelY'] = ty; }
  }
  setProjectionScale(s: number): void {
    const u = this._u;
    if (u) u['uProjectionScale'] = s;
  }
  setWorldContainerPos(x: number, y: number): void {
    const u = this._u;
    if (u) { const a = u['uWorldContainerPos'] as Float32Array; a[0] = x; a[1] = y; }
  }
  setEntityFootY(worldY: number): void {
    const u = this._u;
    if (u) u['uEntityFootWorldY'] = worldY;
  }
  setEntityFootX(worldX: number): void {
    const u = this._u;
    if (u) u['uEntityFootWorldX'] = worldX;
  }
  setFloorOffset(v: number): void {
    const u = this._u;
    if (u) u['uFloorOffset'] = v;
  }
  setFloorOffsetExtra(v: number): void {
    const u = this._u;
    if (u) u['uFloorOffsetExtra'] = v;
  }
  setTolerance(v: number): void {
    const u = this._u;
    if (u) u['uTolerance'] = v;
  }
  setOcclusionBlendFactor(v: number): void {
    const u = this._u;
    if (u) u['uOcclusionBlendFactor'] = Math.min(1, Math.max(0, v));
  }

  /** 脚点行走面深度。与 setFootQ 写同一个 uFootQ.z（同源同值，避免两份脚深度漂移）；
   *  null = 无行走面场，回落旧的 floor 直线口径。 */
  setFootDepthQ(v: number | null): void {
    const u = this._u;
    if (!u) return;
    if (v === null || !Number.isFinite(v)) { u['uHasFootDepth'] = 0; return; }
    (u['uFootQ'] as Float32Array)[2] = v;
    u['uHasFootDepth'] = 1;
  }

  /** 脚点遮挡偏置（实验室常数 0.045） */
  setFootBias(v: number): void {
    const u = this._u;
    if (u) u['uFootBias'] = Math.max(0, v);
  }
  setForegroundCoverage(src: TextureSource | null): void {
    const u = this._u;
    const tex = src ?? Texture.EMPTY.source;
    const res = this.resources as Record<string, unknown>;
    res['uFgCoverage'] = tex;
    // WGSL 的采样器跟着换(「纹理名 + Sampler」= 该纹理自己的 style)
    res['uFgCoverageSampler'] = samplerOf(tex);
    if (u) u['uHasFgCoverage'] = src ? 1 : 0;
  }
  setDebug(on: boolean): void {
    const u = this._u;
    if (u) u['uDebug'] = on ? 1 : 0;
  }
  /** 保留的游戏侧 sprite AO(applyShadowFilterToneAO 广播命中;tone 无 setter=淘汰) */
  setAO(contact: number, form: number): void {
    const u = this._u;
    if (u) {
      u['uAOContact'] = Math.max(0, Math.min(1, contact));
      u['uAOForm'] = Math.max(0, Math.min(1, form));
    }
  }

  // ---- 角色照明驱动(CharacterLightingSystem 逐帧调用) ----
  setFootQ(x: number, y: number, z: number): void {
    const u = this._u;
    if (u) { const a = u['uFootQ'] as Float32Array; a[0] = x; a[1] = y; a[2] = z; }
  }
  setCharSize(wWu: number, hWu: number): void {
    const u = this._u;
    if (u) { u['uCharW'] = Math.max(wWu, 1e-4); u['uCharH'] = Math.max(hWu, 1e-4); }
  }
  setNormalFrame(rect: [number, number, number, number] | null, flipX: boolean): void {
    const u = this._u;
    if (!u) return;
    if (rect) {
      const a = u['uNrmRect'] as Float32Array;
      a[0] = rect[0]; a[1] = rect[1]; a[2] = rect[2]; a[3] = rect[3];
      u['uHasNrm'] = 1;
    } else {
      u['uHasNrm'] = 0;
    }
    u['uFlipX'] = flipX ? 1 : 0;
  }
  /** sprite 的世界 AABB(左上 x,y + 宽高)—— 法线 local UV 的唯一依据,裁剪无关。 */
  setSpriteWorldRect(x: number, y: number, w: number, h: number): void {
    const u = this._u;
    if (!u) return;
    const a = u['uSpriteWorldRect'] as Float32Array;
    a[0] = x; a[1] = y; a[2] = Math.max(w, 1e-5); a[3] = Math.max(h, 1e-5);
  }
  /** 当前绑定的法线图集源;用于逐帧同步时跳过未变的情况(见 boundNormalSource)。 */
  private _nrmSrc: TextureSource | null = null;
  get boundNormalSource(): TextureSource | null { return this._nrmSrc; }
  setNormalTexture(src: TextureSource | null): void {
    if (src === this._nrmSrc) return;                 // 未变:逐帧调用零开销
    this._nrmSrc = src ?? null;
    const next = src ?? Texture.WHITE.source;
    const res = this.resources as Record<string, unknown>;
    res['uNrm'] = next;
    // WGSL 采样器跟着换:旧图集销毁时它的 style 一起销毁,留着会让 BindGroup 当场作废
    res['uNrmSampler'] = samplerOf(next);
  }
  applyParams(p: CharShadingParams): void {
    const u = this._u;
    if (!u) return;
    u['uMode'] = p.mode;
    u['uSpp'] = p.spp;
    u['uMSteps'] = p.msteps;
    u['uFold'] = p.fold ? 1 : 0;
    u['uMissMode'] = p.missMode ? 1 : 0;
    u['uNEE'] = p.nee ? 1 : 0;
    u['uStep'] = p.step;
    u['uBeta'] = Math.pow(2, p.beta);
    u['uAmbStrength'] = p.ambStrength;
    u['uBulge'] = p.bulge;
    u['uFlatten'] = p.flatten;
    u['uShowN'] = p.showNormals ? 1 : 0;
    u['uGiStrength'] = p.giStrength;
    u['uIndirectFactor'] = lightFactor(p.indirectFactor, p.giStrength);
    u['uDirectFactor'] = lightFactor(p.directFactor);
    u['uTotalFactor'] = lightFactor(p.totalFactor, Math.pow(2, p.beta) / Math.PI);
    u['uSunOn'] = p.sunEnabled ? 1 : 0;
    const az = (p.sunAzimuthDeg * Math.PI) / 180;
    const el = (p.sunElevationDeg * Math.PI) / 180;
    const d = u['uSunDirQ'] as Float32Array;
    // q 空间:x=画面右,y=上,z=纵深(远为正);az 0°右/90°纵深/180°左/270°朝镜头
    d[0] = Math.cos(el) * Math.cos(az);
    d[1] = Math.sin(el);
    d[2] = Math.cos(el) * Math.sin(az);
    const c = u['uSunColor'] as Float32Array;
    c[0] = p.sunColor[0] * p.sunIntensity;
    c[1] = p.sunColor[1] * p.sunIntensity;
    c[2] = p.sunColor[2] * p.sunIntensity;
  }

  /**
   * 调试/覆盖状态(showN 覆盖档、纯E、棋盘、skyao blend)。
   * mesh 路径这些走 syncFrame 的 frameLit 共享组;filter 每实体一份 uniform,
   * 必须在 driveFilter 里逐个推 —— 漏推的症状是「调试档只有 mesh 角色生效」
   * (2026-09-01:GI体 档 filter 角色漆黑、band 档 filter 角色无色,均此因)。
   */
  applyDebugState(showN: number, eOnly: number, eChecker: number, skyaoBlend: number,
                  fixedNQ = 0): void {
    const u = this._u;
    if (!u) return;
    u['uFixedNQ'] = fixedNQ;
    u['uShowN'] = showN;
    u['uEOnly'] = eOnly;
    u['uEChecker'] = eChecker;
    u['uSkyaoBlend'] = skyaoBlend;
  }

  /** F2 测试旋钮:E 色度权重 0(只借明暗)~1(完整彩色 E)。 */
  setEChroma(v: number): void {
    const u = this._u;
    if (u) u['uEChroma'] = v;
  }
}
