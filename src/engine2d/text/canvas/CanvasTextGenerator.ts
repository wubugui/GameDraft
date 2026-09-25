/**
 * 把文字画到画布上(位图文字的像素来源)。
 * 移植自 PixiJS v8.17(MIT)`scene/text/canvas/CanvasTextGenerator.mjs`:画布尺寸 / padding / 分辨率缩放、
 * 投影先画(文字画到画布外、靠 shadowOffsetY 把影子拉回来)、描边先于填充、对齐 / 两端对齐、逐字字距、
 * 带标签文字的逐段绘制,调用顺序与参数逐行一致。
 */
import { Rectangle } from '../../math/Rectangle';
import type { CanvasAndContext, ICanvasRenderingContext2D } from '../adapter';
import { pixiColorToRgbaString, type ConvertedFillStyle } from '../fill';
import type { TextStyle } from '../TextStyle';
import { CanvasPool } from './CanvasPool';
import { CanvasTextMetrics } from './CanvasTextMetrics';
import { fontStringFromTextStyle } from './utils/fontStringFromTextStyle';
import { getCanvasBoundingBox } from './utils/getCanvasBoundingBox';
import { getCanvasFillStyle, type FillStyleMetrics } from './utils/getCanvasFillStyle';

const tempRect = new Rectangle();

function countSpaces(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 32) count++;
  }
  return count;
}

export interface CanvasTextGeneratorOptions {
  text: string;
  style: TextStyle;
  resolution?: number;
  padding?: number;
}

export class CanvasTextGeneratorClass {
  /**
   * 生成画好文字的画布(从 CanvasPool 取,2 的幂尺寸)与内容区 frame(像素;style.trim 时为非透明像素包围盒)。
   */
  getCanvasAndContext(options: CanvasTextGeneratorOptions): { canvasAndContext: CanvasAndContext; frame: Rectangle } {
    const { text, style, resolution = 1 } = options;
    const padding = style._getFinalPadding();
    const measured = CanvasTextMetrics.measureText(text || ' ', style);
    const width = Math.ceil(Math.ceil(Math.max(1, measured.width) + padding * 2) * resolution);
    const height = Math.ceil(Math.ceil(Math.max(1, measured.height) + padding * 2) * resolution);
    const canvasAndContext = CanvasPool.getOptimalCanvasAndContext(width, height);
    this._renderTextToCanvas(style, padding, resolution, canvasAndContext, measured);
    const frame = style.trim
      ? getCanvasBoundingBox({ canvas: canvasAndContext.canvas, width, height, resolution: 1, output: tempRect })
      : tempRect.set(0, 0, width, height);
    return { canvasAndContext, frame };
  }

  /** 画布还回池 */
  returnCanvasAndContext(canvasAndContext: CanvasAndContext): void {
    CanvasPool.returnCanvasAndContext(canvasAndContext);
  }

