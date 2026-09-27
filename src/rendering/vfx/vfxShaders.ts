/**
 * 世界空间粒子的两套着色程序：
 *
 * - **unlit**：贴图 × 顶点色，只做深度遮挡 / 软边 + 显示变换；外观要受光而场景没有照明载荷时
 *   再叠 NPC 那时走的色调融入（见 `FRAG_UNLIT_WGSL` 头注释）；
 * - **lit**：在 unlit 之上叠角色那套照明——probe 底光（q 空间查表）+ 场景实体灯（M-world、wu，
 *   与场景 / 角色吃**同一次** packLights）+ 与背景同一组显示变换。公共块 `CHAR_LIGHT_COMMON_WGSL`、
 *   `charShadeCore` 与实体灯循环 `ENTITY_SCENE_LIGHTS_WGSL` **原样拼接**，不内联重写
 *   （character-lighting 硬契约；`worldSpaceShading.test.ts` 钉着"粒子不许自己写灯循环"）。
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
 * ## 着色器
 *
 * 只有 WGSL（`get*GpuProgram`，四个模块见 {@link VFX_WGSL_SOURCES}）。master 的 GLSL 版是像素对照的参考：
 * 等价由 `tools/render_parity/cases/90_vfx.ts`（「粒子 /」）逐像素钉住，资源键 / uniform 结构偏移由 `vfxWgsl.test.ts` 钉住。
 *
 * ⚠ 模板字符串里不许出现反引号。
 */
import { GpuProgram } from '../../engine2d';

import {
  CHAR_LIGHTS_WGSL, ENTITY_SCENE_LIGHTS_WGSL, FRAME_SHADE_WGSL, SCENE_SHADE_WGSL,
} from '../CharacterLitSprite';
import { CHAR_LIGHT_COMMON_WGSL } from '../CharacterShadingFilter';
import { FG_OCCLUSION_WGSL, fgCoverageBindingsWgsl } from '../foreground/foregroundMaskWgsl';
import { LC_WGSL, WR_CORE_WGSL } from '../lighting/wgslChunks';
import { BOLT_WGSL_KERNEL } from './vfxBoltWgsl';

// ───────────────────────────── WGSL
//
// 约定(见 agent_docs 的 pixi-shader-wgsl-port 配方卡):
// - 组 0 / 1 是 Pixi 网格约定(globalUniforms / localUniforms,声明了 Pixi 才自动绑);自有资源全在组 2,
//   变量名 = resources 的键名,绑定号按 resources 对象里的相对顺序排(与 master 的 GLSL 版分纹理单元的顺序一致)。
// - 采样的纹理各配一个「纹理名 + Sampler」采样器(= 该纹理自己的 style);只 textureLoad 的纹理(probe 图集等)不配。
// - 片元开头第一次取色在一致控制流里,用 textureSample(按导数选级);discard / 分支之后一律
//   textureSampleLevel(…, 0.0)(深度图 / probe 图都没有 mip)。
// - uniform 结构成员同名同序对应 JS 的 UniformGroup 声明(Pixi 按声明顺序、WGSL 对齐规则排偏移);
//   `vfxWgsl.test.ts` 用 Pixi 自己的布局函数逐项核对偏移,并核对每个资源键都有同名绑定。
// - 角色照明公共块 / 实体灯循环 / 光照核心拼的是共享 WGSL 片段(CHAR_LIGHT_COMMON_WGSL / ENTITY_SCENE_LIGHTS_WGSL /
//   LC_WGSL + WR_CORE_WGSL),每个模块各拼一次;公共块不读绑定,uniform 由 main 按字段名逐个赋进值结构。
// - 结构体里不写注释、注释里不写「at 号 + group / binding + 括号」:Pixi 用正则解析 WGSL。

/** Pixi 网格约定的组 0 / 1(粒子、雷、光柱共用) */
export const VFX_MESH_GLOBALS_WGSL = /* wgsl */ `
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
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
`;

/**
 * 顶点程序。`plate` = 薄片（纸钱）：多一条逐顶点世界法线 `aNrm` → `vNrm`（片能弯能翻，法线不是朝相机的那根）。
 */
