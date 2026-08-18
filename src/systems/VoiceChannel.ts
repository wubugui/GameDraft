import type { AudioPlaybackHandle, TransientSfxOptions } from '../data/types';

/**
 * 配音（人声）通道：全局唯一「当前这条人声」的所有者。
 *
 * 为什么要单独一层而不是各拍自己 playTransientSfx：一条配音的**寿命常常长于说它那一拍**
 * （一句配音配三条短字幕），"谁来停它"就必须有一个跨拍的所有者。此前字幕把句柄攥在
 * showSubtitleText 的闭包里、finally 一律 stop，长配音必被切断，且各台词面各写一份必然漂。
 *
 * 三条硬语义：
 * - **单声道**：任何新配音开播前先停掉在播的那条（两条人声叠着响必是编排事故）。
 * - **默认跟拍**：`hold` 不为真 = 本拍结束即停（与本层出现之前逐字一致）。
 * - **hold = 留声**：本拍结束不停，转入「留声态」等后续拍接管；被接管后就跟接管那一拍
 *   一起结束；没人接管就自然播完。
 *
 * 「接管」只由**声明了跟随配音推进**（`autoAdvance: "voice"`）却自己没配音的那一拍发起，
 * 见 {@link VoiceChannel.takeSustained}——语义即"这条字幕跟着前面那条配音一起结束"。
 */

/** 一拍配音的数据形态；字符串形态等价于只写 `id`。 */
export interface VoiceSpec {
  /** audio_config.sfx 里的条目 id */
  id: string;
  /** 相对音量（0–1）；不写 = 用条目自身的基础音量 */
  volume?: number;
  /** 本拍结束时不停，把这条配音留给后续拍（默认 false = 跟本拍一起结束） */
  hold?: boolean;
}

/** 一拍的自动推进方式；`null` = 等玩家点击（缺省语义）。 */
export type VoiceAdvanceSpec = { mode: 'voice' } | { mode: 'timer'; ms: number };

/**
 * 本层只需要 AudioManager 的这一个能力，不持有整个音频系统（同层 system 解耦）。
 *
 * 走 `playVoice` 而不是 `playTransientSfx`：台词乘的是**对白音量**那条通道——
 * 玩家把音效压低时台词必须还听得见，这是有对白的游戏的通行做法。
 */
export interface IVoicePlayer {
  playVoice(id: string, options?: TransientSfxOptions): AudioPlaybackHandle | null;
}

/** 一拍持有的配音票据：订阅自然播完 + 本拍收尾。 */
export interface VoiceBeatTicket {
  /** 这条配音是否已自然播完 */
  readonly ended: boolean;
  /**
   * 订阅「**自然**播完」；已播完则同步立即回调。返回退订函数。
   * 手动停 / 被新配音顶掉**不触发**——「跟随配音推进」据此安全退化为等玩家点击，
   * 而不是在配音被打断时闪切过去。
   */
  onEnd(cb: () => void): () => void;
  /**
   * 订阅「本条配音以任何方式收场」（自然播完 / 被顶掉 / 被停）；已收场则同步立即回调。
   * 给**必须封口**的等待方用（await 一条配音结束的动作不能因为配音被打断就永久悬挂）。
   */
  onSettled(cb: () => void): () => void;
  /** 本拍收尾：hold 为真则留声，否则停。幂等；已被新配音顶掉时为 no-op。 */
  endBeat(): void;
}

interface ActiveVoice {
  handle: AudioPlaybackHandle | null;
  hold: boolean;
  ended: boolean;
  /** 已收场（播完 / 被停 / 被顶掉）；settleSubs 只放行一次 */
  settled: boolean;
  /** 本拍已收尾、正处于留声态（等后续拍接管或自然播完） */
  sustained: boolean;
  subs: Set<() => void>;
  settleSubs: Set<() => void>;
}

/**
 * `voice` 字段解析：字符串 = sfx id；对象可写 `{ id | sfxId, volume, hold }`。
 * 非法/空 id 一律 null（调用方退化为"这一拍没有配音"）。
 */
export function parseVoiceSpec(raw: unknown): VoiceSpec | null {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const idRaw = typeof o.id === 'string'
    ? o.id
    : typeof o.sfxId === 'string'
      ? o.sfxId
      : '';
  const id = idRaw.trim();
  if (!id) return null;
  const spec: VoiceSpec = { id };
  /** null / 空串不当 0：Number(null) === 0 会把"没写音量"静默解释成静音 */
  const rawVolume = o.volume;
  if (rawVolume !== undefined && rawVolume !== null && rawVolume !== '') {
    const volume = typeof rawVolume === 'number' ? rawVolume : Number(rawVolume);
    if (Number.isFinite(volume)) spec.volume = volume;
  }
  /** 只认真布尔 true（与步骤级 disabled 同口径，杜绝 "false" 字符串反成真） */
  if (o.hold === true) spec.hold = true;
  return spec;
}

/**
 * `autoAdvance` 字段解析：`"voice"` = 跟随配音自然播完；正数 = 该毫秒数后推进。
 * 缺省 / 非法值 = null（等玩家点击）。数值只认真数值，不认 "3000" 字符串。
 */
