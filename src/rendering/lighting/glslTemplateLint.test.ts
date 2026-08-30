import { describe, expect, it } from 'vitest';

import CHAR from './UnifiedCharacterShader.ts?raw';
import LIT_BG from './LitBackground.ts?raw';
import SCENE from './SceneLightingPass.ts?raw';

/**
 * GLSL 是拼在 **JS 模板字符串**里的,所以里面**一个反引号都不能有**。
 *
 * 这条被踩过**三次**,每次都是在 GLSL 的中文注释里用反引号引一段代码
 * (` \`dd = dot(...)\` `),模板串当场被截断,报出来的是一串莫名其妙的
 * 「',' expected」「Expression expected」,指向的行号还离真凶好几行。
 *
 * 靠自觉记不住 —— 锁在这里。GLSL 注释里要引代码,直接写,不要加反引号。
 */

/** 取出文件里所有 GLSL 模板串的内容(`const X = /* glsl *\/ \`...\`` 这种)。 */
function glslBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /\/\* glsl \*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    // 模板串到下一个**未转义**的反引号为止。这里正是问题所在:
    // 注释里的反引号就是"下一个反引号",于是模板串提前收尾。
    let i = start;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') break;
      i += 1;
    }
    out.push(src.slice(start, i));
    re.lastIndex = i + 1;
  }
  return out;
}

const FILES: [string, string][] = [
  ['SceneLightingPass.ts', SCENE],
  ['UnifiedCharacterShader.ts', CHAR],
  ['LitBackground.ts', LIT_BG],
];

describe('GLSL 模板串里不许出现反引号', () => {
  it.each(FILES)('%s', (_name, src) => {
    const blocks = glslBlocks(src);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      // 走到这里说明模板串已经按"第一个反引号"切开了。真正的判据是:
      // 切出来的块必须以 GLSL 该有的东西收尾,而不是半截注释。
      // 更直接的判据在下一条。
      expect(b.length).toBeGreaterThan(0);
    }
  });

  it.each(FILES)('%s 的每个 glsl 块都完整（含 main 或至少一个函数体）', (name, src) => {
    for (const b of glslBlocks(src)) {
      const looksComplete = b.includes('void main(') || /\)\s*\{[\s\S]*\}/.test(b);
      expect(looksComplete, `${name}: 有个 glsl 块被提前截断了——八成是注释里写了反引号`)
        .toBe(true);
    }
  });

  it.each(FILES)('%s 的 glsl 块收尾处必须是 JS 语法，不是半截注释', (name, src) => {
    // 这条才是真正拦得住的那个判据。上一条只看"块里有没有函数体"——
    // 而注释里的反引号截断出来的前半截**照样有函数体**，所以它漏过了（实测踩到第 4 次）。
    // 真判据：模板串收尾的反引号之后，下一个非空白字符必须是 JS 能接的东西
    // （分号、逗号、右括号）。如果是中文或字母，说明那个反引号是注释里的、块被腰斩了。
    const BACKSLASH = String.fromCharCode(92);
    const re = /\/\* glsl \*\/\s*`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let i = m.index + m[0].length;
      while (i < src.length) {
        if (src[i] === BACKSLASH) { i += 2; continue; }
        if (src[i] === '`') break;
        i += 1;
      }
      const after = src.slice(i + 1).trimStart()[0] ?? ';';
      expect(
        [';', ',', ')', '}'].includes(after),
        `${name}: glsl 块结束后是 ${JSON.stringify(after)} —— 注释里有反引号，模板串被腰斩了`,
      ).toBe(true);
      re.lastIndex = i + 1;
    }
  });
});

describe('阴影用线扫前缀，不是逐像素 march', () => {
  it('灯的可见性是一次查表 + 一次比较，没有步进循环', () => {
    // 这是 2026-08-22 的算法更换：march 的第 i 步永远落在以灯为圆心的等距壳上，
    // 于是阴影边界被量化成同心弧（网状走样），而且步长随距离变粗会漏挡。
    // 线扫把「灯与我之间最挡的那个东西」预解成前缀最小 M，这里只剩 sp > M。
    expect(SCENE).toContain('float lightVisibilityPrefix(');
    expect(SCENE).toContain('return sp > M ? 0.0 : 1.0;');
    // 防回退：点/聚/面光那条不许再出现 march
    expect(SCENE).toContain('vis = lightVisibilityPrefix(i, px, d);');
    expect(SCENE).not.toContain('vis = lightVisibility(q,');
  });

  it('强度为 0 的灯直接跳过', () => {
    // 雾津街头的 moon 就是 intensity 0 还 enabled。零乘任何数都是零 ——
    // 这条不是优化是纠错。
    expect(SCENE).toContain('if (B.w <= 0.0) continue;');
  });

  it('超出高斯截断的像素跳过（判据与 lcAreaLight 里那条同一个）', () => {
    const iCut = SCENE.indexOf('< 1e-4) continue;');
    const iVis = SCENE.indexOf('vis = lightVisibilityPrefix(');
    expect(iCut).toBeGreaterThan(0);
    expect(iVis).toBeGreaterThan(0);
    expect(iCut, '早退必须排在可见性求解之前，否则省不下任何东西').toBeLessThan(iVis);
  });
});

describe('光晕是沿视线积分，不是表面点距离', () => {
  it('用的是 airlight 闭式解，不是 exp(-表面点距离)', () => {
    // 制作人 2026-08-21 一眼看出的两个症状：光晕不完整、阴影区没有光晕。
    // 根因是拿「该像素表面点到灯的三维距离」当光晕 —— 一遇深度断层就被切。
    expect(SCENE).toContain('float ac = (atan((qw.z - lq.z) / rc) - atan((dNear - lq.z) / rc)) / rc;');
    expect(SCENE).toContain('float ah = (atan((qw.z - lq.z) / rh) - atan((dNear - lq.z) / rh)) / rh;');
    // 防回退：旧的表面点写法必须已经不在
    expect(SCENE).not.toContain('float dd = dot(P - A.xyz, P - A.xyz);');
  });

  it('积分上限是该像素的真实表面深度——挡在灯前面的东西仍然遮得住光晕', () => {
    // 上限用 q.z（= 该像素的真实深度）而不是一个常数，遮挡才成立。
    // 若有人把它换成固定值，光晕会穿墙。
    expect(SCENE).toContain('atan((qw.z - lq.z)');
  });

  it('积分必须配高斯包络——否则 1/r⊥ 长尾把整张画淹了', () => {
    // 只积分不加包络的实测后果：光晕在 ≈100% 的像素上非零，中位发光亮度是中位
    // 表面亮度的 277 倍，且「光晕半径」旋钮框不住光。
    // 同一个教训 lcFalloff 的注释里已经写过一次。
    expect(SCENE).toContain('float core = visC * exp(-r2 / max(uCore.y * uCore.y, 1e-9));');
    expect(SCENE).toContain('float halo = visH * exp(-r2 / max(uCore.z * uCore.z, 1e-9));');
  });

  it('灯位先折进 q 才算垂距（不是拿 M-world 的 xy 当屏幕坐标）', () => {
    expect(SCENE).toContain('vec3 lq = wrWorldToQ(uMRow0, uMRow1, uMRow2, A.xyz);');
    expect(SCENE).toContain('float r2 = dot(qw.xy - lq.xy, qw.xy - lq.xy);');
  });
});
