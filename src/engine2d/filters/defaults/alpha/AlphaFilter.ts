/**
 * 移植自 PixiJS v8.17(MIT):filters/defaults/alpha/AlphaFilter。
 *
 * 整体乘一个不透明度(输入是预乘色,`sample * uAlpha`)。与 Pixi 的差别只有一处:engine2d 只有 WebGPU,
 * 不建 GlProgram。
 */
import { Filter, type FilterOptions } from '../../Filter';
import { GpuProgram } from '../../../shader/GpuProgram';
import { UniformGroup } from '../../../shader/UniformGroup';
import source from './alpha.wgsl';

export interface AlphaFilterOptions extends FilterOptions {
  /** 0 = 全透明,1 = 不透明(默认) */
  alpha: number;
}

export class AlphaFilter extends Filter {
  static override defaultOptions: AlphaFilterOptions = {
    alpha: 1,
  };

  constructor(options?: AlphaFilterOptions) {
    options = { ...AlphaFilter.defaultOptions, ...options };

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

    const { alpha, ...rest } = options;

    const alphaUniforms = new UniformGroup({
      uAlpha: { value: alpha, type: 'f32' },
    });

    super({
      ...rest,
      gpuProgram,
      resources: {
        alphaUniforms,
      },
    });
  }

  get alpha(): number {
    return this.resources.alphaUniforms.uniforms.uAlpha;
  }

  set alpha(value: number) {
    this.resources.alphaUniforms.uniforms.uAlpha = value;
  }
}
