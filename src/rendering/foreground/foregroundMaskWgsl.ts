/**
 * 场景前景图层的着色片段(游戏只画 WGSL):覆盖图程序(蒙版判定 + 覆盖图顶点 / 片元)与遮挡使用方共用的取样段。
 * 覆盖图的通道、语义见 `foregroundMaskGlsl.ts` 的头注释;取样段 `fgSample` 在那里还有一份 GLSL 版(只剩角色逐像素
 * 照明滤镜的 GLSL 程序在拼),两份由 `shaderTwins.test.ts` 钉着函数集合与字面量顺序。数值与 master 的 GLSL 版逐像素一致
 * 由 tools/render_parity 的前景层用例钉住。
 *
 * 写法上的约束(都不改数值):
 * - WGSL 没有 out 参数:`fgSample` 的深度走 `ptr<function, f32>`;开关 `uHasFgCoverage` 在宿主各自的
 *   参数结构体里,这里作为参数传进来(`fgSample(uv, 宿主.uHasFgCoverage, &d)`)。
 * - 分支里取样一律 `textureSampleLevel(.., 0.0)`(WGSL 只许在一致控制流里 textureSample;覆盖图 / 位移图 / id /
 *   matte 都没有 mip)。
 * - 覆盖图片元的接地采样 `uBase` 是 vec2 数组:WGSL 的 uniform 数组要 16 字节跨度,声明成 vec4 数组再按奇偶拆
 *   (JS 端 UniformGroup 按 8 字节跨度紧排,与这里的 vec4 逐字节相同);它必须排在参数组**第一个**,
 *   否则 JS 端按 8 对齐、WGSL 端按 16 对齐,偏移对不上。
 * ⚠ 本文件的字符串会拼进 TS 模板字符串:注释里不许出现反引号。
 */
import { FG_BASE_SAMPLES } from './foregroundLayerDefs';

/**
 * 遮挡消费方共用的取样(深度遮挡滤镜三支、粒子)。宿主在模块作用域声明 `uFgCoverage: texture_2d<f32>` 与
 * `uFgCoverageSampler: sampler`,参数结构体里带 `uHasFgCoverage: f32`。
 *
 * 返回 0 = 不在前景层里(照旧用深度图);1 = 前景面(深度写进 outDepth,拿它顶替深度图比);2 = 外沿(不判遮挡)。
 */
export const FG_OCCLUSION_WGSL = /* wgsl */ `
fn fgSample(uv: vec2<f32>, hasCoverage: f32, outDepth: ptr<function, f32>) -> f32 {
    *outDepth = 0.0;
    if (hasCoverage < 0.5) { return 0.0; }
    let s = textureSampleLevel(uFgCoverage, uFgCoverageSampler, uv, 0.0);
    if (s.r <= 0.5) { return 0.0; }
    if (s.b > 0.5) {
        *outDepth = s.g / max(s.r, 1e-4);
        return 1.0;
    }
    return 2.0;
}
`;

/** 宿主绑定组里前景覆盖图的两条声明(组号 / 起始绑定号由宿主定) */
export function fgCoverageBindingsWgsl(group: number, binding: number): string {
  return `@group(${group}) @binding(${binding}) var uFgCoverage: texture_2d<f32>;\n`
    + `@group(${group}) @binding(${binding + 1}) var uFgCoverageSampler: sampler;\n`;
}

/**
 * 覆盖图程序的参数结构体(成员顺序 = `SwayBackground.createForegroundMask` 里 fgMaskU 的声明顺序,uBase 必须第一个)。
 * 结构体里不写注释:按正则解析成员。
 */
const FG_MASK_U_WGSL = /* wgsl */ `
struct FgMaskU {
    uBase: array<vec4<f32>, ${FG_BASE_SAMPLES / 2}>,
    uSceneSize: vec2<f32>,
    uTargetSize: vec2<f32>,
    uFgInst: f32,
    uDilate: vec2<f32>,
    uTexelHalf: vec2<f32>,
    uBaseX: vec2<f32>,
    uUpright: f32,
}
`;

/**
 * 蒙版判定:读模块作用域的 uUvMap / uIds(最近邻)/ uMatte 与 fgMaskU.uFgInst(实例 id)。
 * 位移图覆盖度太小时 rg / a 数值上不稳;那里的植物本来也只剩一丝,前景层不要它(m.a < 0.02 直接 0)。
 */
