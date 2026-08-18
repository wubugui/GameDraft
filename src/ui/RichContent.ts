import { CanvasTextMetrics, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';
import { mediaUrlFromShortPath } from '../core/projectPaths';
import { UITheme } from './UITheme';
import { markPointerConsumed } from './uiPointerCoords';
import { paletteTagStyles, styledRuns } from '../core/textStyle';
import { createStyledText } from '../core/styledText';
import { parseRichMarkup, type RichBlock, type RichImageSize } from '../core/richMarkup';

/**
 * 册子/成书正文的**run 级版式引擎**（审查批3a：图文排版与可点词条共用的同一块地基）。
 *
 * v1 是"分段渲染器"：整段丢进单个 Pixi Text，只认 [img:] 一个标记——是"能塞图的纯文本"，
 * 不是排版；且单 Text 不暴露字形几何，行内可点物理不可行。v2 分两层：
 *
 * **块级**（文档结构）：标题 / 正文段 / 引文 / 插图（inline·wide·full 三档 + 图注）/ 分隔线。
 *   数据侧标记（行首生效）：`[h]小节标题`、`[quote]…[/quote]`、`[hr]`、
 *   `[img:路径]` / `[img:路径|wide]` / `[img:路径|full]`、紧跟图后的 `[caption]图注`；
 *   空行 = 分段。程序侧可以直接喂 `RichBlock[]`（五本册子把印象/例句/来源拼成结构而非字符串）。
 *
 * **行内**（run 排版）：`[c:id]…[/c]` 染色 run；正文逐 run 自建 Text、中文逐字断行、
 *   拉丁词整词断行、行首禁则（句读不落行首）。每个 run 落成的行内片段都有几何矩形——
 *   带 `link` 的 run 自动挂 hitArea + markPointerConsumed（批4 线索词条的命中层就是它）。
 *   ⚠ 本路径**不经过 Pixi tagged text**：正文里的裸 `<` 就是普通字符，无降级（textStyle
 *   单 Text 路径的"裸 < 降级"地雷在这里天然不存在）。
 */

const SEGMENT_GAP = 10;

/** 把 ``[img:...]`` 短名解析为媒体 URL，统一走 ProjectPaths 同语义入口。 */
export function resolveContentImageUrl(ref: string): string {
  try {
    return mediaUrlFromShortPath(ref);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 块模型与标记解析：已下沉到 core/richMarkup（systems 预热与本引擎共用同一份语法），
// 这里原样再导出,既有 UI 消费方 import 面不变。
// ---------------------------------------------------------------------------

export { parseRichMarkup };
export type { RichBlock, RichImageSize };

/** 行内 run 的交互语义（批4 线索系统在 textStyle 层扩出 [clue:id] 后填进来） */
export interface RichLink {
  kind: string;
  id: string;
}

/** 可点片段的命中登记（内容坐标系），供调用方接 UIFocus / 调试 */
export interface RichSpan {
  rect: Rectangle;
  link: RichLink;
}

/** 文档配色：暗底/纸页两套预设；markup 是 [c:] 语义色的按面替换 */
export interface RichPalette {
  body: number;
  muted: number;
  faint: number;
  heading: number;
  rule: number;
  quote: number;
  markup?: Record<string, number>;
  /** 已采集线索词条的常驻色（K7）；缺省退 faint */
  linkCollected?: number;
  /**
   * 引文左侧那根竖线的颜色；缺省退 `rule`。
   * 引文与正文**同重**（见 RICH_DARK 的说明），把它们分成两个声部的就是这根线——
   * 所以它得看得见（琥珀），不是又一根淡到没有的分栏线。
   */
  quoteBar?: number;
}

/**
 * 暗底文档色板（册子右栏 / 成书内页 / 一切长正文）。**全站只有这一套**——
 * 米白纸页那一套 `RICH_PAPER` 已随批3a 的商业档案观感一起撤销，理由见
 * `ArchiveBookView` 顶部注释（一句话：这游戏没有亮面板）。
 *
 * 明度阶梯（对面板底 (9,8,6) 实测算）：
 *   引文/正文 14.8:1 → 次要段 10.7:1 → 注/来源 4.9:1；标题走琥珀 13.6:1。
 * ⚠ `quote` 原来直接等于 `muted`（**同一个色号**）：于是歪歌册里真正要读的那首歌谣，
 * 与它下面那条"备注"一模一样重——本该最响的声部被压成了配角。引文与正文同重，
 * 把它们分开的是**缩进 + 琥珀竖线**，不是压暗。
 */
export const RICH_DARK: RichPalette = {
  body: UITheme.colors.body,
  muted: UITheme.colors.bodyMuted,
  faint: UITheme.colors.hintMid,
  heading: UITheme.colors.title,
  rule: UITheme.colors.titleRule,
  quote: UITheme.colors.body,
  linkCollected: UITheme.colors.goldDim,
  quoteBar: UITheme.colors.goldDim,
};

export interface RichContentOptions {
  width: number;
  fontSize: number;
  fontFamily: string;
  lineHeight?: number;
  /** 兼容旧调用：给了就覆盖 palette.body */
  fill?: number;
  palette?: RichPalette;
  imageMaxHeight?: number;
  /**
   * 插图异步到位后的重排钩子。**不给就等于插图永远不显示**——见下方 `loadOnce` 的说明。
   * 调用方应在回调里整段重画（图有了高度会变，就地塞 Sprite 排不回去）。
   */
  onImageLoaded?: () => void;
  /** 可点 run 被点击时回调（批4 线索采集入口） */
  onLinkTap?: (link: RichLink) => void;
  /** 词条状态：fresh=未采集（苔绿亮）/ collected=已采集（暗金常驻）。不给 = 全按 fresh 画 */
  linkStateResolver?: (link: RichLink) => 'fresh' | 'collected';
}

// ---------------------------------------------------------------------------
// 插图装载（与 v1 相同的登记逻辑）
// ---------------------------------------------------------------------------

const inFlight = new Set<string>();
const failed = new Set<string>();

function loadOnce(url: string, assetManager: AssetManager, onDone?: () => void): void {
  if (!url || inFlight.has(url) || failed.has(url)) return;
  inFlight.add(url);
  assetManager.loadTexture(url)
    .then(() => { onDone?.(); })
    .catch((e) => {
      failed.add(url);
      console.warn('RichContent: 插图装载失败，保留占位块', url, e);
    })
    .finally(() => { inFlight.delete(url); });
}

// ---------------------------------------------------------------------------
// run 级段落排版
// ---------------------------------------------------------------------------

/** 排版单元：CJK 单字 / 拉丁词 / 空格 / 换行 */
interface LayoutUnit {
  text: string;
  paletteId: string | null;
  link: RichLink | null;
  kind: 'cjk' | 'word' | 'space' | 'newline';
}

/** 行首禁则：这些落在行首会被钉回上一行行尾（允许轻微超宽——中文排印的通行处理） */
const NO_LINE_START = new Set([...'，。、！？；：）」』】》〉…—·', ')', ',', '.', '!', '?', ';', ':', '%']);
/** 行尾禁则：开引号/开括号不留在行尾 */
const NO_LINE_END = new Set([...'（「『【《〈', '(']);

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x2e80 && code <= 0x9fff)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef);
}

