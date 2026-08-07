/**
 * 玩家可见文本的**语义色板标记**：`[c:<色板id>]…[/c]`。
 *
 * 与 `[tag:…]`（项目引用）分层：`resolveText` 先把引用解出来，本模块再处理样式标记——
 * 顺序不能反，否则 `[tag:string:…]` 解出来的正文里带的色标记会漏掉。
 *
 * 渲染不自己排版：`toPixiTagged` 把本项目标记翻成 **Pixi v8 原生 tagged text**
 * （`<id>…</id>` + `TextStyle.tagStyles`），换行/度量/混排全部交给引擎。
 * 这样打字机、wordWrap、面板高度与迁移前逐像素一致（同字号 → 行高不变）。
 *
 * 色板本身是**数据**（`game_config.json` 的 `textPalette`），一处改全局；代码里的
 * `DEFAULT_TEXT_PALETTE` 只是 game_config 没配时的兜底，不是权威清单。
 */

import type { TextPaletteEntry } from '../data/types';

/** `[c:id]`；id 限 ASCII slug，避免与正文里的方括号内容混淆 */
const OPEN_RE = /\[c:([A-Za-z0-9_-]+)\]/g;
/** `[/c]` */
const CLOSE_TOKEN = '[/c]';
/** 开/闭一起扫的分词器（下标语义依赖捕获组位置，改这里要同步改 tokenize） */
const TOKEN_RE = /\[c:([A-Za-z0-9_-]+)\]|\[\/c\]/g;

/**
 * game_config 未配 textPalette 时的兜底色板。
 * 取值全部落在 UITheme 既有暖木色系内——这套观感里出现纯红/正绿会一眼破功
 * （见 UITheme.colors 里 green/red 被停用的注释）。
 */
export const DEFAULT_TEXT_PALETTE: readonly TextPaletteEntry[] = [
  { id: 'emphasis', label: '强调', color: '#ffcc66' },
  { id: 'danger', label: '危险', color: '#b0644a' },
  { id: 'rule', label: '规矩', color: '#ffaa44' },
  { id: 'clue', label: '线索', color: '#8fae72' },
  { id: 'item', label: '物件', color: '#ddccaa' },
  { id: 'dim', label: '弱化', color: '#8e867a' },
];

/** id → 0xRRGGBB。模块级单例：Game 读到 game_config 后注入，UI 层直接查。 */
let paletteColors: Map<string, number> = new Map();
/** id → 展示用中文名，供调试/编辑器侧回显 */
let paletteLabels: Map<string, string> = new Map();
/** 每个未知 id 只警告一次，避免打字机逐帧刷屏 */
const warnedUnknown = new Set<string>();

function parseHexColor(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return parseInt(s, 16);
}

/**
 * 注入色板（Game 在读到 game_config 后调用一次）。
 * 传入空/无效条目时回落到 {@link DEFAULT_TEXT_PALETTE}，绝不让色板变成空表——
 * 空表会让所有已写好的 `[c:…]` 标记集体降级成无色，比用兜底色更糟。
 */
export function setTextPalette(entries: readonly TextPaletteEntry[] | undefined): void {
  const src = Array.isArray(entries) && entries.length > 0 ? entries : DEFAULT_TEXT_PALETTE;
  const colors = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const e of src) {
    const id = String(e?.id ?? '').trim();
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      console.warn(`textPalette: 非法色板 id ${JSON.stringify(e?.id)}，已跳过`);
      continue;
    }
    const color = parseHexColor(e?.color ?? '');
    if (color === null) {
      console.warn(`textPalette: 色板 "${id}" 的颜色 ${JSON.stringify(e?.color)} 不是 #RRGGBB，已跳过`);
      continue;
    }
    colors.set(id, color);
    labels.set(id, String(e?.label ?? id));
  }
  if (colors.size === 0) {
    for (const e of DEFAULT_TEXT_PALETTE) {
      colors.set(e.id, parseHexColor(e.color)!);
      labels.set(e.id, e.label);
    }
  }
  paletteColors = colors;
  paletteLabels = labels;
  warnedUnknown.clear();
}

/** 当前色板（只读快照），供调试面板/编辑器桥回显 */
export function getTextPalette(): TextPaletteEntry[] {
  return [...paletteColors.entries()].map(([id, c]) => ({
    id,
    label: paletteLabels.get(id) ?? id,
    color: `#${c.toString(16).padStart(6, '0')}`,
  }));
}

export function isKnownPaletteId(id: string): boolean {
  return paletteColors.has(id);
}

/**
 * 供 `TextStyle.tagStyles` 用的映射。Pixi 只在 tagStyles 非空**且**正文含 `<` 时才解析标记，
 * 所以给每个 Text 都挂上它不会有额外开销。
 */