  /** @internal */
  _renderTextToCanvas(style: TextStyle, padding: number, resolution: number, canvasAndContext: CanvasAndContext, measured: CanvasTextMetrics): void {
    if (measured.runsByLine && measured.runsByLine.length > 0) {
      this._renderTaggedTextToCanvas(measured, style, padding, resolution, canvasAndContext);
      return;
    }
    const { canvas, context } = canvasAndContext;
    const font = fontStringFromTextStyle(style);
    const lines = measured.lines;
    const lineHeight = measured.lineHeight;
    const lineWidths = measured.lineWidths;
    const maxLineWidth = measured.maxLineWidth;
    const fontProperties = measured.fontProperties;
    const height = canvas.height;
    context.resetTransform();
    context.scale(resolution, resolution);
    context.textBaseline = style.textBaseline;
    if (style._stroke?.width) {
      const strokeStyle = style._stroke;
      context.lineWidth = strokeStyle.width;
      context.miterLimit = strokeStyle.miterLimit;
      context.lineJoin = strokeStyle.join;
      context.lineCap = strokeStyle.cap;
    }
    context.font = font;
    let linePositionX: number;
    let linePositionY: number;
    const passesCount = style.dropShadow ? 2 : 1;
    const alignWidth = style.wordWrap ? style.wordWrapWidth : maxLineWidth;
    const strokeWidth = style._stroke?.width ?? 0;
    const halfStroke = strokeWidth / 2;
    let linePositionYShift = (lineHeight - fontProperties.fontSize) / 2;
    if (lineHeight - fontProperties.fontSize < 0) {
      linePositionYShift = 0;
    }
    for (let i = 0; i < passesCount; ++i) {
      const isShadowPass = style.dropShadow && i === 0;
      const dsOffsetText = isShadowPass ? Math.ceil(Math.max(1, height) + padding * 2) : 0;
      const dsOffsetShadow = dsOffsetText * resolution;
      if (isShadowPass) {
        this._setupDropShadow(context, style, resolution, dsOffsetShadow);
      } else {
        const gradientBounds = style._gradientBounds;
        const gradientOffset = style._gradientOffset;
        if (gradientBounds) {
          const gradientMetrics: FillStyleMetrics = {
            width: gradientBounds.width,
            height: gradientBounds.height,
            lineHeight: gradientBounds.height,
            lines: measured.lines,
          };
          this._setFillAndStrokeStyles(context, style, gradientMetrics, padding, halfStroke, gradientOffset?.x ?? 0, gradientOffset?.y ?? 0);
        } else if (gradientOffset) {
          this._setFillAndStrokeStyles(context, style, measured, padding, halfStroke, gradientOffset.x, gradientOffset.y);
        } else {
          this._setFillAndStrokeStyles(context, style, measured, padding, halfStroke);
        }
        context.shadowColor = 'rgba(0,0,0,0)';
      }
      for (let j = 0; j < lines.length; j++) {
        linePositionX = halfStroke;
        linePositionY = halfStroke + j * lineHeight + fontProperties.ascent + linePositionYShift;
        linePositionX += this._getAlignmentOffset(lineWidths[j], alignWidth, style.align);
        let wordSpacing = 0;
        if (style.align === 'justify' && style.wordWrap && j < lines.length - 1) {
          const spaces = countSpaces(lines[j]);
          if (spaces > 0) {
            wordSpacing = (alignWidth - lineWidths[j]) / spaces;
          }
        }
        if (style._stroke?.width) {
          this._drawLetterSpacing(lines[j], style, canvasAndContext, linePositionX + padding, linePositionY + padding - dsOffsetText, true, wordSpacing);
        }
        if (style._fill !== undefined) {
          this._drawLetterSpacing(lines[j], style, canvasAndContext, linePositionX + padding, linePositionY + padding - dsOffsetText, false, wordSpacing);
        }
      }
    }
  }