function unitsFromRuns(
  runs: { text: string; paletteId: string | null; link?: RichLink | null }[],
): LayoutUnit[] {
  const units: LayoutUnit[] = [];
  for (const run of runs) {
    let word = '';
    const flushWord = (): void => {
      if (word) {
        units.push({ text: word, paletteId: run.paletteId, link: run.link ?? null, kind: 'word' });
        word = '';
      }
    };
    for (const ch of Array.from(run.text)) {
      if (ch === '\n') { flushWord(); units.push({ text: '\n', paletteId: run.paletteId, link: run.link ?? null, kind: 'newline' }); continue; }
      if (ch === ' ' || ch === '\t') { flushWord(); units.push({ text: ' ', paletteId: run.paletteId, link: run.link ?? null, kind: 'space' }); continue; }
      if (isCjk(ch)) { flushWord(); units.push({ text: ch, paletteId: run.paletteId, link: run.link ?? null, kind: 'cjk' }); continue; }
      word += ch;
    }
    flushWord();
  }
  return units;
}

/** 度量缓存：同一 (字号|字族|文本) 的宽度只量一次。度量与 fill 无关，键里不含颜色。 */
const measureCache = new Map<string, number>();
const measureStyles = new Map<string, TextStyle>();

function measureUnit(text: string, fontSize: number, fontFamily: string): number {
  const styleKey = `${fontSize}|${fontFamily}`;
  const key = `${styleKey}|${text}`;
  const hit = measureCache.get(key);
  if (hit !== undefined) return hit;
  let style = measureStyles.get(styleKey);
  if (!style) {
    style = new TextStyle({ fontSize, fontFamily });
    measureStyles.set(styleKey, style);
  }
  const w = CanvasTextMetrics.measureText(text, style).width;
  measureCache.set(key, w);
  return w;
}

