import { CanvasTextMetrics, TextStyle } from 'pixi.js';
import { styledRuns } from '../core/textStyle';

/**
 * 单 `Text` 上的 `[clue:id]` 词条命中框推算（玩法需求清单 K7 二阶段）。
 *
 * ## 为什么不走 `RichContent` 那条 run 级排版
 *
 * 册子/成书的正文是**静态**的，`RichContent` 把每个 run 拆成独立 `Text` 逐个摆位，
 * 顺手就有了几何。对话框不行：它有**打字机**（逐字显示）、有玩家可调的速度与"整句出全"，
 * 还有随立绘 inset 变化的换行宽——把它换成 run 级排版等于重写全游戏被看得最多的那块 UI
 * 的文本渲染，风险与收益完全不成比例。
 *
 * ## 所以：渲染一个字都不动，只在上面盖一层命中框
 *
 * 关键在于命中框**不能自己猜换行**——猜错一格，框就飘在别的字上。这里的做法是
 * 把换行这件事原样问回 Pixi：`CanvasTextMetrics.measureText` 用的就是 `Text` 内部
 * 那一套度量与折行，它吐出来的 `lines` 就是屏幕上真正的那几行。我们只做两件事：
 *
 * 1. 把「第几个可见字」映射到「第几行、行内第几个字」——按 Pixi 给的 `lines` 走，
 *    不重算折行点；
 * 2. 行内位置用**不折行**的度量取前缀宽度（折行的样式会把前缀又折一次，量出来是错的）。
 *
 * 标记本身是零宽的：`styledRuns` 给的 run 文本已经剥掉了 `[c:]`/`[clue:]`，
 * 把它们接起来就是屏幕上那串可见字，与 Pixi 拿去折行的是同一串。
 */

export interface TextLinkSpan {
  id: string;
  /** 相对文本左上角（即 `Text.x/y`）的偏移 */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 前缀宽度用的不折行样式缓存：键取样式的度量相关字段 */
const noWrapCache = new Map<string, TextStyle>();

function noWrapStyleOf(style: TextStyle): TextStyle {
  const key = [
    style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle,
    style.letterSpacing, style.lineHeight,
  ].join('|');
  const hit = noWrapCache.get(key);
  if (hit) return hit;
  const s = new TextStyle({
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    wordWrap: false,
  });
  noWrapCache.set(key, s);
  return s;
}

/**
 * 算出 `raw` 里每一段 `[clue:id]` 词条在渲染后落在哪。
 *
 * @param raw   带标记原串（与喂给 `setStyledText` 的**同一串**）
 * @param style 渲染那份样式（同一实例或逐字段相同的克隆）
 * @returns 相对文本原点的矩形列表；没有词条、或该样式不是左对齐时返回空表
 *
 * ⚠ 只支持左对齐（`align` 缺省即左）。居中/右对齐要按每行实宽反推起点，
 * 现网没有这种正文，先明确不支持而不是算个大概——框飘在别的字上比没有框更糟。
 */
export function measureClueSpans(raw: string, style: TextStyle): TextLinkSpan[] {
  const src = raw ?? '';
  if (!src.includes('[clue:')) return [];
  const align = style.align ?? 'left';
  if (align !== 'left' && align !== 'justify') return [];

  const runs = styledRuns(src);
  if (runs.length === 0) return [];

  // 可见字串 + 逐字的词条归属（标记零宽，接起来就是屏幕上那串）
  let plain = '';
  const linkOf: (string | null)[] = [];
  for (const run of runs) {
    const id = run.link?.kind === 'clue' ? run.link.id : null;
    plain += run.text;
    for (let i = 0; i < run.text.length; i++) linkOf.push(id);
  }
  if (!plain || linkOf.every((v) => v === null)) return [];

  const metrics = CanvasTextMetrics.measureText(plain, style);
  const lines: string[] = metrics.lines ?? [];
  const lineHeight = metrics.lineHeight || Number(style.lineHeight) || Number(style.fontSize) || 20;
  const noWrap = noWrapStyleOf(style);
  const widthOf = (s: string): number => (s ? CanvasTextMetrics.measureText(s, noWrap).width : 0);

  return spansFromLines(plain, linkOf, lines, lineHeight, widthOf);
}

/**
 * 映射本身（**纯函数**，度量注入）：把「第几个可见字属于哪个词条」+「Pixi 折出来的行」
 * 合成矩形列表。抽出来是为了能脱离引擎测——度量是引擎的事，映射是这里的事，
 * 而映射正是会错的那部分（行首偏移、一行多个词条、词条跨行）。
 *
 * @param widthOf 量一段文字的宽度（真实路径给的是不折行的 `CanvasTextMetrics`）
 */
export function spansFromLines(
  plain: string,
  linkOf: readonly (string | null)[],
  lines: readonly string[],
  lineHeight: number,
  widthOf: (s: string) => number,
): TextLinkSpan[] {
  const spans: TextLinkSpan[] = [];
  // 折行只会**插入断点**、并可能吃掉断点处的空白，行内容本身在 plain 里逐字出现；
  // 用游标 + indexOf 定位即可，天然对"被吃掉的空格"免疫。
  let cursor = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const at = plain.indexOf(line, cursor);
    if (at < 0) break;          // 对不上就整体放弃，宁可没有框也不要错位的框
    cursor = at + line.length;

    let i = 0;
    while (i < line.length) {
      const id = linkOf[at + i];
      if (!id) { i++; continue; }
      let j = i + 1;
      while (j < line.length && linkOf[at + j] === id) j++;
      const x = widthOf(line.slice(0, i));
      const w = widthOf(line.slice(0, j)) - x;
      // 词条被折行切开时，这里每行各出一个矩形——它在屏幕上本来就是两段
      if (w > 0) spans.push({ id, x, y: li * lineHeight, w, h: lineHeight });
      i = j;
    }
  }
  return spans;
}