export const FG_MASK_WGSL = /* wgsl */ `
fn fgMaskAt(uv: vec2<f32>) -> f32 {
    let m = textureSampleLevel(uUvMap, uUvMapSampler, uv, 0.0);
    if (m.a < 0.02) { return 0.0; }
    let src = uv + m.rg / m.a;
    let idc = textureSampleLevel(uIds, uIdsSampler, src, 0.0);
    let id = floor(idc.r * 255.0 + 0.5) + 256.0 * floor(idc.g * 255.0 + 0.5);
    if (abs(id - fgMaskU.uFgInst) > 0.5) { return 0.0; }
    return textureSampleLevel(uMatte, uMatteSampler, src, 0.0).r * clamp(m.a, 0.0, 1.0);
}
`;

/**
 * 覆盖图程序(顶点 + 片元)。`meshUniforms` = 宿主的网格约定(组 0 globalUniforms、组 1 localUniforms,
 * 见 backgroundSway 的 WGSL_MESH_UNIFORMS);自己的资源在组 2。
 *
 * - 顶点:网格顶点是场景坐标,按目标 RT 尺寸缩放(与位移图同一个做法,不靠容器变换);uv 取网格自带的那一份
 *   (= 场景归一化);aUV 必须声明(几何体的每个属性都要在顶点输入里有)。
 * - 片元:B(前景面)= 本点 + 四个 ±半纹素的对角点取最大——覆盖图一个纹素 4 原画像素宽,只取纹素中心的话两三像素宽的
 *   细枝会整根漏掉,细长前景正是这套东西要补的;R(外沿)= B 与四个 ±uDilate 对角点取最大(覆盖 ±膨胀量的方框)。
 *   提前结束:使用方只判"过不过半",深度按 G / R 解、与 R 的确切值无关——已经过半就不再多取点
 *   (2026-09-27 实测:固定取满 9 点,跑马梁那棵树覆盖图 GPU 0.29 ms)。
 * - 前景面深度 fgSurfaceDepth:按 x 在接地采样里线性插值出 (接地 y, 接地深度),再立成直立面。
 */
export function fgCoverageProgramWgsl(meshUniforms: string): string {
  return meshUniforms + FG_MASK_U_WGSL + /* wgsl */ `
@group(2) @binding(0) var uUvMap: texture_2d<f32>;
@group(2) @binding(1) var uUvMapSampler: sampler;
@group(2) @binding(2) var uIds: texture_2d<f32>;
@group(2) @binding(3) var uIdsSampler: sampler;
@group(2) @binding(4) var uMatte: texture_2d<f32>;
@group(2) @binding(5) var uMatteSampler: sampler;
@group(2) @binding(6) var<uniform> fgMaskU: FgMaskU;
` + FG_MASK_WGSL + /* wgsl */ `
fn fgBaseAt(i: i32) -> vec2<f32> {
    let v = fgMaskU.uBase[i / 2];
    if ((i & 1) == 0) { return v.xy; }
    return v.zw;
}

fn fgSurfaceDepth(p: vec2<f32>) -> f32 {
    let t = clamp((p.x - fgMaskU.uBaseX.x) / max(fgMaskU.uBaseX.y - fgMaskU.uBaseX.x, 1e-3), 0.0, 1.0) * f32(${FG_BASE_SAMPLES - 1});
    let i = min(i32(floor(t)), ${FG_BASE_SAMPLES - 2});
    let b = mix(fgBaseAt(i), fgBaseAt(i + 1), t - f32(i));
    return b.y + fgMaskU.uUpright * (p.y - b.x);
}

struct FgVSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUv: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> FgVSOutput {
    var o: FgVSOutput;
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let rt = aPosition * (fgMaskU.uTargetSize / fgMaskU.uSceneSize);
    let screen = (model * vec3<f32>(rt, 1.0)).xy;
    o.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
    o.vUv = aUV;
    return o;
}

@fragment
fn mainFragment(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {
    let h = fgMaskU.uTexelHalf;
    var body = fgMaskAt(vUv);
    if (body < 0.5) {
        body = max(body, fgMaskAt(vUv + h));
        body = max(body, fgMaskAt(vUv - h));
        body = max(body, fgMaskAt(vUv + vec2<f32>(h.x, -h.y)));
        body = max(body, fgMaskAt(vUv + vec2<f32>(-h.x, h.y)));
    }
    var rim = body;
    if (rim < 0.5) {
        let d = fgMaskU.uDilate;
        rim = max(rim, fgMaskAt(vUv + d));
        rim = max(rim, fgMaskAt(vUv - d));
        rim = max(rim, fgMaskAt(vUv + vec2<f32>(d.x, -d.y)));
        rim = max(rim, fgMaskAt(vUv + vec2<f32>(-d.x, d.y)));
    }
    if (rim < 0.004) { discard; }
    return vec4<f32>(rim, rim * fgSurfaceDepth(vUv * fgMaskU.uSceneSize), body, rim);
}
`;
}
