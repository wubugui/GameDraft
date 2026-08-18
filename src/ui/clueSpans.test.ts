import { describe, expect, it } from 'vitest';
import { spansFromLines } from './clueSpans';

/** 等宽假度量：一个字符 10 宽——让断言看得出"第几个字"，与真实字体无关 */
const widthOf = (s: string): number => s.length * 10;

/** 把「哪几段属于哪个词条」写成可读的形式：`[起, 止)` 半开区间 */
function linkMap(plain: string, marks: { id: string; from: number; to: number }[]): (string | null)[] {
  const out: (string | null)[] = new Array(plain.length).fill(null);
  for (const m of marks) for (let i = m.from; i < m.to; i++) out[i] = m.id;
  return out;
}

describe('spansFromLines（可见字 → 屏幕矩形的映射）', () => {
  it('单行、词条在句首：x 从 0 起', () => {
    const plain = '阎王岭那边莫去';
    const linkOf = linkMap(plain, [{ id: 'ridge', from: 0, to: 3 }]);
    expect(spansFromLines(plain, linkOf, [plain], 40, widthOf)).toEqual([
      { id: 'ridge', x: 0, y: 0, w: 30, h: 40 },
    ]);
  });

  it('单行、词条前面有前缀：x = 前缀宽', () => {
    const plain = '听说了没得，刘麻子昨晚又出来了';
    const linkOf = linkMap(plain, [{ id: 'mazi', from: 6, to: 9 }]);
    expect(spansFromLines(plain, linkOf, [plain], 40, widthOf)).toEqual([
      { id: 'mazi', x: 60, y: 0, w: 30, h: 40 },
    ]);
  });

  it('一行里两个词条各出一框，互不相连', () => {
    const plain = '莫去阎王岭也莫提天书';
    const linkOf = linkMap(plain, [
      { id: 'ridge', from: 2, to: 5 },
      { id: 'book', from: 8, to: 10 },
    ]);
    expect(spansFromLines(plain, linkOf, [plain], 40, widthOf)).toEqual([
      { id: 'ridge', x: 20, y: 0, w: 30, h: 40 },
      { id: 'book', x: 80, y: 0, w: 20, h: 40 },
    ]);
  });

  it('词条落在第二行：y 跟着行号走，x 从该行行首重新算', () => {
    const plain = '前面是铺垫的废话阎王岭那边莫去';
    const lines = ['前面是铺垫的废话', '阎王岭那边莫去'];
    const linkOf = linkMap(plain, [{ id: 'ridge', from: 8, to: 11 }]);
    expect(spansFromLines(plain, linkOf, lines, 40, widthOf)).toEqual([
      { id: 'ridge', x: 0, y: 40, w: 30, h: 40 },
    ]);
  });

  it('词条被折行切开：每行各出一个矩形（屏幕上本来就是两段）', () => {
    const plain = '去过神仙顶的人都说';
    const lines = ['去过神仙', '顶的人都说'];
    const linkOf = linkMap(plain, [{ id: 'peak', from: 2, to: 5 }]);   // 「神仙顶」跨行
    expect(spansFromLines(plain, linkOf, lines, 40, widthOf)).toEqual([
      { id: 'peak', x: 20, y: 0, w: 20, h: 40 },   // 第一行的「神仙」
      { id: 'peak', x: 0, y: 40, w: 10, h: 40 },   // 第二行的「顶」
    ]);
  });

  it('折行吃掉断点处的空格也不会错位（拉丁文本）', () => {
    const plain = 'the old road to Yanwang Ridge is closed';
    // Pixi 折行时把断点那个空格丢了：两行拼起来 ≠ plain
    const lines = ['the old road to', 'Yanwang Ridge is closed'];
    const linkOf = linkMap(plain, [{ id: 'ridge', from: 16, to: 29 }]);  // "Yanwang Ridge"
    expect(spansFromLines(plain, linkOf, lines, 40, widthOf)).toEqual([
      { id: 'ridge', x: 0, y: 40, w: 130, h: 40 },
    ]);
  });

  it('没有词条就没有矩形', () => {
    const plain = '一句普通的话';
    expect(spansFromLines(plain, new Array(plain.length).fill(null), [plain], 40, widthOf)).toEqual([]);
  });

  it('行内容对不上（度量与原串不同源）时整体放弃，不产出错位的框', () => {
    const plain = '阎王岭那边莫去';
    const linkOf = linkMap(plain, [{ id: 'ridge', from: 0, to: 3 }]);
    // 第二行是原串里根本没有的内容 → 从那一行起停手（已产出的第一行仍然有效）
    expect(spansFromLines(plain, linkOf, ['阎王岭那边莫去', '完全对不上的一行'], 40, widthOf)).toEqual([
      { id: 'ridge', x: 0, y: 0, w: 30, h: 40 },
    ]);
  });

  it('空行跳过、不占行号（Pixi 会给出空行）', () => {
    const plain = '甲乙丙';
    const linkOf = linkMap(plain, [{ id: 'x', from: 0, to: 3 }]);
    expect(spansFromLines(plain, linkOf, ['', '甲乙丙'], 40, widthOf)).toEqual([
      { id: 'x', x: 0, y: 40, w: 30, h: 40 },
    ]);
  });
});
