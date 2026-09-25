/**
 * 粒子 shader 的两条"卡帧"闸（2026-09-16 实测：进茶馆第一帧 11 s、第一次点火把同样卡）。
 *
 * 1. 受光粒子不许把角色那条 uMode 0 的 gatherRT（192×256 嵌套循环里采 3D 纹理）拼进主函数：
 *    对粒子不可达（粒子那组 uMode 钉在 1..3），却把后端编译从约 3 s 拖到 11 s。GLSL(master 对照 / 编辑器)与
 *    WGSL(运行时)两份都查。
 * 2. 粒子目录里的每个 GPU 程序都必须在 `vfxPipelineSpecs()` 清单里：漏了的不会被开局预建管线，
 *    第一次出现时在可见画面上等编译。
 */
import { DOMAdapter, type GpuProgram } from '../../engine2d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import CHAR_LIGHTING_SRC from '../../core/CharacterLightingSystem.ts?raw';
import { vfxPipelineSpecs } from './VfxRenderer';
import RENDERER_SRC from './VfxRenderer.ts?raw';
import { getVfxLitGpuProgram, getVfxLitProgram, getVfxPlateLitGpuProgram, getVfxPlateLitProgram } from './vfxShaders';

const VFX_SOURCES = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function mainBody(src: string): string {
  const i = src.indexOf('void main(void)');
  expect(i, '找不到 main').toBeGreaterThan(0);
  return src.slice(i);
}

/** WGSL 里某个函数的函数体(按花括号配对) */
function wgslFnBody(src: string, name: string): string {
  const head = new RegExp(`fn\\s+${name}\\s*\\(`).exec(src);
  expect(head, `找不到 fn ${name}`).toBeTruthy();
  let i = src.indexOf('{', head!.index);
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

describe('粒子 shader 不卡帧', () => {
  // node 里没有 document：GlProgram 构造时探片元精度要建画布，换个不建 GL 上下文的适配器
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('受光粒子 / 受光薄片的主函数只走 probe 底光，不调 gatherRT(GLSL)', () => {
    for (const p of [getVfxLitProgram(), getVfxPlateLitProgram()]) {
      const body = mainBody(p.fragment!);
      expect(body).not.toMatch(/gatherRT\s*\(/);
      expect(body).toContain('probeE(q, nQ)');
    }
  });

  it('受光粒子 / 受光薄片的片元入口不调 gatherRT(WGSL,运行时实际跑的)', () => {
    for (const p of [getVfxLitGpuProgram(), getVfxPlateLitGpuProgram()]) {
      const body = wgslFnBody(p.source, p.fragmentEntry);
      expect(body).not.toMatch(/gatherRT\s*\(/);
    }
  });

  it('前提：粒子那组 frameShade 的 uMode 由照明系统钉在 ≥ 1（gatherRT 那支对粒子不可达）', () => {
    expect(CHAR_LIGHTING_SRC).toMatch(/Object\.assign\(this\.vfxFrameLit\.uniforms, \{\s*uMode: sh && sh\.mode >= 1 \? sh\.mode : 3,/);
  });

  it('粒子目录里建的每个 GPU 程序都在管线预建清单里', () => {
    const specs = vfxPipelineSpecs();
    const programs = new Set<GpuProgram>(specs.map((s) => s.program));
    // 程序只许由 get*GpuProgram 单例建（每次 new 一个就等于每次重建管线）；清单函数体里得点到每一个
    const getters = new Set<string>();
    for (const [file, src] of Object.entries(VFX_SOURCES)) {
      if (file.endsWith('.test.ts')) continue;
      const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      for (const m of code.matchAll(/export function (get\w+GpuProgram)\(\): GpuProgram/g)) getters.add(m[1]);
    }
    expect(getters.size).toBeGreaterThanOrEqual(5);
    const fn = RENDERER_SRC.slice(RENDERER_SRC.indexOf('export function vfxPipelineSpecs'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    for (const g of getters) expect(body, `${g} 没进 vfxPipelineSpecs()`).toContain(`${g}()`);
    expect(programs.size).toBe(getters.size);
  });

  it('每条预建的几何都带齐程序顶点入口要的属性(否则布局建不起来)', () => {
    for (const s of vfxPipelineSpecs()) {
      const have = Object.keys(s.geometry.attributes);
      for (const a of s.program.attributes) {
        expect(have, `${s.program.name ?? s.program.uid} 要 ${a.name}`).toContain(a.name);
      }
      expect(s.blendModes.length).toBeGreaterThan(0);
    }
  });
});