function vertWgsl(plate: boolean): string {
  return /* wgsl */ `
${VFX_MESH_GLOBALS_WGSL}
struct VfxVOut {
    @builtin(position) position: vec4<f32>,
    @location(0) vUV: vec2<f32>,
    @location(1) vColor: vec4<f32>,
    @location(2) vQ: vec3<f32>,
    @location(3) vWorld: vec2<f32>,
    @location(4) vLocal: vec2<f32>,
    @location(5) vMisc: vec2<f32>,
${plate ? '    @location(6) vNrm: vec3<f32>,\n' : ''}}

@vertex
fn mainVertex(
    @location(0) aPosition: vec2<f32>,
    @location(1) aUV: vec2<f32>,
    @location(2) aColor: vec4<f32>,
    @location(3) aQ: vec3<f32>,
    @location(4) aLocal: vec2<f32>,
    @location(5) aMisc: vec2<f32>,
${plate ? '    @location(6) aNrm: vec3<f32>,\n' : ''}) -> VfxVOut {
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
    var o: VfxVOut;
    o.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
    o.vUV = aUV;
    o.vColor = aColor * localUniforms.uColor;
    o.vQ = aQ;
    o.vWorld = aPosition;
    o.vLocal = aLocal;
    o.vMisc = aMisc;
${plate ? '    o.vNrm = aNrm;\n' : ''}    return o;
}
`;
}

/**
 * 遮挡 / 软边共用段(粒子的四个程序都拼它)。返回可见度 0..1,≤ 0 = 完全被挡(调用方 discard)。
 * 读模块作用域的 `vfxDepth` / `uDepthMap` / `uDepthMapSampler` 与前景覆盖图 `uFgCoverage` / `uFgCoverageSampler`(每个拼它的宿主都以这五个名字声明绑定,覆盖图那两条用
 * {@link fgCoverageBindingsWgsl})。结构 = VfxRenderer 里粒子 depthGroup 的声明顺序(uHasFgCoverage 在最后)。
 * 场景前景层:外沿那圈(深度图糊的地方)不判(返回 1),前景面拿按接地线立起来的前景面深度**顶替深度图**(容差照旧),
 * 其余照旧读深度图。`fgSample` 是 foregroundMaskWgsl 的共用段(与三支实体滤镜同一份),开关作参数传进去。
 */
const OCCLUSION_WGSL = /* wgsl */ `
struct VfxDepth {
    uSceneSize: vec2<f32>,
    uHasDepth: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uTolerance: f32,
    uOcclusionBlend: f32,
    uHasFgCoverage: f32,
}
${FG_OCCLUSION_WGSL}
fn vfxVisibility(world: vec2<f32>, qz: f32, softQ: f32) -> f32 {
    if (vfxDepth.uHasDepth < 0.5) { return 1.0; }
    let duv = world / vfxDepth.uSceneSize;
    if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) { return 1.0; }
    var fgDepth: f32;
    let fgKind = fgSample(duv, vfxDepth.uHasFgCoverage, &fgDepth);
    if (fgKind > 1.5) { return 1.0; }
    var sceneDepth = fgDepth;
    if (fgKind < 0.5) {
        let ds = textureSampleLevel(uDepthMap, uDepthMapSampler, duv, 0.0);
        let raw = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
        var t = raw;
        if (vfxDepth.uInvert > 0.5) { t = 1.0 - raw; }
        sceneDepth = t * vfxDepth.uScale + vfxDepth.uOffset;
    }
    if (sceneDepth + vfxDepth.uTolerance < qz) { return vfxDepth.uOcclusionBlend; }
    if (softQ > 1e-6) { return clamp((sceneDepth + vfxDepth.uTolerance - qz) / softQ, 0.0, 1.0); }
    return 1.0;
}
`;

/** 测试钉遮挡段用(vfxVisibility 的前景层分支) */
export const VFX_OCCLUSION_WGSL = OCCLUSION_WGSL;

/** 显示变换(charLights 组里的 uDisp*,与背景 / 角色同一组数) */
const DISPLAY_ARGS_WGSL = 'charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite, '
  + 'charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor';

