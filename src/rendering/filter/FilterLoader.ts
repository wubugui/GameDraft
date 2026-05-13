/**
 * 滤镜加载器：从 JSON 定义创建 PixiJS Filter 实例
 * 支持扩展：后续可增加自定义 shader 类型
 */
import { ColorMatrixFilter, type Filter } from 'pixi.js';
import { resolveAssetPath } from '../../core/assetPath';
import type { FilterDef } from './types';
import { isValidFilterDef, IDENTITY_MATRIX } from './types';

const FILTER_ASSET_BASE = 'assets/data/filters';

/** 已加载滤镜缓存，避免重复创建 */
const filterCache = new Map<string, Filter>();

/**
 * 从 FilterDef 创建 ColorMatrixFilter（氛围/色彩滤镜）
 * 后续可扩展支持其他类型（如带深度图的 shader）
 */
export function createFilterFromDef(def: FilterDef): ColorMatrixFilter {
  const filter = new ColorMatrixFilter();
  const arr = Array.isArray(def.matrix) && def.matrix.length === 20
    ? def.matrix
    : [...IDENTITY_MATRIX];
  filter.matrix = arr as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  filter.alpha = typeof def.alpha === 'number' ? def.alpha : 1;
  return filter;
}

/**
 * 加载滤镜 JSON 并创建 Filter 实例
 * @param filterId 滤镜 ID，对应 assets/data/filters/{filterId}.json
 * @param useCache 是否使用缓存，默认 true
 */
export async function loadFilter(filterId: string, useCache = true): Promise<Filter> {
  if (useCache && filterCache.has(filterId)) {
    return filterCache.get(filterId)!;
  }

  const path = `${FILTER_ASSET_BASE}/${filterId}.json`;
  const resolved = resolveAssetPath(path);
  const response = await fetch(resolved);
  if (!response.ok) {
    throw new Error(`Filter load failed: ${filterId} (${response.status})`);
  }

  const data = await response.json() as unknown;
  if (!isValidFilterDef(data)) {
    throw new Error(`Invalid filter definition: ${filterId}`);
  }

  const filter = createFilterFromDef(data);
  if (useCache) {
    filterCache.set(filterId, filter);
  }
  return filter;
}

/**
 * 同步从已加载的 JSON 创建 Filter（供外部传入 JSON 时使用）
 */
export function createFilterFromJson(json: FilterDef): ColorMatrixFilter {
  return createFilterFromDef(json);
}

/**
 * 清除滤镜缓存（场景切换或资源释放时可选调用）
 */
export function clearFilterCache(): void {
  filterCache.clear();
}
