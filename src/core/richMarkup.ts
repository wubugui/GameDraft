/**
 * 册子/成书正文的**块级标记解析**（`[h]` / `[quote]` / `[hr]` / `[img:路径|档位]` / `[caption]`）。
 *
 * 为什么住在 core 而不是 ui/RichContent：这套语法有两类消费者——ui 的排版引擎（渲染）
 * 与 systems/ArchiveManager 的插图预热（只要路径）。分层只许自上而下（UI→系统→…→核心），
 * systems 不能 import ui，于是纯解析下沉到 core，两边共用**同一份**语法知识。
 * 历史教训：预热侧曾手写影子正则模仿本解析，v2 加档位后缀时没跟上，把 `路径|wide`
 * 整串当路径去加载，冷启动刷 load-failure（2026-08-17）。语法只此一份，不许再抄。
 *
 * Pixi 排版、调色板、可点词条等渲染事务仍在 ui/RichContent——本文件只做 字符串 → 块。
 */

export type RichImageSize = 'inline' | 'wide' | 'full';

export type RichBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string; tone?: 'body' | 'muted' | 'faint' }
  | { kind: 'quote'; text: string }
  | { kind: 'image'; path: string; size?: RichImageSize; caption?: string }
  | { kind: 'divider' };

const IMG_LINE_RE = /^\[img:([^\]|]+)(?:\|(inline|wide|full))?\]\s*$/;
const IMG_INLINE_RE = /\[img:([^\]|]+)(?:\|(inline|wide|full))?\]/g;

/**
 * 把带标记的原文解析成块列表。行首标记逐行判；`[img:…]` 混在段落中间时
 * 仍按 v1 语义把段落切开（内容侧已有大量"文字[img:x]文字"写法，不许静默丢图）。
 * 空行分段——v1 的 `trim()` 把作者用空行做的节奏全吃掉了（审查批3a 点名）。
 */
export function parseRichMarkup(raw: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  const pushParagraph = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    // 段内混排的 [img:]：切成 文/图/文 序列（v1 兼容语义）
    let last = 0;
    IMG_INLINE_RE.lastIndex = 0;
    for (let m = IMG_INLINE_RE.exec(t); m !== null; m = IMG_INLINE_RE.exec(t)) {
      const before = t.slice(last, m.index).trim();
      if (before) blocks.push({ kind: 'paragraph', text: before });
      blocks.push({ kind: 'image', path: m[1], size: (m[2] as RichImageSize) ?? 'inline' });
      last = m.index + m[0].length;
    }
    const tail = t.slice(last).trim();
    if (tail) blocks.push({ kind: 'paragraph', text: tail });
  };

  let para: string[] = [];
  let quote: string[] | null = null;
  const flushPara = (): void => {
    if (para.length > 0) pushParagraph(para.join('\n'));
    para = [];
  };

  for (const rawLine of String(raw ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (quote !== null) {
      if (trimmed === '[/quote]') {
        blocks.push({ kind: 'quote', text: quote.join('\n').trim() });
        quote = null;
      } else {
        quote.push(line);
      }
      continue;
    }

    if (trimmed === '') { flushPara(); continue; }
    if (trimmed === '[hr]') { flushPara(); blocks.push({ kind: 'divider' }); continue; }
    if (trimmed.startsWith('[quote]')) {
      flushPara();
      const rest = trimmed.slice(7).trim();
      if (rest.endsWith('[/quote]')) {
        // 单行开闭：[quote]床板要竖着放[/quote]
        const inner = rest.slice(0, -8).trim();
        if (inner) blocks.push({ kind: 'quote', text: inner });
      } else {
        quote = rest ? [rest] : [];
      }
      continue;
    }
    if (trimmed.startsWith('[h]')) {
      flushPara();
      const text = trimmed.slice(3).trim();
      if (text) blocks.push({ kind: 'heading', text });
      continue;
    }
    if (trimmed.startsWith('[caption]')) {
      flushPara();
      const text = trimmed.slice(9).trim();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === 'image' && !prev.caption) prev.caption = text;
      else if (text) blocks.push({ kind: 'paragraph', text, tone: 'faint' });
      continue;
    }
    const imgLine = IMG_LINE_RE.exec(trimmed);
    if (imgLine) {
      flushPara();
      blocks.push({ kind: 'image', path: imgLine[1], size: (imgLine[2] as RichImageSize) ?? 'inline' });
      continue;
    }
    para.push(line);
  }
  // 未闭合的 [quote]：按引文收尾（内容写漏闭合不该把整段吃掉）
  if (quote !== null && quote.length > 0) blocks.push({ kind: 'quote', text: quote.join('\n').trim() });
  flushPara();
  return blocks;
}

/**
 * 抽取正文里所有会被渲染的插图路径（不含 `|档位` 后缀）。给预热等只要路径的消费者：
 * 走与渲染完全相同的解析，所以"预热到的"与"会画出来的"按构造一致——
 * 引文块内的 `[img:]` 渲染不认，这里同样不会抽出来。
 */
export function extractMarkupImagePaths(raw: string): string[] {
  const out: string[] = [];
  for (const block of parseRichMarkup(raw)) {
    if (block.kind === 'image') out.push(block.path);
  }
  return out;
}
