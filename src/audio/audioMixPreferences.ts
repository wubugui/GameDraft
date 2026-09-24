import type { AudioChannel } from '../data/types';

/**
 * 玩家的混音偏好：**总音量 + 四条通道音量**（2026-09-23 制作人定：总音量要做进声音底层）。
 *
 * ## 这几个数是什么、住在哪
 *
 * - **总音量**乘在整个游戏的**唯一出口**上（Howler 的主增益——Howler 自己的声音、空间音总线、
 *   解锁提示音全部汇到这一个节点），所以它管住游戏里的**每一个**声音，不需要任何一条播放路径
 *   各自去乘一遍；以后新加的播放路径只要还接在这个出口上，自动就被它管着。
 * - **通道音量**（背景音乐 / 音效 / 环境音 / 对白）照旧在各自的混音公式里乘（见 per-site-audio-volume）。
 * - 两者都是**玩家偏好**，落 `settings/audio.json`（与文字呈现、气味指向同一个存放面），
 *   **不进存档**：以前它们存在每个存档槽里，读一个老档就把玩家刚调好的音量冲回存档那一刻的值，
 *   刷新页面 / 新游戏又回到出厂值。
 *
 * 本文件只放**纯数据**的解析与规整（可单测、不碰音频设备），读写与生效在 AudioManager。
 */
export interface AudioMixPreferences {
  master: number;
  bgm: number;
  sfx: number;
  ambient: number;
  voice: number;
}

/**
 * 出厂值。通道那四个与改动前 AudioManager 的字段初值逐字一致（编辑器试听的镜像表
 * `tools/editor/shared/audio_library.py::CHANNEL_DEFAULT_VOLUME` 靠这几个数对齐）；
 * 总音量缺省满档 = 与没有总音量时响度逐位相同。
 */
export const AUDIO_MIX_DEFAULTS: Readonly<AudioMixPreferences> = Object.freeze({
  master: 1,
  bgm: 0.6,
  sfx: 0.8,
  ambient: 0.4,
  voice: 1,
});

export const AUDIO_MIX_KEYS = ['master', 'bgm', 'sfx', 'ambient', 'voice'] as const satisfies readonly (keyof AudioMixPreferences)[];

/** 通道键（不含总音量）——与 {@link AudioChannel} 同一组名字。 */
export const AUDIO_MIX_CHANNELS: readonly AudioChannel[] = ['bgm', 'sfx', 'ambient', 'voice'];

export function clampMixLevel(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * 把偏好文件的原文解析成一份完整偏好。**只认类型对得上的键**，缺的 / 坏的一律落回出厂值，
 * 一条脏偏好绝不能把设置页读成 NaN 或者把游戏整个静音（NaN 进增益节点 = 全哑且不报错）。
 * 返回 `null` = 文件整个不可用（JSON 坏了 / 不是对象），调用方按"没有偏好文件"处理。
 */
export function parseAudioMixPreferences(raw: string): AudioMixPreferences | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const out: AudioMixPreferences = { ...AUDIO_MIX_DEFAULTS };
  for (const key of AUDIO_MIX_KEYS) {
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clampMixLevel(v);
  }
  return out;
}

/** 落盘用的序列化：键序固定（文件好读、好比对），数值收到 3 位小数（拖滑条出来的 0.73000000001 不进文件）。 */
export function serializeAudioMixPreferences(p: AudioMixPreferences): string {
  const out: Record<string, number> = {};
  for (const key of AUDIO_MIX_KEYS) out[key] = Number(clampMixLevel(p[key]).toFixed(3));
  return JSON.stringify(out);
}
