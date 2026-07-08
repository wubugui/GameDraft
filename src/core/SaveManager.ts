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

  /** 返回是否真正写盘成功（配额满 / 沙箱禁 localStorage / 非可存档态均为 false），供 UI 区分提示 */
  save(slot: number): boolean {
    if (slot < 0 || slot >= MAX_SLOTS) return false;
    // 对话/遭遇/演出/小游戏进行中存档会丢失这些瞬时进行态（其 serialize 本就不持久化在途状态）。
    // 玩家路径（暂停菜单）只在探索态可达，安全；此处统一拦截调试/脚本路径的非安全态存档。
    if (this.canSave && !this.canSave()) {
      console.warn('SaveManager: 当前不是可存档状态（对话/遭遇/演出/小游戏进行中），已忽略存档请求');
      return false;
    }

    const systems = this.collector();
    const payload = {
      version: SAVE_VERSION,
      timestamp: Date.now(),
      systems,
    };

    try {
      localStorage.setItem(STORAGE_PREFIX + slot, JSON.stringify(payload));
      return true;
    } catch (e) {
      console.error('SaveManager: failed to save', e);
      return false;
    }
  }

  async load(slot: number): Promise<boolean> {
    if (slot < 0 || slot >= MAX_SLOTS) return false;

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_PREFIX + slot);
    } catch (e) {
      console.error('SaveManager: failed to read save', e);
      return false;
    }
    if (!raw) return false;

    // 先解析并校验结构：坏档在覆盖任何系统状态之前拒绝，不进回滚路径
    type SavePayload = { version: number; timestamp: number; systems: Record<string, object> };
    let payload: SavePayload;
    try {
      payload = JSON.parse(raw) as SavePayload;
    } catch (e) {
      console.error('SaveManager: 存档损坏（JSON 解析失败），已拒绝读取', e);
      return false;
    }
    if (!payload || typeof payload !== 'object' || typeof payload.systems !== 'object' || payload.systems === null) {
      console.error('SaveManager: 存档结构无效（缺 systems），已拒绝读取');
      return false;
    }
    if (typeof payload.version === 'number' && payload.version > SAVE_VERSION) {
      // 来自更新版本的存档：结构可能不兼容，尽力加载但提示，避免“无报错=已正确”的误判。
      console.warn(
        `SaveManager: 存档版本 ${payload.version} 高于当前支持的 ${SAVE_VERSION}，将尽力加载，部分数据可能缺失`,
      );
    }

    // 读档原子性（R18）：先经 collector 对当前全系统状态拍快照；distribute / 场景重载
    // 任一失败都回滚快照并重载原场景，避免“系统状态已覆盖、场景还是旧局”的半读档脏混合态。
    const snapshot = this.collector();
    const snapshotSceneId =
      (snapshot['sceneManager'] as { currentSceneId?: string } | undefined)?.currentSceneId ?? this.fallbackScene;

    try {
      this.distributor(payload.systems);

      const sceneMgr = payload.systems['sceneManager'] as { currentSceneId?: string } | undefined;
      const sceneId = sceneMgr?.currentSceneId ?? this.fallbackScene;
      await this.sceneReloader(sceneId);

      return true;
    } catch (e) {
      console.error('SaveManager: failed to load', e);
      try {
        this.distributor(snapshot);
        await this.sceneReloader(snapshotSceneId);
      } catch (rollbackError) {
        console.error('SaveManager: 读档失败后的回滚也失败，运行时状态可能不一致', rollbackError);
      }
      return false;
    }
  }

  getSlotMeta(slot: number): SaveSlotMeta | null {
    if (slot < 0 || slot >= MAX_SLOTS) return null;

    // localStorage 访问也在 try 内：沙箱/隐私模式抛 SecurityError 时按“无档”处理，不炸主菜单
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + slot);
      if (!raw) return null;
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
    try {
      return localStorage.getItem(STORAGE_PREFIX + slot) !== null;
    } catch {
      return false;
    }
  }

  deleteSlot(slot: number): void {
    try {
      localStorage.removeItem(STORAGE_PREFIX + slot);
    } catch (e) {
      console.warn('SaveManager: failed to delete save', e);
    }
  }

  hasAnySave(): boolean {
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (this.hasSave(i)) return true;
    }
    return false;
  }
}
