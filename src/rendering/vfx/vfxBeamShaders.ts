/**
 * 光柱的 Pixi 程序：顶点 = 画面包络（场景坐标），片元 = `vfxBeamGlsl.ts` 的核心 + 本游戏的三样宿主函数。
 *
 * - 原画深度解码与粒子同一条 `depth_mapping`（RG16 + invert/scale/offset）、同一个 `depth_tolerance`；
 * - sRGB → 线性走 `lcSrgbToLinear`（与粒子同一条解码路径）；
 * - 显示变换与背景 / 角色 / 粒子**同一组** `uDisp*`，作用在光柱颜色上；亮度乘在显示空间里
 *   （与粒子 `显示颜色 × alpha` 同一个约定——线性亮度过 sRGB 编码会把暗部放大，软边看着是硬边）。
 *
 * 混合（`uBeamBlend`，Pixi 的 blendMode 同步设）：add = ONE, ONE；screen = ONE, ONE_MINUS_SRC_COLOR；
 * normal = 预乘 over（亮度当不透明度，钳到 1）。亮度为 0 的像素输出 0，包络边上不会被显示变换的 lift 抬亮。
 *
 * WebGPU 迁移期另有一份同一资源布局的 WGSL 程序（`getVfxBeamGpuProgram`，核心的 WGSL 孪生在 `vfxBeamWgsl.ts`），
 * 等价由 `tools/render_parity` 的「粒子 / 光柱」用例钉住。
 *
 * ⚠ 实际编译目标见 pixi-v8-traps：不用数组构造式；模板字符串里不许出现反引号。
 */
import { GlProgram, GpuProgram } from 'pixi.js';

import { CHAR_LIGHTS_WGSL } from '../CharacterLitSprite';
import { LC_WGSL, WR_CORE_WGSL } from '../lighting/wgslChunks';
import { BEAM_GLSL_CORE, BEAM_GLSL_UNIFORMS } from './vfxBeamGlsl';
import { BEAM_WGSL_CORE, BEAM_WGSL_UNIFORMS } from './vfxBeamWgsl';
import { LC, VFX_MESH_GLOBALS_WGSL, WR_CORE } from './vfxShaders';

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;   // 场景坐标 wu（网格挂在 entityLayer 下，容器变换 = 相机）
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vWorld;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vWorld = aPosition;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vWorld;
out vec4 finalColor;
uniform vec4 uColor;

uniform sampler2D uDepthMap;
uniform vec2  uSceneSize;
uniform float uHasDepth;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uTolerance;
uniform sampler2D uBeamCookie;

uniform float uDispEv;
uniform int   uDispTonemap;
uniform vec3  uDispWhite;
uniform float uDispSaturation;
uniform float uDispContrast;
uniform float uDispLift;
uniform vec3  uDispLiftColor;
${BEAM_GLSL_UNIFORMS}
${WR_CORE}
${LC}

// 宿主：原画深度（q.z，已加容差），与粒子 vfxVisibility 同一条解码
float bmSceneDepth(vec2 world) {
    if (uHasDepth < 0.5) return 1e20;
    vec2 duv = world / uSceneSize;
    if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) return 1e20;
    vec4 ds = texture(uDepthMap, duv);
    float raw = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
    float t = uInvert > 0.5 ? 1.0 - raw : raw;
    return t * uScale + uOffset + uTolerance;
}

vec3 bmToLinear(vec3 c) {
    return lcSrgbToLinear(c);
}

vec3 bmDisplay(vec3 lin) {
    return lcDisplayTransform(lin, uDispEv, uDispTonemap, uDispWhite,
        uDispSaturation, uDispContrast, uDispLift, uDispLiftColor);
}
${BEAM_GLSL_CORE}

