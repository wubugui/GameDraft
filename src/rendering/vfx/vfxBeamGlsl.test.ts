/**
 * 光柱着色的机械护栏（不经 GPU）：
 * - WGSL 结构 `VfxBeamUniforms` 的成员 ⇔ 打包数值表的键 ⇔ `VfxBeamView` uniform 组的键，三处逐字相同
 *   （少一个 = 那一项在 GPU 上恒 0 且不报错）；
 * - 游戏的光柱模块拼上了核心、三样宿主函数都在；
 * - 亮度乘在显示空间（与粒子"显示颜色 × alpha"同一个约定）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBeamUniformValues } from './vfxBeamGlsl';
import { VFX_BEAM_WGSL_SOURCE } from './vfxBeamShaders';
import { BEAM_WGSL_CORE, BEAM_WGSL_UNIFORMS } from './vfxBeamWgsl';

const declared = [...(/struct VfxBeamUniforms \{([^}]*)\}/.exec(BEAM_WGSL_UNIFORMS)?.[1] ?? '').matchAll(/(uBeam\w+)\s*:/g)]
  .map((m) => m[1]).sort();

describe('光柱着色接线', () => {
  it('WGSL 结构成员 == 打包数值表的键', () => {
    expect(declared.length).toBeGreaterThan(20);
    expect(Object.keys(createBeamUniformValues()).sort()).toEqual(declared);
  });

  it('VfxBeamView 的 uniform 组的键 == WGSL 结构成员', () => {
    const src = readFileSync(resolve(__dirname, 'VfxBeamView.ts'), 'utf8');
    const block = src.slice(src.indexOf('this.beamGroup = new UniformGroup({'), src.indexOf('this.depthGroup = new UniformGroup'));
    const keys = [...block.matchAll(/^\s+(uBeam\w+):/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(declared);
  });

  it('核心读到的 uniform 都在结构里', () => {
    const used = new Set([...BEAM_WGSL_CORE.matchAll(/\bvfxBeam\.(uBeam\w+)\b/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const u of used) expect(declared).toContain(u);
  });

  it('游戏的光柱模块：核心 + 宿主函数齐；亮度乘在显示空间、叠加扣 DT(0)', () => {
    const f = VFX_BEAM_WGSL_SOURCE;
    expect(f).toContain('fn bmEval(');
    expect(f).toContain('fn bmSceneDepth(world: vec2<f32>) -> f32');
    expect(f).toContain('fn bmToLinear(c: vec3<f32>) -> vec3<f32>');
    expect(f).toContain('var uBeamCookie: texture_2d<f32>;');
    expect(f).toContain('var uBeamCookieSampler: sampler;');
    // 亮度乘在显示空间（与粒子 alpha 同约定）
    expect(f).toContain('o = vec4<f32>(col * r.a, 0.0);');
  });
});
