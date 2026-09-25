/**
 * 混合模式。名字与 Pixi 相同;**因子按 Pixi 的 WebGL 表**(= master 的行为)定义,不是 Pixi 的 WebGPU 表
 * (那张表 add / none / erase 三处与 WebGL 不一致,见 pixi-v8-traps / pixiWebGpuPatches)。
 * 纹理与顶点色一律是预乘 alpha。
 */
export type BlendMode =
  | 'inherit'
  | 'normal'
  | 'add'
  | 'multiply'
  | 'screen'
  | 'none'
  | 'normal-npm'
  | 'add-npm'
  | 'screen-npm'
  | 'erase'
  | 'min'
  | 'max';

export interface BlendComponent {
  srcFactor: GPUBlendFactor;
  dstFactor: GPUBlendFactor;
  operation: GPUBlendOperation;
}

export interface BlendState {
  color: BlendComponent;
  alpha: BlendComponent;
}

const c = (srcFactor: GPUBlendFactor, dstFactor: GPUBlendFactor, operation: GPUBlendOperation = 'add'): BlendComponent => ({ srcFactor, dstFactor, operation });

/** 与 Pixi `mapWebGLBlendModesToPixi` 逐项对应(blendFunc 两参 = 颜色 alpha 同因子;四参 = 颜色 / alpha 分开) */
export const BLEND_STATES: Readonly<Record<Exclude<BlendMode, 'inherit'>, BlendState | null>> = {
  normal: { color: c('one', 'one-minus-src-alpha'), alpha: c('one', 'one-minus-src-alpha') },
  add: { color: c('one', 'one'), alpha: c('one', 'one') },
  multiply: { color: c('dst', 'one-minus-src-alpha'), alpha: c('one', 'one-minus-src-alpha') },
  screen: { color: c('one', 'one-minus-src'), alpha: c('one', 'one-minus-src-alpha') },
  /** Pixi 里 'none' 关闭混合(State.blend = false),直接覆盖写入 */
  none: null,
  'normal-npm': { color: c('src-alpha', 'one-minus-src-alpha'), alpha: c('one', 'one-minus-src-alpha') },
  'add-npm': { color: c('src-alpha', 'one'), alpha: c('one', 'one') },
  'screen-npm': { color: c('src-alpha', 'one-minus-src'), alpha: c('one', 'one-minus-src-alpha') },
  erase: { color: c('zero', 'one-minus-src-alpha'), alpha: c('zero', 'one-minus-src-alpha') },
  min: { color: c('one', 'one', 'min'), alpha: c('one', 'one', 'min') },
  max: { color: c('one', 'one', 'max'), alpha: c('one', 'one', 'max') },
};

/** 'inherit' 取父级的混合模式(与 Pixi 相同:根上是 normal) */
export function resolveBlendMode(own: BlendMode, parent: Exclude<BlendMode, 'inherit'>): Exclude<BlendMode, 'inherit'> {
  return own === 'inherit' ? parent : own;
}