/**
 * 无光片元（两条路共用一个程序，逐视图 `uToneOn` 分）：
 *
 * - **tone**（`uToneOn = 1`）：外观要受光、但本场景 / 本时段没有照明载荷。NPC 此时走的是
 *   `EntityLightingFilter` 的**色调融入**——拿运行时从原画建的辐照 probe 做保亮度白平衡；
 *   粒子吃同一张图、同一组数、同一个式子（逐字对照那边的片元），才叫"和 NPC 一样"。
 *   受光强度 `uLightGain` 乘在这份光照因子上（同一个 [0,1] 钳位）。
 * - **unlit**（`uToneOn = 0`）：`lit:false`——自发光的萤火、按原画标定 tint 的纸钱，不染；
 *   这类视图 `uLightGain` 恒送 1（`vfxLightGain`），片元里 `!= 1.0` 那一支不进。
 *
 * ⚠ `LC` 段里的遮挡步进函数调用 `WR_CORE` 的函数：只拼 `LC` 不拼 `WR_CORE` 编译失败、整批粒子不画。
 *
 * 两条都过显示变换（与背景 / 角色同一组 `uDisp*`）：显示恒等时 `srgb → 线性 → 显示变换`
 * 逐位回到原色（所有资产 tint ≤ 1，不会被收尾的 [0,1] 钳掉），所以对今天的场景画面不变；
 * 场景一旦配了 ev / tonemap，粒子与背景同一个曝光。
 */
const FRAG_UNLIT_WGSL = /* wgsl */ `
${OCCLUSION_WGSL}
struct VfxTone {
    uToneStrength: f32,
    uKeyColor: vec3<f32>,
    uKeyIntensity: f32,
    uAmbientColor: vec3<f32>,
    uAmbientIntensity: f32,
}
struct VfxToneOn {
    uToneOn: f32,
    uLightGain: f32,
}
${CHAR_LIGHTS_WGSL}
@group(2) @binding(0) var uColorTex: texture_2d<f32>;
@group(2) @binding(1) var uColorTexSampler: sampler;
@group(2) @binding(2) var<uniform> vfxDepth: VfxDepth;
@group(2) @binding(3) var uDepthMap: texture_2d<f32>;
@group(2) @binding(4) var uDepthMapSampler: sampler;
${fgCoverageBindingsWgsl(2, 5)}@group(2) @binding(7) var<uniform> charLights: CharLights;
@group(2) @binding(8) var<uniform> vfxTone: VfxTone;
@group(2) @binding(9) var<uniform> vfxToneOn: VfxToneOn;
@group(2) @binding(10) var uProbe: texture_2d<f32>;
@group(2) @binding(11) var uProbeSampler: sampler;
${WR_CORE_WGSL}
${LC_WGSL}

@fragment
fn mainFragment(i: VfxVOut) -> @location(0) vec4<f32> {
    let c = textureSample(uColorTex, uColorTexSampler, i.vUV) * i.vColor;
    if (c.a < 0.004) { discard; }
    let vis = vfxVisibility(i.vWorld, i.vQ.z, i.vMisc.x);
    if (vis <= 0.0) { discard; }
    var rgb = c.rgb / max(c.a, 1e-4);
    // 色调融入(EntityLightingFilter 同式;粒子在哪就采哪)
    let tone = vfxToneOn.uToneOn * vfxTone.uToneStrength;
    if (tone > 1e-4) {
        let su = clamp(i.vWorld / max(vfxDepth.uSceneSize, vec2<f32>(1e-3)), vec2<f32>(0.0), vec2<f32>(1.0));
        let amb = textureSampleLevel(uProbe, uProbeSampler, su, 0.0).rgb;
        let net = amb * vfxTone.uAmbientIntensity + vfxTone.uKeyColor * (vfxTone.uKeyIntensity * 0.5);
        let l = max(dot(net, LC_LUMA), 0.04);
        let wb = clamp(net / l, vec3<f32>(0.5), vec3<f32>(1.7));
        rgb = min(rgb * mix(vec3<f32>(1.0), wb, tone) * vfxToneOn.uLightGain, vec3<f32>(1.0));
    } else if (vfxToneOn.uLightGain != 1.0) {
        // 没有色调可融时光照因子 = 1,受光强度照样乘在它上面
        rgb = min(rgb * vfxToneOn.uLightGain, vec3<f32>(1.0));
    }
    let outRgb = clamp(lcDisplayTransform(lcSrgbToLinear(rgb), ${DISPLAY_ARGS_WGSL}),
        vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(outRgb * c.a, c.a) * vis;
}
`;

