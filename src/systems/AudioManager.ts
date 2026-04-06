import { Howl, Howler } from 'howler';
import type { EventBus } from '../core/EventBus';
import type { AssetManager } from '../core/AssetManager';
import { resolveAssetPath } from '../core/assetPath';
import type { IGameSystem, GameContext, IAudioSettingsProvider } from '../data/types';

interface AudioEntry {
  src: string;
}

interface AudioConfig {
  bgm: Record<string, AudioEntry>;
  ambient: Record<string, AudioEntry>;
  sfx: Record<string, AudioEntry>;
}

export class AudioManager implements IGameSystem, IAudioSettingsProvider {
  private eventBus: EventBus;
  private config: AudioConfig = { bgm: {}, ambient: {}, sfx: {} };
  private loaded = false;

  private currentBgm: Howl | null = null;
  private currentBgmId: string | null = null;
  private ambientLayers: Map<string, Howl> = new Map();
  private sfxCache: Map<string, Howl> = new Map();

  private bgmVolume = 0.6;
  private sfxVolume = 0.8;
  private ambientVolume = 0.4;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  private assetManager!: AssetManager;

  /** 嵌入式 WebView 等场景下，页面加载后尚无用户手势，此时 play() 会触发 AudioContext 警告；推迟到首次输入再真正播放。 */
  private audioUnblocked = false;
  private pendingPlayback: Array<() => void> = [];
  private gestureListenersInstalled = false;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.installAudioGestureGate();
  }
  update(_dt: number): void {}

  async loadConfig(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<Record<string, Record<string, { src: string }>>>('/assets/data/audio_config.json');
      const resolveSrc = (obj: Record<string, { src: string }>) => {
        const out: Record<string, { src: string }> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = { src: resolveAssetPath((v as { src: string }).src) };
        }
        return out;
      };
      this.config = {
        bgm: resolveSrc(raw.bgm ?? {}),
        ambient: resolveSrc(raw.ambient ?? {}),
        sfx: resolveSrc(raw.sfx ?? {}),
      };
      this.loaded = true;
    } catch {
      console.warn('AudioManager: audio_config.json not found, running silent');
      this.loaded = true;
    }
  }

  playBgm(id: string, fadeMs: number = 1000): void {
    this.runWhenAudioAllowed(() => {
      if (this.currentBgmId === id) return;

      const entry = this.config.bgm[id];
      if (!entry) {
        console.warn(`AudioManager: unknown bgm "${id}"`);
        return;
      }

      if (this.currentBgm) {
        const old = this.currentBgm;
        old.fade(old.volume(), 0, fadeMs);
        this.scheduleCleanup(() => { old.stop(); old.unload(); }, fadeMs);
      }

      const howl = new Howl({
        src: [entry.src],
        loop: true,
        volume: 0,
      });
      howl.play();
      howl.fade(0, this.bgmVolume, fadeMs);

      this.currentBgm = howl;
      this.currentBgmId = id;
    });
  }

  stopBgm(fadeMs: number = 1000): void {
    this.runWhenAudioAllowed(() => {
      if (!this.currentBgm) return;
      const bgm = this.currentBgm;
      bgm.fade(bgm.volume(), 0, fadeMs);
      this.scheduleCleanup(() => { bgm.stop(); bgm.unload(); }, fadeMs);
      this.currentBgm = null;
      this.currentBgmId = null;
    });
  }

  addAmbient(id: string, volume?: number): void {
    this.runWhenAudioAllowed(() => {
      if (this.ambientLayers.has(id)) return;

      const entry = this.config.ambient[id];
      if (!entry) {
        console.warn(`AudioManager: unknown ambient "${id}"`);
        return;
      }

      const vol = (volume ?? 1.0) * this.ambientVolume;
      const howl = new Howl({
        src: [entry.src],
        loop: true,
        volume: vol,
      });
      howl.play();
      this.ambientLayers.set(id, howl);
    });
  }

  removeAmbient(id: string, fadeMs: number = 500): void {
    this.runWhenAudioAllowed(() => {
      const howl = this.ambientLayers.get(id);
      if (!howl) return;
      howl.fade(howl.volume(), 0, fadeMs);
      this.scheduleCleanup(() => { howl.stop(); howl.unload(); }, fadeMs);
      this.ambientLayers.delete(id);
    });
  }

  clearAmbient(fadeMs: number = 500): void {
    this.runWhenAudioAllowed(() => {
      this.ambientLayers.forEach((howl) => {
        howl.fade(howl.volume(), 0, fadeMs);
        this.scheduleCleanup(() => { howl.stop(); howl.unload(); }, fadeMs);
      });
      this.ambientLayers.clear();
    });
  }

  playSfx(id: string): void {
    this.runWhenAudioAllowed(() => {
      const entry = this.config.sfx[id];
      if (!entry) return;

      let howl = this.sfxCache.get(id);
      if (!howl) {
        howl = new Howl({ src: [entry.src], volume: this.sfxVolume });
        this.sfxCache.set(id, howl);
      }
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

  private runWhenAudioAllowed(fn: () => void): void {
    if (this.audioUnblocked) {
      fn();
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
      fn();
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

  destroy(): void {
    this.removeAudioGestureListeners();
    this.pendingPlayback = [];
    if (this.currentBgm) {
      const bgm = this.currentBgm;
      this.currentBgm = null;
      this.currentBgmId = null;
      bgm.stop();
      bgm.unload();
    }
    this.pendingTimers.forEach(id => clearTimeout(id));
    this.pendingTimers.clear();
    this.ambientLayers.forEach((howl) => { howl.stop(); howl.unload(); });
    this.ambientLayers.clear();
    this.sfxCache.forEach((howl) => howl.unload());
    this.sfxCache.clear();
    Howler.unload();
  }
}
