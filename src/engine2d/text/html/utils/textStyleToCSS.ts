/**
 * HTMLTextStyle → CSS。移植自 PixiJS v8.17(MIT)`scene/text-html/utils/textStyleToCSS.mjs`。
 */
import type { ColorSource } from '../../../color/Color';
import { pixiColorToHexa, type ConvertedStrokeStyle } from '../../fill';
import { TextStyle, type TextDropShadow } from '../../TextStyle';
import type { HTMLTextStyle, HTMLTextStyleOptions } from '../HTMLTextStyle';

export function textStyleToCSS(style: HTMLTextStyle): string {
  const stroke = style._stroke;
  const fill = style._fill;
  const color = pixiColorToHexa(fill.color, fill.alpha ?? 1);
  const cssStyleString = [
    `color: ${color}`,
    `font-size: ${style.fontSize}px`,
    `font-family: ${style.fontFamily}`,
    `font-weight: ${style.fontWeight}`,
    `font-style: ${style.fontStyle}`,
    `font-variant: ${style.fontVariant}`,
    `letter-spacing: ${style.letterSpacing}px`,
    `text-align: ${style.align}`,
    `padding: ${style.padding}px`,
    `white-space: ${style.whiteSpace === 'pre' && style.wordWrap ? 'pre-wrap' : style.whiteSpace}`,
    ...(style.lineHeight ? [`line-height: ${style.lineHeight}px`] : []),
    ...(style.wordWrap
      ? [`word-break: ${style.breakWords ? 'break-word' : 'normal'}`, `max-width: ${style.wordWrapWidth}px`]
      : []),
    ...(stroke ? [strokeToCSS(stroke)] : []),
    ...(style.dropShadow ? [dropShadowToCSS(style.dropShadow)] : []),
    ...style.cssOverrides,
  ].join(';');
  const cssStyles = [`div { ${cssStyleString} }`];
  tagStyleToCSS(style.tagStyles as Record<string, HTMLTextStyleOptions> | undefined, cssStyles);
  return cssStyles.join(' ');
}

function dropShadowToCSS(dropShadowStyle: TextDropShadow): string {
  const dropshadowStyle = { ...dropShadowStyle };
  const color = pixiColorToHexa(dropshadowStyle.color, dropshadowStyle.alpha ?? 1);
  const x = Math.round(Math.cos(dropshadowStyle.angle) * dropshadowStyle.distance);
  const y = Math.round(Math.sin(dropshadowStyle.angle) * dropshadowStyle.distance);
  const position = `${x}px ${y}px`;
  if (dropshadowStyle.blur > 0) {
    return `text-shadow: ${position} ${dropshadowStyle.blur}px ${color}`;
  }
  return `text-shadow: ${position} ${color}`;
}

function strokeToCSS(stroke: Pick<ConvertedStrokeStyle, 'color' | 'alpha' | 'width'>): string {
  const color = pixiColorToHexa(stroke.color, stroke.alpha ?? 1);
  return [
    `-webkit-text-stroke-width: ${stroke.width}px`,
    `-webkit-text-stroke-color: ${color}`,
    `text-stroke-width: ${stroke.width}px`,
    `text-stroke-color: ${color}`,
    'paint-order: stroke',
  ].join(';');
}

const templates: Record<string, string> = {
  fontSize: `font-size: {{VALUE}}px`,
  fontFamily: `font-family: {{VALUE}}`,
  fontWeight: `font-weight: {{VALUE}}`,
  fontStyle: `font-style: {{VALUE}}`,
  fontVariant: `font-variant: {{VALUE}}`,
  letterSpacing: `letter-spacing: {{VALUE}}px`,
  align: `text-align: {{VALUE}}`,
  padding: `padding: {{VALUE}}px`,
  whiteSpace: `white-space: {{VALUE}}`,
  lineHeight: `line-height: {{VALUE}}px`,
  wordWrapWidth: `max-width: {{VALUE}}px`,
};

const transform: Record<string, (value: never) => string> = {
  fill: (value: ColorSource) => `color: ${pixiColorToHexa(value)}`,
  breakWords: (value: boolean) => `word-break: ${value ? 'break-all' : 'normal'}`,
  stroke: strokeToCSS,
  dropShadow: (value: boolean | Partial<TextDropShadow>) => {
    if (value === true) {
      return dropShadowToCSS(TextStyle.defaultDropShadow);
    }
    if (value && typeof value === 'object') {
      return dropShadowToCSS({ ...TextStyle.defaultDropShadow, ...value });
    }
    return '';
  },
};

function tagStyleToCSS(tagStyles: Record<string, HTMLTextStyleOptions> | undefined, out: string[]): void {
  for (const i in tagStyles) {
    const tagStyle = tagStyles[i] as Record<string, unknown>;
    const cssTagStyle: string[] = [];
    for (const j in tagStyle) {
      if (transform[j]) {
        cssTagStyle.push(transform[j](tagStyle[j] as never));
      } else if (templates[j]) {
        cssTagStyle.push(templates[j].replace('{{VALUE}}', tagStyle[j] as string));
      }
    }
    out.push(`${i} { ${cssTagStyle.join(';')} }`);
  }
}
