import { Howler } from 'howler';
import type { Howl } from 'howler';
import type { EventBus } from '../core/EventBus';
import type { AssetManager, AssetRef } from '../core/AssetManager';
import { resolveAssetPath } from '../core/assetPath';
import { TEXT_URLS } from '../core/projectPaths';
import type { IGameSystem, GameContext, IAudioSettingsProvider } from '../data/types';

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
  private ambientLayers: Map<string, Howl> = new Map();
  private sfxCache: Map<string, Howl> = new Map();

  private bgmVolume = 0.6;
  private sfxVolume = 0.8;
  private ambientVolume = 0.4;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  private assetManager!: AssetManager;

  /** 嵌入式 WebView 等场景下，页面加载后尚无用户手势，此时 play() 会触发 AudioContext 警告；推迟到首次输入再真正播放。 */
  private audioUnblocked = false;
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
      howl.fade(0, this.bgmVolume, fadeMs);

      this.currentBgm = howl;
      this.currentBgmId = id;
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

  addAmbient(id: string, volume?: number): void {
    this.runWhenAudioAllowed(async () => {
      if (this.ambientLayers.has(id)) return;

      const entry = this.config.ambient[id];
      if (!entry) {
        console.warn(`AudioManager: unknown ambient "${id}"`);
        return;
      }

      const vol = (volume ?? entry.volume ?? 1.0) * this.ambientVolume;
      const howl = this.assetManager.getAudio(entry.src, { loop: true })
        ?? await this.assetManager.loadAudio(entry.src, { loop: true });
      howl.loop(true);
      howl.volume(vol);
      howl.play();
      this.ambientLayers.set(id, howl);
    });
  }

  removeAmbient(id: string, fadeMs: number = 500): void {
    this.runWhenAudioAllowed(() => {
      const howl = this.ambientLayers.get(id);
      if (!howl) return;
      howl.fade(howl.volume(), 0, fadeMs);
      this.scheduleCleanup(() => { howl.stop(); }, fadeMs);
      this.ambientLayers.delete(id);
    });
  }

  clearAmbient(fadeMs: number = 500): void {
    this.runWhenAudioAllowed(() => {
      this.ambientLayers.forEach((howl) => {
        howl.fade(howl.volume(), 0, fadeMs);
        this.scheduleCleanup(() => { howl.stop(); }, fadeMs);
      });
      this.ambientLayers.clear();
    });
  }

  playSfx(id: string): void {
    this.runWhenAudioAllowed(async () => {
      const entry = this.config.sfx[id];
      if (!entry) return;

      const howl = this.sfxCache.get(id)
        ?? this.assetManager.getAudio(entry.src, { loop: false })
        ?? await this.assetManager.loadAudio(entry.src, { loop: false });
      if (!this.sfxCache.has(id)) this.sfxCache.set(id, howl);
      howl.volume(this.sfxVolume);
      howl.play();
    });
  }

  setVolume(channel: 'bgm' | 'sfx' | 'ambient', vol: number): void {
    const v = Math.max(0, Math.min(1, vol));
    switch (channel) {
      case 'bgm':
        this.bgmVolume = v;
        if (this.currentBgm) this.currentBgm.volume(v);
        break;
      case 'sfx':
        this.sfxVolume = v;
        break;
      case 'ambient':
        this.ambientVolume = v;
        this.ambientLayers.forEach((howl) => howl.volume(v));
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

  private readonly _onFirstGesture = (_e: Event): void => {
    if (this.audioUnblocked) return;
    this.audioUnblocked = true;
    void Howler.ctx?.resume().catch(() => {});
    this.removeAudioGestureListeners();
    const queued = this.pendingPlayback.splice(0);
    for (const fn of queued) {
      void fn();
    }
  };

  private installAudioGestureGate(): void {
    if (typeof window === 'undefined' || this.gestureListenersInstalled) return;
    this.gestureListenersInstalled = true;
    const capPassive: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', this._onFirstGesture, capPassive);
    window.addEventListener('keydown', this._onFirstGesture, { capture: true });
    window.addEventListener('touchstart', this._onFirstGesture, capPassive);
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
    this.onSfx('quest:accepted', () => this.playSystemSfx('questAccepted'));
    this.onSfx('quest:completed', () => this.playSystemSfx('questCompleted'));
    this.onSfx('dialogue:start', () => this.playSystemSfx('dialogueStart'));
    this.onSfx('dialogue:end', () => this.playSystemSfx('dialogueEnd'));
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
    // 使任何仍在 await loadAudio 的 playBgm 失效：到点 resume 时 myReq!==bgmRequestSeq 即放弃 play()，
    // 否则会在 destroy 之后才起一个永不被停止的 Howl。
    ++this.bgmRequestSeq;
    for (const { event, callback } of this.sfxEventListeners) {
      this.eventBus.off(event, callback);
    }
    this.sfxEventListeners = [];
    this.removeAudioGestureListeners();
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
    this.sfxCache.forEach((howl) => howl.stop());
    this.sfxCache.clear();
  }
}