  private _renderTaggedTextToCanvas(measured: CanvasTextMetrics, style: TextStyle, padding: number, resolution: number, canvasAndContext: CanvasAndContext): void {
    const { canvas, context } = canvasAndContext;
    const { lineWidths, maxLineWidth, hasDropShadow } = measured;
    const runsByLine = measured.runsByLine!;
    const lineAscents = measured.lineAscents!;
    const lineHeights = measured.lineHeights!;
    const height = canvas.height;
    context.resetTransform();
    context.scale(resolution, resolution);
    context.textBaseline = style.textBaseline;
    const passesCount = hasDropShadow ? 2 : 1;
    const alignWidth = style.wordWrap ? style.wordWrapWidth : maxLineWidth;
    let maxStrokeWidth = style._stroke?.width ?? 0;
    for (const lineRuns of runsByLine) {
      for (const run of lineRuns) {
        const w = run.style._stroke?.width ?? 0;
        if (w > maxStrokeWidth) maxStrokeWidth = w;
      }
    }
    const halfStroke = maxStrokeWidth / 2;
    const runDataByLine: Array<Array<{ width: number; font: string }>> = [];
    for (let lineIndex = 0; lineIndex < runsByLine.length; lineIndex++) {
      const lineRuns = runsByLine[lineIndex];
      const runData: Array<{ width: number; font: string }> = [];
      for (const run of lineRuns) {
        const font = fontStringFromTextStyle(run.style);
        context.font = font;
        runData.push({
          width: CanvasTextMetrics._measureText(run.text, run.style.letterSpacing, context),
          font,
        });
      }
      runDataByLine.push(runData);
    }
    for (let pass = 0; pass < passesCount; ++pass) {
      const isShadowPass = hasDropShadow && pass === 0;
      const dsOffsetText = isShadowPass ? Math.ceil(Math.max(1, height) + padding * 2) : 0;
      const dsOffsetShadow = dsOffsetText * resolution;
      if (!isShadowPass) {
        context.shadowColor = 'rgba(0,0,0,0)';
      }
      let currentY = halfStroke;
      for (let lineIndex = 0; lineIndex < runsByLine.length; lineIndex++) {
        const lineRuns = runsByLine[lineIndex];
        const lineWidth = lineWidths[lineIndex];
        const lineAscent = lineAscents[lineIndex];
        const currentLineHeight = lineHeights[lineIndex];
        const lineRunData = runDataByLine[lineIndex];
        let linePositionX = halfStroke;
        linePositionX += this._getAlignmentOffset(lineWidth, alignWidth, style.align);
        let wordSpacing = 0;
        if (style.align === 'justify' && style.wordWrap && lineIndex < runsByLine.length - 1) {
          let totalSpaces = 0;
          for (const run of lineRuns) {
            totalSpaces += countSpaces(run.text);
          }
          if (totalSpaces > 0) {
            wordSpacing = (alignWidth - lineWidth) / totalSpaces;
          }
        }
        const linePositionY = currentY + lineAscent;
        let runX = linePositionX + padding;
        for (let runIndex = 0; runIndex < lineRuns.length; runIndex++) {
          const run = lineRuns[runIndex];
          const { width: runWidth, font: runFont } = lineRunData[runIndex];
          context.font = runFont;
          context.textBaseline = run.style.textBaseline;
          if (run.style._stroke?.width) {
            const runStroke = run.style._stroke;
            context.lineWidth = runStroke.width;
            context.miterLimit = runStroke.miterLimit;
            context.lineJoin = runStroke.join;
            context.lineCap = runStroke.cap;
            if (isShadowPass) {
              if (run.style.dropShadow) {
                this._setupDropShadow(context, run.style, resolution, dsOffsetShadow);
              } else {
                const spacesSkipped = countSpaces(run.text);
                runX += runWidth + spacesSkipped * wordSpacing;
                continue;
              }
            } else {
              const runFontProps = CanvasTextMetrics.measureFont(runFont);
              const runHeight = run.style.lineHeight || runFontProps.fontSize;
              const runMetrics: FillStyleMetrics = {
                width: runWidth,
                height: runHeight,
                lineHeight: runHeight,
                lines: [run.text],
              };
              context.strokeStyle = getCanvasFillStyle(runStroke, context, runMetrics, padding * 2, runX - padding, currentY);
            }
            this._drawLetterSpacing(run.text, run.style, canvasAndContext, runX, linePositionY + padding - dsOffsetText, true, wordSpacing);
          }
          const spacesInRun = countSpaces(run.text);
          runX += runWidth + spacesInRun * wordSpacing;
        }
        runX = linePositionX + padding;
        for (let runIndex = 0; runIndex < lineRuns.length; runIndex++) {
          const run = lineRuns[runIndex];
          const { width: runWidth, font: runFont } = lineRunData[runIndex];
          context.font = runFont;
          context.textBaseline = run.style.textBaseline;
          if (run.style._fill !== undefined) {
            if (isShadowPass) {
              if (run.style.dropShadow) {
                this._setupDropShadow(context, run.style, resolution, dsOffsetShadow);
              } else {
                const spacesSkipped = countSpaces(run.text);
                runX += runWidth + spacesSkipped * wordSpacing;
                continue;
              }
            } else {
              const runFontProps = CanvasTextMetrics.measureFont(runFont);
              const runHeight = run.style.lineHeight || runFontProps.fontSize;
              const runMetrics: FillStyleMetrics = {
                width: runWidth,
                height: runHeight,
                lineHeight: runHeight,
                lines: [run.text],
              };
              context.fillStyle = getCanvasFillStyle(run.style._fill, context, runMetrics, padding * 2, runX - padding, currentY);
            }
            this._drawLetterSpacing(run.text, run.style, canvasAndContext, runX, linePositionY + padding - dsOffsetText, false, wordSpacing);
          }
          const spacesInFillRun = countSpaces(run.text);
          runX += runWidth + spacesInFillRun * wordSpacing;
        }
        currentY += currentLineHeight;
      }
    }
  }

