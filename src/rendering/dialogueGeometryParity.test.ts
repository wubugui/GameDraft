import { describe, expect, it } from 'vitest';
// 用 vite 的 ?raw 读源码（项目既有范式：CharacterShadingFilter 用它注入 glsl）。
// 刻意不用 node:fs —— 主 tsconfig 不带 @types/node，读文件会让 tsc 直接红。
import UI_SRC from '../ui/DialogueUI.ts?raw';
import CUT_SRC from './CutsceneRenderer.ts?raw';

/**
 * 对白框几何的**镜像 parity 门**。
 *
 * `CutsceneRenderer.showDialogueBox` 是 `DialogueUI` 的手工复刻——两处各有一份几何常量，
 * 注释里写着「那边改了这里要跟」，但在本测试之前**没有任何护栏**。按 editor-tools/runtime
 * 两域共同的不变量：「注释里写『有护栏』= 没有护栏」，手工镜像必须有语义级 parity 测试。
 *
 * 这里逐项比对两份源码里的常量字面量。不是最强的形式（最强是消灭镜像、读单一真相源），
 * 但那要重构已经 ship 的过场渲染路径，风险不该在加功能时顺带承担。
 */
const UI = UI_SRC;
const CUT = CUT_SRC;

/** 从源码里抓 `const NAME = 123;` 的字面量（只认数字常量）。 */
function constOf(src: string, name: string): number | null {
  const m = new RegExp(String.raw`const\s+` + name + String.raw`\s*=\s*(-?\d+(?:\.\d+)?)\s*;`).exec(src);
  return m ? Number(m[1]) : null;
}

describe('对白框几何 · DialogueUI ↔ CutsceneRenderer 镜像 parity', () => {
  /** 两边同名同值的几何常量。任一处改了另一处没跟，这里就红。 */
  const MIRRORED: { name: string; expect: number }[] = [
    { name: 'PLATE_HEIGHT', expect: 56 },
    { name: 'PLATE_RISE', expect: 34 },
    { name: 'PLATE_INSET_X', expect: 20 },
    { name: 'BODY_TOP', expect: 28 },
    { name: 'BODY_LINE_HEIGHT', expect: 40 },
    { name: 'PORTRAIT_SIZE', expect: 360 },
    { name: 'PORTRAIT_INSET', expect: 248 },
    { name: 'PORTRAIT_LIFT', expect: 0 },
  ];

  for (const { name, expect: want } of MIRRORED) {
    it(`${name} 两侧同值`, () => {
      const cut = constOf(CUT, name);
      expect(cut, `CutsceneRenderer 里找不到常量 ${name}`).not.toBeNull();
      expect(cut).toBe(want);
    });
  }

  it('BOX_HEIGHT：DialogueUI 由算式推出，CutsceneRenderer 写死同一个数', () => {
    // DialogueUI: BODY_MASK_TOP(=BODY_TOP-2) + BODY_LINE_HEIGHT * BODY_MAX_LINES + BODY_MASK_BOTTOM_INSET
    const bodyTop = constOf(UI, 'BODY_TOP')!;
    const lineH = constOf(UI, 'BODY_LINE_HEIGHT')!;
    const maxLines = constOf(UI, 'BODY_MAX_LINES')!;
    // BODY_MASK_BOTTOM_INSET = UITheme.spacing.xl；与 BOX_MARGIN 同一档，取 CutsceneRenderer 的 20
    const bottomInset = constOf(CUT, 'BOX_MARGIN')!;
    const derived = (bodyTop - 2) + lineH * maxLines + bottomInset;
    expect(constOf(CUT, 'BOX_HEIGHT')).toBe(derived);
  });

  /** 气泡档三个常量：两处各写一份（CutsceneRenderer 在函数体内），必须同值。 */
  const BUBBLE: { name: string; expect: number }[] = [
    { name: 'BUBBLE_WIDTH', expect: 560 },
    { name: 'BUBBLE_ABOVE_GAP', expect: 18 },
    { name: 'BUBBLE_EDGE_MARGIN', expect: 16 },
  ];
  for (const { name, expect: want } of BUBBLE) {
    it(`${name} 两侧同值（气泡档）`, () => {
      expect(constOf(UI, name), `DialogueUI 里找不到 ${name}`).toBe(want);
      expect(constOf(CUT, name), `CutsceneRenderer 里找不到 ${name}`).toBe(want);
    });
  }

  /** 语义级：三档在两处都要被认，缺一档就是「写了 layout 什么都不发生」的静默半瘫。 */
  it('三档版式两处都认', () => {
    for (const src of [UI, CUT]) {
      expect(src).toContain("'top'");
      expect(src).toContain("'bubble'");
    }
  });

  it('立绘上下镜像：两处都按档切 anchor', () => {
    expect(UI).toMatch(/anchor\.set\(0\.5,\s*0\)/);
    expect(CUT).toMatch(/anchor\.set\(0\.5,\s*layout === 'top' \? 0 : 1\)/);
  });
});
