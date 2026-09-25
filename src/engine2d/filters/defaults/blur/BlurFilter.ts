/**
 * 移植自 PixiJS v8.17(MIT):filters/defaults/blur/BlurFilter。
 *
 * 高斯模糊 = 横向 pass(`blurXFilter`)+ 纵向 pass(`blurYFilter`)。两个方向都有强度时,
 * 横向先画进一张池里的临时纹理(与输入同尺寸,用完归还),纵向再从它画到输出。
 * 本滤镜自己没有着色器程序(`compatibleRenderers = BOTH`),滤镜系统必须调它的 `apply`。
 *
 * 与 Pixi 的差别:弃用的 API(数字参数构造、`blur` / `blurX` / `blurY`)照常可用,但不打弃用警告。
 */
import { Filter, type FilterOptions, type FilterSystemLike } from '../../Filter';
import { TexturePool } from '../../../textures/TexturePool';
import { RendererType } from '../../../shader/Shader';
import type { Texture } from '../../../textures/Texture';
import type { RenderSurface } from '../../../gpu/renderTargets';
import { BlurFilterPass } from './BlurFilterPass';

export interface BlurFilterOptions extends FilterOptions {
  /** 两个方向的强度 */
  strength?: number;
  /** 横向强度(覆盖 strength) */
  strengthX?: number;
  /** 纵向强度(覆盖 strength) */
  strengthY?: number;
  /** 质量 = 每个方向的 pass 数 */
  quality?: number;
  /** 卷积核尺寸:5 / 7 / 9 / 11 / 13 / 15 */
  kernelSize?: number;
  /** 旧的多 pass 强度分配(见 BlurFilterPass) */
  legacy?: boolean;
}

export class BlurFilter extends Filter {
  static override defaultOptions: Partial<BlurFilterOptions> = {
    strength: 8,
    quality: 4,
    kernelSize: 5,
    legacy: false,
  };

  /** 横向 pass */
  blurXFilter: BlurFilterPass;
  /** 纵向 pass */
  blurYFilter: BlurFilterPass;

  private _repeatEdgePixels: boolean;

  constructor(options?: BlurFilterOptions);
  /** @deprecated 自 Pixi 8.0.0 起改用选项对象 */
  constructor(strength?: number, quality?: number, resolution?: number | null, kernelSize?: number);
  constructor(...args: [BlurFilterOptions?] | [number?, number?, (number | null)?, number?]) {
    let options: BlurFilterOptions | number = args[0] ?? {};

    if (typeof options === 'number') {
      // Pixi:deprecation(v8_0_0, 'BlurFilter constructor params are now options object. ...')
      options = { strength: options };

      if (args[1] !== undefined) options.quality = args[1] as number;
      if (args[2] !== undefined) options.resolution = (args[2] as number | null) || 'inherit';
      if (args[3] !== undefined) options.kernelSize = args[3] as number;
    }

    options = { ...BlurFilterPass.defaultOptions, ...options };

    const { strength, strengthX, strengthY, quality, ...rest } = options;

    super({
      ...rest,
      compatibleRenderers: RendererType.BOTH,
      resources: {},
    });

    this._repeatEdgePixels = false;

    this.blurXFilter = new BlurFilterPass({ horizontal: true, ...options });
    this.blurYFilter = new BlurFilterPass({ horizontal: false, ...options });

    this.quality = quality!;
    this.strengthX = strengthX ?? strength!;
    this.strengthY = strengthY ?? strength!;
    this.repeatEdgePixels = false;
  }

  override apply(filterManager: FilterSystemLike, input: Texture, output: RenderSurface, clearMode: boolean): void {
    const xStrength = Math.abs(this.blurXFilter.strength);
    const yStrength = Math.abs(this.blurYFilter.strength);

    if (xStrength && yStrength) {
      const tempTexture = TexturePool.getSameSizeTexture(input);

      this.blurXFilter.blendMode = 'normal';

      this.blurXFilter.apply(filterManager, input, tempTexture, true);

      this.blurYFilter.blendMode = this.blendMode;

      this.blurYFilter.apply(filterManager, tempTexture, output, clearMode);

      TexturePool.returnTexture(tempTexture);
    } else if (yStrength) {
      this.blurYFilter.blendMode = this.blendMode;
      this.blurYFilter.apply(filterManager, input, output, clearMode);
    } else {
      this.blurXFilter.blendMode = this.blendMode;
      this.blurXFilter.apply(filterManager, input, output, clearMode);
    }
  }

  protected updatePadding(): void {
    if (this._repeatEdgePixels) {
      this.padding = 0;
    } else {
      this.padding = Math.max(Math.abs(this.blurXFilter.blur), Math.abs(this.blurYFilter.blur)) * 2;
    }
  }

  /** 两个方向的强度(两方向不同时读它会抛错) */
  get strength(): number {
    if (this.strengthX !== this.strengthY) {
      throw new Error("BlurFilter's strengthX and strengthY are different");
    }

    return this.strengthX;
  }

  set strength(value: number) {
    this.blurXFilter.blur = this.blurYFilter.blur = value;
    this.updatePadding();
  }

  /** 质量 = 每个方向的 pass 数 */
  get quality(): number {
    return this.blurXFilter.quality;
  }

  set quality(value: number) {
    this.blurXFilter.quality = this.blurYFilter.quality = value;
  }

  /** 横向强度 */
  get strengthX(): number {
    return this.blurXFilter.blur;
  }

  set strengthX(value: number) {
    this.blurXFilter.blur = value;
    this.updatePadding();
  }

  /** 纵向强度 */
  get strengthY(): number {
    return this.blurYFilter.blur;
  }

  set strengthY(value: number) {
    this.blurYFilter.blur = value;
    this.updatePadding();
  }

  /** @deprecated 自 Pixi 8.3.0 起改用 strength */
  get blur(): number {
    return this.strength;
  }

  set blur(value: number) {
    this.strength = value;
  }

  /** @deprecated 自 Pixi 8.3.0 起改用 strengthX */
  get blurX(): number {
    return this.strengthX;
  }

  set blurX(value: number) {
    this.strengthX = value;
  }

  /** @deprecated 自 Pixi 8.3.0 起改用 strengthY */
  get blurY(): number {
    return this.strengthY;
  }

  set blurY(value: number) {
    this.strengthY = value;
  }

  /** true 时 padding 为 0(边缘像素外延) */
  get repeatEdgePixels(): boolean {
    return this._repeatEdgePixels;
  }

  set repeatEdgePixels(value: boolean) {
    this._repeatEdgePixels = value;
    this.updatePadding();
  }
}