interface ParagraphLayout {
  container: Container;
  height: number;
  spans: RichSpan[];
}

/**
 * 一段正文的 run 排版：贪心断行 + 行首/行尾禁则，按（行 × run）合并成 Text 片段。
 * 片段矩形即 span 几何——单 Text 时代"无字形几何、行内不可点"的墙在这里拆掉。
 */
function layoutParagraph(
  runs: { text: string; paletteId: string | null; link?: RichLink | null }[],
  opts: {
    width: number;
    fontSize: number;
    fontFamily: string;
    lineHeight: number;
    baseFill: number;
    palette: RichPalette;
    onLinkTap?: (link: RichLink) => void;
    /** 词条落色（状态感知，由 buildRichDoc 现算闭包） */
    linkFill?: (link: RichLink) => number;
  },
): ParagraphLayout {
  const container = new Container();
  const spans: RichSpan[] = [];
  const units = unitsFromRuns(runs);

  // 1) 断行
  const lines: LayoutUnit[][] = [];
  let line: LayoutUnit[] = [];
  let lineW = 0;
  const pushLine = (): void => {
    // 行尾空格不占位
    while (line.length > 0 && line[line.length - 1].kind === 'space') line.pop();
    lines.push(line);
    line = [];
    lineW = 0;
  };
  for (const u of units) {
    if (u.kind === 'newline') { pushLine(); continue; }
    if (u.kind === 'space' && line.length === 0) continue; // 行首空格丢弃
    const w = measureUnit(u.text, opts.fontSize, opts.fontFamily);
    if (lineW + w > opts.width && line.length > 0) {
      // 行首禁则：句读钉回上一行行尾（轻微超宽），开引号挪去下一行
      if (u.text.length === 1 && NO_LINE_START.has(u.text)) {
        line.push(u);
        pushLine();
        continue;
      }
      const last = line[line.length - 1];
      if (last && last.text.length === 1 && NO_LINE_END.has(last.text)) {
        line.pop();
        pushLine();
        line.push(last);
        lineW = measureUnit(last.text, opts.fontSize, opts.fontFamily);
      } else {
        pushLine();
      }
      if (u.kind === 'space') continue;
    }
    line.push(u);
    lineW += w;
  }
  if (line.length > 0) pushLine();

  // 2) 逐行合并同色同链接的片段 → Text
  let y = 0;
  for (const ln of lines) {
    let x = 0;
    let i = 0;
    while (i < ln.length) {
      const start = ln[i];
      let text = start.text;
      let j = i + 1;
      while (
        j < ln.length
        && ln[j].paletteId === start.paletteId
        && (ln[j].link?.id ?? null) === (start.link?.id ?? null)
        && (ln[j].link?.kind ?? null) === (start.link?.kind ?? null)
      ) {
        text += ln[j].text;
        j++;
      }
      const fragW = measureUnit(text, opts.fontSize, opts.fontFamily);
      // 无标记片段仍走 createStyledText（拿到统一的字体渲染路径），颜色显式给。
      // 词条片段的颜色按采集状态落（fresh 苔绿 / collected 暗金），压过行内 [c:]。
      const fragFill = start.link && opts.linkFill
        ? opts.linkFill(start.link)
        : start.paletteId ? resolvePaletteColor(start.paletteId, opts) : opts.baseFill;
      const frag: Text = createStyledText({
        text,
        style: {
          fontSize: opts.fontSize,
          fill: fragFill,
          fontFamily: opts.fontFamily,
        },
      });
      frag.position.set(Math.round(x), Math.round(y));
      frag.eventMode = 'none';
      container.addChild(frag);

      if (start.link) {
        const rect = new Rectangle(x, y, fragW, opts.lineHeight);
        spans.push({ rect, link: start.link });

        // 悬停下划：沿用「点亮一档琥珀」定稿语汇的一条短金线
        const underline = new Graphics();
        underline.rect(x, y + opts.lineHeight - 4, fragW, 1.5);
        underline.fill({ color: UITheme.colors.borderSelected, alpha: 0.9 });
        underline.visible = false;
        underline.eventMode = 'none';
        container.addChild(underline);

        const hit = new Graphics();
        hit.rect(rect.x, rect.y, rect.width, rect.height);
        hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        const link = start.link;
        hit.on('pointerover', () => { underline.visible = true; });
        hit.on('pointerout', () => { underline.visible = false; });
        hit.on('pointerdown', (e) => {
          markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
          // 采集闪金：词条上盖一层琥珀速闪（280ms 淡出），给"记下了"一个看得见的落点
          const flash = new Graphics();
          flash.rect(rect.x, rect.y, rect.width, rect.height);
          flash.fill({ color: UITheme.colors.gold, alpha: 0.45 });
          flash.eventMode = 'none';
          container.addChild(flash);
          const start2 = performance.now();
          const fade = (): void => {
            if (flash.destroyed) return;
            const t = Math.min(1, (performance.now() - start2) / 280);
            flash.alpha = 1 - UITheme.motion.easeOut(t);
            if (t < 1) requestAnimationFrame(fade);
            else {
              if (flash.parent) flash.parent.removeChild(flash);
              flash.destroy();
            }
          };
          requestAnimationFrame(fade);
          opts.onLinkTap?.(link);
        });
        container.addChild(hit);
      }

      x += fragW;
      i = j;
    }
    y += opts.lineHeight;
  }

  return { container, height: Math.max(0, lines.length * opts.lineHeight), spans };

  /** [c:id] 的落色：本面替换映射（纸页）> 全局语义色板（game_config.textPalette）> 基础色 */
  function resolvePaletteColor(paletteId: string, o: typeof opts): number {
    const override = o.palette.markup?.[paletteId];
    if (override !== undefined) return override;
    return paletteTagStyles()[paletteId]?.fill ?? o.baseFill;
  }
}

