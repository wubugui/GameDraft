/**
 * 带标签文字的度量与换行(逐行逐段样式)。
 * 移植自 PixiJS v8.17(MIT)`scene/text/canvas/utils/measureTaggedText.mjs`。
 */
import type { ICanvasRenderingContext2D } from '../../adapter';
import type { TextStyle } from '../../TextStyle';
import { parseTaggedText, type TextStyleRun } from './parseTaggedText';
import {
  collapseNewlines,
  collapseSpaces,
  getCharacterGroups,
  isBreakingSpace,
  isNewline,
  NEWLINE_SPLIT_REGEX,
  tokenize,
  trimRight,
} from './textTokenization';
import type { CanBreakCharsFn, MeasureTextFn, WordWrapSplitFn } from './wordWrap';

/** 字体度量(Pixi `FontMetrics`) */
export interface FontMetrics {
  ascent: number;
  descent: number;
  fontSize: number;
}

export type MeasureFontFn = (font: string) => FontMetrics;

export interface TaggedTextMeasurement {
  width: number;
  height: number;
  lines: string[];
  lineWidths: number[];
  lineHeight: number;
  maxLineWidth: number;
  fontProperties: FontMetrics;
  runsByLine: TextStyleRun[][];
  lineAscents: number[];
  lineDescents: number[];
  lineHeights: number[];
  hasDropShadow: boolean;
}

const NEWLINE_TO_SPACE_REGEX = /\r\n|\r|\n/g;

export function measureTaggedText(
  text: string,
  style: TextStyle,
  wordWrap: boolean,
  context: ICanvasRenderingContext2D,
  measureTextFn: MeasureTextFn,
  measureFontFn: MeasureFontFn,
  canBreakCharsFn: CanBreakCharsFn,
  wordWrapSplitFn: WordWrapSplitFn,
): TaggedTextMeasurement {
  const runs = parseTaggedText(text, style);
  const shouldCollapseNewlines = collapseNewlines(style.whiteSpace);
  if (shouldCollapseNewlines) {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      runs[i] = { text: run.text.replace(NEWLINE_TO_SPACE_REGEX, ' '), style: run.style };
    }
  }
  const runsByLine: TextStyleRun[][] = [];
  let currentLineRuns: TextStyleRun[] = [];
  for (const run of runs) {
    const parts = run.text.split(NEWLINE_SPLIT_REGEX);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '\r\n' || part === '\r' || part === '\n') {
        runsByLine.push(currentLineRuns);
        currentLineRuns = [];
      } else if (part.length > 0) {
        currentLineRuns.push({ text: part, style: run.style });
      }
    }
  }
  if (currentLineRuns.length > 0 || runsByLine.length === 0) {
    runsByLine.push(currentLineRuns);
  }
  const wrappedRunsByLine = wordWrap
    ? wordWrapTaggedLines(runsByLine, style, context, measureTextFn, canBreakCharsFn, wordWrapSplitFn)
    : runsByLine;
  const lineWidths: number[] = [];
  const lineAscents: number[] = [];
  const lineDescents: number[] = [];
  const lineHeightsArr: number[] = [];
  const lines: string[] = [];
  let maxLineWidth = 0;
  const baseFont = style._fontString;
  const baseFontProps = measureFontFn(baseFont);
  if (baseFontProps.fontSize === 0) {
    baseFontProps.fontSize = style.fontSize;
    baseFontProps.ascent = style.fontSize;
  }
  let lastFont = '';
  let hasDropShadow = !!style.dropShadow;
  let maxRunStrokeWidth = style._stroke?.width || 0;
  for (const lineRuns of wrappedRunsByLine) {
    let lineWidth = 0;
    let lineAscent = baseFontProps.ascent;
    let lineDescent = baseFontProps.descent;
    let lineText = '';
    for (const run of lineRuns) {
      const runFont = run.style._fontString;
      const runFontProps = measureFontFn(runFont);
      if (runFont !== lastFont) {
        context.font = runFont;
        lastFont = runFont;
      }
      const runWidth = measureTextFn(run.text, run.style.letterSpacing, context);
      lineWidth += runWidth;
      lineAscent = Math.max(lineAscent, runFontProps.ascent);
      lineDescent = Math.max(lineDescent, runFontProps.descent);
      lineText += run.text;
      const runStrokeWidth = run.style._stroke?.width || 0;
      if (runStrokeWidth > maxRunStrokeWidth) maxRunStrokeWidth = runStrokeWidth;
      if (!hasDropShadow && run.style.dropShadow) {
        hasDropShadow = true;
      }
    }
    if (lineRuns.length === 0) {
      lineAscent = baseFontProps.ascent;
      lineDescent = baseFontProps.descent;
    }
    lineWidths.push(lineWidth);
    lineAscents.push(lineAscent);
    lineDescents.push(lineDescent);
    lines.push(lineText);
    const computedLineHeight = style.lineHeight || lineAscent + lineDescent;
    lineHeightsArr.push(computedLineHeight + style.leading);
    maxLineWidth = Math.max(maxLineWidth, lineWidth);
  }
  const strokeWidth = maxRunStrokeWidth;
  const useWrapWidth = wordWrap && style.align !== 'left';
  const alignWidth = useWrapWidth ? Math.max(maxLineWidth, style.wordWrapWidth) : maxLineWidth;
  const width = alignWidth + strokeWidth + (style.dropShadow ? style.dropShadow.distance : 0);
  let baseHeight = 0;
  for (let i = 0; i < lineHeightsArr.length; i++) {
    baseHeight += lineHeightsArr[i];
  }
  baseHeight = Math.max(baseHeight, lineHeightsArr[0] + strokeWidth);
  const height = baseHeight + (style.dropShadow ? style.dropShadow.distance : 0);
  const baseLineHeight = style.lineHeight || baseFontProps.fontSize;
  return {
    width,
    height,
    lines,
    lineWidths,
    lineHeight: baseLineHeight + style.leading,
    maxLineWidth,
    fontProperties: baseFontProps,
    runsByLine: wrappedRunsByLine,
    lineAscents,
    lineDescents,
    lineHeights: lineHeightsArr,
    hasDropShadow,
  };
}