void main(void) {
    vec4 r = bmEval(vWorld);
    if (r.a <= 0.0) { discard; }
    vec3 col = clamp(bmDisplay(r.rgb), 0.0, 1.0);
    if (uBeamBlend == 2) {
        float a = clamp(r.a, 0.0, 1.0);
        finalColor = vec4(col * a, a);
    } else {
        finalColor = vec4(col * r.a, 0.0);
    }
    // Pixi 实例 alpha 在显示变换与 normal 饱和之后乘，整根退场不改变颜色/亮度算法。
    finalColor *= uColor.a;
}
`;

let program: GlProgram | null = null;

export function getVfxBeamProgram(): GlProgram {
  if (!program) program = new GlProgram({ vertex: VERT, fragment: FRAG });
  return program;
}

/** 测试用：拼好的片元源码（不经 GL） */
export const VFX_BEAM_FRAGMENT_SOURCE = FRAG;

// ───────────────────────────── WGSL（WebGPU 路径；上面的 GLSL 一个字不动，WebGL 仍跑它）
//
// 顶点 + 片元同一模块。组 0 / 1 = Pixi 网格约定；自有资源全在组 2，绑定号按 `VfxBeamView` 原 resources 的相对顺序
// （vfxBeam、vfxDepth、uDepthMap、uBeamCookie、charLights），两张纹理各配「纹理名 + Sampler」——WebGL 按组号、
// 绑定号升序分纹理单元，这样与移植前一致。核心在 `vfxBeamWgsl.ts`（读模块作用域的 vfxBeam 绑定）；
// charLights 这里只用显示变换那几项，但绑定的是整组，所以拼整份 CharLights 结构（成员同名同序）。
// 结构体里不写注释、注释里不写「at 号 + group / binding + 括号」：Pixi 用正则解析 WGSL。

/** 光柱 WGSL 模块（深度组 VfxBeamDepth = `VfxBeamView.depthGroup` 的声明顺序，比粒子那组少 uOcclusionBlend） */
const BEAM_WGSL = /* wgsl */ `
${VFX_MESH_GLOBALS_WGSL}
struct VfxBeamVOut {
    @builtin(position) position: vec4<f32>,
    @location(0) vWorld: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VfxBeamVOut {
    let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
    var o: VfxBeamVOut;
    o.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
    o.vWorld = aPosition;
    return o;
}

${BEAM_WGSL_UNIFORMS}
struct VfxBeamDepth {
    uSceneSize: vec2<f32>,
    uHasDepth: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uTolerance: f32,
}
${CHAR_LIGHTS_WGSL}
@group(2) @binding(0) var<uniform> vfxBeam: VfxBeamUniforms;
@group(2) @binding(1) var<uniform> vfxDepth: VfxBeamDepth;
@group(2) @binding(2) var uDepthMap: texture_2d<f32>;
@group(2) @binding(3) var uDepthMapSampler: sampler;
@group(2) @binding(4) var uBeamCookie: texture_2d<f32>;
@group(2) @binding(5) var uBeamCookieSampler: sampler;
@group(2) @binding(6) var<uniform> charLights: CharLights;
${WR_CORE_WGSL}
${LC_WGSL}

// 宿主：原画深度（q.z，已加容差），与粒子 vfxVisibility 同一条解码
fn bmSceneDepth(world: vec2<f32>) -> f32 {
    if (vfxDepth.uHasDepth < 0.5) { return 1e20; }
    let duv = world / vfxDepth.uSceneSize;
    if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) { return 1e20; }
    let ds = textureSampleLevel(uDepthMap, uDepthMapSampler, duv, 0.0);
    let raw = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
    var t = raw;
    if (vfxDepth.uInvert > 0.5) { t = 1.0 - raw; }
    return t * vfxDepth.uScale + vfxDepth.uOffset + vfxDepth.uTolerance;
}

fn bmToLinear(c: vec3<f32>) -> vec3<f32> {
    return lcSrgbToLinear(c);
}

fn bmDisplay(lin: vec3<f32>) -> vec3<f32> {
    return lcDisplayTransform(lin, charLights.uDispEv, charLights.uDispTonemap, charLights.uDispWhite,
        charLights.uDispSaturation, charLights.uDispContrast, charLights.uDispLift, charLights.uDispLiftColor);
}
${BEAM_WGSL_CORE}

@fragment
fn mainFragment(i: VfxBeamVOut) -> @location(0) vec4<f32> {
    let r = bmEval(i.vWorld);
    if (r.a <= 0.0) { discard; }
    let col = clamp(bmDisplay(r.rgb), vec3<f32>(0.0), vec3<f32>(1.0));
    var o: vec4<f32>;
    if (vfxBeam.uBeamBlend == 2) {
        let a = clamp(r.a, 0.0, 1.0);
        o = vec4<f32>(col * a, a);
    } else {
        o = vec4<f32>(col * r.a, 0.0);
    }
    // Pixi 实例 alpha 在显示变换与 normal 饱和之后乘，整根退场不改变颜色/亮度算法。
    return o * localUniforms.uColor.a;
}
`;

/** 测试 / 对照用：光柱 WGSL 模块整段源码 */
export const VFX_BEAM_WGSL_SOURCE = BEAM_WGSL;

let gpuProgram: GpuProgram | null = null;

/** {@link getVfxBeamProgram} 的 WGSL 孪生（同一套资源布局） */
export function getVfxBeamGpuProgram(): GpuProgram {
  if (!gpuProgram) {
    gpuProgram = new GpuProgram({
      vertex: { source: BEAM_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: BEAM_WGSL, entryPoint: 'mainFragment' },
    });
  }
  return gpuProgram;
}