export function parseVoiceAdvanceSpec(raw: unknown): VoiceAdvanceSpec | null {
  if (raw === 'voice') return { mode: 'voice' };
  const ms = typeof raw === 'number' ? raw : NaN;
  if (Number.isFinite(ms) && ms > 0) return { mode: 'timer', ms };
  return null;
}

/** 从一个数据对象上按键名优先级取配音规格（旧键名作兼容别名，前者优先）。 */
export function readVoiceSpec(
  src: Record<string, unknown> | null | undefined,
  keys: readonly string[] = ['voice'],
): VoiceSpec | null {
  if (!src) return null;
  for (const k of keys) {
    if (src[k] === undefined || src[k] === null) continue;
    const spec = parseVoiceSpec(src[k]);
    if (spec) return spec;
  }
  return null;
}

/** 同 {@link readVoiceSpec}，取自动推进规格。 */
export function readVoiceAdvanceSpec(
  src: Record<string, unknown> | null | undefined,
  keys: readonly string[] = ['autoAdvance'],
): VoiceAdvanceSpec | null {
  if (!src) return null;
  for (const k of keys) {
    if (src[k] === undefined || src[k] === null) continue;
    const spec = parseVoiceAdvanceSpec(src[k]);
    if (spec) return spec;
  }
  return null;
}

export class VoiceChannel {
  private audio: IVoicePlayer | null = null;
  private active: ActiveVoice | null = null;

  setAudioPlayer(audio: IVoicePlayer | null): void {
    this.audio = audio;
  }

  /**
   * 起本拍的配音（先停掉在播的任何一条）。
   * 返回 null = 没起来（无音频系统 / 未知 id / 加载失败）——调用方据此把"跟随配音推进"
   * 安全退化为等待点击，而不是闪切。
   */
  play(spec: VoiceSpec): VoiceBeatTicket | null {
    this.stopAll();
    if (!this.audio) return null;
    const rec: ActiveVoice = {
      handle: null,
      hold: spec.hold === true,
      ended: false,
      settled: false,
      sustained: false,
      subs: new Set(),
      settleSubs: new Set(),
    };
    const handle = this.audio.playVoice(spec.id, {
      ...(spec.volume !== undefined ? { volume: spec.volume } : {}),
      onEnd: () => this.markEnded(rec),
    });
    if (!handle) return null;
    rec.handle = handle;
    this.active = rec;
    return this.makeTicket(rec);
  }

  /**
   * 接管上一拍 `hold` 留下的配音：本拍成为它的新主人，**跟本拍一起结束**。
   * 没有留声 / 已播完 → null（调用方退化为等待点击）。
   */
  takeSustained(): VoiceBeatTicket | null {
    const rec = this.active;
    if (!rec || !rec.sustained || rec.ended) return null;
    rec.sustained = false;
    rec.hold = false;
    return this.makeTicket(rec);
  }

  /** 当前是否有一条"没人认领"的留声配音（调试快照 / 校验旁证用）。 */
  hasSustainedVoice(): boolean {
    const rec = this.active;
    return !!rec && rec.sustained && !rec.ended;
  }

  /** 停掉在播的配音并清空通道（过场收尾 / 读档 / 拆除的统一收口）。 */
  stopAll(): void {
    const rec = this.active;
    this.active = null;
    if (!rec) return;
    rec.subs.clear();
    if (!rec.ended) rec.handle?.stop();
    this.settle(rec);
  }

  private markEnded(rec: ActiveVoice): void {
    if (rec.ended) return;
    rec.ended = true;
    const subs = Array.from(rec.subs);
    rec.subs.clear();
    /** 自然播完的留声配音无人可停，直接让出通道，免得挡住 takeSustained 的判定 */
    if (this.active === rec && rec.sustained) this.active = null;
    for (const cb of subs) cb();
    this.settle(rec);
  }

  /** 收场广播：每条配音恰好一次，等待方据此封口（不区分自然播完还是被打断）。 */
  private settle(rec: ActiveVoice): void {
    if (rec.settled) return;
    rec.settled = true;
    const subs = Array.from(rec.settleSubs);
    rec.settleSubs.clear();
    for (const cb of subs) cb();
  }

  private makeTicket(rec: ActiveVoice): VoiceBeatTicket {
    return {
      get ended(): boolean {
        return rec.ended;
      },
      onEnd: (cb: () => void): (() => void) => {
        if (rec.ended) {
          cb();
          return () => { /* 已结束：无可退订 */ };
        }
        rec.subs.add(cb);
        return () => { rec.subs.delete(cb); };
      },
      onSettled: (cb: () => void): (() => void) => {
        if (rec.settled) {
          cb();
          return () => { /* 已收场：无可退订 */ };
        }
        rec.settleSubs.add(cb);
        return () => { rec.settleSubs.delete(cb); };
      },
      endBeat: (): void => {
        if (this.active !== rec) return;
        if (rec.ended) {
          this.active = null;
          return;
        }
        if (rec.hold) {
          rec.sustained = true;
          return;
        }
        rec.subs.clear();
        rec.handle?.stop();
        this.active = null;
        this.settle(rec);
      },
    };
  }
}
