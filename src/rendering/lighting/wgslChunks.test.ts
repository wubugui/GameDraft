/**
 * 共享光照片段(WGSL)的**结构闸**(不需要 GPU)。
 *
 * 数值与 master(GLSL 版)一致由 tools/render_parity 的「光照片段 /」用例逐像素证明(要真浏览器);这里钉的是
 * 不跑 GPU 也能抓的那一类:宿主拼接要靠的切片 / 常量 / 布局对不上。
 *
 * - 切片标记齐全、每段都非空,着色核心已注入公共块;
 * - LC_* 光源编码与 lightPacking.LIGHT_KIND_CODE 同值;
 * - `CharLights` 结构与 `createCharLightUniforms` 的声明逐项同名、同类型、同顺序
 *   (Pixi 按 JS 声明顺序排 uniform 缓冲,错位不报错);
 * - 片段里不许有会被 Pixi 正则误当成绑定 / struct 成员的写法,不许有只能在一致控制流里调的
 *   textureSample(片段函数会被宿主从分支 / 循环里调用)。
 * (WR_CONTRACT 与 CPU 镜像的一致由 src/utils/worldReconstruct.test.ts 钉。)
 */
import { describe, expect, it } from 'vitest';
import type { UniformGroup } from '../../engine2d';

import LC_WGSL_SRC from './lightingCore.wgsl?raw';
import WR_WGSL_SRC from './worldReconstruct.wgsl?raw';
import { LC_WGSL, sliceWgsl, WR_CORE_WGSL, WR_SPRITE_WGSL, WR_TEX_WGSL } from './wgslChunks';
import { LIGHT_KIND_CODE, MAX_STATIC_LIGHTS } from './lightPacking';
import { CHAR_LIGHT_COMMON_WGSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_WGSL } from '../CharacterShadingFilter';
import { CHAR_LIGHTS_WGSL, createCharLightUniforms, ENTITY_SCENE_LIGHTS_WGSL } from '../CharacterLitSprite';

/** 去掉 // 与 /* *\/ 注释（函数名 / 结构只看代码） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function wgslFunctions(src: string): string[] {
  return [...stripComments(src).matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]).sort();
}

/** 会被拼进宿主着色器的全部 WGSL 片段（整份文件也算：宿主可以整份拼） */
const WGSL_CHUNKS: ReadonlyArray<readonly [string, string]> = [
  ['lightingCore.wgsl', LC_WGSL_SRC],
  ['worldReconstruct.wgsl', WR_WGSL_SRC],
  ['CHAR_LIGHT_COMMON_WGSL', CHAR_LIGHT_COMMON_WGSL],
  ['CHAR_LIGHTS_WGSL', CHAR_LIGHTS_WGSL],
  ['ENTITY_SCENE_LIGHTS_WGSL', ENTITY_SCENE_LIGHTS_WGSL],
];

describe('共享光照片段(WGSL)的切片与常量', () => {
  it('切片标记齐全，切出来的每段都非空、各有函数', () => {
    for (const tag of ['WR_CORE', 'WR_TEX', 'WR_SPRITE']) expect(sliceWgsl(WR_WGSL_SRC, tag).length).toBeGreaterThan(200);
    expect(sliceWgsl(LC_WGSL_SRC, 'LIGHTING_CORE').length).toBeGreaterThan(200);
    for (const [tag, src] of [
      ['WR_CORE', WR_CORE_WGSL], ['WR_TEX', WR_TEX_WGSL], ['WR_SPRITE', WR_SPRITE_WGSL], ['LC', LC_WGSL],
      ['PROBE_SAMPLING', PROBE_SAMPLING_WGSL], ['SKYAO_SAMPLING', SKYAO_SAMPLING_WGSL], ['ENTITY_SCENE_LIGHTS', ENTITY_SCENE_LIGHTS_WGSL],
    ] as const) {
      expect(wgslFunctions(src).length, `${tag} 一个函数都没切出来`).toBeGreaterThan(0);
    }
    expect(CHAR_LIGHT_COMMON_WGSL).not.toContain('//__CHAR_SHADE_CORE_WGSL__');   // 着色核心已注入
    expect(CHAR_LIGHT_COMMON_WGSL).toContain('fn shadeEntityLinear(');
    // 两个切片是公共块的真子集(场景光照 pass 的调试视图单独拼它们)
    expect(CHAR_LIGHT_COMMON_WGSL).toContain(PROBE_SAMPLING_WGSL);
    expect(CHAR_LIGHT_COMMON_WGSL).toContain(SKYAO_SAMPLING_WGSL);
  });

  it('LC_* 光源编码与 lightPacking.LIGHT_KIND_CODE 同值', () => {
    for (const [kind, code] of Object.entries(LIGHT_KIND_CODE)) {
      const name = `LC_${kind === 'directional' ? 'DIRECTIONAL' : kind.toUpperCase()}`;
      const w = new RegExp(`const\\s+${name}\\s*:\\s*i32\\s*=\\s*(\\d+)\\s*;`).exec(LC_WGSL_SRC);
      expect(w, name).toBeTruthy();
      expect(Number(w![1]), name).toBe(code);
    }
  });
});

describe('CharLights 结构与 charLights 组逐项对齐', () => {
  it('成员名 / 类型 / 数组长度 / 顺序与 createCharLightUniforms 相同', () => {
    const body = /struct\s+CharLights\s*\{([^}]*)\}/.exec(CHAR_LIGHTS_WGSL)?.[1];
    expect(body, '找不到 struct CharLights').toBeTruthy();
    const wgsl = [...body!.matchAll(/(\w+)\s*:\s*(array<([\w<>]+),\s*(\d+)>|[\w<>]+)\s*,/g)]
      .map((m) => (m[3] ? `${m[1]}: ${m[3]}[${m[4]}]` : `${m[1]}: ${m[2]}`));
    const group: UniformGroup = createCharLightUniforms();
    const js = Object.entries(group.uniformStructures as Record<string, { type: string; size?: number }>)
      .map(([k, v]) => ((v.size ?? 1) > 1 ? `${k}: ${v.type}[${v.size}]` : `${k}: ${v.type}`));
    expect(wgsl).toEqual(js);
    expect(js.filter((s) => s.endsWith(`[${MAX_STATIC_LIGHTS}]`)).length).toBe(4);
  });
});

describe('WGSL 片段里不许有 Pixi 正则 / 一致性分析的地雷', () => {
  for (const [name, src] of WGSL_CHUNKS) {
    it(`${name}：不声明绑定、不写「at 号 + group/binding」、struct 体内无注释、不用 textureSample`, () => {
      // Pixi 的 extractStructAndGroups 连注释一起扫：注释里出现也会被当成绑定声明
      expect(src).not.toMatch(/@(group|binding)\(/);
      expect(stripComments(src)).not.toMatch(/\bvar\s*</);
      for (const m of src.matchAll(/struct\s+\w+\s*\{([^}]*)\}/g)) {
        expect(m[1], `${name} 的 struct 体内有注释（Pixi 会把注释里的「名: 类型」当成员）`).not.toMatch(/\/\/|\/\*/);
      }
      expect(stripComments(src), '只能在一致控制流里调；片段函数会被分支 / 循环调用，一律 textureSampleLevel')
        .not.toMatch(/\btextureSample\s*\(/);
    });
  }
});
