/**
 * `build_helpers.mjs` 的类型声明——只给 `src/core/lightingPayloadFiles.test.ts` 那条契约测试用。
 *
 * 验收门是 node 直跑的 .mjs，本身不经 tsc；这里只声明契约测试要比对的那几个导出，
 * 让 `tsc --noEmit` 不把跨目录 import 判成隐式 any。其余导出没声明（TS 侧没人用）。
 */

export const PROBE_ATLAS_FILE_BY_MODE: Readonly<Record<1 | 2 | 3, string>>;
export const DEFAULT_PROBE_MODE: number;
export const LIGHTING_PAYLOAD_CORE: readonly string[];
export const LIGHTING_GEOMETRY_FILES: readonly string[];
export const LIGHTING_PAYLOAD_OPTIONAL: readonly string[];
export const LIGHTING_PAYLOAD_DEBUG_ONLY: readonly string[];
export function probeModeOf(shadingMode: unknown): 1 | 2 | 3;
export function probeAtlasFileForMode(shadingMode: unknown): string;
export function requiredLightingPayloadFiles(
  meta: { shading?: { mode?: unknown } } | null | undefined,
): string[];
export function lightingPayloadParity(
  target: string,
  devPayloads: Map<string, { files: Set<string>; meta: unknown }>,
  landed: Set<string>,
): {
  missing: Array<{ dir: string; file: string; why: string; inDevTree: boolean }>;
  leaked: Array<{ dir: string; file: string }>;
};
