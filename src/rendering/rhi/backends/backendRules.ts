/**
 * 两个后端共用的规则。空后端的校验要与真后端(luma)逐条一致——空后端上通过的用法到真 GPU 上不能再失败——
 * 所以凡是两边都要判的规则只写在这里一处。
 */
import { RhiError, type RhiShaderDesc } from '../types';
import type { RhiBindings } from '../RhiDevice';

/** 采样器按命名约定配给纹理:「纹理名 + Sampler」 */
export const SAMPLER_SUFFIX = 'Sampler';

export interface RhiShaderEntries {
  vertex?: string;
  fragment?: string;
  compute?: string;
}

function findEntry(wgsl: string, stage: 'vertex' | 'fragment' | 'compute'): string | undefined {
  const m = new RegExp(`@${stage}(?:\\s+@workgroup_size\\([^)]*\\))?\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl)
    ?? new RegExp(`@workgroup_size\\([^)]*\\)\\s+@${stage}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl);
  return m?.[1];
}

/** 着色器入口:显式给的优先,缺省按 `@vertex` 等标注找;一个都没有就报错 */
export function resolveShaderEntries(desc: RhiShaderDesc): RhiShaderEntries {
  if (!desc.wgsl) throw new RhiError('invalid-usage', `着色器「${desc.label}」没有 WGSL 源`);
  const entry = {
    vertex: desc.entryPoints?.vertex ?? findEntry(desc.wgsl, 'vertex'),
    fragment: desc.entryPoints?.fragment ?? findEntry(desc.wgsl, 'fragment'),
    compute: desc.entryPoints?.compute ?? findEntry(desc.wgsl, 'compute'),
  };
  if (!entry.vertex && !entry.fragment && !entry.compute) {
    throw new RhiError('invalid-usage', `着色器「${desc.label}」里找不到 @vertex / @fragment / @compute 入口`);
  }
  return entry;
}

/**
 * 着色器声明了、调用方却没给的绑定名。「纹理名Sampler」在纹理给了时不算缺(用纹理自带的采样器)。
 * 只在报错路径上调(会分配)。
 */
export function missingBindings(declared: readonly string[], bindings: RhiBindings): string[] {
  return declared.filter((n) => {
    if (bindings[n] !== undefined) return false;
    if (!n.endsWith(SAMPLER_SUFFIX)) return true;
    return (bindings[n.slice(0, -SAMPLER_SUFFIX.length)] as { kind?: string } | undefined)?.kind !== 'texture';
  });
}
