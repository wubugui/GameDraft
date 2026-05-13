import type { SaveSlotMeta, ISaveDataProvider } from '../data/types';
import type { StringsProvider } from './StringsProvider';

const STORAGE_PREFIX = 'gamedraft_save_';
const MAX_SLOTS = 3;

type SerializeCollector = () => Record<string, object>;
type DeserializeDistributor = (data: Record<string, object>) => void;
type SceneReloader = (sceneId: string) => Promise<void>;

export class SaveManager implements ISaveDataProvider {
  private collector: SerializeCollector;
  private distributor: DeserializeDistributor;
  private sceneReloader: SceneReloader;
  private fallbackScene: string;
  private strings: StringsProvider;

  constructor(
    collector: SerializeCollector,
    distributor: DeserializeDistributor,
    sceneReloader: SceneReloader,
    strings: StringsProvider,
    fallbackScene: string,
  ) {
    this.collector = collector;
    this.distributor = distributor;
    this.sceneReloader = sceneReloader;
    this.strings = strings;
    this.fallbackScene = fallbackScene;
  }

  setFallbackScene(scene: string): void {
    this.fallbackScene = scene;
  }

  save(slot: number): void {
    if (slot < 0 || slot >= MAX_SLOTS) return;

    const systems = this.collector();
    const payload = {
      version: 1,
      timestamp: Date.now(),
      systems,
    };

    try {
      localStorage.setItem(STORAGE_PREFIX + slot, JSON.stringify(payload));
    } catch (e) {
      console.error('SaveManager: failed to save', e);
    }
  }

  async load(slot: number): Promise<boolean> {
    if (slot < 0 || slot >= MAX_SLOTS) return false;

    const raw = localStorage.getItem(STORAGE_PREFIX + slot);
    if (!raw) return false;

    try {
      const payload = JSON.parse(raw) as { version: number; timestamp: number; systems: Record<string, object> };
      this.distributor(payload.systems);

      const sceneMgr = payload.systems['sceneManager'] as { currentSceneId?: string } | undefined;
      const sceneId = sceneMgr?.currentSceneId ?? this.fallbackScene;
      await this.sceneReloader(sceneId);

      return true;
    } catch (e) {
      console.error('SaveManager: failed to load', e);
      return false;
    }
  }

  getSlotMeta(slot: number): SaveSlotMeta | null {
    if (slot < 0 || slot >= MAX_SLOTS) return null;

    const raw = localStorage.getItem(STORAGE_PREFIX + slot);
    if (!raw) return null;

    try {
      const payload = JSON.parse(raw);
      const systems = payload.systems as Record<string, object>;
      const scene = systems['sceneManager'] as { currentSceneId?: string } | undefined;
      const day = systems['dayManager'] as { currentDay?: number } | undefined;
      const game = systems['game'] as { playTimeMs?: number; sceneName?: string } | undefined;

      return {
        slot,
        timestamp: payload.timestamp ?? 0,
        sceneId: scene?.currentSceneId ?? 'unknown',
        sceneName: game?.sceneName ?? scene?.currentSceneId ?? this.strings.get('menu', 'unknownScene'),
        dayNumber: day?.currentDay ?? 1,
        playTimeMs: game?.playTimeMs ?? 0,
      };
    } catch {
      return null;
    }
  }

  hasSave(slot: number): boolean {
    return localStorage.getItem(STORAGE_PREFIX + slot) !== null;
  }

  deleteSlot(slot: number): void {
    localStorage.removeItem(STORAGE_PREFIX + slot);
  }

  hasAnySave(): boolean {
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (this.hasSave(i)) return true;
    }
    return false;
  }
}