/**
 * 受光片元的 uniform 结构:sceneShade / frameShade 拼角色那边导出的 `SCENE_SHADE_WGSL` / `FRAME_SHADE_WGSL`
 * (与 `createSceneLitUniforms` / `createFrameLitUniforms` 同名同序;粒子那组 frameShade 是照明系统里单独一份,
 * 结构相同),entityShade 是 `CharacterLightingSystem.createCustomLitShader` 里建的那组(比角色网格那组少
 * uBodyWidthWu,所以自己写),vfxParams 是 VfxRenderer 的逐视图参数组。
 */
const LIT_STRUCTS_WGSL = /* wgsl */ `
${SCENE_SHADE_WGSL}
${FRAME_SHADE_WGSL}
struct VfxEntityShade {
    uHasNrm: f32,
    uL2W0: vec3<f32>,
    uL2W1: vec3<f32>,
}
struct VfxParams {
    uSphere: f32,
    uEmissive: f32,
    uLightGain: f32,
    uVfxIndirectFactor: f32,
    uVfxDirectFactor: f32,
    uVfxTotalFactor: f32,
}
`;

/**
 * 受光片元。`plate` = 薄片：法线用顶点插值来的世界法线 `vNrm`（查 probe 的 nQ = Rᵀ·n，灯循环用世界 n，
 * 与角色 / 普通粒子同口径）；非薄片是"朝相机 + 球面鼓包"。
 *
 * 底光只走 probe 查表。角色那条的 uMode 0（gatherRT 体素光线步进）对粒子不可达：粒子那组 frameShade 的 uMode
 * 由 CharacterLightingSystem 钉成 1..3。把那一支拼进来不改画面，却让后端编译从约 3 秒涨到 11 秒（192×256 嵌套循环里
 * 采 3D 纹理，2026-09-16 实测），而且是在第一个受光粒子出现那一帧同步卡住主线程（`vfxPipelineSpecs.test.ts` 钉着）。
 * 镜面 / 自发光份额（appearance.emissive）不吃漫反射着色、按比例混入原色：水滴、火星这类靠镜面才看得见的材质用它
 * ——漫反射路径没有镜面瓣，只用它画出来是黑疙瘩。
 *
 * 绑定号 = `createCustomLitShader` 的 resources 顺序(sceneShade … uSkyaoTex)
 * 接 VfxRenderer 给的 extra(vfxDepth / uDepthMap / uFgCoverage / vfxParams),三个采样器插在各自纹理后面。
 * 片元阶段绑定数(WebGPU 默认上限 16 张取样纹理 / 16 个采样器 / 12 个 uniform 缓冲;luma 按 WGSL 声明建布局、
 * 可见性全阶段,声明了没读的也算;vfxWgsl.test 钉着):纹理 12 张、采样器 3 个、uniform 缓冲 8 个(含组 0 / 1)。
 * uNrm / uGround / uVolRad / uVolEmit 粒子不读(声明着、不参与计算),但资源键在,所以要有同名绑定。
 */
