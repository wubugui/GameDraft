/**
 * 移植自 PixiJS v8.17(MIT):filters/defaults/passthrough/PassthroughFilter。
 *
 * 原样拷贝输入。滤镜系统在滤镜 `enabled = false` 时用它顶替(Pixi `FilterSystem._getPassthroughFilter`)。
 * 只有 WGSL 程序(engine2d 只有 WebGPU)。
 */
import { Filter } from '../../Filter';
import { GpuProgram } from '../../../shader/GpuProgram';
import source from './passthrough.wgsl';

export class PassthroughFilter extends Filter {
  constructor() {
    const gpuProgram = GpuProgram.from({
      vertex: { source, entryPoint: 'mainVertex' },
      fragment: { source, entryPoint: 'mainFragment' },
      name: 'passthrough-filter',
    });

    super({
      gpuProgram,
    });
  }
}
