/**
 * 光柱着色的机械护栏（不经 GL）：
 * - GLSL 里声明的 `uBeam*` uniform ⇔ 打包数值表的键 ⇔ Pixi uniform 组的键，三处逐字相同
 *   （少一个 = 那一项在 GPU 上恒 0 且不报错）；
 * - 游戏片元源码拼上了核心、三样宿主函数都在、没有反引号（pixi-v8-traps）；
 * - 亮度乘在显示空间（与粒子"显示颜色 × alpha"同一个约定）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BEAM_GLSL_CORE, BEAM_GLSL_UNIFORMS, createBeamUniformValues } from './vfxBeamGlsl';
import { VFX_BEAM_FRAGMENT_SOURCE } from './vfxBeamShaders';

const declared = [...BEAM_GLSL_UNIFORMS.matchAll(/uniform\s+\w+\s+(uBeam\w+)/g)].map((m) => m[1]).sort();

describe('光柱 GLSL 接线', () => {
  it('GLSL 声明的 uniform == 打包数值表的键', () => {
    expect(Object.keys(createBeamUniformValues()).sort()).toEqual(declared);
  });

  it('Pixi uniform 组的键 == GLSL 声明的 uniform', () => {
    const src = readFileSync(resolve(__dirname, 'VfxBeamView.ts'), 'utf8');
    const block = src.slice(src.indexOf('this.beamGroup = new UniformGroup({'), src.indexOf('this.depthGroup = new UniformGroup'));
    const keys = [...block.matchAll(/^\s+(uBeam\w+):/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(declared);
  });

  it('核心用到的 uniform 都声明了', () => {
    const used = new Set([...BEAM_GLSL_CORE.matchAll(/\b(uBeam\w+)\b/g)].map((m) => m[1]));
    used.delete('uBeamCookie'); // 采样器由宿主声明
    for (const u of used) expect(declared).toContain(u);
  });

  it('游戏片元：核心 + 宿主函数齐、无反引号、叠加扣 DT(0)', () => {
    const f = VFX_BEAM_FRAGMENT_SOURCE;
    expect(f).toContain('vec4 bmEval(vec2 s)');
    expect(f).toContain('float bmSceneDepth(vec2 world)');
    expect(f).toContain('vec3 bmToLinear(vec3 c)');
    expect(f).toContain('uniform sampler2D uBeamCookie;');
    expect(f.indexOf('float bmSceneDepth')).toBeLessThan(f.indexOf('vec4 bmEval3d'));
    // 反引号只查本模块自己写的模板（拼进来的 .glsl 原文不受模板字符串限制）
    expect(BEAM_GLSL_CORE).not.toContain('`');
    expect(BEAM_GLSL_UNIFORMS).not.toContain('`');
    // 亮度乘在显示空间（与粒子 alpha 同约定）
    expect(f).toContain('finalColor = vec4(col * r.a, 0.0)');
  });
});
