import { uid } from '../utils/uid';
import { Matrix } from '../math/Matrix';
import { createUboLayout, WGSL_ALIGN_SIZE_DATA, type UboLayout, type UniformType } from './uboLayout';

export interface UniformData {
  value: unknown;
  type: UniformType | string;
  size?: number;
  name?: string;
}

export interface UniformGroupOptions {
  ubo?: boolean;
  isStatic?: boolean;
}

type Structures = Record<string, UniformData>;

/**
 * 一组 uniform(照 Pixi `UniformGroup`):`uniforms.xxx` 读写值;改了值调 `update()`(本实现每次绘制都按当时的值打包,
 * `update()` 只递增脏计数,供缓存判断)。在 WGSL 里对应一个 `var<uniform> 名字: 结构体`,布局见 uboLayout。
 */
export class UniformGroup<T extends Structures = Structures> {
  readonly uid = uid('uniform');
  readonly _resourceType = 'uniformGroup';
  readonly isUniformGroup = true;
  readonly uniformStructures: T;
  readonly uniforms: { [K in keyof T]: T[K]['value'] } & Record<string, unknown>;
  ubo: boolean;
  isStatic: boolean;
  _dirtyId = 1;
  destroyed = false;
  private _layout: UboLayout | null = null;

  constructor(uniformStructures: T, options: UniformGroupOptions = {}) {
    this.uniformStructures = uniformStructures;
    const uniforms: Record<string, unknown> = {};
    for (const name in uniformStructures) {
      const u = uniformStructures[name];
      u.name = name;
      u.size = u.size ?? 1;
      if (!WGSL_ALIGN_SIZE_DATA[u.type]) {
        throw new Error(`[engine2d] Uniform「${name}」的类型 ${u.type} 不支持`);
      }
      u.value ??= defaultValue(u.type, u.size);
      uniforms[name] = u.value;
    }
    this.uniforms = uniforms as UniformGroup<T>['uniforms'];
    this.ubo = !!options.ubo;
    this.isStatic = !!options.isStatic;
  }

  /** WGSL uniform 缓冲布局(按声明顺序) */
  get layout(): UboLayout {
    return (this._layout ??= createUboLayout(
      Object.keys(this.uniformStructures).map((name) => ({
        name,
        type: this.uniformStructures[name].type,
        size: this.uniformStructures[name].size ?? 1,
      })),
    ));
  }

  update(): void {
    this._dirtyId++;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function defaultValue(type: string, size: number): unknown {
  switch (type) {
    case 'f32':
    case 'i32':
    case 'u32':
      return size > 1 ? new Float32Array(size) : 0;
    case 'vec2<f32>':
      return new Float32Array(2 * size);
    case 'vec3<f32>':
      return new Float32Array(3 * size);
    case 'vec4<f32>':
      return new Float32Array(4 * size);
    case 'vec2<i32>':
      return new Int32Array(2 * size);
    case 'vec3<i32>':
      return new Int32Array(3 * size);
    case 'vec4<i32>':
      return new Int32Array(4 * size);
    case 'mat2x2<f32>':
      return new Float32Array([1, 0, 0, 1]);
    case 'mat3x3<f32>':
      return size > 1 ? new Float32Array(9 * size) : new Matrix();
    case 'mat4x4<f32>':
      return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    default:
      return null;
  }
}
