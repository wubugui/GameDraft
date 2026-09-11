/**
 * F2 调试面板：**每一页都得真被画出来**。
 *
 * 这条钉的是一个只会表现为"那一页是空白"的失效：`mkTab` 建了页签、`mkPanel` 建了容器、
 * 内容区也造好了，但 `render()` 的那串 `renderXxx()` 里漏掉一行，于是那个面板永远没人往里塞
 * 东西。TypeScript 不管（没有未使用私有方法的报错，方法在别处被引用过就算用了），
 * 跑起来也不报错——只有人点开那一页才发现是白的。粒子页 2026-09-11 就是这么漏的。
 *
 * 判据用"谁往面板里写"反查，不靠命名约定（`panelLog` 的填充者叫 `renderLogOnly`，
 * 按名字对不上）：凡是方法体里碰了 `this.panelXxx` 或 `this.logPre` 的 `render*` 方法，
 * 都必须出现在 `render()` 的方法体里。
 *
 * DOM 断言做不了（本仓库 vitest 跑在 node 环境，没有 jsdom），所以按 `?raw` 读源码——
 * 与 `rendering/dialogueGeometryParity.test.ts` 同一条路子。
 */
import { describe, expect, it } from 'vitest';

import SRC from './DebugPanelUI.ts?raw';

/** 取出某个方法的方法体（花括号配平；字符串/注释里的花括号在本文件里不成问题）。 */
function methodBody(src: string, name: string): string {
  const head = new RegExp(`\\n  (?:private )?${name}\\([^)]*\\)(?:: [\\w<>[\\]| ]+)? \\{`).exec(src);
  if (!head) throw new Error(`找不到方法 ${name}()`);
  let i = head.index + head[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`方法 ${name}() 花括号没配平`);
  return src.slice(start, i - 1);
}

/** 所有 `private renderXxx()` 方法名 */
function allRenderMethods(src: string): string[] {
  return [...src.matchAll(/\n {2}private (render[A-Z]\w*)\(/g)].map((m) => m[1]);
}

describe('DebugPanelUI · 每一页都被 render() 画到', () => {
  it('凡是往面板里写内容的 render* 方法，都必须被 render() 调到', () => {
    const body = methodBody(SRC, 'render');
    const called = new Set([...body.matchAll(/this\.(render[A-Z]\w*)\(\)/g)].map((m) => m[1]));

    const fillers = allRenderMethods(SRC).filter((name) => {
      if (name === 'render') return false;
      return /this\.(?:panel[A-Z]\w*|logPre)\b/.test(methodBody(SRC, name));
    });
    expect(fillers.length).toBeGreaterThan(5);

    const missing = fillers.filter((n) => !called.has(n));
    expect(missing, `这些页会是空白：${missing.join(', ')}`).toEqual([]);
  });

  it('render() 里没有调用不存在 / 不填面板的东西（防手滑改名后留下死行）', () => {
    const body = methodBody(SRC, 'render');
    const called = [...body.matchAll(/this\.(render[A-Z]\w*)\(\)/g)].map((m) => m[1]);
    const known = new Set(allRenderMethods(SRC));
    expect(called.filter((n) => !known.has(n))).toEqual([]);
    expect(new Set(called).size, '同一页画了两遍').toBe(called.length);
  });

  it('每个 mkPanel 出来的面板都挂进了面板容器（漏挂 = 那一页根本不在 DOM 里）', () => {
    const panels = [...SRC.matchAll(/this\.(panel[A-Z]\w*) = this\.mkPanel\(/g)].map((m) => m[1]);
    const attached = new Set(
      [...SRC.matchAll(/panels\.appendChild\(this\.(panel[A-Z]\w*)\)/g)].map((m) => m[1]),
    );
    const orphans = panels.filter((p) => !attached.has(p));
    expect(orphans, `这些面板建了但没挂进 DOM：${orphans.join(', ')}`).toEqual([]);
  });

  it('每个 mkPanel 出来的面板都有人往里写（否则那个容器是死的）', () => {
    const panels = [...SRC.matchAll(/this\.(panel[A-Z]\w*) = this\.mkPanel\(/g)].map((m) => m[1]);
    expect(panels.length).toBeGreaterThan(5);
    const body = methodBody(SRC, 'render');
    const called = [...body.matchAll(/this\.(render[A-Z]\w*)\(\)/g)].map((m) => m[1]);
    const reachable = called.map((n) => methodBody(SRC, n)).join('\n');
    // panelLog 的内容挂在它的子节点 logPre 上，没有直接的 panelLog.xxx —— 单列。
    const viaChild: Record<string, string> = { panelLog: 'logPre' };
    for (const p of panels) {
      const token = viaChild[p] ?? p;
      expect(reachable.includes(`this.${token}`), `${p} 没有任何 render() 路径往里写`).toBe(true);
    }
  });
});
