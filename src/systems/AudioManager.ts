import { Howl, Howler } from 'howler';
import type { EventBus } from '../core/EventBus';
import type { AssetManager, AssetRef } from '../core/AssetManager';
import { resolveAssetPath } from '../core/assetPath';
import { TEXT_URLS } from '../core/projectPaths';
import type { DialogueEndPayload, IGameSystem, GameContext, IAudioSettingsProvider, AudioPlaybackHandle, TransientSfxOptions } from '../data/types';

interface AudioEntry {
  src: string;
  volume?: number;
}

interface AudioConfig {
  bgm: Record<string, AudioEntry>;
  ambient: Record<string, AudioEntry>;
  sfx: Record<string, AudioEntry>;
  systemSfx: Record<string, string>;
}

type EventCallback = (payload?: any) => void;

export class AudioManager implements IGameSystem, IAudioSettingsProvider {
  private eventBus: EventBus;
  private config: AudioConfig = { bgm: {}, ambient: {}, sfx: {}, systemSfx: {} };
  private loaded = false;

  private currentBgm: Howl | null = null;
  private currentBgmId: string | null = null;
  /** 每次 playBgm/stopBgm 自增；await loadAudio 期间若被更新的请求取代，旧请求放弃播放，避免泄漏正在播放的 Howl。 */
  private bgmRequestSeq = 0;
  /** 当前 BGM 的基础音量乘数（配置 entry.volume ?? 1）；setVolume('bgm') 按 base×全局 重算而非直接覆盖 */
  private currentBgmBaseVolume = 1.0;
  private ambientLayers: Map<string, Howl> = new Map();
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
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  private assetManager!: AssetManager;

