import { Howl, Howler } from 'howler';
import type { EventBus } from '../core/EventBus';
import type { AssetManager, AssetRef } from '../core/AssetManager';
import { resolveAssetPath } from '../core/assetPath';
import { SpatialAudioBus } from '../audio/SpatialAudioBus';
import type { AcousticPoint, AcousticSpaceDef, DirectPath } from '../audio/acousticSpace';
import { TEXT_URLS } from '../core/projectPaths';
import type { AudioChannel, AudioCueRef, DialogueEndPayload, IGameSystem, GameContext, IAudioSettingsProvider, AudioPlaybackHandle, TransientSfxOptions } from '../data/types';
import { audioCueId, audioCueIds, audioCueVolume, normalizeAudioCues } from '../data/audioCue';
import type { OverlaySfxCue } from '../data/overlayImages';

interface AudioEntry {
  src: string;
  volume?: number;
  /**
   * 走不走场景声学空间。缺省＝不走（继续从 Howler 出，行为与以前完全一致）。
   *
   * 写了就改走**并行的空间音通道**：原生 Web Audio 播放，干湿分开送，
   * 湿信号进场景的卷积器。sfx 与 voice 两区都支持——喊叫要不要带场景回音，
   * 逐条自己决定。
   *
   * ⚠ 环境底噪不要开：底噪本身就是这个空间，再加混响是重复。
   */
  spatial?: { wet?: number; dry?: number };
}

interface AudioConfig {
  bgm: Record<string, AudioEntry>;
  ambient: Record<string, AudioEntry>;
  sfx: Record<string, AudioEntry>;
  /** 对白配音。独立一区（配音会长到近千条，混进 sfx 就没法管）；**不与 sfx 互相回落** */
  voice: Record<string, AudioEntry>;
  /**
   * 事件 → sfx 引用。值可写 `{ id, volume }` 给**这一条系统音**单独定音量：
   * 同一声"叮"用作确认音要清脆、用作悬停音就得压到三分之一，靠这里而不是复制素材。
   */
  systemSfx: Record<string, AudioCueRef>;
}

type EventCallback = (payload?: any) => void;

/** JSON 里的 spatial 字段可能是任何东西（策划手写/编辑器旧版），一律收敛成合法值或 undefined。 */
function normalizeSpatial(raw: unknown): { wet?: number; dry?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
  const wet = num(o.wet);
  const dry = num(o.dry);
  if (wet === undefined && dry === undefined) return undefined;
  return { wet, dry };
}

/** UI 切换/悬停音的最小间隔（毫秒）；理由见 installSystemSfxListeners 里的 ui:hover */
const UI_HOVER_SFX_MIN_GAP_MS = 60;

export class AudioManager implements IGameSystem, IAudioSettingsProvider {
  private eventBus: EventBus;
  private config: AudioConfig = { bgm: {}, ambient: {}, sfx: {}, voice: {}, systemSfx: {} };
  /** 声学空间库（acoustic_spaces.json）；空表＝没有任何空间，空间音退化为干声。 */
  private acousticSpaces: Record<string, AcousticSpaceDef> = {};
  /** 空间音总线，首次用到才建（拿不到 Howler.ctx 时保持 null，安静降级）。 */
  private spatialBus: SpatialAudioBus | null = null;
  private loaded = false;

  private currentBgm: Howl | null = null;
  private currentBgmId: string | null = null;
  /** 数据/动作层要求的 BGM；不受浏览器手势门、解码时序和输出设备状态影响。 */
  private requestedBgmId: string | null = null;
  /** 同上，但记的是**本处音量**（undefined = 沿用素材级）；过场基线快照要连音量一起记。 */
  private requestedBgmVolume: number | undefined = undefined;
  /** 已提交的当前 BGM 的本处音量；幂等守卫按 (id, 本处音量) 判，只比 id 会吞掉"同曲换音量"。 */
  private currentBgmSiteVolume: number | undefined = undefined;
  /** 每次 playBgm/stopBgm 自增；await loadAudio 期间若被更新的请求取代，旧请求放弃播放，避免泄漏正在播放的 Howl。 */
  private bgmRequestSeq = 0;
  /** 当前 BGM 的基础音量乘数（配置 entry.volume ?? 1）；setVolume('bgm') 按 base×全局 重算而非直接覆盖 */
  private currentBgmBaseVolume = 1.0;
  private ambientLayers: Map<string, Howl> = new Map();
  /** 数据/动作层要求的环境音集合；用于跨运行时确定性快照。 */
  private requestedAmbientIds = new Set<string>();
  /** 每层 ambient 的基础音量乘数（addAmbient 入参 ?? 配置 entry.volume ?? 1）；setVolume('ambient') 按 base×全局 重算 */
  private ambientBaseVolume: Map<string, number> = new Map();
  /**
   * 对齐 bgmRequestSeq 的按层代次守卫：addAmbient 记下自己的代次，removeAmbient/clearAmbient/destroy
   * 推进代次使在途加载作废（await loadAudio 归来发现代次过期即不 play、不入 Map），
   * 防快速切场时旧场景环境音复活、以及同 id 并发 add 对同一 Howl 双 play 叠音。
   * 代次只增不清零：destroy 后残留的在途回调靠单调计数保证永远过期。
   */
  private ambientRequestSeq: Map<string, number> = new Map();
  private sfxCache: Map<string, Howl> = new Map();

  /**
   * 过场「一次性音效捕获」作用域：beginCutsceneSfxCapture 开启后，playSfx 会把本次 play 的
   * (共享 Howl, soundId) 登记进 cutsceneSfxSounds；endCutsceneSfxCapture(true)（过场中断收尾）只停这些
   * 具体 soundId（不 unload 共享缓存、不影响过场外同名音效的其它并发实例）。
   */
  private cutsceneSfxActive = false;
  private cutsceneSfxSounds: Array<{ howl: Howl; sid: number }> = [];

  private bgmVolume = 0.6;
  private sfxVolume = 0.8;
  private ambientVolume = 0.4;
  /** 对白音量。**默认满档**：台词是"听不见就玩不下去"的信息，
   *  其余通道相对它让位，而不是反过来把台词压在音效之下（对白锚定）。 */
  private voiceVolume = 1.0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  private assetManager!: AssetManager;

