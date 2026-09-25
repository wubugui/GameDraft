/**
 * RHI 公共入口。上层渲染代码只从这里取东西,不直接碰 luma.gl 或任何图形 API。
 *
 * 分层:`types` / `RhiDevice`(接口)→ `RhiResourceScope`(资源所有权)→ `graph/`(渲染图,只依赖接口)
 * → `backends/luma`(唯一图形实现:WebGPU,没有回落)、`backends/null`(不碰 GPU,单测用)。
 */
export * from './types';
export type * from './RhiDevice';
export { RhiResourceScope } from './RhiResourceScope';
export { RenderGraph } from './graph/RenderGraph';
export type * from './graph/RenderGraph';
export { RgTransientPool } from './graph/RgTransientPool';
export type { RgTransientPoolStats } from './graph/RgTransientPool';
export { createLumaRhiDevice as createRhiDevice } from './backends/luma/LumaRhiDevice';
export type { LumaRhiDeviceOptions as RhiDeviceOptions } from './backends/luma/LumaRhiDevice';
export { NullRhiDevice } from './backends/null/NullRhiDevice';
export type { NullRhiDeviceOptions } from './backends/null/NullRhiDevice';
