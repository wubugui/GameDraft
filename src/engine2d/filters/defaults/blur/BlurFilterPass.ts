/**
 * 移植自 PixiJS v8.17(MIT):filters/defaults/blur/BlurFilterPass。
 *
 * 单方向高斯模糊。`quality` = pass 数;多 pass 时在输入与一张池里的临时纹理之间来回画,最后一 pass 画到输出。
 *
 * 与 Pixi 的差别:
 * - 不建 GlProgram;
 * - Pixi 按 `filterManager.renderer.type` 分 WebGL / WebGPU 两条路,这里走 **master 实际跑的 WebGL 那条**
 *   (制作人 2026-09-27:结果与 master 一模一样):中间 pass 不清屏(第一 pass 除外)、关混合直接覆盖写
 *   (`_state.blend = false` ↔ 这里临时把 blendMode 切成 'none',最后一 pass 前还原)。四边形外那圈临时纹理
 *   保留池里上一次的内容,模糊核读到的与 master 相同(engine2d 的纹理池照 Pixi 同键同序复用);
 *   WebGPU 那条(每 pass 都清)在边缘与 master 差出几级(A/B 实测投影阴影下沿);
 * - Pixi 在 WebGPU 下每 pass 用 `uniformBatch.getUboResource` 给 uniform 拍快照,engine2d 由滤镜系统在
 *   `applyFilter` 时按当时的值打包(同一帧里本滤镜会以不同的 uStrength 连续 apply 多次)。
 */
import { Filter, type FilterSystemLike } from '../../Filter';
import { TexturePool } from '../../../textures/TexturePool';
import type { Texture } from '../../../textures/Texture';
import type { RenderSurface } from '../../../gpu/renderTargets';
import type { UniformGroup } from '../../../shader/UniformGroup';
import { generateBlurProgram } from './gpu/generateBlurProgram';
import type { BlurFilterOptions } from './BlurFilter';

export interface BlurFilterPassOptions extends BlurFilterOptions {
  /** true = 横向,false = 纵向 */
  horizontal: boolean;
}

export class BlurFilterPass extends Filter {
  static override defaultOptions: Partial<BlurFilterPassOptions> = {
    strength: 8,
    quality: 4,
    kernelSize: 5,
    legacy: false,
  };

  /** 方向 */
  horizontal: boolean;
  /** pass 数(= quality) */
  passes!: number;
  /** 模糊强度 */
  strength!: number;
  /** 旧算法:强度均分给各 pass;新算法见 `_calculateInitialStrength` */
  legacy: boolean;

  private _quality: number;
  private readonly _uniforms: { uStrength: number };
  private readonly _blurUniforms: UniformGroup;

  constructor(options: BlurFilterPassOptions) {
    options = { ...BlurFilterPass.defaultOptions, ...options };

    const gpuProgram = generateBlurProgram(options.horizontal, options.kernelSize!);

    super({
      gpuProgram,
      resources: {
        blurUniforms: {
          uStrength: { value: 0, type: 'f32' },
        },
      },
      ...options,
    });

    this.horizontal = options.horizontal;
    this.legacy = options.legacy ?? false;

    this._quality = 0;

    this.quality = options.quality!;

    this.blur = options.strength!;

    this._blurUniforms = this.resources.blurUniforms;
    this._uniforms = this._blurUniforms.uniforms as { uStrength: number };
  }

  override apply(filterManager: FilterSystemLike, input: Texture, output: RenderSurface, clearMode: boolean): void {
    if (this.legacy) {
      this._applyLegacy(filterManager, input, output, clearMode);
    } else {
      this._applyOptimized(filterManager, input, output, clearMode);
    }
  }

  private _applyLegacy(filterManager: FilterSystemLike, input: Texture, output: RenderSurface, clearMode: boolean): void {
    this._uniforms.uStrength = this.strength / this.passes;

    if (this.passes === 1) {
      filterManager.applyFilter(this, input, output, clearMode);
    } else {
      const tempTexture = TexturePool.getSameSizeTexture(input);

      let flip = input;
      let flop = tempTexture;

      // Pixi WebGL(master):this._state.blend = false;shouldClear = renderer.type === WEBGPU → false
      const blend = this.blendMode;
      this.blendMode = 'none';
      const shouldClear = false;

      for (let i = 0; i < this.passes - 1; i++) {
        filterManager.applyFilter(this, flip, flop, i === 0 ? true : shouldClear);

        const temp = flop;

        flop = flip;
        flip = temp;
      }

      // Pixi:this._state.blend = true
      this.blendMode = blend;
      filterManager.applyFilter(this, flip, output, clearMode);
      TexturePool.returnTexture(tempTexture);
    }
  }

  private _applyOptimized(filterManager: FilterSystemLike, input: Texture, output: RenderSurface, clearMode: boolean): void {
    this._uniforms.uStrength = this._calculateInitialStrength();

    if (this.passes === 1) {
      filterManager.applyFilter(this, input, output, clearMode);
    } else {
      const tempTexture = TexturePool.getSameSizeTexture(input);

      let flip = input;
      let flop = tempTexture;

      // Pixi WebGL(master):this._state.blend = false;中间 pass 的 clear = (renderer.type === WEBGPU) → false
      // (uniform 快照由滤镜系统在 applyFilter 时按当时的值打包,不需要 uniformBatch)
      const blend = this.blendMode;
      this.blendMode = 'none';
      const clearIntermediate = false;

      for (let i = 0; i < this.passes - 1; i++) {
        filterManager.applyFilter(this, flip, flop, clearIntermediate);

        const temp = flop;

        flop = flip;
        flip = temp;

        this._uniforms.uStrength *= 0.5;
      }

      // Pixi:this._state.blend = true
      this.blendMode = blend;
      filterManager.applyFilter(this, flip, output, clearMode);
      TexturePool.returnTexture(tempTexture);
    }
  }

  /** 各 pass 强度依次减半,首 pass 强度取 strength / sqrt(Σ系数²),使总模糊量等于 strength */
  private _calculateInitialStrength(): number {
    let sumOfSquares = 1;
    let coefficient = 0.5;

    for (let i = 1; i < this.passes; i++) {
      sumOfSquares += coefficient * coefficient;
      coefficient *= 0.5;
    }

    return this.strength / Math.sqrt(sumOfSquares);
  }

  /** 模糊强度(改它会同步 padding) */
  get blur(): number {
    return this.strength;
  }

  set blur(value: number) {
    this.padding = 1 + (Math.abs(value) * 2);
    this.strength = value;
  }

  /** 质量 = pass 数 */
  get quality(): number {
    return this._quality;
  }

  set quality(value: number) {
    this._quality = value;
    this.passes = value;
  }
}
