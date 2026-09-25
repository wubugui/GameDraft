/**
 * 移植自 PixiJS v8.17(MIT):filters/mask/MaskFilter。Alpha 遮罩的滤镜:把遮罩精灵的纹理按它的世界变换
 * 映射到滤镜区域,输出 `输入 × (mask.a 修正 × mask.r × 帧内裁切)`,反向时取 1 - a。
 *
 * 与 Pixi 的差别:
 * - engine2d 只有 WebGPU,不建 GlProgram;遮罩纹理带自己的采样器(见 mask.wgsl 头注释);
 * - `spriteWorldTransform`:alpha 遮罩把遮罩体先画进临时纹理时,Pixi 直接改内部精灵的 `worldTransform.tx/ty`;
 *   engine2d 的 worldTransform 是按父链现算的,改由这个字段带(为 null 时按精灵本次渲染的变换算)。
 */
import { Filter, type FilterOptions, type FilterSystemLike } from '../Filter';
import { GpuProgram } from '../../shader/GpuProgram';
import { UniformGroup } from '../../shader/UniformGroup';
import { Matrix } from '../../math/Matrix';
import { TextureMatrix } from '../../textures/TextureMatrix';
import type { Texture } from '../../textures/Texture';
import type { Sprite } from '../../sprite/Sprite';
import type { RenderSurface } from '../../gpu/renderTargets';
import source from './mask.wgsl';

export interface MaskFilterOptions extends Partial<FilterOptions> {
  sprite: Sprite;
  inverse?: boolean;
}

export class MaskFilter extends Filter {
  sprite: Sprite;
  /** 不为 null 时代替精灵的世界变换(见文件头) */
  spriteWorldTransform: Matrix | null = null;
  private readonly _textureMatrix: TextureMatrix;

  constructor(options: MaskFilterOptions) {
    const { sprite, inverse, ...rest } = options;
    const textureMatrix = new TextureMatrix(sprite.texture);
    const filterUniforms = new UniformGroup({
      uFilterMatrix: { value: new Matrix(), type: 'mat3x3<f32>' },
      uMaskClamp: { value: textureMatrix.uClampFrame, type: 'vec4<f32>' },
      uAlpha: { value: 1, type: 'f32' },
      uInverse: { value: inverse ? 1 : 0, type: 'f32' },
    });
    const gpuProgram = GpuProgram.from({
      vertex: {
        source,
        entryPoint: 'mainVertex',
      },
      fragment: {
        source,
        entryPoint: 'mainFragment',
      },
    });
    super({
      ...rest,
      gpuProgram,
      clipToViewport: false,
      resources: {
        filterUniforms,
        uMaskTexture: sprite.texture.source,
        uMaskSampler: sprite.texture.source.style,
      },
    });
    this.sprite = sprite;
    this._textureMatrix = textureMatrix;
  }

  set inverse(value: boolean) {
    this.resources.filterUniforms.uniforms.uInverse = value ? 1 : 0;
  }

  get inverse(): boolean {
    return this.resources.filterUniforms.uniforms.uInverse === 1;
  }

  override apply(filterManager: FilterSystemLike, input: Texture, output: RenderSurface, clearMode: boolean): void {
    this._textureMatrix.texture = this.sprite.texture;
    filterManager
      .calculateSpriteMatrix(this.resources.filterUniforms.uniforms.uFilterMatrix as Matrix, this.sprite, this.spriteWorldTransform ?? undefined)
      .prepend(this._textureMatrix.mapCoord);
    this.resources.uMaskTexture = this.sprite.texture.source;
    this.resources.uMaskSampler = this.sprite.texture.source.style;
    filterManager.applyFilter(this, input, output, clearMode);
  }
}
