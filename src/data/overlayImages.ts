/**
 * 叠图注册表（overlay_images.json）
 *
 * 一条 = 一张可被 `showOverlayImage` / `blendOverlayImage` 引用的图。
 * 最早一条只有「短 id → 路径」一个字段，值就是字符串；现在一条还要带上
 * **这张图叠上来时响什么**，于是值可以升级成对象：
 *
 *   "码头告示": "/resources/.../notice.png"                                  // 老写法
 *   "龛前_真":  { "image": "/resources/.../真.png", "sfx": "sfx_xxx" }        // 带音效
 *
 * 两种写法**同时合法**，字符串形态不会被工具改写成对象（作者手写的表不该被重排）。
 *
 * 与 `prop_presets.json` 是同一个思路（短 id → 资源，每条不止一个字段）。
 *
 * 音效本身**不在这里播**：解析出的 cue 由动作层随事件发出，
 * 由音频管理器那张系统音效事件表统一发声（见 `system-sfx-event-table` 机制卡）。
 */

/** 一条叠图登记。字段全可选：只填 image 也是合法条目。 */
export interface OverlayImageDef {
  /** 图片路径（/assets/… 或 /resources/…） */
  image?: string;
  /**
   * 这张图叠上来时响不响。
   * 缺省（未写）= 响，走全局默认叠图音；`false` = 这一条永远不响，连全局默认也跳过。
   */
  playSfx?: boolean;
  /**
   * 专属音效 id（`audio_config.json#sfx` 的键）。
   * 填了就用它、并且**不再叠全局默认音**（逐条与全局二选一，两边都响是唯一的失败模式）。
   */
  sfx?: string;
}

export type OverlayImageTable = Record<string, string | OverlayImageDef>;

/** 一次叠图该怎么发声；由动作层塞进事件负载，音频管理器消费。 */
export interface OverlaySfxCue {
  /** true = 这一条明确要求静音（连全局默认音也跳过） */
  silent: boolean;
  /** 专属音效 id；不填表示走全局默认叠图音 */
  sfx?: string;
}

/** 静音以外的缺省：走全局默认音。 */
export const DEFAULT_OVERLAY_SFX_CUE: OverlaySfxCue = { silent: false };

function asDef(entry: unknown): OverlayImageDef | null {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as OverlayImageDef)
    : null;
}

/** 取这条登记的图片路径；字符串形态即路径本身。查不到返回空串。 */
export function overlayImagePath(entry: string | OverlayImageDef | undefined): string {
  if (typeof entry === 'string') return entry.trim();
  const def = asDef(entry);
  if (!def) return '';
  return typeof def.image === 'string' ? def.image.trim() : '';
}

/** 取这条登记的发声意图。字符串形态没有音效配置 = 走全局默认。 */
export function overlayImageSfxCue(entry: string | OverlayImageDef | undefined): OverlaySfxCue {
  const def = asDef(entry);
  if (!def) return DEFAULT_OVERLAY_SFX_CUE;
  if (def.playSfx === false) return { silent: true };
  const sfx = typeof def.sfx === 'string' ? def.sfx.trim() : '';
  return sfx ? { silent: false, sfx } : DEFAULT_OVERLAY_SFX_CUE;
}

/** 宽容解析整张表：非对象输入给空表，条目原样保留（字符串/对象都不改写）。 */
export function parseOverlayImages(raw: unknown): OverlayImageTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: OverlayImageTable = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (asDef(v)) out[k] = v as OverlayImageDef;
  }
  return out;
}
