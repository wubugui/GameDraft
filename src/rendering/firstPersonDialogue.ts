import { CanvasTextMetrics, type Graphics, type TextStyle } from 'pixi.js';

/**
 * 对白版式「第一人称」（`layout: 'firstPerson'`，2026-09-22 制作人定：设计稿方案一）的共用几何与画法。
 *
 * 第一人称画面（铺满窗口的叠图 = 关二狗眼睛看到的）里图是主角：不要木框、木钮、立绘和名牌，
 * 字直接压在图上，只在屏幕底部约三分之一铺一层由透明到黑的渐变托字。
 * 常规对话框（DialogueUI）、过场对白框（CutsceneRenderer）、动作选项条（ActionChoiceUI）三处
 * 共用这一份——排版口径只在这里定一次，哪处改了另外两处自动跟上。
 *
 * 放在渲染层是为了让过场对白框（渲染层）也能用；UI 层往下引用它合法，反过来不行。
 * 数值照设计稿（1024×768 基准），竖向距离一律量自**屏幕下沿**。
 */
export const FIRST_PERSON = {
  /** 渐变从屏高的这个比例处开始，往下越来越黑 */
  shadeTopRatio: 0.65,
  shadeMaxAlpha: 0.8,
  /** 渐变曲线：>1 = 上半段几乎不压、越近屏底越快变黑 */
  shadeCurve: 1.4,
  shadeSteps: 48,
  /** 字幕最宽；超了折行 */
  textMaxWidth: 780,
  /** 窄屏时字幕与选项行左右至少留这么多 */
  sideMargin: 64,
  /** 字号 / 行距与常规对话框正文同档（bodyLarge 25 / 行距 40） */
  fontSize: 25,
  lineHeight: 40,
  /** 只有台词：字幕块底边距屏底 */
  textBottomInset: 64,
  /** 台词与选项同屏：字幕块底边到选项摞顶边 */
  textAboveChoices: 24,
  /** 「继续」三角在字幕块底边下方多远（三角中心） */
  markGap: 12,
  /** 选项：最后一行底边距屏底 */
  choiceBottomInset: 44,
  /** 一行选项的高（字 + 下面那道金线） */
  choiceRowHeight: 40,
  choiceRowGap: 12,
  /** 同一行两个选项之间 */
  choiceGapX: 64,
  /** 序号与选项字之间 */
  choiceNumberGap: 10,
  choiceNumberFontSize: 15,
  /** 选中那一项底下金线的位置（相对选项顶）与粗细 */
  underlineY: 34,
  underlineHeight: 2,
  /** 正文：暖白（比框里的正文色更亮一档——没有深色框垫着了） */
  bodyFill: 0xefe6d2,
  /** 选项序号：暗金灰，键位提示级的配角 */
  numberFill: 0x968c78,
} as const;

/** 字压在图上靠这道影子托住（渐变之外的第二道保险：亮图上也读得清） */
export const FIRST_PERSON_TEXT_SHADOW = {
  alpha: 0.9,
  angle: Math.PI / 2,
  blur: 4,
  color: 0x000000,
  distance: 2,
} as const;

/** 底部渐变托底（整屏宽）。屏幕尺寸变了就再调一次重画。 */
export function drawFirstPersonShade(g: Graphics, sw: number, sh: number): void {
  g.clear();
  const top = sh * FIRST_PERSON.shadeTopRatio;
  const span = sh - top;
  const n = FIRST_PERSON.shadeSteps;
  for (let i = 0; i < n; i++) {
    // 条与条首尾相接、不重叠（重叠处 alpha 叠两次会出细横纹）
    const y0 = Math.round(top + (span * i) / n);
    const y1 = Math.round(top + (span * (i + 1)) / n);
    if (y1 <= y0) continue;
    const t = (i + 0.5) / n;
    g.rect(0, y0, sw, y1 - y0);
    g.fill({ color: 0x000000, alpha: FIRST_PERSON.shadeMaxAlpha * Math.pow(t, FIRST_PERSON.shadeCurve) });
  }
}

