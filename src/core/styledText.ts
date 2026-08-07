/**
 * 带语义色板的 Pixi 文本工厂。
 *
 * 刻意**不做 Text 的子类**：Pixi 的 `AbstractText` 在构造函数里就会给 `this.text` 赋值，
 * 而 TS 类字段的初始化排在 `super()` 之后——子类里任何用来记「原始带标记文本」的字段都会被
 * 那次初始化抹掉一次，是个只在特定赋值顺序下才发作的坑。这里改用「真 Text + WeakMap 记原文」，
 * 调用点拿到的就是货真价实的 `Text`（anchor / style / mask / width 全部照旧可用），
 * 迁移只是把 `new Text(` 换成 `createStyledText(`、把 `x.text = s` 换成 `setStyledText(x, s)`。
 *
 * 不含标记的文本走快路径，行为与迁移前逐像素一致（同字号 ⇒ 行高、换行、面板高度都不变）。
 */

import { Text, TextStyle } from 'pixi.js';
import type { TextOptions, TextStyleOptions } from 'pixi.js';
import { hasStyleMarkup, paletteTagStyles, plainTextLength, toPixiTagged } from './textStyle';

/** Text → 它当前承载的「原始带标记文本」。用 WeakMap 是为了不往 Pixi 对象上挂私有字段。 */
const rawByText = new WeakMap<Text, string>();

/**
 * 这一串**要不要**挂色板。
 *
 * ⚠ 挂了 tagStyles 之后，正文里字面写着的 `<dim>` / `<emphasis>` 对 Pixi 就是**真 tag**：
 * 它会把 `<dim>` 整段吞掉，其后所有字被无声染色且永不闭合（实测 1778 处不一致）。
 * 所以只有"这一串真的要上色"时才挂——
 * - 没有 `[c:…]` 标记 → 不挂，正文里的 `<…>` 原样显示；
 * - 有标记但同时有裸 `<` → `toPixiTagged` 已降级成纯文本，也不用挂。
 */
function needsTagStyles(raw: string): boolean {
  return hasStyleMarkup(raw) && !raw.includes('<');
}

/** 按需开关某个 Text 的色板（值没变就不动，避免打字机逐帧触发样式重算）。 */
function syncTagStyles(target: Text, needed: boolean): void {
  const has = !!target.style.tagStyles;
  if (needed === has) return;
  target.style.tagStyles = needed ? paletteTagStyles() : undefined;
}

/**
 * 建 Text 时的样式补全。
 */
function withPalette(
  style: TextStyleOptions | TextStyle | undefined,
  needed: boolean,
): TextStyleOptions | TextStyle {
  if (!needed) return style ?? {};
  const tagStyles = paletteTagStyles();
  if (style instanceof TextStyle) {
    // 共享 TextStyle 实例（多个 Text 共用一份）：就地补上 tagStyles，不复制，
    // 否则调用点后续改这份 style 时新 Text 不跟随。
    if (!style.tagStyles) style.tagStyles = tagStyles;
    return style;
  }
  return { ...(style ?? {}), tagStyles };
}

/**
 * 建一个支持 `[c:…]` 语义色板的 `Text`。
 * `options.text` 按带标记文本处理；其余选项原样透传给 Pixi。
 */
export function createStyledText(options: TextOptions = {}): Text {
  const raw = options.text === undefined || options.text === null ? '' : String(options.text);
  const t = new Text({
    ...options,
    text: toPixiTagged(raw),
    style: withPalette(options.style, needsTagStyles(raw)),
  });
  rawByText.set(t, raw);
  return t;
}

/**
 * 给一个 `Text` 设置带标记文本。
 *
 * `revealCount` 是**可见字数**上限（打字机用）：直接对带标记的原串做 `substring` 会把标记切碎，
 * 必须走这里，由 `toPixiTagged` 保证任何一帧输出的标记都是成对的。
 */
export function setStyledText(target: Text, raw: string | undefined, revealCount = Infinity): void {
  const src = raw ?? '';
  rawByText.set(target, src);
  syncTagStyles(target, needsTagStyles(src));
  target.text = toPixiTagged(src, revealCount);
}

/** 只改打字机进度、不改内容（内容由上一次 setStyledText 决定） */
export function setStyledReveal(target: Text, revealCount: number): void {
  const raw = rawByText.get(target) ?? '';
  syncTagStyles(target, needsTagStyles(raw));
  target.text = toPixiTagged(raw, revealCount);
}

/** 该 Text 当前承载的原始带标记文本（没经过本模块设置过则返回它的字面 text） */
export function getStyledRaw(target: Text): string {
  return rawByText.get(target) ?? target.text;
}

/** 该 Text 的可见字数（打字机的终点） */
export function styledPlainLength(target: Text): number {
  return plainTextLength(getStyledRaw(target));
}