  /** 嵌入式 WebView 等场景下，页面加载后尚无用户手势，此时 play() 会触发 AudioContext 警告；推迟到首次输入再真正播放。 */
  private audioUnblocked = false;
  private audioUnlocking = false;
  private pendingPlayback: Array<() => void | Promise<void>> = [];
  private gestureListenersInstalled = false;
  private sfxEventListeners: Array<{ event: string; callback: EventCallback }> = [];
  private lastMapTravelSfxAt = 0;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.installAudioGestureGate();
    this.installSystemSfxListeners();
  }
  update(_dt: number): void {}

  async loadConfig(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<{
        bgm?: Record<string, { src: string }>;
        ambient?: Record<string, { src: string }>;
        sfx?: Record<string, { src: string }>;
        systemSfx?: Record<string, string>;
      }>(TEXT_URLS.audioConfig);
      const resolveSrc = (obj: Record<string, { src: string; volume?: number }>) => {
        const out: Record<string, { src: string; volume?: number }> = {};
        for (const [k, v] of Object.entries(obj)) {
          const volume = typeof v.volume === 'number' ? v.volume : undefined;
          out[k] = { src: resolveAssetPath(v.src), volume };
        }
        return out;
      };
      this.config = {
        bgm: resolveSrc(raw.bgm ?? {}),
        ambient: resolveSrc(raw.ambient ?? {}),
        sfx: resolveSrc(raw.sfx ?? {}),
        systemSfx: Object.fromEntries(
          Object.entries(raw.systemSfx ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()),
        ),
      };
      this.loaded = true;
    } catch {
      console.warn('AudioManager: audio_config.json not found, running silent');
      this.loaded = true;
    }
  }

  playBgm(id: string, fadeMs: number = 1000): void {
    const myReq = ++this.bgmRequestSeq;
    this.runWhenAudioAllowed(async () => {
      // 排队期间已被更新的请求取代：放弃。
      if (myReq !== this.bgmRequestSeq) return;
      if (this.currentBgmId === id && this.currentBgm) return;

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
      if (this.currentBgmId === id && this.currentBgm === howl) return;

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
      const baseVol = entry.volume ?? 1.0;
      howl.fade(0, this.clamp01(baseVol * this.bgmVolume), fadeMs);

      this.currentBgm = howl;
      this.currentBgmId = id;
      this.currentBgmBaseVolume = baseVol;
    });
  }

  stopBgm(fadeMs: number = 1000): void {
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
    });
  }

  private bumpAmbientSeq(id: string): number {
    const next = (this.ambientRequestSeq.get(id) ?? 0) + 1;
    this.ambientRequestSeq.set(id, next);
    return next;
  }

  addAmbient(id: string, volume?: number): void {
    // 代次在调用时同步领取：后续任何 remove/clear/更新的 add 都会使本次请求过期
    const myReq = this.bumpAmbientSeq(id);
    this.runWhenAudioAllowed(async () => {
      if (myReq !== this.ambientRequestSeq.get(id)) return;
      if (this.ambientLayers.has(id)) return;

      const entry = this.config.ambient[id];
      if (!entry) {
        console.warn(`AudioManager: unknown ambient "${id}"`);
        return;
      }

      const baseVol = volume ?? entry.volume ?? 1.0;
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

  /** 当前 BGM id（无则 null）——供过场快照音频基线。 */
  getCurrentBgmId(): string | null {
    return this.currentBgmId;
  }

  /** 当前活跃环境层 id 列表——供过场快照音频基线。 */
  getActiveAmbientIds(): string[] {
    return Array.from(this.ambientLayers.keys());
  }

  /**
   * 还原到过场前音频基线：BGM 切回 bgmId（null=停），并补回 ambientIds。
   * playBgm/addAmbient 自带幂等守卫（同 id 已在播即返回），故基线未被过场改动时全为 no-op。
   */
  restoreAudioBaseline(bgmId: string | null, ambientIds: string[]): void {
    if (bgmId) this.playBgm(bgmId);
    else this.stopBgm();
    for (const id of ambientIds) this.addAmbient(id);
  }

  /**
   * 播放一条与调用方生命周期绑定的短音频。复用 AssetManager 缓存的共享 Howl（同 addAmbient），
   * 只操作本次 play() 返回的 soundId：stop() 走 `howl.stop(soundId)` 只停本实例，**绝不 unload
   * 共享 Howl**（会毁缓存、令后续重播重新解码）。适合字幕配音这类“离开本步即释放”的声音。
   * 加载失败 / 加载归来发现已 stop 均安全退化为不发声（onEnd 不触发，调用方退化为等待点击）。
   */
  playTransientSfx(id: string, options: TransientSfxOptions = {}): AudioPlaybackHandle | null {
    const entry = this.config.sfx[id];
    if (!entry) {
      console.warn(`AudioManager: unknown transient sfx "${id}"`);
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
        console.warn(`AudioManager: transient sfx "${id}" failed to load`, error);
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
      shared.volume(this.clamp01(baseVolume * this.sfxVolume), sid);
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

  setVolume(channel: 'bgm' | 'sfx' | 'ambient', vol: number): void {
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
    }
  }

  getVolume(channel: 'bgm' | 'sfx' | 'ambient'): number {
    switch (channel) {
      case 'bgm': return this.bgmVolume;
      case 'sfx': return this.sfxVolume;
      case 'ambient': return this.ambientVolume;
    }
  }

  applySceneAudio(bgmId?: string, ambientIds?: string[]): void {
    if (bgmId) {
      this.playBgm(bgmId);
    } else {
      this.stopBgm();
    }

    this.clearAmbient();
    if (ambientIds) {
      for (const id of ambientIds) {
        this.addAmbient(id);
      }
    }
  }

  serialize(): object {
    return {
      bgmVolume: this.bgmVolume,
      sfxVolume: this.sfxVolume,
      ambientVolume: this.ambientVolume,
    };
  }

  deserialize(data: { bgmVolume?: number; sfxVolume?: number; ambientVolume?: number }): void {
    if (data.bgmVolume !== undefined) this.bgmVolume = data.bgmVolume;
    if (data.sfxVolume !== undefined) this.sfxVolume = data.sfxVolume;
    if (data.ambientVolume !== undefined) this.ambientVolume = data.ambientVolume;
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

  getSceneAudioRefs(bgmId?: string, ambientIds?: string[]): AssetRef[] {
    const refs: AssetRef[] = [];
    if (bgmId && this.config.bgm[bgmId]) {
      refs.push({ type: 'audio', path: this.config.bgm[bgmId].src, options: { loop: true }, label: `BGM: ${bgmId}` });
    }
    for (const id of ambientIds ?? []) {
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
    const cueId = (
      this.config.systemSfx.audioUnlock
      || this.config.systemSfx.uiHover
      || this.config.systemSfx.uiConfirm
      || ''
    ).trim();
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
    const baseVolume = typeof entry.volume === 'number' ? entry.volume : 1.0;
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

  private flushPendingPlayback(): void {
    this.audioUnblocked = true;
    this.audioUnlocking = false;
    this.playAudioUnlockCue();
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

  private playSystemSfx(key: string): void {
    const id = this.config.systemSfx[key];
    if (!id) return;
    this.playSfx(id);
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

    this.onSfx('ui:hover', () => this.playSystemSfx('uiHover'));
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

    this.onSfx('hotspot:interact', () => this.playSystemSfx('hotspotInteract'));
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
    this.onSfx('document:revealed', () => this.playSystemSfx('documentReveal'));
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
    this.audioUnlocking = false;
    this.pendingPlayback = [];
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
    this.currentBgmBaseVolume = 1.0;
    this.sfxCache.forEach((howl) => howl.stop());
    this.sfxCache.clear();
    // 过场一次性音效句柄随 sfxCache 全停一并作废（其 howl 均来自 sfxCache）；复位作用域标志。
    this.cutsceneSfxActive = false;
    this.cutsceneSfxSounds = [];
  }
}