export interface FirstPersonLineLayout {
  /** 名字（可无）左上角 x */
  nameX: number;
  /** 正文左上角 x */
  bodyX: number;
  /** 字幕块顶 / 底 */
  top: number;
  bottom: number;
  /** 「继续」三角中心 */
  markX: number;
  markY: number;
}

/**
 * 字幕块版面：名字（可无）+ 正文，**整块居中、行在块内左对齐**。
 *
 * - 按**整句**量，不按打字进度量：打字时块不动、字不左右漂（逐行居中的话每打一个字整行都会挪）；
 *   也让 `[clue:]` 词条命中层照旧可用（它只支持左对齐）。
 * - 名字只占第一行，第二行起对齐正文首字。
 * - **副作用**：把算好的折行宽写回 `bodyStyle.wordWrapWidth`——量与画必须同一份样式同口径。
 *
 * @param plainText 去掉样式标记后的整句（`stripStyleMarkup`）
 * @param bodyStyle 渲染正文用的那份样式
 * @param nameWidth 名字（含冒号）的宽；无名字传 0
 * @param bottom    字幕块底边的 y
 */
export function layoutFirstPersonLine(
  plainText: string,
  bodyStyle: TextStyle,
  nameWidth: number,
  sw: number,
  bottom: number,
): FirstPersonLineLayout {
  const maxW = Math.max(160, Math.min(FIRST_PERSON.textMaxWidth, sw - FIRST_PERSON.sideMargin * 2));
  const wrapW = Math.max(80, maxW - nameWidth);
  bodyStyle.wordWrapWidth = wrapW;
  const m = CanvasTextMetrics.measureText(plainText || ' ', bodyStyle);
  const lines = Math.max(1, m.lines?.length ?? 1);
  const textW = Math.min(wrapW, Math.ceil(m.width));
  const top = bottom - lines * FIRST_PERSON.lineHeight;
  const nameX = Math.round((sw - nameWidth - textW) / 2);
  return {
    nameX,
    bodyX: nameX + nameWidth,
    top,
    bottom,
    markX: Math.round(sw / 2),
    markY: bottom + FIRST_PERSON.markGap,
  };
}

/**
 * 横排选项的版面：每项宽度已知 → 按行宽往下折、每行居中，最后一行底边落在 `choiceBottomInset`。
 * 只算几何，不建显示对象——显示与交互归宿主 UI（常规对话框 / 动作选项条）。
 *
 * @returns 每项左上角，与整摞顶边（台词同屏时字幕块压在它上面）
 */
export function layoutFirstPersonChoices(
  widths: readonly number[],
  sw: number,
  sh: number,
): { places: { x: number; y: number }[]; top: number } {
  const maxRowW = Math.max(160, sw - FIRST_PERSON.sideMargin * 2);
  const rows: number[][] = [];
  let cur: number[] = [];
  let curW = 0;
  widths.forEach((w, i) => {
    const need = cur.length ? curW + FIRST_PERSON.choiceGapX + w : w;
    if (cur.length && need > maxRowW) {
      rows.push(cur);
      cur = [i];
      curW = w;
    } else {
      cur.push(i);
      curW = need;
    }
  });
  if (cur.length) rows.push(cur);

  const stackH = rows.length * FIRST_PERSON.choiceRowHeight + Math.max(0, rows.length - 1) * FIRST_PERSON.choiceRowGap;
  const top = sh - FIRST_PERSON.choiceBottomInset - stackH;
  const places: { x: number; y: number }[] = new Array(widths.length);
  rows.forEach((row, r) => {
    const rowW = row.reduce((s, i, k) => s + widths[i] + (k ? FIRST_PERSON.choiceGapX : 0), 0);
    let x = Math.round((sw - rowW) / 2);
    const y = top + r * (FIRST_PERSON.choiceRowHeight + FIRST_PERSON.choiceRowGap);
    for (const i of row) {
      places[i] = { x, y };
      x += widths[i] + FIRST_PERSON.choiceGapX;
    }
  });
  return { places, top };
}