export function paletteTagStyles(): Record<string, { fill: number }> {
  if (paletteColors.size === 0) setTextPalette(undefined);
  const out: Record<string, { fill: number }> = {};
  for (const [id, color] of paletteColors) out[id] = { fill: color };
  return out;
}

interface Token {
  /** 纯文本片段（可能为空） */
  text: string;
  /** 该片段之后的标记：open=压栈的色板 id，close=出栈，null=串尾 */
  mark: { kind: 'open'; id: string } | { kind: 'close' } | null;
}

function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(raw); m !== null; m = TOKEN_RE.exec(raw)) {
    const text = raw.slice(last, m.index);
    out.push({ text, mark: m[1] !== undefined ? { kind: 'open', id: m[1] } : { kind: 'close' } });
    last = m.index + m[0].length;
  }
  out.push({ text: raw.slice(last), mark: null });
  return out;
}

/** 是否含样式标记（快路径判断，避免对绝大多数无标记文本做整串处理） */
export function hasStyleMarkup(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.includes('[c:') || raw.includes(CLOSE_TOKEN);
}

/**
 * 去掉全部样式标记，只留正文。
 *
 * 这是**默认路径**：未迁移到 StyledText 的显示点、以及一切把文本当数据用的地方
 * （数量解析、存档、日志、比较）都走它，保证任何位置都不会把 `[c:…]` 原样显示给玩家。
 */
export function stripStyleMarkup(raw: string | undefined): string {
  if (!hasStyleMarkup(raw)) return raw ?? '';
  return raw!.replace(OPEN_RE, '').split(CLOSE_TOKEN).join('');
}

/** 解出来的可见字数（= stripStyleMarkup 后的长度） */
export function plainTextLength(raw: string | undefined): number {
  return stripStyleMarkup(raw).length;
}

/**
 * 正文里出现裸 `<` 时的处理。
 *
 * Pixi 的解析器见到 `<` 就**一路吞到下一个 `>`**：认不出 tag 名就把整段当字面量吐出来。
 * 于是 `温度<0[c:danger]危险[/c]` 里那个 `<` 会把我们自己 `<danger>` 的 `>` 一起吃掉，
 * 结果是颜色丢了、`<danger>` 原样糊到玩家脸上——正是这套设计要防的事。
 * （早先试过"在 `<` 后插零宽连接符"，无效：解析器根本不看 tag 名就先吞到 `>`。）
 *
 * 所以规则定死两条，都可证明安全：
 * - **没有色标记**：整串原样交给 Pixi。串里没有任何 tag，`<` 不会吃到别人，显示与作者写的一致。
 * - **有色标记又有裸 `<`**：这一句**降级为纯文本**（剥掉色标记、不上色）。宁可少一处颜色，
 *   也不能让玩家看见裸标记或缺字。中文内容里两者同现极罕见，dev 下每串警告一次。
 */
function warnAngleDowngrade(src: string): void {
  if (warnedUnknown.has(src)) return;
  warnedUnknown.add(src);
  console.warn(
    'textStyle: 这段文本同时含裸 "<" 与色标记，已降级为纯文本显示（Pixi 的标记解析会吞掉 "<" 到下一个 ">" 之间的内容）：',
    src,
  );
}

/**
 * 项目标记 → Pixi tagged text。
 *
 * - 未知色板 id：**丢掉标记、保留正文**（内容里写错名字不该把字吃掉），每个 id 警告一次；
 * - 多余的 `[/c]`：忽略；
 * - 串尾仍有未闭合标记：自动补齐闭合（Pixi 要求成对，不补的话整段样式会失效）。
 *
 * `limit` 给打字机用：只输出前 `limit` 个**可见字符**，并把当时仍开着的标记补上闭合，
 * 保证任何一帧的输出都是合法的成对标记（直接对带标记的原串做 substring 会切碎标记）。
 */
