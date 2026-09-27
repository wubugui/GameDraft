/**
 * 场景前景图层的 WGSL 片段:{@link ./foregroundMaskGlsl} 的逐式孪生(游戏只画 WGSL;GLSL 那份留给工作台,
 * 两份要一起改,`shaderTwins.test.ts` 钉着函数集合、字面量顺序与结构体字段)。通道、语义见 GLSL 那份的头注释。
 *
 * 与 GLSL 的写法差异(都不改数值):
 * - WGSL 没有 out 参数:`fgSample` 的深度走 `ptr<function, f32>`;GLSL 的 uniform `uHasFgCoverage` 在宿主各自的
 *   参数结构体里,这里作为参数传进来(`fgSample(uv, 宿主.uHasFgCoverage, &d)`)。
 * - 分支里取样一律 `textureSampleLevel(.., 0.0)`(WGSL 只许在一致控制流里 textureSample;覆盖图 / 位移图 / id /
 *   matte 都没有 mip,与 GLSL 的隐式 LOD 等价)。
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

/** {@link ./foregroundMaskGlsl.FG_MASK_GLSL} 的 WGSL 版:读模块作用域的 uUvMap / uIds / uMatte 与 fgMaskU.uFgInst */
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
