import { Howl, Howler } from 'howler';
import type { EventBus } from '../core/EventBus';
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

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  init(_ctx: GameContext): void {}
  update(_dt: number): void {}

  async loadConfig(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/audio_config.json'));
      const raw = await resp.json();
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
    if (this.currentBgmId === id) return;

    const entry = this.config.bgm[id];
    if (!entry) {
      console.warn(`AudioManager: unknown bgm "${id}"`);
      return;
    }

    if (this.currentBgm) {
      const old = this.currentBgm;
      old.fade(old.volume(), 0, fadeMs);
      setTimeout(() => { old.stop(); old.unload(); }, fadeMs);
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
  }

  stopBgm(fadeMs: number = 1000): void {
    if (!this.currentBgm) return;
    const bgm = this.currentBgm;
    bgm.fade(bgm.volume(), 0, fadeMs);
    setTimeout(() => { bgm.stop(); bgm.unload(); }, fadeMs);
    this.currentBgm = null;
    this.currentBgmId = null;
  }

  addAmbient(id: string, volume?: number): void {
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
  }

  removeAmbient(id: string, fadeMs: number = 500): void {
    const howl = this.ambientLayers.get(id);
    if (!howl) return;
    howl.fade(howl.volume(), 0, fadeMs);
    setTimeout(() => { howl.stop(); howl.unload(); }, fadeMs);
    this.ambientLayers.delete(id);
  }

  clearAmbient(fadeMs: number = 500): void {
    this.ambientLayers.forEach((howl) => {
      howl.fade(howl.volume(), 0, fadeMs);
      setTimeout(() => { howl.stop(); howl.unload(); }, fadeMs);
    });
    this.ambientLayers.clear();
  }

  playSfx(id: string): void {
    const entry = this.config.sfx[id];
    if (!entry) return;

    let howl = this.sfxCache.get(id);
    if (!howl) {
      howl = new Howl({ src: [entry.src], volume: this.sfxVolume });
      this.sfxCache.set(id, howl);
    }
    howl.volume(this.sfxVolume);
    howl.play();
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

  destroy(): void {
    this.stopBgm(0);
    this.ambientLayers.forEach((howl) => { howl.stop(); howl.unload(); });
    this.ambientLayers.clear();
    this.sfxCache.forEach((howl) => howl.unload());
    this.sfxCache.clear();
    Howler.unload();
  }
}
