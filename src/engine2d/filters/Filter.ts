import { Shader, type ShaderWithResources } from '../shader/Shader';
import { GpuProgram, type GpuProgramOptions } from '../shader/GpuProgram';
import { GlProgram, type GlProgramOptions } from '../shader/GlProgram';
import type { BlendMode } from '../core/blendModes';
import type { Texture } from '../textures/Texture';
import type { RenderSurface } from '../gpu/renderTargets';
import type { Matrix } from '../math/Matrix';
import type { Sprite } from '../sprite/Sprite';

export type FilterAntialias = 'on' | 'off' | 'inherit';

export interface FilterOptions extends ShaderWithResources {
  blendMode?: BlendMode;
  resolution?: number | 'inherit';
  padding?: number;
  antialias?: FilterAntialias | boolean;
  blendRequired?: boolean;
  clipToViewport?: boolean;
}

/** 滤镜管理器对滤镜暴露的接口(gpu 模块的 FilterSystem 实现) */
export interface FilterSystemLike {
  applyFilter(filter: Filter, input: Texture, output: RenderSurface, clear: boolean): void;
  /**
   * 照 Pixi `FilterSystem.calculateSpriteMatrix`:滤镜输入纹理坐标 → 精灵纹理的归一化坐标(MaskFilter 用)。
   * `worldTransform` 给了就代替精灵本次渲染的世界变换(见 MaskFilter.spriteWorldTransform)
   */
  calculateSpriteMatrix(outputMatrix: Matrix, sprite: Sprite, worldTransform?: Matrix): Matrix;
  /**
   * 引擎扩展(Pixi 没有):这一道 pass 里滤镜顶点的「位置」`aPosition * uOutputFrame.zw + uOutputFrame.xy` 加上它 =
   * 渲染根目标上的坐标(CSS 像素)。照 Pixi,`uOutputFrame.xy` 只在画回外层目标的最后一道带 bounds 偏移,链中间
   * 画进池纹理的几道是 0——按屏幕位置取东西的滤镜(燃烧的场景 uv 等)排在链中间时拿它补回来。只在 `apply` 回调里有效。
   */
  filterPassOrigin(output: RenderSurface | 'canvas'): { x: number; y: number };
}

/**
 * 滤镜(照 Pixi `Filter`):WGSL 约定与 Pixi 相同——`gfu: GlobalFilterUniforms`、`uTexture`、`uSampler`
 * 由滤镜系统提供,其余资源自己放在 `resources` 里。
 */
export class Filter extends Shader {
  static defaultOptions: Partial<FilterOptions> = {
    blendMode: 'normal',
    resolution: 1,
    padding: 0,
    antialias: 'off',
    blendRequired: false,
    clipToViewport: true,
  };

  enabled = true;
  blendMode: BlendMode;
  padding: number;
  antialias: FilterAntialias;
  resolution: number | 'inherit';
  blendRequired: boolean;
  clipToViewport: boolean;

  constructor(options: FilterOptions) {
    const o = { ...Filter.defaultOptions, ...options };
    super(o);
    this.blendMode = o.blendMode!;
    this.padding = o.padding!;
    this.antialias = typeof o.antialias === 'boolean' ? (o.antialias ? 'on' : 'off') : o.antialias!;
    this.resolution = o.resolution!;
    this.blendRequired = o.blendRequired!;
    this.clipToViewport = o.clipToViewport!;
  }

  apply(filterManager: FilterSystemLike, input: Texture, output: RenderSurface, clearMode: boolean): void {
    filterManager.applyFilter(this, input, output, clearMode);
  }

  static override from(options: Omit<FilterOptions, 'gpuProgram' | 'glProgram'> & { gpu?: GpuProgramOptions; gl?: GlProgramOptions }): Filter {
    const { gpu, gl, ...rest } = options;
    return new Filter({
      gpuProgram: gpu ? GpuProgram.from(gpu) : undefined,
      glProgram: gl ? GlProgram.from(gl) : undefined,
      ...rest,
    });
  }
}
