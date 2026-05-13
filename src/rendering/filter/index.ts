/**
 * 渲染层滤镜模块
 * 统一导出，供 Renderer 及后续扩展使用
 *
 * 扩展方式（未来可增加更多 shader 效果）：
 * - 氛围滤镜：FilterDef JSON -> ColorMatrixFilter（当前实现）
 * - 深度效果：自定义 Filter.from({ glProgram }) 采样深度图，pushFilter 串联
 * - Bloom/DOF 等：新增 Filter 类型，通过 setWorldFilters([...filters]) 串联
 */
export { WorldFilterPipeline } from './WorldFilterPipeline';
export {
  loadFilter,
  createFilterFromDef,
  createFilterFromJson,
  clearFilterCache,
} from './FilterLoader';
export type { FilterDef } from './types';
export { isValidFilterDef, IDENTITY_MATRIX } from './types';
