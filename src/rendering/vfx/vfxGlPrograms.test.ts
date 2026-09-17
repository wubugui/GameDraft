/**
 * 粒子 shader 的两条"卡帧"闸（2026-09-16 实测：进茶馆第一帧 11 s、第一次点火把同样卡）。
 *
 * 1. 受光粒子不许把角色那条 uMode 0 的 gatherRT（192×256 嵌套循环里采 3D 纹理）拼进主函数：
 *    对粒子不可达（粒子那组 uMode 钉在 1..3），却把 ANGLE→D3D11 编译从约 3 s 拖到 11 s。
 * 2. 粒子目录里的每个 GL 程序都必须在 `vfxGlPrograms()` 清单里：漏了的不会被开局预编译，
 *    第一次出现时又在可见画面上同步编。
 */
import { DOMAdapter } from 'pixi.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import CHAR_LIGHTING_SRC from '../../core/CharacterLightingSystem.ts?raw';
import { vfxGlPrograms } from './VfxRenderer';
import RENDERER_SRC from './VfxRenderer.ts?raw';
import { getVfxLitProgram, getVfxPlateLitProgram } from './vfxShaders';

const VFX_SOURCES = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function mainBody(src: string): string {
  const i = src.indexOf('void main(void)');
  expect(i, '找不到 main').toBeGreaterThan(0);
  return src.slice(i);
}

describe('粒子 shader 不卡帧', () => {
  // node 里没有 document：GlProgram 构造时探片元精度要建画布，换个不建 GL 上下文的适配器
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('受光粒子 / 受光薄片的主函数只走 probe 底光，不调 gatherRT', () => {
    for (const p of [getVfxLitProgram(), getVfxPlateLitProgram()]) {
      const body = mainBody(p.fragment!);
      expect(body).not.toMatch(/gatherRT\s*\(/);
      expect(body).toContain('probeE(q, nQ)');
    }
  });

  it('前提：粒子那组 frameShade 的 uMode 由照明系统钉在 ≥ 1（gatherRT 那支对粒子不可达）', () => {
    expect(CHAR_LIGHTING_SRC).toMatch(/Object\.assign\(this\.vfxFrameLit\.uniforms, \{\s*uMode: sh && sh\.mode >= 1 \? sh\.mode : 3,/);
  });

  it('粒子目录里建的每个 GL 程序都在预编译清单里', () => {
    const listed = new Set(vfxGlPrograms());
    expect(listed.size).toBe(vfxGlPrograms().length);
    // 程序只许由 get*Program 单例建（每次 new 一个就等于每次重编）；清单函数体里得点到每一个
    const getters = new Set<string>();
    for (const [file, src] of Object.entries(VFX_SOURCES)) {
      if (file.endsWith('.test.ts')) continue;
      const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      const news = code.match(/new GlProgram\(/g)?.length ?? 0;
      const singletons = code.match(/if \(!\w+\) \w+ = new GlProgram\(/g)?.length ?? 0;
      expect(news, `${file} 里有不是单例的 new GlProgram`).toBe(singletons);
      for (const m of code.matchAll(/export function (get\w+Program)\(\): GlProgram/g)) getters.add(m[1]);
    }
    expect(getters.size).toBeGreaterThanOrEqual(4);
    const fn = RENDERER_SRC.slice(RENDERER_SRC.indexOf('export function vfxGlPrograms'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    for (const g of getters) expect(body, `${g} 没进 vfxGlPrograms()`).toContain(`${g}()`);
  });
});
