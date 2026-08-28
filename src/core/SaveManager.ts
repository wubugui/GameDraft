import type { SaveSlotMeta, ISaveDataProvider } from '../data/types';
import type { StringsProvider } from './StringsProvider';
import { resolvePersistentStore, type PersistentStore } from './storage/persistentStore';

/** 旧存档在 localStorage 里的键前缀。只用于一次性迁移，不再是写入目标。 */
const LEGACY_STORAGE_PREFIX = 'gamedraft_save_';
/**
 * 迁移完成标记，写在 **localStorage 一侧**（也就是数据的来源侧）。
 *
 * 直觉上该写在文件侧，但那样是错的：文件侧的标记躺在 `local/gamedata/`，而
 * `local/` 是 gitignore 的每机状态——换个 worktree、清一次 `local/`，标记就没了，
 * 于是三个远古浏览器档**每次都会**被重新灌回来（原件按设计永不删除）。
 * 标记必须跟着**来源**走：这个浏览器 profile 的旧档已经交接过一次，就不再交接。
 *
 * 这是运行时唯一一处 localStorage **写入**，纯记账、只写一次、与游戏状态无关。
 * 等旧档迁移这件事过了保留期，整套连同 `LEGACY_STORAGE_PREFIX` 一起删掉。
 */
const LEGACY_MIGRATED_FLAG = 'gamedraft_saves_migrated_to_files';
/** 文件存储的命名空间（对应 `local/gamedata/saves/` 或 exe 旁 `gamedata/saves/`）。 */
const SAVE_NAMESPACE = 'saves';
const MAX_SLOTS = 3;
/** 存档结构版本。结构破坏性变更时递增，并在 load() 处补迁移。 */
const SAVE_VERSION = 1;

type SerializeCollector = () => Record<string, object>;
type DeserializeDistributor = (data: Record<string, object>) => void;
type SceneReloader = (sceneId: string) => Promise<void>;

function slotKey(slot: number): string {
  return `slot${slot}`;
}

/**
 * 存档读写。
 *
 * ## 落在哪
 *
 * 文件，不是浏览器存储——见 `storage/persistentStore.ts` 的长注释。开发期经 dev server
 * 写仓库 `local/gamedata/saves/slotN.json`，打包后经 Tauri 写 exe 旁 `gamedata/saves/`。
 * 两边同一套 v1 信封格式，档案可以直接互拷。
 *
 * ## 为什么是「内存镜像 + 异步落盘」
 *
 * 文件 I/O 天然是异步的，而 `getSlotMeta` / `hasSave` 被**菜单的同步构建路径**调用
 * （`MenuUI.build()`：切页、存完档、导入完各重建一次槽位卡片；不是逐帧，但它是同步的，
 * 没法在中间 await）。所以启动时 `hydrate()` 一次性把三个槽读进内存镜像，
 * 查询全部走镜像保持同步；只有真正改动的 `save` / `deleteSlot` / `importSlotPayload`
 * 是异步的，它们要等真的写成了才敢回报成功。
 *
 * 未 `hydrate()` 就查询 = 一律当作无档，而不是抛错：主菜单在极早期就要画。
 */
export class SaveManager implements ISaveDataProvider {
  private collector: SerializeCollector;
  private distributor: DeserializeDistributor;
  private sceneReloader: SceneReloader;
  private fallbackScene: string;
  private strings: StringsProvider;
  /** 由 Game 注入：仅在“可存档”状态（探索 / UI 覆盖层）返回 true；对话/遭遇/演出/小游戏进行中应拒绝存档。 */
  private canSave: (() => boolean) | null = null;

  /** 槽位 → 原始 JSON 信封。文件的内存镜像，查询一律读它。 */
  private mirror = new Map<number, string>();
  private store: PersistentStore | null = null;
  /**
   * 记住的是**在飞的 hydrate**，不是一个布尔。
   *
   * 布尔版是「先置 true 再 await」，第二个并发调用方会拿到一个立刻返回的 Promise，
   * 而镜像还是空的——菜单据此认为"没有存档"。当前只有 `Game.start()` 一个串行调用点，
   * 所以那是个装好但还没踩的陷阱；换成 Promise 就不用指望调用方永远只有一个。
   */
  private hydrating: Promise<void> | null = null;
  /**
   * 每个槽位一条写入链。
   *
   * 快速连存同一槽（脚本 / 命令通道 / 手快）时两个写请求会并发出去，到达顺序不保证：
   * 磁盘可能留下先发的那份，而镜像被后 resolve 的那份覆盖——表现是"重启后存档回退了一步"，
   * 极难复现。串起来就没这回事。
   */
  private writeChain = new Map<string, Promise<unknown>>();

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

