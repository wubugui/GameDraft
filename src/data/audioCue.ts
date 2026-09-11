/**
 * 音频引用的**逐处音量**（2026-09-09）。
 *
 * ## 为什么要有这一层
 *
 * `audio_config` 里那条 `volume` 是**素材级**的："这条音本身录得偏响/偏轻，登记时先修平"。
 * 但同一条音在不同地方要的响度天然不同——同一声木门在近景推门要满，在隔壁屋当氛围只要一半。
 * 素材级音量表达不了这件事，作者以前只能复制一条同源素材、改个 id、单独调 volume（音频目录
 * 因此长出一堆 `xxx_quiet` / `xxx_loud` 的重复条目，且真要整体调一档时全得逐条改）。
 *
 * 于是每一个**引用**音频 id 的地方都可以写成对象形态，把"本处音量"带在身上：
 *
 * ```json
 * "ambientSounds": ["amb_street", { "id": "amb_temple_bell", "volume": 0.35 }]
 * ```
 *
 * ## 口径（唯一，勿另立）
 *
 * 逐处音量**替换**素材级 volume（不是相乘），再乘该通道的全局音量：
 *
 *     最终线性增益 = clamp01( (本处 volume ?? 素材 volume ?? 1) × 通道音量 )
 *
 * 与 `AudioManager.playSfx(id, volume)` 从一开始就是同一口径——本模块只是把这个口径
 * 从"少数几个 action 参数"推广到全部引用点，不是新发明一套。
 *
 * `volume > 1` 合法（表示"比素材原音更响"），但最终仍被 clamp 到满幅 1.0：
 * 只能吃掉"当前音量→满幅"那段余量（通道音量 0.8 时约 +25%），要更响得放大素材本身。
 *
 * ## 形态选择（作者面/数据面约定）
 *
 * - **元素位 / 映射值位**（数组元素、`Record` 的值）→ 对象形态 `{ id, volume }`：
 *   那些位置挂不了兄弟键。
 * - **对象里的单个字段**（`Scene.bgm`、`PressureHoldDef.holdSfx`…）→ 也走对象形态：
 *   兄弟键（`bgmVolume`）在"时段变体只覆盖 bgm 不覆盖 bgmVolume"这类合并路径上会走散，
 *   音量跟着 id 一起走才不会漏。
 * - 唯一的例外是历史字段 `revealSfx` / `revealSfxVolume`（已有数据在盘上），保持兄弟键形态，
 *   读侧照样过本模块（`cueFromLegacyPair`）。
 */
import type { AudioCueRef } from './types';

/** 引用取 id；未配置 / 结构不合法一律空串（调用方按"没配"处理，不猜）。 */
export function audioCueId(ref: AudioCueRef | null | undefined): string {
  if (typeof ref === 'string') return ref.trim();
  if (ref && typeof ref === 'object') return String((ref as { id?: unknown }).id ?? '').trim();
  return '';
}

/**
 * 引用取本处音量；没写 / 非有限数 / 负数一律 `undefined`（= 沿用素材级音量）。
 *
 * ⚠ `0` 是**合法**的（"这里就是要哑"），绝不能与 `undefined` 合并——
 * 写成 `volume || undefined` 会让作者手动配的静音悄悄变回原音量。
 */
export function audioCueVolume(ref: AudioCueRef | null | undefined): number | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const raw = (ref as { volume?: unknown }).volume;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

/** 引用列表取 id 列表（跳过空引用）。 */
export function audioCueIds(refs: readonly AudioCueRef[] | null | undefined): string[] {
  const out: string[] = [];
  for (const ref of refs ?? []) {
    const id = audioCueId(ref);
    if (id) out.push(id);
  }
  return out;
}

/** 把引用规整成 `{ id, volume }`；id 为空返回 null（调用方据此跳过该条）。 */
export function normalizeAudioCue(
  ref: AudioCueRef | null | undefined,
): { id: string; volume: number | undefined } | null {
  const id = audioCueId(ref);
  if (!id) return null;
  return { id, volume: audioCueVolume(ref) };
}

/** 列表版 `normalizeAudioCue`：过滤掉空引用。 */
export function normalizeAudioCues(
  refs: readonly AudioCueRef[] | null | undefined,
): Array<{ id: string; volume: number | undefined }> {
  const out: Array<{ id: string; volume: number | undefined }> = [];
  for (const ref of refs ?? []) {
    const cue = normalizeAudioCue(ref);
    if (cue) out.push(cue);
  }
  return out;
}

/**
 * 历史「兄弟键」形态（`revealSfx` + `revealSfxVolume`）转成统一引用。
 * 只给盘上已有这种形态的字段用；**新字段一律用对象形态**，别再造兄弟键。
 */
export function cueFromLegacyPair(
  id: string | null | undefined,
  volume: number | null | undefined,
): AudioCueRef | null {
  const trimmed = String(id ?? '').trim();
  if (!trimmed) return null;
  if (typeof volume === 'number' && Number.isFinite(volume) && volume >= 0) {
    return { id: trimmed, volume };
  }
  return trimmed;
}

/**
 * 两个引用在**发声上是否等价**——供"要不要重放/重载"这类判等使用。
 * 直接 `a !== b` 比是错的：对象形态每次解析都是新对象，恒判成"变了"。
 */
export function sameAudioCue(a: AudioCueRef | null | undefined, b: AudioCueRef | null | undefined): boolean {
  return audioCueId(a) === audioCueId(b) && audioCueVolume(a) === audioCueVolume(b);
}

/** 列表版 `sameAudioCue`（顺序敏感——环境层顺序就是作者的编排顺序）。 */
export function sameAudioCueList(
  a: readonly AudioCueRef[] | null | undefined,
  b: readonly AudioCueRef[] | null | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!sameAudioCue(left[i], right[i])) return false;
  }
  return true;
}
