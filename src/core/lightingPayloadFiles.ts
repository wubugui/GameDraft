/**
 * 光照烘焙载荷：**运行时到底会读哪些文件** —— 运行时与打包清单共用的唯一真相源。
 *
 * ## 为什么要有这个文件
 *
 * 2026-09-02 角色 probe 正式档从 SH（mode 2 → `atlas_l2.bin`）切到八面体
 * （mode 3 → `atlas_bin.bin`），运行时改了、29 份载荷重烘了，而打包规则
 * `tools/build/manifest_rules.json` 还停在前一天的口径：`atlas_bin.bin` 被当作
 * "只有 F2 切档才读"的调试载荷**刻意排除在发行档之外**。结果发行包里 28 个场景的
 * 角色照明整体失效（probe 图集被 404 正文填成全 0 → 纯黑剪影；或长度为奇数时整份
 * 载荷在 catch 里作废 → 连行走面深度场一起丢），而构建、验收、素材审计三道门全绿。
 *
 * 根因是"运行时读什么"这件事散在三处各自维护（`CharacterLightingSystem.probeCfg`、
 * `manifest_rules.json`、`test_asset_manifest.py` 的硬编码名单），改一处漏两处。
 * 从此收成一处：
 *
 * - 运行时：`CharacterLightingSystem` 按这里的表选图集、按这里的 `fetchPayloadBytes` 取文件；
 * - 打包：`tools/build/asset_manifest.py` 的 `_expand_lighting_payload` 按同一张表
 *   从每份 `lighting.json` 的 `shading.mode` 推导要抽哪些文件（Python 侧是镜像，
 *   `tools/build/tests/test_asset_manifest.py` 解析本文件断言两边逐字相同）；
 * - 验收：`scripts/lib/build_helpers.mjs` 的同名函数在产物上反向核对
 *   （`src/core/lightingPayloadFiles.test.ts` 断言它与本文件逐字相同）。
 *
 * 改这里的任何一个名字/缺省值，两个契约测试会立刻红——那正是目的。
 *
 * ## 表的含义
 *
 * | 组 | 缺了会怎样 | 打包口径 |
 * |---|---|---|
 * | `LIGHTING_PAYLOAD_CORE` + 当前 mode 的图集 | 整份载荷作废（角色不打光 + 深度场丢） | 必抽 |
 * | `LIGHTING_GEOMETRY_FILES` | 场景侧光照不启用（背景不受灯照） | 必抽 |
 * | `LIGHTING_PAYLOAD_OPTIONAL` | 静默降级（skyao 不遮蔽，角色偏亮） | 开发树有就必抽 |
 * | `LIGHTING_PAYLOAD_DEBUG_ONLY` | 只有 F2 切 RT 才读 | 只进 dev 档 |
 * | 其它 mode 的图集 | 只有 F2 切档才读 | 只进 dev 档 |
 */

/** probe 图集：`lighting.json` 的 `shading.mode` → 文件名。 */
export const PROBE_ATLAS_FILE_BY_MODE: Readonly<Record<1 | 2 | 3, string>> = {
  1: 'atlas_l1.bin',
  2: 'atlas_l2.bin',
  3: 'atlas_bin.bin',
};

/** 载荷没写 / 写了不认识的 mode 时的缺省：八面体（2026-09-02 正式档）。 */
export const DEFAULT_PROBE_MODE = 3;

/** 进场景必读；缺任何一个整份载荷作废。 */
export const LIGHTING_PAYLOAD_CORE: readonly string[] = ['lighting.json', 'probes_valid.bin', 'ground_d.png'];

/**
 * 场景侧几何场（`SceneLightingSystem`）：几何 meta / 法线 / **albedo 贴图**。
 *
 * ⚠ `skyvis.png` 2026-09-07 起**不在这里**：它的唯一运行时用途是 albedo 反解的除数
 * `S_day`，而 albedo 现在是烘出来的贴图（`albedo.png`），除数整段搬去了离线端。
 * 那张图照旧烘、留在开发树给烘焙器当输入，只是不再进发行包、运行时也不装它。
 */
export const LIGHTING_GEOMETRY_FILES: readonly string[] = ['geometry.json', 'normal.png', 'albedo.png'];

/** 可选：老载荷没有；缺了**静默降级**（skyao 不遮蔽）。所以开发树里有就必须进包。 */
export const LIGHTING_PAYLOAD_OPTIONAL: readonly string[] = ['skyao_probe.bin'];

/** 只有 F2 调试面板切 RT 才读（20–27 MB/场景）；发行档刻意不带。 */
export const LIGHTING_PAYLOAD_DEBUG_ONLY: readonly string[] = ['vol_rad.bin', 'vol_emit.bin'];

/** `shading.mode` → 实际生效的 probe mode（缺省与不认识的值一律回八面体）。 */
export function probeModeOf(shadingMode: unknown): 1 | 2 | 3 {
  return shadingMode === 1 || shadingMode === 2 ? shadingMode : DEFAULT_PROBE_MODE;
}

/** `shading.mode` → 进场景要拉的那一张 probe 图集文件名。 */
export function probeAtlasFileForMode(shadingMode: unknown): string {
  return PROBE_ATLAS_FILE_BY_MODE[probeModeOf(shadingMode)];
}

/**
 * 一份载荷在**正常游玩路径**上必读的全部文件名（不含可选与调试专用）。
 * `meta` 是 `lighting.json` 的内容；传 null 按缺省 mode 算。
 */
export function requiredLightingPayloadFiles(
  meta: { shading?: { mode?: unknown } } | null | undefined,
): string[] {
  return [
    ...LIGHTING_PAYLOAD_CORE,
    probeAtlasFileForMode(meta?.shading?.mode),
    ...LIGHTING_GEOMETRY_FILES,
  ];
}

/**
 * 取一个载荷文件的字节。**缺文件必须响**，不许把 404 正文当数据。
 *
 * 两条判据缺一不可：
 * - `r.ok`：Tauri 自定义协议 / 静态服务对缺文件回 404 **带正文**（`404 找不到：<path>`），
 *   不看状态码就会把那串文字当 probe 图集吃进去 —— 偶数字节补零成全黑图集，奇数字节
 *   `new Uint16Array` 抛 RangeError。两种表现互相矛盾，排查时极易被带偏。
 * - content-type 不是 HTML：vite dev 服的 SPA fallback 对缺文件回 **200 + index.html**，
 *   只看 `r.ok` 会放行（optional-asset-probe 机制卡）。
 */
export async function fetchPayloadBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  assertPayloadResponse(r, url);
  return r.arrayBuffer();
}

/** 同 `fetchPayloadBytes`，取 Blob（`ground_d.png` 走 `createImageBitmap`）。 */
export async function fetchPayloadBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  assertPayloadResponse(r, url);
  return r.blob();
}

function assertPayloadResponse(r: Response, url: string): void {
  const ct = (r.headers.get('content-type') ?? '').toLowerCase();
  const html = ct.includes('text/html');
  if (r.ok && !html) return;
  throw new Error(
    `光照载荷取不到：${url}（HTTP ${r.status}${html ? '，服务回落成了 index.html' : ''}）`
    + ' —— 打包漏抽或烘焙产物缺失；见 src/core/lightingPayloadFiles.ts',
  );
}