  private _setFillAndStrokeStyles(
    context: ICanvasRenderingContext2D,
    style: TextStyle,
    metrics: FillStyleMetrics,
    padding: number,
    halfStroke: number,
    offsetX = 0,
    offsetY = 0,
  ): void {
    context.fillStyle = (style._fill
      ? getCanvasFillStyle(style._fill, context, metrics, padding * 2, offsetX, offsetY)
      : null) as string;
    if (style._stroke?.width) {
      const strokePadding = halfStroke + padding * 2;
      context.strokeStyle = getCanvasFillStyle(style._stroke as ConvertedFillStyle, context, metrics, strokePadding, offsetX, offsetY);
    }
  }

  private _setupDropShadow(context: ICanvasRenderingContext2D, style: TextStyle, resolution: number, dsOffsetShadow: number): void {
    context.fillStyle = 'black';
    context.strokeStyle = 'black';
    const shadowOptions = style.dropShadow;
    const dropShadowColor = shadowOptions.color;
    const dropShadowAlpha = shadowOptions.alpha;
    context.shadowColor = pixiColorToRgbaString(dropShadowColor, dropShadowAlpha);
    const dropShadowBlur = shadowOptions.blur * resolution;
    const dropShadowDistance = shadowOptions.distance * resolution;
    context.shadowBlur = dropShadowBlur;
    context.shadowOffsetX = Math.cos(shadowOptions.angle) * dropShadowDistance;
    context.shadowOffsetY = Math.sin(shadowOptions.angle) * dropShadowDistance + dsOffsetShadow;
  }

  private _getAlignmentOffset(lineWidth: number, alignWidth: number, align: string): number {
    if (align === 'right') {
      return alignWidth - lineWidth;
    } else if (align === 'center') {
      return (alignWidth - lineWidth) / 2;
    }
    return 0;
  }

  /** 带字距 / 词距地画一行(描边或填充) */
  private _drawLetterSpacing(
    text: string,
    style: TextStyle,
    canvasAndContext: CanvasAndContext,
    x: number,
    y: number,
    isStroke = false,
    wordSpacing = 0,
  ): void {
    const { context } = canvasAndContext;
    const letterSpacing = style.letterSpacing;
    let useExperimentalLetterSpacing = false;
    if (CanvasTextMetrics.experimentalLetterSpacingSupported) {
      if (CanvasTextMetrics.experimentalLetterSpacing) {
        context.letterSpacing = `${letterSpacing}px`;
        context.textLetterSpacing = `${letterSpacing}px`;
        useExperimentalLetterSpacing = true;
      } else {
        context.letterSpacing = '0px';
        context.textLetterSpacing = '0px';
      }
    }
    if ((letterSpacing === 0 || useExperimentalLetterSpacing) && wordSpacing === 0) {
      if (isStroke) {
        context.strokeText(text, x, y);
      } else {
        context.fillText(text, x, y);
      }
      return;
    }
    if (wordSpacing !== 0 && (letterSpacing === 0 || useExperimentalLetterSpacing)) {
      const words = text.split(' ');
      let currentPosition2 = x;
      const spaceWidth = context.measureText(' ').width;
      for (let i = 0; i < words.length; i++) {
        if (isStroke) {
          context.strokeText(words[i], currentPosition2, y);
        } else {
          context.fillText(words[i], currentPosition2, y);
        }
        currentPosition2 += context.measureText(words[i]).width + spaceWidth + wordSpacing;
      }
      return;
    }
    let currentPosition = x;
    const stringArray = CanvasTextMetrics.graphemeSegmenter(text);
    let previousWidth = context.measureText(text).width;
    let currentWidth = 0;
    for (let i = 0; i < stringArray.length; ++i) {
      const currentChar = stringArray[i];
      if (isStroke) {
        context.strokeText(currentChar, currentPosition, y);
      } else {
        context.fillText(currentChar, currentPosition, y);
      }
      let textStr = '';
      for (let j = i + 1; j < stringArray.length; ++j) {
        textStr += stringArray[j];
      }
      currentWidth = context.measureText(textStr).width;
      currentPosition += previousWidth - currentWidth + letterSpacing;
      if (currentChar === ' ') currentPosition += wordSpacing;
      previousWidth = currentWidth;
    }
  }
}

export const CanvasTextGenerator = new CanvasTextGeneratorClass();
