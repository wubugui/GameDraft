/**
 * fill / stroke 输入 → 规范样式。移植自 PixiJS v8.17(MIT):scene/graphics/shared/utils/convertFillInputToFillStyle。
 * 颜色解析走 engine2d 的 Color,取值按 Pixi Color 的 float32 量化(见 ./pixiColor)。
 */
import { Color, type ColorSource } from '../../color/Color';
import { Texture } from '../../textures/Texture';
import { FillGradient } from '../fill/FillGradient';
import { FillPattern } from '../fill/FillPattern';
import { pixiAlpha, pixiColorNumber } from './pixiColor';
import type {
  ConvertedFillStyle,
  ConvertedStrokeStyle,
  FillInput,
  FillStyle,
  StrokeInput,
} from '../FillTypes';

function isColorLike(value: unknown): value is ColorSource {
  return Color.isColorLike(value as ColorSource);
}

function isFillPattern(value: unknown): value is FillPattern {
  return value instanceof FillPattern;
}

function isFillGradient(value: unknown): value is FillGradient {
  return value instanceof FillGradient;
}

function isTexture(value: unknown): value is Texture {
  return value instanceof Texture;
}

function handleColorLike(fill: FillStyle, value: ColorSource, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  const temp = Color.shared.setValue(value ?? 0);
  fill.color = pixiColorNumber(temp);
  const alpha = pixiAlpha(temp);
  fill.alpha = alpha === 1 ? defaultStyle.alpha : alpha;
  fill.texture = Texture.WHITE;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleTexture(fill: FillStyle, value: Texture, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  fill.texture = value;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleFillPattern(fill: FillStyle, value: FillPattern, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  fill.fill = value;
  fill.color = 0xffffff;
  fill.texture = value.texture;
  fill.matrix = value.transform;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleFillGradient(fill: FillStyle, value: FillGradient, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  value.buildGradient();
  fill.fill = value;
  fill.color = 0xffffff;
  fill.texture = value.texture;
  fill.matrix = value.transform;
  fill.textureSpace = value.textureSpace;
  return { ...defaultStyle, ...fill } as ConvertedFillStyle;
}

function handleFillObject(value: FillStyle, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  const style = { ...defaultStyle, ...value } as FillStyle & ConvertedFillStyle;
  const color = Color.shared.setValue(style.color);
  style.alpha *= pixiAlpha(color);
  style.color = pixiColorNumber(color);
  return style as ConvertedFillStyle;
}

export function toFillStyle<T extends FillInput>(value: T, defaultStyle: ConvertedFillStyle): ConvertedFillStyle {
  if (value === undefined || value === null) {
    return null as unknown as ConvertedFillStyle;
  }
  const fill: FillStyle = {};
  const objectStyle = value as FillStyle;
  if (isColorLike(value)) {
    return handleColorLike(fill, value, defaultStyle);
  } else if (isTexture(value)) {
    return handleTexture(fill, value, defaultStyle);
  } else if (isFillPattern(value)) {
    return handleFillPattern(fill, value, defaultStyle);
  } else if (isFillGradient(value)) {
    return handleFillGradient(fill, value, defaultStyle);
  } else if (objectStyle.fill && isFillPattern(objectStyle.fill)) {
    return handleFillPattern(objectStyle, objectStyle.fill, defaultStyle);
  } else if (objectStyle.fill && isFillGradient(objectStyle.fill)) {
    return handleFillGradient(objectStyle, objectStyle.fill, defaultStyle);
  }
  return handleFillObject(objectStyle, defaultStyle);
}

export function toStrokeStyle(value: StrokeInput, defaultStyle: ConvertedStrokeStyle): ConvertedStrokeStyle {
  const { width, alignment, miterLimit, cap, join, pixelLine, ...rest } = defaultStyle;
  const fill = toFillStyle(value, rest);
  if (!fill) {
    return null as unknown as ConvertedStrokeStyle;
  }
  return {
    width,
    alignment,
    miterLimit,
    cap,
    join,
    pixelLine,
    ...fill,
  };
}
