import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import { GpuProgram, type GpuProgramOptions } from './GpuProgram';
import { GlProgram, type GlProgramOptions } from './GlProgram';
import { UniformGroup } from './UniformGroup';

/** 渲染器类型位(与 Pixi 相同的数值,只为兼容调用点;引擎只有 WebGPU) */
export const RendererType = { WEBGL: 1, WEBGPU: 2, CANVAS: 4, BOTH: 3 } as const;
export type RendererType = (typeof RendererType)[keyof typeof RendererType];

export interface ShaderWithResources {
  gpuProgram?: GpuProgram;
  glProgram?: GlProgram;
  resources?: Record<string, unknown>;
  compatibleRenderers?: number;
  [key: string]: unknown;
}

export interface ShaderFromOptions {
  gpu?: GpuProgramOptions;
  gl?: GlProgramOptions;
  resources?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 着色器 = WGSL 程序 + 按名字的资源表(照 Pixi `Shader`)。`resources.名字` 读写:
 * TextureSource(纹理)、TextureStyle(采样器)、UniformGroup(uniform 结构体)、Buffer / BufferResource。
 * 普通对象会被包成 UniformGroup(与 Pixi 相同)。
 */
export class Shader extends EventEmitter {
  readonly uid = uid('shader');
  gpuProgram: GpuProgram | null;
  glProgram: GlProgram | null;
  compatibleRenderers: number;
  resources: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  _destroyed = false;

  constructor(options: ShaderWithResources) {
    super();
    this.gpuProgram = options.gpuProgram ?? null;
    this.glProgram = options.glProgram ?? null;
    this.compatibleRenderers = options.compatibleRenderers ?? ((this.gpuProgram ? RendererType.WEBGPU : 0) | (this.glProgram ? RendererType.WEBGL : 0));
    const resources: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(options.resources ?? {})) {
      resources[name] = wrapResource(value);
    }
    this.resources = resources;
  }

  /** Pixi 兼容:按名字占一个资源位(本实现资源按名字存,不需要预留) */
  addResource(_name: string, _groupIndex: number, _bindIndex: number): void {}

  destroy(destroyPrograms = false): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.emit('destroy', this);
    if (destroyPrograms) {
      this.gpuProgram?.destroy();
      this.glProgram?.destroy();
    }
    this.gpuProgram = null;
    this.glProgram = null;
    this.removeAllListeners();
    this.resources = {};
  }

  static from(options: ShaderFromOptions): Shader {
    const { gpu, gl, ...rest } = options;
    return new Shader({
      gpuProgram: gpu ? GpuProgram.from(gpu) : undefined,
      glProgram: gl ? GlProgram.from(gl) : undefined,
      ...rest,
    });
  }
}

export function wrapResource(value: unknown): unknown {
  if (value && typeof value === 'object' && !('source' in value) && !('_resourceType' in value)) {
    return new UniformGroup(value as ConstructorParameters<typeof UniformGroup>[0]);
  }
  return value;
}
