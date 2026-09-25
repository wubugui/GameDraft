/**
 * 移植自 PixiJS v8.17(MIT):filters/defaults/blur/BlurFilterPass。
 *
 * 单方向高斯模糊。`quality` = pass 数;多 pass 时在输入与一张池里的临时纹理之间来回画,最后一 pass 画到输出。
 *
 * 与 Pixi 的差别(都来自「engine2d 只有 WebGPU」):
 * - 不建 GlProgram;
 * - Pixi 按 `filterManager.renderer.type` 分 WebGL / WebGPU 两条路,这里固定走 **WebGPU 那条**:
 *   中间 pass 一律 `clear = true`;不切 `_state.blend`(Pixi 的 WebGPU 管线本来就不读它——
 *   清成 0 的目标上做 normal 混合 = 直接写入,与 WebGL 关混合的结果相同);
 *   Pixi 在 WebGPU 下每 pass 用 `uniformBatch.getUboResource` 给 uniform 拍快照,engine2d 由滤镜系统在
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

      // Pixi:this._state.blend = false;shouldClear = renderer.type === WEBGPU(engine2d 恒为 true)
      const shouldClear = true;

      for (let i = 0; i < this.passes - 1; i++) {
        filterManager.applyFilter(this, flip, flop, i === 0 ? true : shouldClear);

        const temp = flop;

        flop = flip;
        flip = temp;
      }

      // Pixi:this._state.blend = true
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

      // Pixi:this._state.blend = false;isWebGPU = renderer.type === WEBGPU(engine2d 恒为 true);
      // WebGPU 下每 pass 前 groups[1].setResource(uniformBatch.getUboResource(...)) —— engine2d 由滤镜系统拍快照
      const isWebGPU = true;

      for (let i = 0; i < this.passes - 1; i++) {
        filterManager.applyFilter(this, flip, flop, isWebGPU);

        const temp = flop;

        flop = flip;
        flip = temp;

        this._uniforms.uStrength *= 0.5;
      }

      // Pixi:this._state.blend = true
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
