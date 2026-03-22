/**
 * 渲染层滤镜类型定义
 * 仅用于渲染层，与逻辑层数据分离
 */

/** 滤镜 JSON 格式：基于 ColorMatrix 的 5x4 矩阵（20 个浮点数） */
export interface FilterDef {
  id?: string;
  /** 5x4 颜色变换矩阵，顺序 R行 G行 B行 A行 常量列 */
  matrix: number[];
  /** 混合 alpha，0=原色 1=变换结果，默认 1 */
  alpha?: number;
}

/** 默认单位矩阵（恒等变换） */
export const IDENTITY_MATRIX: number[] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

export function isValidFilterDef(def: unknown): def is FilterDef {
  if (!def || typeof def !== 'object') return false;
  const d = def as Record<string, unknown>;
  if (!Array.isArray(d.matrix) || d.matrix.length !== 20) return false;
  return d.matrix.every((v: unknown) => typeof v === 'number');
}