  /**
   * 启动时调一次：挑后端、读三个槽进镜像、把 localStorage 里的旧档搬上来。
   *
   * 任何一步失败都不抛——存档读不出来不该让游戏起不来，降级成"无档"，
   * 后续 `save()` 仍会如实报告写盘成败。
   */
  hydrate(): Promise<void> {
    if (!this.hydrating) this.hydrating = this.doHydrate();
    return this.hydrating;
  }

  private async doHydrate(): Promise<void> {
    try {
      this.store = await resolvePersistentStore();
    } catch (e) {
      console.error('SaveManager: 无法取得持久化后端', e);
      return;
    }
    try {
      const all = await this.store.readAll(SAVE_NAMESPACE);
      for (let i = 0; i < MAX_SLOTS; i++) {
        const raw = all[slotKey(i)];
        if (typeof raw === 'string' && raw.trim()) this.mirror.set(i, raw);
      }
      await this.migrateLegacySaves();
    } catch (e) {
      console.error('SaveManager: 读取存档失败，本次按无档处理', e);
    }
  }

  /** 把一次写入排到该键的链尾，保证同槽写入按调用顺序落盘。 */
  private enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChain.get(key) ?? Promise.resolve();
    // 前一次失败不该卡住后一次：catch 掉再接
    const next = prev.catch(() => {}).then(task);
    this.writeChain.set(key, next.catch(() => {}));
    return next;
  }

  /**
   * 把 localStorage 里的旧档搬进文件存储，一次性。
   *
   * 只在**文件侧该槽为空**时搬——文件侧已有档说明玩家在新体系下存过，不能被旧档盖掉。
   * 搬完写一个标记，之后不再重扫。**不删 localStorage 里的原件**：搬运是复制，
   * 万一新体系出问题，旧档还在原地。
   */
  private async migrateLegacySaves(): Promise<void> {
    if (!this.store) return;
    try {
      if (localStorage.getItem(LEGACY_MIGRATED_FLAG)) return;
    } catch {
      return; // 沙箱禁 localStorage：没有可搬的
    }
    let moved = 0;
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (this.mirror.has(i)) continue;
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(LEGACY_STORAGE_PREFIX + i);
      } catch {
        return;
      }
      if (!raw || !raw.trim()) continue;
      try {
        JSON.parse(raw);
      } catch {
        console.warn(`SaveManager: 旧档槽 ${i} 不是合法 JSON，跳过迁移`);
        continue;
      }
      try {
        await this.store.write(SAVE_NAMESPACE, slotKey(i), raw);
        this.mirror.set(i, raw);
        moved++;
      } catch (e) {
        console.error(`SaveManager: 旧档槽 ${i} 迁移失败`, e);
        return; // 不打标记，下次启动再试
      }
    }
    try {
      localStorage.setItem(LEGACY_MIGRATED_FLAG, new Date().toISOString());
    } catch { /* 标记写不上只是会多扫一次，不是错误 */ }
    if (moved > 0) {
      console.info(`SaveManager: 已把 ${moved} 个浏览器旧档迁移到文件存储（原件保留在 localStorage）`);
    }
  }

  /** 当前后端是否真的会把存档留下来。false = 内存降级，UI 应当告诉玩家。 */
  isPersistent(): boolean {
    return this.store?.persisted ?? false;
  }

  /** 当前后端种类（'tauri' / 'http' / 'memory'），供调试面板显示。 */
  storeKind(): string {
    return this.store?.kind ?? 'none';
  }

  setFallbackScene(scene: string): void {
    this.fallbackScene = scene;
  }

  /** 设置“可存档”判定。未设置时默认允许（向后兼容）。 */
  setCanSavePredicate(fn: () => boolean): void {
    this.canSave = fn;
  }

  /** 当前是否可存档。调试器用它把"现在存不了档"说成人话，而不是静默失败。 */
  canSaveNow(): boolean {
    return this.canSave ? this.canSave() : true;
  }

  /** 返回是否真正写盘成功（写失败 / 无后端 / 非可存档态均为 false），供 UI 区分提示 */
  async save(slot: number): Promise<boolean> {
    if (slot < 0 || slot >= MAX_SLOTS) return false;
    // 对话/遭遇/演出/小游戏进行中存档会丢失这些瞬时进行态（其 serialize 本就不持久化在途状态）。
    // 玩家路径（暂停菜单）只在探索态可达，安全；此处统一拦截调试/脚本路径的非安全态存档。
    if (this.canSave && !this.canSave()) {
      console.warn('SaveManager: 当前不是可存档状态（对话/遭遇/演出/小游戏进行中），已忽略存档请求');
      return false;
    }
    if (!this.store) {
      console.error('SaveManager: 没有持久化后端，存档请求被拒绝');
      return false;
    }

    const systems = this.collector();
    const payload = {
      version: SAVE_VERSION,
      timestamp: Date.now(),
      systems,
    };

    let raw: string;
    try {
      raw = JSON.stringify(payload);
    } catch (e) {
      console.error('SaveManager: 存档序列化失败', e);
      return false;
    }
    const store = this.store;
    const key = slotKey(slot);
    try {
      // 同槽写入排队：并发两次存档时磁盘与镜像不能各留各的
      await this.enqueueWrite(key, async () => {
        await store.write(SAVE_NAMESPACE, key, raw);
        // 写盘成功才更新镜像，且在同一条链里更新——否则后 resolve 的那次会把镜像
        // 写成和磁盘不一致的内容。菜单绝不该显示一个磁盘上并不存在的档。
        this.mirror.set(slot, raw);
      });
    } catch (e) {
      console.error('SaveManager: failed to save', e);
      return false;
    }
    return true;
  }

  /**
   * 调试用：不经存储直接拍一份全量存档 payload。
   * 与 save() 同一条 collector 路径与同一道 canSave 闸门，只是不落槽——
   * 调试器的"拍子档案库"用它，不占玩家的三个槽。
   */
  capturePayload(): string | null {
    if (this.canSave && !this.canSave()) return null;
    try {
      return JSON.stringify({
        version: SAVE_VERSION,
        timestamp: Date.now(),
        systems: this.collector(),
      });
    } catch (e) {
      console.error('SaveManager: failed to capture payload', e);
      return null;
    }
  }

  /** 调试用：从 payload 字符串读档，与 load(slot) 同一条校验/回滚路径。 */
  async loadPayload(raw: string): Promise<boolean> {
    return this.loadFromRaw(raw);
  }

  async load(slot: number): Promise<boolean> {
    if (slot < 0 || slot >= MAX_SLOTS) return false;
    const raw = this.mirror.get(slot);
    if (!raw) return false;
    return this.loadFromRaw(raw);
  }

  private async loadFromRaw(raw: string): Promise<boolean> {
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
    const raw = this.mirror.get(slot);
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
    return this.mirror.has(slot);
  }

  /**
   * 删一个槽。返回是否真的从磁盘上删掉了。
   *
   * **删失败不动镜像**：镜像已删而磁盘还在的话，重启后那个档会"复活"，
   * 玩家会以为删除功能坏了（或者更糟——以为自己删错了）。与 `save()` 同一条诚实度要求。
   */
  async deleteSlot(slot: number): Promise<boolean> {
    if (slot < 0 || slot >= MAX_SLOTS) return false;
    if (!this.store) return false;
    const store = this.store;
    const key = slotKey(slot);
    try {
      await this.enqueueWrite(key, async () => {
        await store.remove(SAVE_NAMESPACE, key);
        this.mirror.delete(slot);
      });
      return true;
    } catch (e) {
      console.error('SaveManager: failed to delete save', e);
      return false;
    }
  }

  hasAnySave(): boolean {
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (this.hasSave(i)) return true;
    }
    return false;
  }

  exportSlotPayload(slot: number): string | null {
    if (slot < 0 || slot >= MAX_SLOTS) return null;
    const raw = this.mirror.get(slot);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { systems?: unknown };
      return parsed && typeof parsed === 'object' && parsed.systems && typeof parsed.systems === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  async importSlotPayload(slot: number, raw: string): Promise<boolean> {
    if (slot < 0 || slot >= MAX_SLOTS || typeof raw !== 'string' || !raw.trim()) return false;
    if (!this.store) return false;
    let normalized: string;
    try {
      const parsed = JSON.parse(raw) as { systems?: unknown };
      if (!parsed || typeof parsed !== 'object' || !parsed.systems || typeof parsed.systems !== 'object') return false;
      normalized = JSON.stringify(parsed);
    } catch {
      return false;
    }
    const store = this.store;
    const key = slotKey(slot);
    try {
      await this.enqueueWrite(key, async () => {
        await store.write(SAVE_NAMESPACE, key, normalized);
        this.mirror.set(slot, normalized);
      });
    } catch (e) {
      console.error('SaveManager: 导入存档写盘失败', e);
      return false;
    }
    return true;
  }
}
