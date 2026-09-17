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
 * ⚠ 实际编译目标见 pixi-v8-traps：不用数组构造式；模板字符串里不许出现反引号。
 */
import { GlProgram } from 'pixi.js';

import { BEAM_GLSL_CORE, BEAM_GLSL_UNIFORMS } from './vfxBeamGlsl';
import { LC, WR_CORE } from './vfxShaders';

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
}
`;

let program: GlProgram | null = null;

export function getVfxBeamProgram(): GlProgram {
  if (!program) program = new GlProgram({ vertex: VERT, fragment: FRAG });
  return program;
}

/** 测试用：拼好的片元源码（不经 GL） */
export const VFX_BEAM_FRAGMENT_SOURCE = FRAG;
