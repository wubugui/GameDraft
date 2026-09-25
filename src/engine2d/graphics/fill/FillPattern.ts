/**
 * 纹理平铺填充。移植自 PixiJS v8.17(MIT):scene/graphics/shared/fill/FillPattern(游戏未用,随样式解析一并移植)。
 */
import { Matrix } from '../../math/Matrix';
import type { Texture } from '../../textures/Texture';
import type { WRAP_MODE } from '../../textures/TextureStyle';
import { uid } from '../../utils/uid';

export type PatternRepetition = 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';

const repetitionMap: Record<PatternRepetition, { addressModeU: WRAP_MODE; addressModeV: WRAP_MODE }> = {
  repeat: { addressModeU: 'repeat', addressModeV: 'repeat' },
  'repeat-x': { addressModeU: 'repeat', addressModeV: 'clamp-to-edge' },
  'repeat-y': { addressModeU: 'clamp-to-edge', addressModeV: 'repeat' },
  'no-repeat': { addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
};

export class FillPattern {
  readonly uid = uid('fillPattern');
  _tick = 0;
  transform = new Matrix();
  private _texture!: Texture;

  constructor(texture: Texture, repetition?: PatternRepetition) {
    this.texture = texture;
    this.transform.scale(1 / texture.frame.width, 1 / texture.frame.height);
    if (repetition) {
      texture.source.style.addressModeU = repetitionMap[repetition].addressModeU;
      texture.source.style.addressModeV = repetitionMap[repetition].addressModeV;
    }
  }

  setTransform(transform: Matrix): void {
    const texture = this.texture;
    this.transform.copyFrom(transform);
    this.transform.invert();
    this.transform.scale(1 / texture.frame.width, 1 / texture.frame.height);
    this._tick++;
  }

  get texture(): Texture {
    return this._texture;
  }
  set texture(value: Texture) {
    if (this._texture === value) return;
    this._texture = value;
    this._tick++;
  }

  get styleKey(): string {
    return `fill-pattern-${this.uid}-${this._tick}`;
  }

  destroy(): void {
    this.texture.destroy(true);
    this.texture = null as unknown as Texture;
  }
}