function fragLitWgsl(plate: boolean): string {
  const normal = plate
    ? /* wgsl */ `    // ---- 法线:薄片自己的世界法线(CPU 已翻到朝相机那一面);probe 查表用 nQ = Rᵀ·n
    let n = normalize(i.vNrm);
    let nQ = normalize(charLights.uSMRow0 * n.x + charLights.uSMRow1 * n.y + charLights.uSMRow2 * n.z);`
    : /* wgsl */ `    // ---- 法线:q 空间朝相机 + 球面鼓包;世界法线 = R·nQ(灯循环世界对世界)
    let sl = vec2<f32>(i.vLocal.x - 0.5, 0.5 - i.vLocal.y) * 2.0;
    let nQ = normalize(vec3<f32>(sl.x * vfxParams.uSphere, sl.y * vfxParams.uSphere, -1.0));
    let n = normalize(wrQToWorld(charLights.uSMRow0, charLights.uSMRow1, charLights.uSMRow2, nQ));`;
  return /* wgsl */ `
${OCCLUSION_WGSL}
${LIT_STRUCTS_WGSL}
${CHAR_LIGHTS_WGSL}
@group(2) @binding(0) var<uniform> sceneShade: SceneShade;
@group(2) @binding(1) var<uniform> frameShade: FrameShade;
@group(2) @binding(2) var<uniform> charLights: CharLights;
@group(2) @binding(3) var<uniform> entityShade: VfxEntityShade;
@group(2) @binding(4) var uColorTex: texture_2d<f32>;
@group(2) @binding(5) var uColorTexSampler: sampler;
@group(2) @binding(6) var uNrm: texture_2d<f32>;
@group(2) @binding(7) var uGround: texture_2d<f32>;
@group(2) @binding(8) var uPL1: texture_2d<f32>;
@group(2) @binding(9) var uPL2: texture_2d<f32>;
@group(2) @binding(10) var uPBin: texture_2d<f32>;
@group(2) @binding(11) var uValid: texture_2d<f32>;
@group(2) @binding(12) var uVolRad: texture_2d<f32>;
@group(2) @binding(13) var uVolEmit: texture_2d<f32>;
@group(2) @binding(14) var uSkyaoTex: texture_2d<f32>;
@group(2) @binding(15) var<uniform> vfxDepth: VfxDepth;
@group(2) @binding(16) var uDepthMap: texture_2d<f32>;
@group(2) @binding(17) var uDepthMapSampler: sampler;
${fgCoverageBindingsWgsl(2, 18)}@group(2) @binding(20) var<uniform> vfxParams: VfxParams;
${CHAR_LIGHT_COMMON_WGSL}
${WR_CORE_WGSL}
${LC_WGSL}
${ENTITY_SCENE_LIGHTS_WGSL}

@fragment
fn mainFragment(i: VfxVOut) -> @location(0) vec4<f32> {
    let c = textureSample(uColorTex, uColorTexSampler, i.vUV) * i.vColor;
    if (c.a < 0.004) { discard; }
    let vis = vfxVisibility(i.vWorld, i.vQ.z, i.vMisc.x);
    if (vis <= 0.0) { discard; }

${normal}

    let q = i.vQ;
    // 底光只走 probe 查表(uMode 0 的 gatherRT 对粒子不可达,不调;理由见 fragLitWgsl 头注释)。
    // 公共块不读绑定:probe / skyao 的 uniform 按字段名逐个赋进值结构。
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
    var E = probeE(q, nQ, pp, uPL1, uPL2, uPBin, uValid);
    var sk: ClcSkyao;
    sk.uSkyaoN = sceneShade.uSkyaoN;
    sk.uSkyaoTiles = sceneShade.uSkyaoTiles;
    sk.uSkyaoMin = sceneShade.uSkyaoMin;
    sk.uSkyaoScale = sceneShade.uSkyaoScale;
    sk.uSkyaoM = sceneShade.uSkyaoM;
    sk.uSkyaoOn = sceneShade.uSkyaoOn;
    E *= mix(1.0, skyaoAt(q, nQ, sk, uSkyaoTex), clamp(frameShade.uSkyaoBlend, 0.0, 1.0));

    // 实体灯:与角色同一段循环(ENTITY_SCENE_LIGHTS_WGSL),同一次 packLights 的数
    let directE = entitySceneLightsE(q, n);
    // 受光强度乘在收到的全部光上(probe 底光 + 实体灯),着色之前;自发光份额不乘它
    let alb = c.rgb / max(c.a, 1e-4);
    var litLin = shadeEntityLinear(alb, E, directE, vfxParams.uVfxIndirectFactor, vfxParams.uVfxDirectFactor,
        vfxParams.uVfxTotalFactor * vfxParams.uLightGain, frameShade.uEChroma);
    // 镜面 / 自发光份额按比例混入原色(线性);逐顶点自发光(燃着的纸那道火线)与发射器份额取大
    litLin = mix(litLin, srgb2lin(alb), clamp(max(vfxParams.uEmissive, i.vMisc.y), 0.0, 1.0));
    let outRgb = clamp(lcDisplayTransform(litLin, ${DISPLAY_ARGS_WGSL}), vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(outRgb * c.a, c.a) * vis;
}
`;
}

/**
 * 雷（`appearance.bolt`）：一张 quad = 一小段折线的一层光斑（芯 / 光晕 / 外晕），片元里算这段线与高斯光斑的
 * 卷积（`BOLT_WGSL_KERNEL`），加法混合——整条折线的卷积 = 各段之和，接缝不断不叠。
 * 逐顶点带 q（雷身直立面上那一点的伪世界深度，插值后逐片元比壳：前面的屋顶挡住它，后面的不挡）。
 * 雷是光源，不吃灯、不过显示变换（曝光不该把闪电压暗），直接加到画面上。
 */