  /** 嵌入式 WebView 等场景下，页面加载后尚无用户手势，此时 play() 会触发 AudioContext 警告；推迟到首次输入再真正播放。 */
  private audioUnblocked = false;
  private audioUnlocking = false;
  private pendingPlayback: Array<() => void | Promise<void>> = [];
  private gestureListenersInstalled = false;
  /** 音频保活：每秒看一眼 AudioContext（见 installAudioKeepAlive） */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveOff: (() => void) | null = null;
  private resumeInFlight = false;
  private forcedUnlockDone = false;
  /** 最近一次喂给总线的听者：总线重建 / 首次建出来时立刻喂回去，别让第一声按原点算 */
  private lastListener: { ear: AcousticPoint; forward: [number, number, number] | null } | null = null;
  /** 音频没靠任何手势就解锁了（免手势的专用预览窗 / 桌面客户端）；普通浏览器页签里永远 false */
  private audioAutoUnlocked = false;
  private sfxEventListeners: Array<{ event: string; callback: EventCallback }> = [];
  private lastMapTravelSfxAt = 0;
  /** UI 切换/悬停音的上次发声时刻（节流，见 installSystemSfxListeners 的 ui:hover） */
  private lastUiHoverSfxAt = 0;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.installAudioGestureGate();
    this.installAudioKeepAlive();
    this.installSystemSfxListeners();
  }
  update(_dt: number): void {}

  async loadConfig(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<{
        bgm?: Record<string, { src: string }>;
        ambient?: Record<string, { src: string }>;
        sfx?: Record<string, { src: string }>;
        voice?: Record<string, { src: string }>;
        systemSfx?: Record<string, unknown>;
      }>(TEXT_URLS.audioConfig);
      const resolveSrc = (obj: Record<string, { src: string; volume?: number; spatial?: unknown }>) => {
        const out: Record<string, AudioEntry> = {};
        for (const [k, v] of Object.entries(obj)) {
          const volume = typeof v.volume === 'number' ? v.volume : undefined;
          out[k] = { src: resolveAssetPath(v.src), volume, spatial: normalizeSpatial(v.spatial) };
        }
        return out;
      };
      this.config = {
        bgm: resolveSrc(raw.bgm ?? {}),
        ambient: resolveSrc(raw.ambient ?? {}),
        sfx: resolveSrc(raw.sfx ?? {}),
        // 按键名逐个装配的白名单：新增一个区必须同步加这一行，
        // 否则 JSON 里写了、运行时是空的，而且一声不吭（踩过）。
        voice: resolveSrc(raw.voice ?? {}),
        // 值可以是裸 id 也可以是 { id, volume }；解析不出 id 的条目一律丢掉
        // （丢掉而不是留个空 id：空 id 会在每次事件上走一遍查表未命中，白烧且掩盖配置错误）。
        systemSfx: Object.fromEntries(
          Object.entries(raw.systemSfx ?? {})
            .map(([k, v]) => [k, v as AudioCueRef] as const)
            .filter(([, v]) => audioCueId(v) !== ''),
        ),
      };
      this.loaded = true;
    } catch {
      console.warn('AudioManager: audio_config.json not found, running silent');
      this.loaded = true;
    }
    await this.loadAcousticSpaces();
  }

  /** 声学空间库。缺文件不是错——没有空间就退化为干声，与加这套之前完全一致。 */
  private async loadAcousticSpaces(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<{
        spaces?: Record<string, AcousticSpaceDef>;
      }>(TEXT_URLS.acousticSpaces);
      const out: Record<string, AcousticSpaceDef> = {};
      for (const [k, v] of Object.entries(raw.spaces ?? {})) {
        if (v && Array.isArray(v.reflectors) && v.listener) out[k] = v;
        else console.warn(`[AudioManager] 声学空间 "${k}" 结构不合法，已跳过`);
      }
      this.acousticSpaces = out;
    } catch {
      this.acousticSpaces = {};
    }
  }

  // ================= 空间音（场景声学） =================

  /**
   * 换场景声学空间。`null` / 未知 id ＝ 没有空间，空间音退化为纯干声。
   *
   * IR 由 JS 现算（毫秒级），不预存文件 —— 这也是实时联动能成立的前提：
   * 改一个数字立刻重算，不用等烘焙。
   */
  setAcousticSpace(id: string | null | undefined): void {
    const def = id ? this.acousticSpaces[id] : null;
    if (id && !def) {
      console.warn(`[AudioManager] 未知声学空间 "${id}"，本场景按无空间处理`);
    }
    const bus = this.ensureSpatialBus();
    if (!bus) {
      // 音频上下文要用户手势才有：先记账，`flushPendingAcoustic` 每帧补挂。
      // 不记的话「进场景 → 点一下解锁」之后这个场景永远没有回音，而且毫无痕迹。
      this.pendingAcoustic = { id: def ? id! : null, def: def ?? null };
      return;
    }
    this.pendingAcoustic = null;
    bus.setSpace(def ? id! : null, def ?? null);
  }

  /** 总线建不出来时欠着的那份空间（音频尚未解锁）。 */
  private pendingAcoustic: { id: string | null; def: AcousticSpaceDef | null } | null = null;

  /**
   * 音频上下文晚于场景就绪（要用户手势）：每帧问一次，能建总线了就把欠着的空间挂上。
   * 返回 true 表示这一帧真挂上了（调用方据此强制重算一次听者）。
   */
  flushPendingAcoustic(): boolean {
    if (!this.pendingAcoustic) return false;
    const bus = this.ensureSpatialBus();
    if (!bus) return false;
    const p = this.pendingAcoustic;
    this.pendingAcoustic = null;
    bus.setSpace(p.id, p.def);
    return true;
  }

  /** 是否还有欠着没挂上的空间（状态回传用，别让"已套用"看起来像在响）。 */
  hasPendingAcoustic(): boolean {
    return this.pendingAcoustic !== null;
  }

  /** 当前挂着的声学空间 id；调试面板与实时联动用。 */
  getAcousticSpaceId(): string | null {
    return this.spatialBus?.getSpaceId() ?? null;
  }

  /**
   * 移动听者（**耳点**，M-world wu，已含耳高；`forward` = 视线方向，方位角以它为正前）。回音随之改变。
   * 内部带节流：挪动不足阈值（按空间距离缩放折成米）或距上次重算不足 300ms 就跳过；直达声逐声音现算不受节流。
   * 返回是否真重算了。
   */
  setAcousticListener(ear: AcousticPoint, forward: [number, number, number] | null, force = false): boolean {
    this.lastListener = { ear, forward };
    return this.spatialBus?.setListener(ear, forward, force) ?? false;
  }

  /** 当前听者耳点（wu，M-world）。 */
  getAcousticListener(): AcousticPoint | null {
    return this.spatialBus?.getListener() ?? null;
  }

  /** 总线上实际挂着的空间定义（可能是工作台推来的工作态，不在库里）。 */
  getActiveAcousticSpaceDef(): AcousticSpaceDef | null {
    return this.spatialBus?.getSpaceDef() ?? null;
  }

  /** 某个发声点相对当前听者的直达声（诊断 / 面板）。 */
  getAcousticDirect(at: AcousticPoint | null): DirectPath | null {
    return this.spatialBus?.getDirect(at) ?? null;
  }

  /**
   * 最近 `windowMs` 内**空间音总线输出**的峰值（dBFS；总线还没建时量主输出）。**这是"真出声了"的证据**：
   * 试听发出去后工作台问这个，而不是相信「播放函数返回了 true」。只量空间音——BGM / 环境 / UI 在响不会
   * 冒充试听出声。没有上下文 / 电平表还没装时返回 -Infinity。
   */
  getRecentOutputPeakDb(windowMs = 3000): number {
    const now = Date.now();
    let pk = 0;
    for (const s of this.meterSamples) if (now - s.at <= windowMs && s.peak > pk) pk = s.peak;
    return pk > 0 ? 20 * Math.log10(pk) : -Infinity;
  }

  /** 上次重算 IR 的耗时（毫秒），性能诊断用。 */
  getAcousticBuildCostMs(): number {
    return this.spatialBus?.getLastBuildCostMs() ?? 0;
  }

  /** 当前移动阈值（米）：挪够这么远才重算 IR，按空间尺度与重算代价自适应。 */
  getAcousticMoveThresholdM(): number {
    return this.spatialBus?.getMoveThresholdM() ?? 0;
  }

  /** 当前 IR 的抽头表（距离/延迟/方位/增益），编辑器与调试面板直接显示。 */
  getAcousticTaps(): unknown[] {
    return this.spatialBus?.getTaps() ?? [];
  }

  /** 库里全部空间 id（F2「声学」页的下拉）。 */
  listAcousticSpaceIds(): string[] {
    return Object.keys(this.acousticSpaces);
  }

  /** 取一份空间定义。调用方要改就自己深拷贝 —— 这里给的是库里那份的引用。 */
  getAcousticSpaceDef(id: string): AcousticSpaceDef | null {
    return this.acousticSpaces[id] ?? null;
  }

  /**
   * 直接喂一份声学空间定义（不经过库）。实时联动改的就是这条：
   * 工作台或游戏内编辑模式改了参数 → 推进来 → 立刻重算 IR → 下一声就是新的。
   */
  applyAcousticSpaceDef(id: string, def: AcousticSpaceDef | null): void {
    if (def) this.acousticSpaces[id] = def;
    const bus = this.ensureSpatialBus();
    if (!bus) {
      this.pendingAcoustic = { id: def ? id : null, def };
      return;
    }
    this.pendingAcoustic = null;
    bus.setSpace(def ? id : null, def);
  }

  /**
   * 浏览器音频是否已被用户手势解锁。没解锁时任何播放都是静默的——
   * 实时联动的试听要据此回报「没播出去」，而不是假装播了。
   */
  isAudioUnlocked(): boolean {
    // ⚠ 不能只看 ctx.state：Howler 的 autoSuspend 会在 30s 没声音后把 ctx 挂起，播放时再自动 resume。
    //   挂起 ≠ 没解锁。见过一次 running 就算解锁；Howler 自己的 _audioUnlocked 也作数。
    const h = Howler as unknown as { ctx?: AudioContext; _audioUnlocked?: boolean };
    if (h.ctx && h.ctx.state === 'running') this.audioUnlockedSeen = true;
    return this.audioUnlockedSeen || h._audioUnlocked === true;
  }
  private audioUnlockedSeen = false;

  /** 音频是不是没靠任何手势就解锁了（跑在免手势的专用预览窗 / 桌面客户端里）。工作台据此判断这页是不是普通浏览器页签。 */
  isAudioAutoUnlocked(): boolean {
    return this.audioAutoUnlocked;
  }

  private ensureSpatialBus(): SpatialAudioBus | null {
    const H = Howler as unknown as { ctx?: AudioContext; masterGain?: GainNode };
    const ctx = H.ctx, master = H.masterGain;
    if (this.spatialBus) {
      // 总线挂在一个已关掉 / 被换掉的 AudioContext 上 = 所有空间音全哑而毫无报错
      // （2026-09-08 「试听一点声音都没有」的根因：总线的 ctx 是 closed 的，Howler 早换了一个新的）。
      // 拆掉重建；挂着的空间记回账，下一拍 flushPendingAcoustic 补挂，Game 随即强制重喂听者。
      const stale = this.spatialBus.context.state === 'closed' || (!!ctx && this.spatialBus.context !== ctx);
      if (!stale) return this.spatialBus;
      console.warn('[AudioManager] 空间音总线的 AudioContext 已失效（closed 或被换掉），重建总线并重挂空间');
      const old = this.spatialBus;
      this.pendingAcoustic = { id: old.getSpaceId(), def: old.getSpaceDef() };
      old.destroy();
      this.spatialBus = null;
    }
    // Howler 的 AudioContext 与主增益就是汇入点：两条通道共用同一条音量总线。
    // 够不到就安静降级 —— 空间音退化成走 Howler 的普通音效，不该整条崩掉。
    if (!ctx || !master || ctx.state === 'closed') return null;
    this.spatialBus = new SpatialAudioBus({ ctx, destination: master });
    if (this.lastListener) this.spatialBus.setListener(this.lastListener.ear, this.lastListener.forward, true);
    return this.spatialBus;
  }

  /** 返回 true 表示已由空间通道接管；false 表示回落到 Howler。 */
  private playViaSpatial(entry: AudioEntry, volume?: number): boolean {
    const bus = this.ensureSpatialBus();
    if (!bus) return false;
    const optionVolume = typeof volume === 'number' && Number.isFinite(volume) ? volume : undefined;
    const base = optionVolume ?? entry.volume ?? 1.0;
    bus.playAt(entry.src, null, {
      volume: this.clamp01(base * this.sfxVolume),
      wet: entry.spatial?.wet ?? 0.6,
      dry: entry.spatial?.dry ?? 1.0,
    });
    return true;
  }

  /** 没标 `spatial` 的素材（脚步等）从有位置的发声点播时的缺省湿量。 */
  static DEFAULT_POSITIONAL_WET = 0.5;

  /**
   * 从 M-world 里的一个发声点播一条音效（**有物理位置的声源**：脚步、NPC、试听声源……）。
   * `at = null` = 声源在听者耳朵上（自己喊）。直达声按几何算延迟 / 衰减 / 声像，反射按镜像声源法，
   * 全在 `SpatialAudioBus`。没有 AudioContext（音频还没建起来）时退成不带位置的一次性音。
   *
   * 句柄只停本次实例。id 查不到当场 warn + 返回 null，**不回落**（同 playTransientSfx 的理由）。
   */
  playSfxAt(
    id: string,
    at: AcousticPoint | null,
    options: {
      volume?: number; onEnd?: () => void; onStart?: () => void;
      /**
       * `false` = 绕开整条空间音通道，就播一个声音（无距离 / 声像 / 延迟 / 空气低通 / 回音）。
       * 与"没有 AudioContext"走的是**同一条**退路，所以音量口径天然一致
       * （两边都是 `volume × sfxVolume`）——另起一条播放路径才会出现"关了空间化顺便变响了"。
       */
      spatialized?: boolean;
    } = {},
  ): AudioPlaybackHandle | null {
    const entry = this.config.sfx[id];
    if (!entry) {
      console.warn(`AudioManager: audio_config.sfx 里没有 "${id}"——这条不发声`);
      return null;
    }
    if (options.spatialized === false) {
      return this.playTransientSfx(id, { volume: options.volume, onEnd: options.onEnd });
    }
    const bus = this.ensureSpatialBus();
    if (!bus) return this.playTransientSfx(id, { volume: options.volume, onEnd: options.onEnd });
    // 播放门还关着（还没解锁）：有位置的声音**丢掉**，不排队——排队会在解锁那一刻把攒下的几十步脚步
    // 按早已过时的位置一齐放出来
    if (!this.audioUnblocked) return null;
    let stopped = false;
    let inner: { stop(): void } | null = null;
    const handle: AudioPlaybackHandle = {
      stop: () => { stopped = true; inner?.stop(); inner = null; },
    };
    const optionVolume = typeof options.volume === 'number' && Number.isFinite(options.volume) ? options.volume : undefined;
    const base = optionVolume ?? entry.volume ?? 1.0;
    this.runWhenAudioAllowed(() => {
      if (stopped) return;
      const b = this.ensureSpatialBus() ?? bus;
      inner = b.playAt(entry.src, at, {
        volume: this.clamp01(base * this.sfxVolume),
        wet: entry.spatial?.wet ?? AudioManager.DEFAULT_POSITIONAL_WET,
        dry: entry.spatial?.dry ?? 1.0,
        onEnd: options.onEnd,
        onStart: options.onStart,
      });
    });
    return handle;
  }

  /**
   * `volume` = **本处音量**（逐处覆盖素材级 `entry.volume`，口径见 `data/audioCue.ts`）。
   * 缺省沿用素材级；最终 `clamp01(base × bgmVolume)`。
   *
   * ⚠ 幂等守卫按 (id, 本处音量) 判：只比 id 的话，同一首曲子换了音量的请求会被当成
   * "已经在播这首了"直接吞掉——夜里想把白天那首压半档就静默不生效。
   */
  playBgm(id: string, fadeMs: number = 1000, volume?: number): void {
    const requestedVolume = typeof volume === 'number' && Number.isFinite(volume) && volume >= 0
      ? volume
      : undefined;
    this.requestedBgmId = id;
    this.requestedBgmVolume = requestedVolume;
    const myReq = ++this.bgmRequestSeq;
    this.runWhenAudioAllowed(async () => {
      // 排队期间已被更新的请求取代：放弃。
      if (myReq !== this.bgmRequestSeq) return;
      if (this.currentBgmId === id && this.currentBgm && this.currentBgmSiteVolume === requestedVolume) return;

      const entry = this.config.bgm[id];
      if (!entry) {
        console.warn(`AudioManager: unknown bgm "${id}"`);
        return;
      }

      // 先加载、后切换：加载期间保持当前 BGM 播放；若加载期间被更新请求/stopBgm 取代则原样退出，
      // 绝不在“尚未提交新 BGM”时就清空 currentBgm（否则会出现 currentBgm=null 但 currentBgmId 仍旧的错位）。
      const howl = this.assetManager.getAudio(entry.src, { loop: true })
        ?? await this.assetManager.loadAudio(entry.src, { loop: true });
      if (myReq !== this.bgmRequestSeq) return;
      if (this.currentBgmId === id && this.currentBgm === howl && this.currentBgmSiteVolume === requestedVolume) return;

      // 提交切换：仅当旧 BGM 与新实例不同才淡出（避免重复请求同一缓存 Howl 时把自己停掉）；
      // currentBgm 与 currentBgmId 一起更新，无中间空窗。
      if (this.currentBgm && this.currentBgm !== howl) {
        const old = this.currentBgm;
        old.fade(old.volume(), 0, fadeMs);
        // 若淡出期间该 Howl 又被重新设为当前（A→B→A 且共享缓存实例），延时到点时不要再 stop。
        this.scheduleCleanup(() => { if (this.currentBgm !== old) old.stop(); }, fadeMs);
      }
      // 复用缓存 Howl 前，先停掉其上任何残留发声实例（如 A→B→A 中被淡出但仍在循环的旧实例）：
      // Howler 的 play() 在已有发声时会再开一个并发实例，volume(0) 不会停旧实例，故不先 stop 会叠音。
      howl.stop();
      howl.loop(true);
      howl.volume(0);
      howl.play();
      // 本处音量**替换**素材级（不是相乘）——与 playSfx / addAmbient 同口径。
      const baseVol = requestedVolume ?? entry.volume ?? 1.0;
      howl.fade(0, this.clamp01(baseVol * this.bgmVolume), fadeMs);

      this.currentBgm = howl;
      this.currentBgmId = id;
      this.currentBgmBaseVolume = baseVol;
      this.currentBgmSiteVolume = requestedVolume;
    });
  }

  stopBgm(fadeMs: number = 1000): void {
    this.requestedBgmId = null;
    this.requestedBgmVolume = undefined;
    // 使任何在途的 playBgm 失效（其 myReq 将不再匹配），避免 stop 后旧加载又把 BGM 拉起。
    ++this.bgmRequestSeq;
    this.runWhenAudioAllowed(() => {
      if (!this.currentBgm) return;
      const bgm = this.currentBgm;
      bgm.fade(bgm.volume(), 0, fadeMs);
      // 若淡出期间又有 playBgm 重新起用同一 Howl，到点时不要把它 stop 掉。
      this.scheduleCleanup(() => { if (this.currentBgm !== bgm) bgm.stop(); }, fadeMs);
      this.currentBgm = null;
      this.currentBgmId = null;
      this.currentBgmSiteVolume = undefined;
    });
  }

  private bumpAmbientSeq(id: string): number {
    const next = (this.ambientRequestSeq.get(id) ?? 0) + 1;
    this.ambientRequestSeq.set(id, next);
    return next;
  }

  addAmbient(id: string, volume?: number): void {
    this.requestedAmbientIds.add(id);
    // 代次在调用时同步领取：后续任何 remove/clear/更新的 add 都会使本次请求过期
    const myReq = this.bumpAmbientSeq(id);
    this.runWhenAudioAllowed(async () => {
      if (myReq !== this.ambientRequestSeq.get(id)) return;

      const entry = this.config.ambient[id];
      if (!entry) {
        console.warn(`AudioManager: unknown ambient "${id}"`);
        return;
      }

      // 本处音量**替换**素材级（不是相乘）——与 playSfx / playBgm 同口径。
      const baseVol = volume ?? entry.volume ?? 1.0;

      // 该层已在播：不重放（重放会有一次爆音/相位跳），但**要认新音量**——
      // 幂等守卫写成"已在播就整个返回"的话，「同一层换个音量」这条指令会静默丢掉。
      const playing = this.ambientLayers.get(id);
      if (playing) {
        if (this.ambientBaseVolume.get(id) !== baseVol) {
          playing.volume(this.clamp01(baseVol * this.ambientVolume));
          this.ambientBaseVolume.set(id, baseVol);
        }
        return;
      }

      const howl = this.assetManager.getAudio(entry.src, { loop: true })
        ?? await this.assetManager.loadAudio(entry.src, { loop: true });
      // 加载期间被 removeAmbient/clearAmbient/更新的 addAmbient 取代：放弃，不 play 不入 Map
      if (myReq !== this.ambientRequestSeq.get(id)) return;
      if (this.ambientLayers.has(id)) return;
      // 复用缓存 Howl 前先停残留发声实例（如淡出中的旧层），否则 play() 会另起并发实例叠音（同 playBgm）
      howl.stop();
      howl.loop(true);
      howl.volume(this.clamp01(baseVol * this.ambientVolume));
      howl.play();
      this.ambientLayers.set(id, howl);
      this.ambientBaseVolume.set(id, baseVol);
    });
  }

  removeAmbient(id: string, fadeMs: number = 500): void {
    this.requestedAmbientIds.delete(id);
    // 使该层任何在途 addAmbient 作废
    this.bumpAmbientSeq(id);
    this.runWhenAudioAllowed(() => {
      const howl = this.ambientLayers.get(id);
      if (!howl) return;
      howl.fade(howl.volume(), 0, fadeMs);
      // 淡出期间同 id 被重新 add（共享缓存实例）时，到点不要把新层停掉（同 stopBgm 的守卫）
      this.scheduleCleanup(() => { if (this.ambientLayers.get(id) !== howl) howl.stop(); }, fadeMs);
      this.ambientLayers.delete(id);
      this.ambientBaseVolume.delete(id);
    });
  }

  clearAmbient(fadeMs: number = 500): void {
    this.requestedAmbientIds.clear();
    // 使全部层的在途 addAmbient 作废（含尚未入 Map、还停在 await loadAudio 的）
    for (const key of this.ambientRequestSeq.keys()) this.bumpAmbientSeq(key);
    this.runWhenAudioAllowed(() => {
      this.ambientLayers.forEach((howl, id) => {
        howl.fade(howl.volume(), 0, fadeMs);
        this.scheduleCleanup(() => { if (this.ambientLayers.get(id) !== howl) howl.stop(); }, fadeMs);
      });
      this.ambientLayers.clear();
      this.ambientBaseVolume.clear();
    });
  }

  /**
   * 播放一次性音效。`volume` 给定时**替换** entry 的基础音量再乘全局 sfxVolume
   * （与 playTransientSfx 口径一致）；缺省沿用 entry.volume ?? 1。
   * 允许 >1 表示"调大"，但最终经 clamp01 封顶到 1.0（Howler / 浏览器音频满幅上限）——
   * 即只能在"当前播放音量→满幅"这段余量内变大，超过满幅需放大素材文件本身。
   */
  playSfx(id: string, volume?: number): void {
    // 在同步入口捕获作用域标志：runWhenAudioAllowed 的回调可能被推迟异步执行，
    // 届时以 sync 时刻的意图为准，再在回调内复查 cutsceneSfxActive 决定是否登记。
    const captureForCutscene = this.cutsceneSfxActive;
    this.runWhenAudioAllowed(async () => {
      const entry = this.config.sfx[id];
      if (!entry) return;

      // 标了 spatial 的走并行的空间音通道（原生 Web Audio + 卷积），不进 Howler。
      // 没标的行为与以前完全一致。
      if (entry.spatial && this.playViaSpatial(entry, volume)) return;

      const howl = this.sfxCache.get(id)
        ?? this.assetManager.getAudio(entry.src, { loop: false })
        ?? await this.assetManager.loadAudio(entry.src, { loop: false });
      if (!this.sfxCache.has(id)) this.sfxCache.set(id, howl);
      // 配置里的 per-entry volume 是基础乘数，与全局 sfxVolume 相乘（与 playTransientSfx 口径一致）
      const optionVolume = typeof volume === 'number' && Number.isFinite(volume) ? volume : undefined;
      const baseVolume = optionVolume ?? entry.volume ?? 1.0;
      howl.volume(this.clamp01(baseVolume * this.sfxVolume));
      const sid = howl.play();
      // 过场作用域内起的一次性音效登记句柄：过场结束（cleanup）统一停，避免尾音在切画面后继续响。
      // 复查 cutsceneSfxActive：runWhenAudioAllowed 可能把本次播放推迟到过场结束后才执行，此时不登记。
      if (captureForCutscene && this.cutsceneSfxActive) {
        this.cutsceneSfxSounds.push({ howl, sid });
      }
    });
  }

  /** 过场开始：开启一次性音效捕获并清空上一轮登记（防跨过场残留）。 */
  beginCutsceneSfxCapture(): void {
    this.cutsceneSfxActive = true;
    this.cutsceneSfxSounds = [];
  }

  /**
   * 过场收尾：关闭捕获作用域。
   * `stopPlaying=true`（Esc 跳过 / 读档 / 拆除等**中断**路径）立即停掉尚在播放的本过场 SFX——
   * 回收「画面已切走、尾音仍响」的泄漏；对已自然播完/已卸载的 stop 为安全 no-op。
   * `stopPlaying=false`（过场**自然播完**）只关闭作用域、丢弃句柄引用，让末拍音效按作者编排自然收尾，
   * 不改动既有听感。无论哪种都不 unload 共享缓存、不影响过场外的并发实例。
   */
  endCutsceneSfxCapture(stopPlaying: boolean): void {
    this.cutsceneSfxActive = false;
    if (stopPlaying) {
      for (const s of this.cutsceneSfxSounds) {
        try { s.howl.stop(s.sid); } catch { /* 已卸载/已停止安全忽略 */ }
      }
    }
    this.cutsceneSfxSounds = [];
  }

  /**
   * 当前 BGM 的**带音量引用**（无则 null）——供过场快照音频基线。
   *
   * ⚠ 刻意**不提供**只返回 id 的版本：还原路径拿到裸 id 就会按素材原音量重播，
   * 场景特意压低的那半档静默丢掉（只在真机听得出来）。要纯 id 的调试信息走
   * `getDebugOutputState()` / `getRequestedBgmId()`。
   */
  getCurrentBgmCue(): AudioCueRef | null {
    if (!this.currentBgmId) return null;
    const vol = this.currentBgmSiteVolume;
    return vol === undefined ? this.currentBgmId : { id: this.currentBgmId, volume: vol };
  }

  /** 当前活跃环境层的**带音量引用**列表——供过场快照音频基线（理由同上）。 */
  getActiveAmbientCues(): AudioCueRef[] {
    return Array.from(this.ambientLayers.keys()).map((id) => {
      const vol = this.ambientBaseVolume.get(id);
      return vol === undefined ? id : { id, volume: vol };
    });
  }

  /** 与设备实际是否已获准发声解耦的确定性音频意图。 */
  getRequestedBgmId(): string | null {
    return this.requestedBgmId;
  }

  getRequestedAmbientIds(): string[] {
    return Array.from(this.requestedAmbientIds);
  }

  /** 自动化听感门禁：读取实际 Howler 播放实例，不参与存档或玩法判断。 */
  getDebugOutputState(): Record<string, unknown> {
    const bgmVolume = this.currentBgm ? Number(this.currentBgm.volume()) : 0;
    return {
      audioUnblocked: this.audioUnblocked,
      bgm: {
        requestedId: this.requestedBgmId,
        currentId: this.currentBgmId,
        linearVolume: Number.isFinite(bgmVolume) ? bgmVolume : 0,
        playing: this.currentBgm?.playing() === true,
      },
      ambient: Array.from(this.ambientLayers.entries())
        .map(([id, howl]) => ({ id, linearVolume: Number(howl.volume()) || 0, playing: howl.playing() === true }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      activeSfxCount: this.sfxCache.size,
    };
  }

  /**
   * 还原到过场前音频基线：BGM 切回 `bgm`（null=停），并补回环境层——**连本处音量一起还原**。
   * playBgm/addAmbient 自带幂等守卫（同 id 同音量已在播即返回），故基线未被过场改动时全为 no-op。
   */
  restoreAudioBaseline(bgm: AudioCueRef | null, ambient: AudioCueRef[]): void {
    const bgmId = audioCueId(bgm);
    if (bgmId) this.playBgm(bgmId, 1000, audioCueVolume(bgm));
    else this.stopBgm();
    for (const cue of normalizeAudioCues(ambient)) this.addAmbient(cue.id, cue.volume);
  }

  /**
   * 播放一条与调用方生命周期绑定的短音频。复用 AssetManager 缓存的共享 Howl（同 addAmbient），
   * 只操作本次 play() 返回的 soundId：stop() 走 `howl.stop(soundId)` 只停本实例，**绝不 unload
   * 共享 Howl**（会毁缓存、令后续重播重新解码）。适合字幕配音这类“离开本步即释放”的声音。
   * 加载失败 / 加载归来发现已 stop 均安全退化为不发声（onEnd 不触发，调用方退化为等待点击）。
   */
  playTransientSfx(id: string, options: TransientSfxOptions = {}): AudioPlaybackHandle | null {
    return this.playTransientEntry(id, options, 'sfx');
  }

  /**
   * playTransientSfx / playVoice 的共同实现。唯一差别是乘哪条通道音量。
   *
   * **不做任何回落**：id 查不到就是查不到，当场 warn + 返回 null。
   * 静默回落（"这里没有就去那里找"）是混乱的源头——它让"配置写错了"这件事
   * 在游戏里表现正常、只在别处露馅，等于把矛盾藏起来留给以后。
   */
  private playTransientEntry(
    id: string,
    options: TransientSfxOptions,
    channel: 'sfx' | 'voice',
  ): AudioPlaybackHandle | null {
    const entry = this.config[channel][id];
    if (!entry) {
      console.warn(`AudioManager: audio_config.${channel} 里没有 "${id}"——不回落别的区，这条不发声`);
      return null;
    }

    let stopped = false;
    let howl: Howl | null = null;
    let soundId: number | null = null;
    /** 绑在本次 soundId 上的 'end' 监听：手动 stop 时须一并 off，否则死闭包永久残留在长寿共享 Howl 上。 */
    let endListener: (() => void) | null = null;

    const handle: AudioPlaybackHandle = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        // 只停本次实例，不 unload 共享缓存 Howl（其它调用/后续重播仍复用）。
        if (howl !== null && soundId !== null) {
          // Howler 的 stop() 不会触发 'end'，故 once('end') 不会自动摘除——手动 off 防监听器累积。
          if (endListener) howl.off('end', endListener, soundId);
          howl.stop(soundId);
        }
        howl = null;
        soundId = null;
        endListener = null;
      },
    };

    this.runWhenAudioAllowed(async () => {
      if (stopped) return;
      let shared: Howl;
      try {
        shared = this.assetManager.getAudio(entry.src, { loop: false })
          ?? await this.assetManager.loadAudio(entry.src, { loop: false });
      } catch (error) {
        console.warn(`AudioManager: transient ${channel} "${id}" failed to load`, error);
        stopped = true;
        return;
      }
      // await 期间被 handle.stop() 取消：不 play（否则起一个无人停止的实例）。
      if (stopped) return;

      const optionVolume = typeof options.volume === 'number' && Number.isFinite(options.volume)
        ? options.volume
        : undefined;
      const baseVolume = optionVolume ?? entry.volume ?? 1.0;

      const sid = shared.play();
      const channelVolume = channel === 'voice' ? this.voiceVolume : this.sfxVolume;
      shared.volume(this.clamp01(baseVolume * channelVolume), sid);
      // 声像**一律带 soundId**：共享 Howl 上的组级写入会被后续所有实例继承且清不掉
      // （Howler 的 Sound.init/reset 每次从 parent 复制 _stereo）。见 TransientSfxOptions。
      if (typeof options.pan === 'number' && Number.isFinite(options.pan)) {
        // 在 play() 之后立刻调：Howler 建 panner 时会对已在播的实例 pause().play()，
        // 此刻 seek≈0，等于重头播——听不出来。晚调（声音已经放出去一截）才会咔哒。
        shared.stereo(Math.max(-1, Math.min(1, options.pan)), sid);
      }
      howl = shared;
      soundId = sid;
      // 结束事件绑到本次 soundId：只在本实例自然播完时触发一次（手动 stop 不会走到这里）。
      endListener = () => {
        if (stopped) return;
        stopped = true;
        howl = null;
        soundId = null;
        endListener = null;
        options.onEnd?.();
      };
      shared.once('end', endListener, sid);
    });

    return handle;
  }

  /**
   * 播放一条对白配音。与 playTransientSfx 只差一件事：**音量乘 `voiceVolume`**。
   *
   * 条目和音效同在 `audio_config.sfx` 一个来源——**走哪条总线由调用点决定，
   * 不由条目存在哪个区决定**。曾经为此单开过一个 `voice` 配置区，结果是
   * 编辑器四处登记面漏配、"游戏能放但编辑器说 id 无效"，白白多出一层不一致。
   */
  playVoice(id: string, options: TransientSfxOptions = {}): AudioPlaybackHandle | null {
    return this.playTransientEntry(id, options, 'voice');
  }

  setVolume(channel: AudioChannel, vol: number): void {
    const v = Math.max(0, Math.min(1, vol));
    switch (channel) {
      case 'bgm':
        this.bgmVolume = v;
        if (this.currentBgm) this.currentBgm.volume(this.clamp01(this.currentBgmBaseVolume * v));
        break;
      case 'sfx':
        this.sfxVolume = v;
        break;
      case 'ambient':
        this.ambientVolume = v;
        // 按「每层基础乘数 × 新全局值」重算，不能直接覆盖成 v（会把配置/入参的层级音量冲掉）
        this.ambientLayers.forEach((howl, id) =>
          howl.volume(this.clamp01((this.ambientBaseVolume.get(id) ?? 1.0) * v)));
        break;
      case 'voice':
        this.voiceVolume = v;
        break;
    }
  }

  /**
   * 设置页「松手试听」：按**这条通道刚调好的响度**放一声样本。语义见 IAudioSettingsProvider。
   *
   * ⚠ 音量取的是 `getVolume(channel)` 而**不是** `sfxVolume`——调环境音时听到的响度
   * 必须就是环境音那条的响度，拿音效通道的音量放一声等于给了个假参照。
   * 所以这里不能图省事走 `playSfx()`（那条恒乘 sfxVolume）。
   * 样本取 `systemSfx.volumePreview`，没配就退到确认音/悬停音——这三个都没有就静默不响。
   */
  previewVolume(channel: AudioChannel): void {
    // bgm / ambient 是实时生效的：正在出声时拖滑条本来就听得见，再补一声是多余的噪音
    if (channel === 'bgm' && this.currentBgm?.playing() === true) return;
    if (channel === 'ambient' && this.ambientLayers.size > 0) return;

    // 同 playAudioUnlockCue：值可能是 { id, volume } 对象，不能 `||` 串起来再 .trim()。
    const cueRef = [
      this.config.systemSfx.volumePreview,
      this.config.systemSfx.uiConfirm,
      this.config.systemSfx.uiHover,
    ].find((r) => audioCueId(r) !== '');
    const cueId = audioCueId(cueRef);
    const entry = cueId ? this.config.sfx[cueId] : undefined;
    if (!entry) return;
    const channelVolume = this.getVolume(channel);
    // 本处音量（表里给这条样本单独配的）优先于素材级——与 playSystemSfx 同口径。
    const cueBaseVolume = audioCueVolume(cueRef) ?? entry.volume ?? 1.0;

    this.runWhenAudioAllowed(async () => {
      const howl = this.sfxCache.get(cueId)
        ?? this.assetManager.getAudio(entry.src, { loop: false })
        ?? await this.assetManager.loadAudio(entry.src, { loop: false });
      if (!this.sfxCache.has(cueId)) this.sfxCache.set(cueId, howl);
      howl.volume(this.clamp01(cueBaseVolume * channelVolume));
      howl.play();
    });
  }

  getVolume(channel: AudioChannel): number {
    switch (channel) {
      case 'bgm': return this.bgmVolume;
      case 'sfx': return this.sfxVolume;
      case 'ambient': return this.ambientVolume;
      case 'voice': return this.voiceVolume;
    }
  }

  /** 套用场景音频。`bgm` / `ambient` 逐项可带**本处音量**（同一条环境音在两个场景不同响度）。 */
  applySceneAudio(bgm?: AudioCueRef, ambient?: AudioCueRef[]): void {
    const bgmId = audioCueId(bgm);
    if (bgmId) {
      this.playBgm(bgmId, 1000, audioCueVolume(bgm));
    } else {
      this.stopBgm();
    }

    this.clearAmbient();
    for (const cue of normalizeAudioCues(ambient)) {
      this.addAmbient(cue.id, cue.volume);
    }
  }

  serialize(): object {
    return {
      bgmVolume: this.bgmVolume,
      sfxVolume: this.sfxVolume,
      ambientVolume: this.ambientVolume,
      voiceVolume: this.voiceVolume,
    };
  }

  deserialize(data: {
    bgmVolume?: number; sfxVolume?: number; ambientVolume?: number; voiceVolume?: number;
  }): void {
    if (data.bgmVolume !== undefined) this.bgmVolume = data.bgmVolume;
    if (data.sfxVolume !== undefined) this.sfxVolume = data.sfxVolume;
    if (data.ambientVolume !== undefined) this.ambientVolume = data.ambientVolume;
    // 旧档没有这个键：保持默认满档，不要按 0 处理（那会让老存档一读进来台词全哑）
    if (data.voiceVolume !== undefined) this.voiceVolume = data.voiceVolume;
  }

  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  private scheduleCleanup(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.pendingTimers.delete(id);
      fn();
    }, ms);
    this.pendingTimers.add(id);
  }

  getSceneAudioRefs(bgm?: AudioCueRef, ambient?: AudioCueRef[]): AssetRef[] {
    const refs: AssetRef[] = [];
    const bgmId = audioCueId(bgm);
    if (bgmId && this.config.bgm[bgmId]) {
      refs.push({ type: 'audio', path: this.config.bgm[bgmId].src, options: { loop: true }, label: `BGM: ${bgmId}` });
    }
    for (const id of audioCueIds(ambient)) {
      const entry = this.config.ambient[id];
      if (entry) refs.push({ type: 'audio', path: entry.src, options: { loop: true }, label: `环境音: ${id}` });
    }
    return refs;
  }

  private runWhenAudioAllowed(fn: () => void | Promise<void>): void {
    if (this.audioUnblocked) {
      void fn();
      return;
    }
    this.pendingPlayback.push(fn);
  }

  private playAudioUnlockCue(): void {
    // 三个候选按顺序取第一条**解析得出 id** 的（值可能是 { id, volume } 对象，
    // 直接 `||` 串起来会把对象当真值，再 .trim() 就崩）。
    const cueRef = [
      this.config.systemSfx.audioUnlock,
      this.config.systemSfx.uiHover,
      this.config.systemSfx.uiConfirm,
    ].find((r) => audioCueId(r) !== '');
    const cueId = audioCueId(cueRef);
    const entry = cueId ? this.config.sfx[cueId] : undefined;
    if (!entry) return;

    let cue: Howl | null = null;
    const cleanup = () => {
      const h = cue;
      if (!h) return;
      h.stop();
      h.unload();
      cue = null;
    };
    // 本处音量（表里给这条系统音单独配的）优先于素材级——与 playSystemSfx 同口径。
    const baseVolume = audioCueVolume(cueRef) ?? (typeof entry.volume === 'number' ? entry.volume : 1.0);
    cue = new Howl({
      src: [entry.src],
      loop: false,
      preload: true,
      volume: Math.max(0, Math.min(0.18, baseVolume * this.sfxVolume * 0.35)),
      onend: cleanup,
      onloaderror: cleanup,
    });
    cue.play();
    this.scheduleCleanup(cleanup, 3000);
  }

  private flushPendingPlayback(playCue = true): void {
    this.audioUnblocked = true;
    this.audioUnlocking = false;
    if (playCue) this.playAudioUnlockCue();
    const queued = this.pendingPlayback.splice(0);
    for (const fn of queued) {
      void fn();
    }
  }

  private readonly _onFirstGesture = (e: Event): void => {
    if (this.audioUnblocked || this.audioUnlocking) return;
    const shouldReserveGestureForAudio = this.pendingPlayback.length > 0;
    if (shouldReserveGestureForAudio) {
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
    }
    this.audioUnlocking = true;
    this.removeAudioGestureListeners();
    const resume = Howler.ctx?.resume();
    if (resume && typeof resume.then === 'function') {
      void resume.catch(() => {}).finally(() => this.flushPendingPlayback());
    } else {
      this.flushPendingPlayback();
    }
  };

  private installAudioGestureGate(): void {
    if (typeof window === 'undefined' || this.gestureListenersInstalled) return;
    // 页面已获得 sticky 用户激活（如首启「点击开始」遮罩已被点过）：AudioContext 可直接解锁，
    // 不必再等一次输入——否则开场过场首句配音会被推迟到下一次点击才补播、与字幕错位。
    if (this.pageHasUserActivation()) {
      this.audioUnblocked = true;
      this.audioUnlocking = false;
      const resume = Howler.ctx?.resume?.();
      if (resume && typeof resume.then === 'function') void resume.catch(() => {});
      return;
    }
    this.gestureListenersInstalled = true;
    const capActive: AddEventListenerOptions = { capture: true, passive: false };
    window.addEventListener('pointerdown', this._onFirstGesture, capActive);
    window.addEventListener('keydown', this._onFirstGesture, { capture: true });
    window.addEventListener('touchstart', this._onFirstGesture, capActive);
  }

  /**
   * 音频保活——这是桌面游戏，不是网页（制作人 2026-09-08：浏览器那套"没点过不出声、没焦点就掐掉"一律禁止）。
   *
   * - `Howler.autoSuspend = false`：Howler 缺省 30s 没声音就把 AudioContext 挂起、下次播放再 resume。叠上浏览器对
   *   没焦点 / 被盖住的窗口的后台降级，就是"播着播着断了、点回窗口再播一下才续上"。进程活着上下文就活着。
   * - 每秒看一眼上下文：挂起就 resume。同一时刻只挂一个 resume 在飞——浏览器不放行时那个 promise 会一直等到手势
   *   才落（Chrome 的行为），不会堆积；放行了（专用预览窗 / Tauri 客户端带 `--autoplay-policy=no-user-gesture-required`）
   *   下一拍就是 running。
   * - 上下文已 running 而播放门还关着：直接开门放队列，**不放解锁提示音**（那是给"你点了一下"的回应；这里根本没人点）。
   *   没有这一步，自动播放放行的窗口里 `playSfx` 照样排队等一个永远不来的首次手势——工作台的试听就是这么静默丢掉的。
   * - visibilitychange / focus 也立刻看一眼，不等下一秒。
   */
  private installAudioKeepAlive(): void {
    if (typeof window === 'undefined' || this.keepAliveTimer) return;
    Howler.autoSuspend = false;
    this.detectAutoplayAllowed();
    const tick = () => this.keepAudioAlive();
    this.keepAliveTimer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    this.keepAliveOff = () => {
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
    tick();
  }

  /** 电平表：AnalyserNode 挂在空间音总线的汇合节点上（没总线时挂 Howler.masterGain），每 100ms 记一次峰值，留最近 5 秒。 */
  private meterAnalyser: AnalyserNode | null = null;
  private meterCtx: AudioContext | null = null;
  private meterNode: AudioNode | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private meterBuf: Float32Array<ArrayBuffer> = new Float32Array(0);
  private meterSamples: Array<{ at: number; peak: number }> = [];

  private ensureOutputMeter(ctx: AudioContext): void {
    const master = (Howler as unknown as { masterGain?: GainNode }).masterGain;
    const bus = this.spatialBus && this.spatialBus.context === ctx ? this.spatialBus : null;
    const target: AudioNode | undefined = bus?.output ?? master;
    if (this.meterAnalyser && this.meterCtx === ctx && this.meterNode === target) return;
    this.dropOutputMeter();   // 换了目标节点 / 上下文：先把旧的从源头拔掉（源 → 分析器这条边不会自己消失）
    if (!target || target.context !== ctx || typeof ctx.createAnalyser !== 'function') return;
    try {
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      target.connect(an);
      this.meterAnalyser = an;
      this.meterCtx = ctx;
      this.meterNode = target;
      this.meterBuf = new Float32Array(an.fftSize);
      this.meterTimer = setInterval(() => this.sampleOutputMeter(), 100);
    } catch { /* 拿不到电平表就没有证据，但不影响出声 */ }
  }

  private sampleOutputMeter(): void {
    const an = this.meterAnalyser;
    if (!an) return;
    an.getFloatTimeDomainData(this.meterBuf);
    let pk = 0;
    const b = this.meterBuf;
    for (let i = 0; i < b.length; i++) { const a = b[i] < 0 ? -b[i] : b[i]; if (a > pk) pk = a; }
    const now = Date.now();
    this.meterSamples.push({ at: now, peak: pk });
    while (this.meterSamples.length && now - this.meterSamples[0].at > 5000) this.meterSamples.shift();
  }

  private dropOutputMeter(): void {
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; }
    if (this.meterAnalyser) {
      // AnalyserNode.disconnect() 只断它的**出边**；源 → 分析器这条边要从源头断，否则每次重建都在 masterGain 上多挂一个
      try { this.meterNode?.disconnect(this.meterAnalyser); } catch { /* 已断开 */ }
      try { this.meterAnalyser.disconnect(); } catch { /* 已断开 */ }
    }
    this.meterAnalyser = null;
    this.meterCtx = null;
    this.meterNode = null;
    this.meterSamples = [];
  }

  /**
   * 这页是不是免手势（专用预览窗 / 桌面客户端带 `--autoplay-policy=no-user-gesture-required`）：
   * 开一个探针 AudioContext 看它生下来是不是 running。**只在页面还没有任何用户激活时判**——有过手势的页
   * 新上下文本来就 running，判不出来（那种情况留给 keepAudioAlive 的自动开门分支）。
   */
  private detectAutoplayAllowed(): void {
    if (this.pageHasUserActivation()) return;
    try {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
      const Ctor = AC.AudioContext ?? AC.webkitAudioContext;
      if (!Ctor) return;
      const probe = new Ctor();
      // 构造后 state 可能还是 suspended、几毫秒后才 running（渲染线程异步起）：等一次 statechange，最多 1.5s
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        probe.onstatechange = null;
        if (probe.state === 'running' && !this.pageHasUserActivation()) this.audioAutoUnlocked = true;
        void probe.close?.().catch(() => {});
      };
      if (probe.state === 'running') settle();
      else {
        probe.onstatechange = () => { if (probe.state === 'running') settle(); };
        setTimeout(settle, 1500);
      }
    } catch { /* 拿不到就当普通页 */ }
  }

  private keepAudioAlive(): void {
    const H = Howler as unknown as {
      ctx?: AudioContext | null; volume: () => number; noAudio?: boolean;
      _mobileUnloaded?: boolean; _unlockAudio?: () => void;
    };
    // Howler 到第一个 Howl 才建 AudioContext：场景里一时没有声音要放，上下文就一直不存在，
    // 空间总线建不出来、解锁也无从谈起（实测：免手势预览窗开着 15 秒还是「未解锁 / 欠着空间」）。
    // Howler.volume()（取值）会在没有 ctx 时顺手 setupAudioContext —— 借它把上下文先建出来。
    if (!H.ctx && !H.noAudio) { try { H.volume(); } catch { /* 没有 WebAudio 就算了 */ } }
    // 🔴 Howler 在**第一个 Howl** 创建时跑 `_unlockAudio`，里面若发现 ctx.sampleRate ≠ 44100（本机 48k）
    //    就 `Howler.unload()`：把 AudioContext **关掉重建**。此前建在旧 ctx 上的一切（空间总线、卷积器）
    //    从此全哑而不报错——2026-09-08 「试听一点声音都没有」的根因（栈：Howl.init → _unlockAudio → unload → ctx.close）。
    //    这里在任何 Howl 出现之前先把这一步逼出来，让 ctx 稳定下来，总线才建在最终那个上下文上。
    //    （ensureSpatialBus 另有一道「ctx 已关 / 被换 ⇒ 重建总线」的兜底，两道都要。）
    // 只逼一次：44.1k 设备上 Howler 不会置 _mobileUnloaded，每次调用都会再挂一组 document 监听（泄漏）
    if (H.ctx && !this.forcedUnlockDone && typeof H._unlockAudio === 'function') {
      this.forcedUnlockDone = true;
      try { H._unlockAudio(); } catch { /* 走不通就交给兜底 */ }
    }
    const ctx = H.ctx;
    if (!ctx || ctx.state === 'closed') return;
    // 总线若挂在已关掉 / 被换掉的上下文上，这里主动重建（不等下一次播放才发现全哑）
    if (this.spatialBus) this.ensureSpatialBus();
    this.ensureOutputMeter(ctx);
    if (ctx.state === 'running') {
      this.audioUnlockedSeen = true;
      // 门还关着、也没有手势在解锁途中，而上下文已经 running：没有手势它就自己开了 = 免手势环境
      if (!this.audioUnblocked && !this.audioUnlocking) {
        if (!this.pageHasUserActivation()) this.audioAutoUnlocked = true;
        this.removeAudioGestureListeners();
        this.flushPendingPlayback(false);
      }
      return;
    }
    if (this.resumeInFlight) return;
    let p: Promise<void> | undefined;
    try { p = ctx.resume(); } catch { return; }
    if (p && typeof p.then === 'function') {
      this.resumeInFlight = true;
      void p.catch(() => {}).finally(() => { this.resumeInFlight = false; });
    }
  }

  /** 页面是否已有过用户手势（sticky）。老 WebView 无 navigator.userActivation 时回退 false（走原手势门）。 */
  private pageHasUserActivation(): boolean {
    try {
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } })
        .userActivation;
      return ua?.hasBeenActive === true;
    } catch {
      return false;
    }
  }

  private removeAudioGestureListeners(): void {
    if (!this.gestureListenersInstalled) return;
    this.gestureListenersInstalled = false;
    window.removeEventListener('pointerdown', this._onFirstGesture, true);
    window.removeEventListener('keydown', this._onFirstGesture, true);
    window.removeEventListener('touchstart', this._onFirstGesture, true);
  }

  /**
   * 播一条系统音。表里的值可带**本处音量**——同一条素材当确认音要清脆、当悬停音要压低，
   * 靠这一条而不是在音频目录里复制一份改 volume。
   */
  private playSystemSfx(key: string): void {
    const ref = this.config.systemSfx[key];
    const id = audioCueId(ref);
    if (!id) return;
    this.playSfx(id, audioCueVolume(ref));
  }

  /**
   * 叠图音的三态：这条明确静音 → 什么都不响；这条配了专属音 → 只响它；
   * 都没配 → 响该事件的全局默认（`systemSfx.overlayShow` / `overlayBlend`，没配条目就自然不响）。
   *
   * 专属音也在这里播、不在动作层播：全表只此一个发声点，才不会做出双响。
   */
  private playOverlaySfx(cue: OverlaySfxCue | undefined, defaultKey: string): void {
    if (cue?.silent) return;
    const own = (cue?.sfx ?? '').trim();
    if (own) {
      this.playSfx(own);
      return;
    }
    this.playSystemSfx(defaultKey);
  }

  private onSfx(event: string, callback: EventCallback): void {
    this.eventBus.on(event, callback);
    this.sfxEventListeners.push({ event, callback });
  }

  private installSystemSfxListeners(): void {
    this.onSfx('quest:accepted', (p?: { restored?: boolean }) => {
      /** 读档时 QuestManager.deserialize 补发的 quest:accepted{restored} 只重建 HUD，不响接取音 */
      if (p?.restored) return;
      this.playSystemSfx('questAccepted');
    });
    this.onSfx('quest:completed', () => this.playSystemSfx('questCompleted'));
    this.onSfx('dialogue:start', () => this.playSystemSfx('dialogueStart'));
    this.onSfx('dialogue:end', (payload?: DialogueEndPayload) => {
      /** 仅最外层对话结束播结束音效（与 EventBridge 状态恢复同判据）：
       *  嵌套脚本台词（nestedInGraph）与图链式接续的中间 end（willContinue）都跳过 */
      if (payload?.willContinue === true || payload?.nestedInGraph === true) return;
      this.playSystemSfx('dialogueEnd');
    });
    this.onSfx('dialogue:advanceInput', () => this.playSystemSfx('dialogueAdvance'));
    this.onSfx('dialogue:choiceSelected:log', () => this.playSystemSfx('dialogueChoice'));

    /**
     * 切换/悬停音**在这里节流**，不在各发射端各限一次。
     *
     * 发射端不止一处（UIFocus 的移焦钩子、UIButton/UIWindow 的 onSound、面板自己的悬停），
     * 同一次悬停常常同帧发两条（一枚按钮既是焦点项、又挂了 onSound）；而鼠标横扫背包网格 /
     * 地图节点会一路移焦，连发十几声。收在消费端一处限速：两种情况一起解决，
     * 且以后再多接一个发射端也不会突然变吵。60ms ≈ 人快按方向键的上限，键盘导航一按一响不受影响。
     */
    this.onSfx('ui:hover', () => {
      const now = Date.now();
      if (now - this.lastUiHoverSfxAt < UI_HOVER_SFX_MIN_GAP_MS) return;
      this.lastUiHoverSfxAt = now;
      this.playSystemSfx('uiHover');
    });
    this.onSfx('ui:confirm', () => this.playSystemSfx('uiConfirm'));
    this.onSfx('ui:cancel', () => this.playSystemSfx('uiCancel'));
    this.onSfx('ui:panelOpen', () => this.playSystemSfx('uiPanelOpen'));
    this.onSfx('ui:panelClose', () => this.playSystemSfx('uiPanelClose'));
    this.onSfx('notification:show', (payload?: { type?: string }) => {
      const type = payload?.type;
      if (type === 'warning') {
        this.playSystemSfx('uiWarning');
        return;
      }
      if (type === 'quest' || type === 'rule' || type === 'archive') return;
      this.playSystemSfx('uiNotification');
    });

    // 叠图（showOverlayImage / blendOverlayImage）：负载来自 overlay_images.json 的逐条配置。
    // 逐条与全局二选一 —— 该条配了专属音就只播专属音，配了「不播」就连全局默认也跳过。
    this.onSfx('overlay:show', (p?: OverlaySfxCue) => this.playOverlaySfx(p, 'overlayShow'));
    this.onSfx('overlay:blend', (p?: OverlaySfxCue) => this.playOverlaySfx(p, 'overlayBlend'));

    this.onSfx('hotspot:interact', () => this.playSystemSfx('hotspotInteract'));
    // 三把火（G.5）：首次出场仪式 / 平时显 / 平时隐。事件由 HUD 在火真出现那一帧发；读档 instant 恢复不发
    this.onSfx('threeFires:debut', () => this.playSystemSfx('threeFiresDebut'));
    this.onSfx('threeFires:show', () => this.playSystemSfx('threeFiresShow'));
    this.onSfx('threeFires:hide', () => this.playSystemSfx('threeFiresHide'));
    // 气味指示器（G.6）：首次出场仪式（深吸一口气）/ 平时显（轻嗅）/ 平时隐（呼气）。同三把火由 HUD 在真出现那一帧发
    this.onSfx('smell:debut', () => this.playSystemSfx('smellDebut'));
    this.onSfx('smell:show', () => this.playSystemSfx('smellShow'));
    this.onSfx('smell:hide', () => this.playSystemSfx('smellHide'));
    this.onSfx('scene:transition', () => {
      if (Date.now() - this.lastMapTravelSfxAt < 500) return;
      this.playSystemSfx('sceneTransition');
    });
    this.onSfx('map:travel', () => {
      this.lastMapTravelSfxAt = Date.now();
      this.playSystemSfx('mapTravel');
    });
    this.onSfx('item:acquired', () => this.playSystemSfx('itemAcquired'));
    this.onSfx('item:consumed', () => this.playSystemSfx('itemConsumed'));
    this.onSfx('inventory:full', () => this.playSystemSfx('inventoryFull'));
    this.onSfx('currency:changed', (payload?: { amount?: number }) => {
      const amount = payload?.amount ?? 0;
      if (amount > 0) this.playSystemSfx('coinGain');
      if (amount < 0) this.playSystemSfx('coinSpend');
    });
    this.onSfx('rule:fragment', () => this.playSystemSfx('ruleFragment'));
    this.onSfx('rule:layer', (payload?: { source?: string }) => {
      if (payload?.source === 'fragment') return;
      this.playSystemSfx('ruleLayer');
    });
    this.onSfx('rule:acquired', () => this.playSystemSfx('ruleAcquired'));
    this.onSfx('ruleUse:apply', () => this.playSystemSfx('ruleUseApply'));
    this.onSfx('zone:ruleAvailable', () => this.playSystemSfx('zoneRuleAvailable'));
    this.onSfx('zone:ruleUnavailable', () => this.playSystemSfx('zoneRuleUnavailable'));
    this.onSfx('archive:updated', () => this.playSystemSfx('archiveUpdated'));
    this.onSfx('encounter:start', () => this.playSystemSfx('encounterStart'));
    this.onSfx('encounter:choiceSelected', () => this.playSystemSfx('encounterChoice'));
    this.onSfx('encounter:result', () => this.playSystemSfx('encounterResult'));
    this.onSfx('cutscene:start', () => this.playSystemSfx('cutsceneStart'));
    this.onSfx('cutscene:end', () => this.playSystemSfx('cutsceneEnd'));
    this.onSfx('day:start', () => this.playSystemSfx('dayStart'));
    this.onSfx('day:end', () => this.playSystemSfx('dayEnd'));
    this.onSfx('shop:opened', () => this.playSystemSfx('shopOpen'));
    this.onSfx('shop:closed', () => this.playSystemSfx('shopClose'));
    this.onSfx('minigame:sugarWheelResult', () => this.playSystemSfx('minigameResult'));
    // 该条揭示在 document_reveals.json 里自带 revealSfx 时不再叠全局默认揭示音（逐条覆盖全局）
    this.onSfx('document:revealed', (payload?: { customSfx?: boolean }) => {
      if (payload?.customSfx) return;
      this.playSystemSfx('documentReveal');
    });
  }

  destroy(): void {
    // 使任何仍在 await loadAudio 的 playBgm/addAmbient 失效：到点 resume 时代次不匹配即放弃 play()，
    // 否则会在 destroy 之后才起一个永不被停止的 Howl。
    ++this.bgmRequestSeq;
    for (const key of this.ambientRequestSeq.keys()) this.bumpAmbientSeq(key);
    for (const { event, callback } of this.sfxEventListeners) {
      this.eventBus.off(event, callback);
    }
    this.sfxEventListeners = [];
    this.removeAudioGestureListeners();
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    this.keepAliveOff?.(); this.keepAliveOff = null;
    this.dropOutputMeter();
    this.audioUnlocking = false;
    this.pendingPlayback = [];
    // 空间音通道：断开卷积器与所有在飞的 BufferSource，不留残留（runtime 规范红线）
    this.spatialBus?.destroy();
    this.spatialBus = null;
    if (this.currentBgm) {
      const bgm = this.currentBgm;
      this.currentBgm = null;
      this.currentBgmId = null;
      bgm.stop();
    }
    this.pendingTimers.forEach(id => clearTimeout(id));
    this.pendingTimers.clear();
    this.ambientLayers.forEach((howl) => { howl.stop(); });
    this.ambientLayers.clear();
    this.ambientBaseVolume.clear();
    this.requestedBgmId = null;
    this.requestedAmbientIds.clear();
    this.currentBgmBaseVolume = 1.0;
    this.sfxCache.forEach((howl) => howl.stop());
    this.sfxCache.clear();
    // 过场一次性音效句柄随 sfxCache 全停一并作废（其 howl 均来自 sfxCache）；复位作用域标志。
    this.cutsceneSfxActive = false;
    this.cutsceneSfxSounds = [];
  }
}