// ---------------------------------------------------------------------------
// 文档装配
// ---------------------------------------------------------------------------

export interface RichDocResult {
  container: Container;
  totalHeight: number;
  spans: RichSpan[];
}

/** 图档：inline 贴左小图（v1 语义）、wide 居中大图、full 通栏（只受栏宽约束） */
const IMAGE_MAX_H: Record<RichImageSize, number> = { inline: 200, wide: 340, full: 4096 };

export function buildRichDoc(
  blocks: RichBlock[],
  options: RichContentOptions,
  assetManager: AssetManager,
): RichDocResult {
  const palette = options.palette ?? RICH_DARK;
  const baseFill = options.fill ?? palette.body;
  const fontSize = options.fontSize;
  const lineHeight = options.lineHeight ?? Math.round(fontSize * 1.5);
  const container = new Container();
  const spans: RichSpan[] = [];
  let y = 0;

  // 词条状态落色：fresh=clue 语义色（纸面走 markup 替换），collected=暗金常驻
  const linkFill = (link: RichLink): number => {
    if (options.linkStateResolver?.(link) === 'collected') {
      return palette.linkCollected ?? palette.faint;
    }
    return palette.markup?.clue ?? paletteTagStyles()['clue']?.fill ?? palette.body;
  };

  const addParagraph = (text: string, fill: number, size = fontSize, lh = lineHeight): void => {
    const runs = styledRuns(text);
    const laid = layoutParagraph(runs, {
      width: options.width,
      fontSize: size,
      fontFamily: options.fontFamily,
      lineHeight: lh,
      baseFill: fill,
      palette,
      onLinkTap: options.onLinkTap,
      linkFill,
    });
    laid.container.y = y;
    container.addChild(laid.container);
    for (const s of laid.spans) {
      s.rect.y += y;
      spans.push(s);
    }
    y += laid.height + SEGMENT_GAP;
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        // 小节标题：display 族 + 拉字距 + 右侧渐隐横线——"文字没有重点"的册面解法之一
        const h = createStyledText({
          text: block.text,
          style: {
            fontSize: Math.round(fontSize * 1.1),
            fill: palette.heading,
            fontFamily: UITheme.fonts.display,
            fontWeight: 'bold',
            letterSpacing: UITheme.letterSpacing.title,
          },
        });
        h.eventMode = 'none';
        h.y = y + UITheme.spacing.xs;
        container.addChild(h);
        const ruleX = h.width + UITheme.spacing.md;
        const ruleW = options.width - ruleX;
        if (ruleW > 24) {
          const rule = new Graphics();
          rule.rect(ruleX, y + UITheme.spacing.xs + Math.round(h.height / 2), ruleW, 1);
          rule.fill({ color: palette.rule, alpha: 0.6 });
          rule.eventMode = 'none';
          container.addChild(rule);
        }
        y += h.height + UITheme.spacing.xs + UITheme.spacing.sm;
        break;
      }
      case 'paragraph': {
        const tone = block.tone ?? 'body';
        const fill = tone === 'body' ? baseFill : tone === 'muted' ? palette.muted : palette.faint;
        const size = tone === 'faint' ? Math.max(UITheme.fontSize.small, fontSize - 4) : fontSize;
        const lh = tone === 'faint' ? Math.round(size * 1.5) : lineHeight;
        addParagraph(block.text, fill, size, lh);
        break;
      }
      case 'quote': {
        // 引文：左缩进 + 竖墨线 + 弱化色——例句/引语与正文拉开声部
        const inset = UITheme.spacing.lg;
        const runs = styledRuns(block.text);
        const laid = layoutParagraph(runs, {
          width: options.width - inset,
          fontSize,
          fontFamily: options.fontFamily,
          lineHeight,
          baseFill: palette.quote,
          palette,
          onLinkTap: options.onLinkTap,
          linkFill,
        });
        const bar = new Graphics();
        // 2px 的一条在 1024 宽的纸上是根发丝；引文靠它分声部，得看得见（3px + 不透明）
        bar.rect(0, y + 2, 3, Math.max(2, laid.height - 4));
        bar.fill({ color: palette.quoteBar ?? palette.rule, alpha: 0.9 });
        bar.eventMode = 'none';
        container.addChild(bar);
        laid.container.position.set(inset, y);
        container.addChild(laid.container);
        for (const s of laid.spans) {
          s.rect.x += inset;
          s.rect.y += y;
          spans.push(s);
        }
        y += laid.height + SEGMENT_GAP;
        break;
      }
      case 'divider': {
        const rule = new Graphics();
        rule.rect(Math.round(options.width * 0.18), y + 4, Math.round(options.width * 0.64), 1);
        rule.fill({ color: palette.rule, alpha: 0.55 });
        rule.eventMode = 'none';
        container.addChild(rule);
        y += 9 + SEGMENT_GAP;
        break;
      }
      case 'image': {
        const size = block.size ?? 'inline';
        const resolved = resolveContentImageUrl(block.path);
        const tex = resolved ? assetManager.getTexture(resolved) : null;
        const maxH = Math.min(options.imageMaxHeight ?? IMAGE_MAX_H[size], IMAGE_MAX_H[size]);
        if (tex && tex !== Texture.EMPTY) {
          const sprite = new Sprite(tex);
          const scale = Math.min(options.width / tex.width, maxH / tex.height, size === 'full' ? options.width / tex.width : 1);
          sprite.width = tex.width * scale;
          sprite.height = tex.height * scale;
          // inline 贴左（与文字齐），wide/full 居中——商业档案版式的通行做法
          sprite.x = size === 'inline' ? 0 : Math.round((options.width - sprite.width) / 2);
          sprite.y = y;
          container.addChild(sprite);
          y += sprite.height;
        } else {
          loadOnce(resolved, assetManager, options.onImageLoaded);
          const ph = new Graphics();
          const phW = size === 'inline' ? Math.min(options.width, 200) : options.width;
          const phH = size === 'inline' ? 60 : 120;
          const phX = size === 'inline' ? 0 : 0;
          // 插图缺位占位块：素净空位，**不写资源路径**（那是玩家在读的册页，露路径既穿帮又像 bug）
          ph.roundRect(phX, y, phW, phH, UITheme.panel.borderRadiusSmall);
          ph.fill({ color: UITheme.colors.rowBgInactive, alpha: 0.35 });
          ph.roundRect(phX, y, phW, phH, UITheme.panel.borderRadiusSmall);
          ph.stroke({ color: palette.rule, width: 1, alpha: 0.5 });
          ph.eventMode = 'none';
          container.addChild(ph);
          y += phH;
        }
        if (block.caption) {
          const cap = createStyledText({
            text: block.caption,
            style: {
              fontSize: UITheme.fontSize.small,
              fill: palette.faint,
              fontFamily: options.fontFamily,
              wordWrap: true, breakWords: true, wordWrapWidth: options.width,
            },
          });
          cap.eventMode = 'none';
          cap.position.set(Math.round((options.width - cap.width) / 2), y + UITheme.spacing.xs);
          container.addChild(cap);
          y += cap.height + UITheme.spacing.xs;
        }
        y += SEGMENT_GAP;
        break;
      }
    }
  }

  return { container, totalHeight: Math.max(0, y - SEGMENT_GAP), spans };
}

/** 旧签名入口：解析标记 → 块 → 排版。v1 的调用方（册子右栏 / 成书内页）原样迁移。 */
export function buildRichContent(
  raw: string,
  options: RichContentOptions,
  assetManager: AssetManager,
): RichDocResult {
  return buildRichDoc(parseRichMarkup(raw), options, assetManager);
}
