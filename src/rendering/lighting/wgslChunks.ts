/**
 * 光照 / 世界重建共用片段的 **WGSL 版**切片（WebGPU 迁移期与 GLSL 并存；WebGL 路径不读本模块）。
 *
 * GLSL 那边每个宿主文件各自 `?raw` 引入再用同一行切片器切（SceneLightingPass / LitBackground /
 * CharacterLitSprite / vfxShaders）；WGSL 版集中在这里切一次，宿主直接拿常量拼：
 *
 *   - `WR_CORE_WGSL` / `WR_TEX_WGSL` / `WR_SPRITE_WGSL`：worldReconstruct.wgsl 的三段（与 GLSL 同名同界）；
 *   - `LC_WGSL`：lightingCore.wgsl 的 LIGHTING_CORE 段（lcMarchVisibility 依赖 WR_CORE，要一起拼）；
 *   - `WORLD_RECONSTRUCT_WGSL` / `LIGHTING_CORE_WGSL`：整份文件（切片 + 注释；GLSL 那边停用的统一角色路径
 *     是两份整拼的）。整份与切片不能在同一模块里同时拼。
 *
 * 角色照明公共块（CHAR_LIGHT_COMMON / PROBE_SAMPLING / SKYAO_SAMPLING 的 WGSL 版）在
 * `CharacterShadingFilter.ts`，实体灯循环与 `charLights` 结构在 `CharacterLitSprite.ts`，
 * 都与各自的 GLSL 常量并排导出。
 *
 * 各片段的设计（不读任何绑定、全部走形参；与 GLSL 的形式差异）写在对应 .wgsl 文件头。
 * 同一个 WGSL 模块里每段只许拼一次（没有预处理器，重复定义编译失败）。
 */
import LIGHTING_CORE_WGSL_SRC from './lightingCore.wgsl?raw';
import WORLD_RECONSTRUCT_WGSL_SRC from './worldReconstruct.wgsl?raw';

/** 取 `//__${tag}_BEGIN__` 与 `//__${tag}_END__` 之间（不含标记），与 GLSL 宿主的切片器同一行代码。 */
export function sliceWgsl(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`[wgslChunks] WGSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}

export const WORLD_RECONSTRUCT_WGSL: string = WORLD_RECONSTRUCT_WGSL_SRC;
export const LIGHTING_CORE_WGSL: string = LIGHTING_CORE_WGSL_SRC;
export const WR_CORE_WGSL: string = sliceWgsl(WORLD_RECONSTRUCT_WGSL_SRC, 'WR_CORE');
export const WR_TEX_WGSL: string = sliceWgsl(WORLD_RECONSTRUCT_WGSL_SRC, 'WR_TEX');
export const WR_SPRITE_WGSL: string = sliceWgsl(WORLD_RECONSTRUCT_WGSL_SRC, 'WR_SPRITE');
export const LC_WGSL: string = sliceWgsl(LIGHTING_CORE_WGSL_SRC, 'LIGHTING_CORE');
