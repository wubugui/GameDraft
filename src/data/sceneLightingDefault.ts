import type { SceneLightingDef } from './types';
import sceneLightingDefault from './scene_lighting_default.json';

/**
 * 场景没写 `lighting` 块时生效的那份：无作者灯、显示变换恒等、不去霾 ⇒ **画面 = 原画**。
 *
 * 没写块 ≠ 不打光：块里只装作者的灯与显示参数，运行时灯（手持火把、跟随灯）与它无关，
 * 只要这张原画烘了几何场就该照得亮（2026-09-14，见 scene-lighting 机制卡）。
 *
 * 唯一的值住在 `scene_lighting_default.json`，编辑器 `scene_lights.default_lighting_block`
 * 读的是同一个文件：作者在没写块的场景里摆第一盏灯时落盘的就是运行时此刻正在用的这份，
 * 不会因为"多了一盏灯"整个场景的色调映射跟着变。每次给一份新拷贝（调用方与 F2 会原地改它）。
 */
export function defaultSceneLighting(): SceneLightingDef {
  return structuredClone(sceneLightingDefault) as unknown as SceneLightingDef;
}