export function toPixiTagged(raw: string | undefined, limit = Infinity): string {
  const src = raw ?? '';
  // 无标记：原样（含裸 `<`）。串里没有 tag，Pixi 不会吃掉任何东西。
  // ⚠ 这里**不能**先转义再按 limit 切——limit 是可见字数，切转义后的串会稳定少显示最后几个字。
  if (!hasStyleMarkup(src)) {
    return limit === Infinity ? src : src.slice(0, Math.max(0, limit));
  }
  // 有标记 + 裸 `<`：降级为纯文本（见 warnAngleDowngrade 的说明）
  if (src.includes('<')) {
    warnAngleDowngrade(src);
    const plain = stripStyleMarkup(src);
    return limit === Infinity ? plain : plain.slice(0, Math.max(0, limit));
  }
  if (paletteColors.size === 0) setTextPalette(undefined);

  const stack: string[] = [];
  let out = '';
  let shown = 0;
  let truncated = false;

  for (const tok of tokenize(src)) {
    if (tok.text) {
      const room = limit - shown;
      if (room <= 0) {
        truncated = true;
        break;
      }
      const piece = tok.text.length <= room ? tok.text : tok.text.slice(0, room);
      out += piece;
      shown += piece.length;
      if (piece.length < tok.text.length) {
        truncated = true;
        break;
      }
    }
    if (!tok.mark) break;
    // 预算已用尽就别再开新标记：后面的字一个也不会显示，开了只会吐出一对空标签
    // （`[c:a]危[/c][c:b]险[/c]` 截到 1 字时曾多出 `<b></b>`）。
    if (shown >= limit) {
      truncated = true;
      break;
    }
    if (tok.mark.kind === 'open') {
      const id = tok.mark.id;
      if (!paletteColors.has(id)) {
        if (!warnedUnknown.has(id)) {
          warnedUnknown.add(id);
          console.warn(`textStyle: 未知色板 id "${id}"（[c:${id}] 已按无色处理）`);
        }
        // 压一个哨兵：对应的 [/c] 要能配对出栈，否则后续闭合会错位
        stack.push('');
      } else {
        stack.push(id);
        out += `<${id}>`;
      }
    } else {
      const id = stack.pop();
      if (id) out += `</${id}>`;
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const id = stack[i];
    if (id) out += `</${id}>`;
  }
  return out;
}

/**
 * 按**可见字数**截断，仍返回项目标记形式（`[c:…]…[/c]`，闭合自动补齐）。
 *
 * 给"一行放不下就截到放得下"这类省略号逻辑用——那些地方原本直接 `raw.slice(0, n)`，
 * 带标记之后会切出半个 `[c:emph`，剥标记时又剥不掉，会原样糊到玩家脸上。
 */
export function sliceStyledMarkup(raw: string | undefined, limit: number): string {
  const src = raw ?? '';
  if (!hasStyleMarkup(src)) return src.slice(0, Math.max(0, limit));

  const stack: string[] = [];
  let out = '';
  let shown = 0;
  for (const tok of tokenize(src)) {
    if (tok.text) {
      const room = limit - shown;
      if (room <= 0) break;
      const piece = tok.text.length <= room ? tok.text : tok.text.slice(0, room);
      out += piece;
      shown += piece.length;
      if (piece.length < tok.text.length) break;
    }
    if (!tok.mark) break;
    if (shown >= limit) break;
    if (tok.mark.kind === 'open') {
      stack.push(tok.mark.id);
      out += `[c:${tok.mark.id}]`;
    } else if (stack.pop() !== undefined) {
      out += CLOSE_TOKEN;
    }
  }
  for (let i = 0; i < stack.length; i++) out += CLOSE_TOKEN;
  return out;
}

/**
 * 校验用：返回标记的结构性问题（未知 id / 多余闭合 / 未闭合）。
 * 运行时不调用——运行时一律按上面的容错规则显示，不因为内容写错就不显示文本。
 */
export function inspectStyleMarkup(raw: string | undefined): {
  unknownIds: string[];
  strayCloses: number;
  unclosed: number;
  /** 形如 `[c:强调]` 的非法 id（只允许字母/数字/下划线/连字符）——正则认不出来，会原样糊给玩家 */
  malformed: string[];
} {
  const src = raw ?? '';
  const unknownIds: string[] = [];
  const malformed: string[] = [];
  let strayCloses = 0;
  let depth = 0;
  if (!hasStyleMarkup(src)) return { unknownIds, strayCloses, unclosed: 0, malformed };
  // `[c:` 出现的次数必须与合法开标记数相同；多出来的就是 id 写得不合法的那些
  for (const m of src.matchAll(/\[c:([^\]]*)\]/g)) {
    const id = m[1];
    if (!/^[A-Za-z0-9_-]+$/.test(id) && !malformed.includes(id)) malformed.push(id);
  }
  for (const tok of tokenize(src)) {
    if (!tok.mark) break;
    if (tok.mark.kind === 'open') {
      depth++;
      if (!paletteColors.has(tok.mark.id) && !unknownIds.includes(tok.mark.id)) {
        unknownIds.push(tok.mark.id);
      }
    } else if (depth > 0) {
      depth--;
    } else {
      strayCloses++;
    }
  }
  return { unknownIds, strayCloses, unclosed: depth, malformed };
}