const BOLT_WGSL = /* wgsl */ `
${VFX_MESH_GLOBALS_WGSL}
struct VfxBoltVOut {
    @builtin(position) position: vec4<f32>,
    @location(0) vWorld: vec2<f32>,
    @location(1) vSeg: vec4<f32>,
    @location(2) vK: vec2<f32>,
    @location(3) vColor: vec4<f32>,
    @location(4) vQ: vec3<f32>,
}

@vertex
fn mainVertex(
    @location(0) aPosition: vec2<f32>,
    @location(1) aSeg: vec4<f32>,
    @location(2) aK: vec2<f32>,
    @location(3) aColor: vec4<f32>,
    @location(4) aQ: vec3<f32>,
) -> VfxBoltVOut {
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
    var o: VfxBoltVOut;
    o.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
    o.vWorld = aPosition;
    o.vSeg = aSeg;
    o.vK = aK;
    o.vColor = aColor * localUniforms.uColor;
    o.vQ = aQ;
    return o;
}

${OCCLUSION_WGSL}
@group(2) @binding(0) var<uniform> vfxDepth: VfxDepth;
@group(2) @binding(1) var uDepthMap: texture_2d<f32>;
@group(2) @binding(2) var uDepthMapSampler: sampler;
${fgCoverageBindingsWgsl(2, 3)}${BOLT_WGSL_KERNEL}

@fragment
fn mainFragment(i: VfxBoltVOut) -> @location(0) vec4<f32> {
    let k = boltSeg(i.vWorld, i.vSeg.xy, i.vSeg.zw, i.vK.x) * i.vK.y;
    if (k < 1e-4) { discard; }
    let vis = vfxVisibility(i.vWorld, i.vQ.z, 0.0);
    if (vis <= 0.0) { discard; }
    let rgb = min(i.vColor.rgb * k, vec3<f32>(1.0)) * vis;
    return vec4<f32>(rgb, clamp(i.vColor.a * k, 0.0, 1.0) * vis);
}
`;

/** 测试 / 对照用:四个粒子 WGSL 模块的整段源码(顶点 + 片元同一模块) */
export const VFX_WGSL_SOURCES = {
  unlit: vertWgsl(false) + FRAG_UNLIT_WGSL,
  lit: vertWgsl(false) + fragLitWgsl(false),
  plateLit: vertWgsl(true) + fragLitWgsl(true),
  bolt: BOLT_WGSL,
} as const;

function gpuProgramOf(source: string): GpuProgram {
  return new GpuProgram({
    vertex: { source, entryPoint: 'mainVertex' },
    fragment: { source, entryPoint: 'mainFragment' },
  });
}

let unlitGpuProgram: GpuProgram | null = null;
let litGpuProgram: GpuProgram | null = null;
let plateLitGpuProgram: GpuProgram | null = null;
let boltGpuProgram: GpuProgram | null = null;

/** 无光 / tone 程序 */
export function getVfxUnlitGpuProgram(): GpuProgram {
  if (!unlitGpuProgram) unlitGpuProgram = gpuProgramOf(VFX_WGSL_SOURCES.unlit);
  return unlitGpuProgram;
}

/** 受光程序 */
export function getVfxLitGpuProgram(): GpuProgram {
  if (!litGpuProgram) litGpuProgram = gpuProgramOf(VFX_WGSL_SOURCES.lit);
  return litGpuProgram;
}

/**
 * 薄片（纸钱）的受光程序：声明了 `aNrm`，**只能**配 `VfxPlateBatchMesh`。
 * 无光的薄片直接用 {@link getVfxUnlitGpuProgram}（多出来的 `aNrm` 顶点流不读）。
 */
export function getVfxPlateLitGpuProgram(): GpuProgram {
  if (!plateLitGpuProgram) plateLitGpuProgram = gpuProgramOf(VFX_WGSL_SOURCES.plateLit);
  return plateLitGpuProgram;
}

/** 雷的程序 */
export function getVfxBoltGpuProgram(): GpuProgram {
  if (!boltGpuProgram) boltGpuProgram = gpuProgramOf(VFX_WGSL_SOURCES.bolt);
  return boltGpuProgram;
}