interface StyledToken {
  token: string;
  style: TextStyle;
  continuesFromPrevious: boolean;
}

export function wordWrapTaggedLines(
  runsByLine: TextStyleRun[][],
  style: TextStyle,
  context: ICanvasRenderingContext2D,
  measureTextFn: MeasureTextFn,
  canBreakCharsFn: CanBreakCharsFn,
  wordWrapSplitFn: WordWrapSplitFn,
): TextStyleRun[][] {
  const { letterSpacing, whiteSpace, wordWrapWidth, breakWords } = style;
  const shouldCollapseSpaces = collapseSpaces(whiteSpace);
  const adjustedWrapWidth = wordWrapWidth + letterSpacing;
  const tokenWidthCache: Record<string, number> = {};
  let lastFont = '';
  const measureTokenWidth = (token: string, tokenStyle: TextStyle): number => {
    const cacheKey = `${token}|${tokenStyle.styleKey}`;
    let width = tokenWidthCache[cacheKey];
    if (width === undefined) {
      const font = tokenStyle._fontString;
      if (font !== lastFont) {
        context.font = font;
        lastFont = font;
      }
      width = measureTextFn(token, tokenStyle.letterSpacing, context) + tokenStyle.letterSpacing;
      tokenWidthCache[cacheKey] = width;
    }
    return width;
  };
  const result: TextStyleRun[][] = [];
  for (const lineRuns of runsByLine) {
    const styledTokens = tokenizeTaggedRuns(lineRuns);
    const resultStartLength = result.length;
    const getWordGroupWidth = (startIndex: number): number => {
      let totalWidth = 0;
      let j = startIndex;
      do {
        const { token: groupToken, style: groupStyle } = styledTokens[j];
        totalWidth += measureTokenWidth(groupToken, groupStyle);
        j++;
      } while (j < styledTokens.length && styledTokens[j].continuesFromPrevious);
      return totalWidth;
    };
    const getWordGroupTokens = (startIndex: number): Array<{ token: string; style: TextStyle }> => {
      const tokens: Array<{ token: string; style: TextStyle }> = [];
      let j = startIndex;
      do {
        tokens.push({ token: styledTokens[j].token, style: styledTokens[j].style });
        j++;
      } while (j < styledTokens.length && styledTokens[j].continuesFromPrevious);
      return tokens;
    };
    let currentLineRuns: TextStyleRun[] = [];
    let currentWidth = 0;
    let canPrependSpaces = !shouldCollapseSpaces;
    let buildingRun: TextStyleRun | null = null;
    const flushBuildingRun = (): void => {
      if (buildingRun && buildingRun.text.length > 0) {
        currentLineRuns.push(buildingRun);
      }
      buildingRun = null;
    };
    const startNewLine = (): void => {
      flushBuildingRun();
      if (currentLineRuns.length > 0) {
        const lastRun = currentLineRuns[currentLineRuns.length - 1];
        lastRun.text = trimRight(lastRun.text);
        if (lastRun.text.length === 0) currentLineRuns.pop();
      }
      result.push(currentLineRuns);
      currentLineRuns = [];
      currentWidth = 0;
      canPrependSpaces = false;
    };
    for (let i = 0; i < styledTokens.length; i++) {
      const { token, style: tokenStyle, continuesFromPrevious } = styledTokens[i];
      const tokenWidth = measureTokenWidth(token, tokenStyle);
      if (shouldCollapseSpaces) {
        const currIsSpace = isBreakingSpace(token);
        const br = buildingRun as TextStyleRun | null;
        const lastChar = br?.text[br.text.length - 1] ?? currentLineRuns[currentLineRuns.length - 1]?.text.slice(-1) ?? '';
        const lastIsSpace = lastChar ? isBreakingSpace(lastChar) : false;
        if (currIsSpace && lastIsSpace) continue;
      }
      const startsWordGroup = !continuesFromPrevious;
      const wordGroupWidth = startsWordGroup ? getWordGroupWidth(i) : tokenWidth;
      if (wordGroupWidth > adjustedWrapWidth && startsWordGroup) {
        if (currentWidth > 0) startNewLine();
        if (breakWords) {
          const wordGroupTokens = getWordGroupTokens(i);
          for (let g = 0; g < wordGroupTokens.length; g++) {
            const groupToken = wordGroupTokens[g].token;
            const groupStyle = wordGroupTokens[g].style;
            const charGroups = getCharacterGroups(groupToken, breakWords, wordWrapSplitFn, canBreakCharsFn);
            for (const char of charGroups) {
              const charWidth = measureTokenWidth(char, groupStyle);
              if (charWidth + currentWidth > adjustedWrapWidth) startNewLine();
              const br = buildingRun as TextStyleRun | null;
              if (!br || br.style !== groupStyle) {
                flushBuildingRun();
                buildingRun = { text: char, style: groupStyle };
              } else {
                br.text += char;
              }
              currentWidth += charWidth;
            }
          }
          i += wordGroupTokens.length - 1;
        } else {
          const wordGroupTokens = getWordGroupTokens(i);
          flushBuildingRun();
          result.push(wordGroupTokens.map((t) => ({ text: t.token, style: t.style })));
          canPrependSpaces = false;
          i += wordGroupTokens.length - 1;
        }
      } else if (wordGroupWidth + currentWidth > adjustedWrapWidth && startsWordGroup) {
        if (isBreakingSpace(token)) {
          canPrependSpaces = false;
          continue;
        }
        startNewLine();
        buildingRun = { text: token, style: tokenStyle };
        currentWidth = tokenWidth;
      } else if (continuesFromPrevious && !breakWords) {
        const br = buildingRun as TextStyleRun | null;
        if (!br || br.style !== tokenStyle) {
          flushBuildingRun();
          buildingRun = { text: token, style: tokenStyle };
        } else {
          br.text += token;
        }
        currentWidth += tokenWidth;
      } else {
        const isSpace = isBreakingSpace(token);
        if (currentWidth === 0 && isSpace && !canPrependSpaces) continue;
        const br = buildingRun as TextStyleRun | null;
        if (!br || br.style !== tokenStyle) {
          flushBuildingRun();
          buildingRun = { text: token, style: tokenStyle };
        } else {
          br.text += token;
        }
        currentWidth += tokenWidth;
      }
    }
    flushBuildingRun();
    if (currentLineRuns.length > 0) {
      const lastRun = currentLineRuns[currentLineRuns.length - 1];
      lastRun.text = trimRight(lastRun.text);
      if (lastRun.text.length === 0) currentLineRuns.pop();
    }
    if (currentLineRuns.length > 0 || result.length === resultStartLength) {
      result.push(currentLineRuns);
    }
  }
  return result;
}

export function tokenizeTaggedRuns(runs: TextStyleRun[]): StyledToken[] {
  const styledTokens: StyledToken[] = [];
  let lastTokenWasWord = false;
  for (const run of runs) {
    const tokens = tokenize(run.text);
    let isFirstTokenInRun = true;
    for (const token of tokens) {
      const isSpace = isBreakingSpace(token) || isNewline(token);
      const continuesFromPrevious = isFirstTokenInRun && lastTokenWasWord && !isSpace;
      styledTokens.push({ token, style: run.style, continuesFromPrevious });
      lastTokenWasWord = !isSpace;
      isFirstTokenInRun = false;
    }
  }
  return styledTokens;
}
