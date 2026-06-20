import type { SaveSlotMeta, ISaveDataProvider } from '../data/types';
import type { StringsProvider } from './StringsProvider';

const STORAGE_PREFIX = 'gamedraft_save_';
const MAX_SLOTS = 3;
/** 存档结构版本。结构破坏性变更时递增，并在 load() 处补迁移。 */
const SAVE_VERSION = 1;

type SerializeCollector = () => Record<string, object>;
type DeserializeDistributor = (data: Record<string, object>) => void;
type SceneReloader = (sceneId: string) => Promise<void>;

export class SaveManager implements ISaveDataProvider {
  private collector: SerializeCollector;
  private distributor: DeserializeDistributor;
  private sceneReloader: SceneReloader;
  private fallbackScene: string;
  private strings: StringsProvider;
  /** 由 Game 注入：仅在“可存档”状态（探索 / UI 覆盖层）返回 true；对话/遭遇/演出/小游戏进行中应拒绝存档。 */
  private canSave: (() => boolean) | null = null;

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

  /** 设置“可存档”判定。未设置时默认允许（向后兼容）。 */
  setCanSavePredicate(fn: () => boolean): void {
    this.canSave = fn;
  }

  save(slot: number): void {
    if (slot < 0 || slot >= MAX_SLOTS) return;
    // 对话/遭遇/演出/小游戏进行中存档会丢失这些瞬时进行态（其 serialize 本就不持久化在途状态）。
    // 玩家路径（暂停菜单）只在探索态可达，安全；此处统一拦截调试/脚本路径的非安全态存档。
    if (this.canSave && !this.canSave()) {
      console.warn('SaveManager: 当前不是可存档状态（对话/遭遇/演出/小游戏进行中），已忽略存档请求');
      return;
    }

    const systems = this.collector();
    const payload = {
      version: SAVE_VERSION,
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
      if (typeof payload.version === 'number' && payload.version > SAVE_VERSION) {
        // 来自更新版本的存档：结构可能不兼容，尽力加载但提示，避免“无报错=已正确”的误判。
        console.warn(
          `SaveManager: 存档版本 ${payload.version} 高于当前支持的 ${SAVE_VERSION}，将尽力加载，部分数据可能缺失`,
        );
      }
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
