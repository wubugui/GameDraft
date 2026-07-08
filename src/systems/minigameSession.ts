/**
 * 小游戏会话公共骨架（扎纸 / 糖画转盘 / 挑水共用）。
 *
 * 三个 Manager 此前逐行复制同一套「index 加载 + 实例缓存 + 资源 scope 钉住 +
 * GameState 压栈 + Esc 订阅 + teardown/resolve」骨架（审查 D2），且各自复制了
 * 同一处二次启动竞态（B12：`runUntilDone` 先覆盖 `sessionResolve`、`start` 的
 * active 守卫直接 return → 外层动作链永久悬挂）。此处收敛为单一实现：
 * - `runUntilDone` 已在会话中时立即 resolve 失败结果并告警，不触碰在跑会话；
 * - 正常路径保证 resolve 恰好一次（teardown 幂等、destroy 兜底）；
 * - destroy 在会话中时同样恢复 GameState 并触发 onSessionEnd。
 */

import type { Container } from 'pixi.js';
import type { AssetManager, AssetRef } from '../core/AssetManager';
import type { InputManager } from '../core/InputManager';
import type { GameStateController } from '../core/GameStateController';
import type { Renderer } from '../rendering/Renderer';
import type { ActionDef, GameContext, IGameSystem } from '../data/types';
import { GameState } from '../data/types';
import { dataSubdirJsonUrl } from '../core/projectPaths';

export interface MinigameIndexEntry {
  id: string;
  label: string;
  file: string;
}

/** 会话场景需满足的最小契约；`isActionsPlaybackLocked` 供 Esc 等会话快捷键在动作播放期间让路。 */
export interface MinigameSessionScene {
  readonly root: Container;
  abort(): void;
  destroy(): void;
  isActionsPlaybackLocked?(): boolean;
}

/**
 * 局内 Action 批播放通道（B13 泛化自糖画转盘的 `runSugarWheelActionBatch`）：
 * - 播放期间 `locked` 为真：场景应屏蔽玩家输入，Manager 侧 Esc/调试键同样让路；
 * - 批结束后调用 `restoreMinigameState`——动作里若配了对话，`dialogue:end` 会把
 *   GameState 打回 Exploring，此钩子把仍在会话中的状态拉回 Minigame。
 */
export class MinigameActionPlaybackGate {
  private depth = 0;

  constructor(
    private readonly executeBatch: (actions: ActionDef[]) => Promise<void>,
    private readonly hooks?: {
      onLockChanged?: (locked: boolean) => void;
      restoreMinigameState?: () => void;
    },
  ) {}

  get locked(): boolean {
    return this.depth > 0;
  }

  async run(actions: ActionDef[] | undefined): Promise<void> {
    if (!actions || actions.length === 0) return;
    this.depth++;
    if (this.depth === 1) this.hooks?.onLockChanged?.(true);
    try {
      await this.executeBatch(actions);
    } finally {
      this.depth--;
      if (this.depth === 0) this.hooks?.onLockChanged?.(false);
      this.hooks?.restoreMinigameState?.();
    }
  }
}

export abstract class MinigameSessionManagerBase<
  TInstance extends { id: string },
  TScene extends MinigameSessionScene,
  TResult,
> implements IGameSystem {
  protected assetManager!: AssetManager;
  protected renderer: Renderer | null = null;
  protected inputManager: InputManager | null = null;
  protected stateController: GameStateController | null = null;

  protected index: MinigameIndexEntry[] = [];
  private instanceCache = new Map<string, TInstance>();
  protected scene: TScene | null = null;
  private activeScopeId: string | null = null;
  protected active = false;
  protected prevState = GameState.Exploring;
  private unsubKey: (() => void) | null = null;
  private sessionResolve: ((result: TResult | null) => void) | null = null;
  protected lastResult: TResult | null = null;
  private onSessionEnd: (() => void) | null = null;
  /** start() 加载阶段（active 尚未置真）的并发守卫 */
  private startInFlight = false;
  /** destroy / teardown 时递增，作废仍停在 await 上的在途 start() */
  private sessionEpoch = 0;

  /** index JSON 的 URL（TEXT_URLS.*） */
  protected abstract readonly indexUrl: string;
  /** 实例 JSON 所在 `public/assets/data/` 子目录名 */
  protected abstract readonly dataSubdir: string;
  /** 资源 scope 前缀，如 `minigame:paperCraft` */
  protected abstract readonly scopePrefix: string;
  /** 告警文案前缀（console / F2 面板） */
  protected abstract readonly systemLabel: string;

  protected abstract buildInstanceManifestRefs(inst: TInstance): AssetRef[];
  protected abstract createScene(inst: TInstance): TScene;
  protected abstract loadSceneContent(scene: TScene, inst: TInstance): Promise<void>;
  protected abstract tickScene(scene: TScene, dt: number): void;

  // ---- 可选模板钩子 ----

  /** 实例数据校验；返回 false 则本次启动失败（已 resolve）。 */
  protected validateInstance(_inst: TInstance): boolean {
    return true;
  }

  /** 建场景前对实例做会话级加工（如挑水剔除已消费实体）。 */
  protected prepareInstance(inst: TInstance): TInstance {
    return inst;
  }

  /** active 置真后、场景创建前调用（如挑水挂空格桥接监听）。 */
  protected onSessionActive(_inst: TInstance): void {}

  /** 场景成功加载并上屏后调用（如挑水在此才登记每日配额）。 */
  protected onSceneLoaded(_inst: TInstance): void {}

  /** teardown 起始处调用（此时 active 已置假），用于子类清理会话级监听 / 计数。 */
  protected onTeardown(): void {}

  /** Esc 之外的会话按键扩展（动作播放锁已在外层挡掉）。 */
  protected onSessionKeyDown(_e: KeyboardEvent): void {}

  /** 子类若有额外运行时依赖（actionExecutor 等）在此追加判定。 */
  protected runtimeReady(): boolean {
    return !!(this.renderer && this.inputManager && this.stateController);
  }

  /** 告警通道；转盘子类改走 F2 调试面板。 */
  protected warnSession(msg: string, detail?: unknown): void {
    if (detail !== undefined) console.warn(`${this.systemLabel}: ${msg}`, detail);
    else console.warn(`${this.systemLabel}: ${msg}`);
  }

  // ---- IGameSystem ----

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
  }

  update(dt: number): void {
    if (!this.scene || !this.active) return;
    this.tickScene(this.scene, dt);
  }

  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {
    /* 默认无持久状态；需要的子类自行覆写 */
  }

  destroy(): void {
    this.sessionEpoch++;
    if (this.active) {
      // 会话中被整机拆除（HMR 等）：走完整 teardown，恢复 GameState 并通知 onSessionEnd
      this.teardownSession();
    } else {
      this.unsubKey?.();
      this.unsubKey = null;
      this.inputManager?.setGameKeyboardBlocked(false);
      this.releaseActiveScope();
      this.removeScene();
      this.resolveSession();
    }
    this.instanceCache.clear();
    this.index = [];
  }

  // ---- 公共会话 API ----

  setOnSessionEnd(fn: (() => void) | null): void {
    this.onSessionEnd = fn;
  }

  async loadIndex(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<MinigameIndexEntry[]>(this.indexUrl);
      this.index = Array.isArray(raw) ? raw : [];
    } catch (e) {
      this.warnSession('failed to load index', e);
      this.index = [];
    }
  }

  getInstanceList(): { id: string; label: string }[] {
    return this.index.map((e) => ({ id: e.id, label: e.label }));
  }

  /** 供外部动作链 await；退出（含启动失败）后 resolve。 */
  runUntilDone(id: string): Promise<TResult | null> {
    // B12：已在会话中（或另一局正在启动）时不得覆盖 sessionResolve——
    // 否则上一局的外层动作链永久悬挂。立即以失败结果 resolve 本次调用。
    if (this.active || this.startInFlight || this.sessionResolve) {
      this.warnSession(`已有小游戏会话进行中，忽略重复启动 "${id}"`);
      return Promise.resolve(null);
    }
    return new Promise<TResult | null>((resolve) => {
      this.sessionResolve = resolve;
      void this.start(id);
    });
  }

  async start(id: string): Promise<void> {
    if (!this.runtimeReady()) {
      this.warnSession('runtime not bound');
      this.resolveSession();
      return;
    }
    if (this.active || this.startInFlight) return;
    this.startInFlight = true;
    const epoch = this.sessionEpoch;
    try {
      const inst0 = await this.loadInstance(id);
      if (epoch !== this.sessionEpoch) {
        this.resolveSession();
        return;
      }
      if (!inst0) {
        this.warnSession(`unknown instance "${id}"`);
        this.resolveSession();
        return;
      }
      if (!this.validateInstance(inst0)) {
        this.resolveSession();
        return;
      }
      const inst = this.prepareInstance(inst0);

      const scopeId = `${this.scopePrefix}:${inst.id}`;
      await this.assetManager.preloadManifest(
        { scopeId, refs: this.buildInstanceManifestRefs(inst) },
        { mode: 'stage', tolerateErrors: true },
      );
      if (epoch !== this.sessionEpoch) {
        this.assetManager.releaseScope(scopeId);
        this.resolveSession();
        return;
      }
      this.activeScopeId = scopeId;

      this.prevState = this.stateController!.currentState;
      this.stateController!.setState(GameState.Minigame);
      this.inputManager!.setGameKeyboardBlocked(true);
      this.active = true;
      this.lastResult = null;
      this.onSessionActive(inst);

      this.unsubKey = this.inputManager!.subscribeKeyDown((e) => this.handleSessionKeyDown(e));

      const scene = this.createScene(inst);
      this.scene = scene;
      try {
        await this.loadSceneContent(scene, inst);
      } catch (e) {
        this.warnSession('scene load failed', e);
        this.teardownSession();
        return;
      }
      // 加载期间会话可能已被 destroy/teardown 拆掉（scene 已销毁），不再上屏
      if (epoch !== this.sessionEpoch || !this.active || this.scene !== scene) return;

      this.renderer!.cutsceneOverlay.addChild(scene.root);
      this.onSceneLoaded(inst);
    } finally {
      this.startInFlight = false;
    }
  }

  // ---- 内部 ----

  private handleSessionKeyDown(e: KeyboardEvent): void {
    if (!this.active || e.repeat) return;
    // B13：动作批播放中屏蔽会话快捷键（Esc 拆场延后到批结束之后再由玩家触发）
    if (this.scene?.isActionsPlaybackLocked?.()) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      this.scene?.abort();
      return;
    }
    this.onSessionKeyDown(e);
  }

  protected async loadInstance(id: string): Promise<TInstance | null> {
    const cached = this.instanceCache.get(id);
    if (cached) return cached;
    const entry = this.index.find((x) => x.id === id);
    if (!entry) return null;
    try {
      const path = dataSubdirJsonUrl(this.dataSubdir, entry.file);
      const data = await this.assetManager.loadJson<TInstance>(path);
      this.instanceCache.set(id, data);
      return data;
    } catch (e) {
      this.warnSession(`load instance failed (${id})`, e);
      return null;
    }
  }

  protected teardownSession(): void {
    if (!this.active) return;
    this.sessionEpoch++;
    this.active = false;
    this.onTeardown();

    this.unsubKey?.();
    this.unsubKey = null;
    this.inputManager?.setGameKeyboardBlocked(false);
    this.releaseActiveScope();
    this.removeScene();
    this.stateController?.setState(this.prevState);
    this.resolveSession();
    this.onSessionEnd?.();
  }

  /**
   * B13：动作批可能经 `dialogue:end` 等把状态打回 Exploring；
   * 批结束后若会话仍在，拉回 Minigame。以回调形式注入各场景的播放通道。
   */
  protected restoreMinigameStateAfterAction(): void {
    if (!this.active || !this.stateController) return;
    if (this.stateController.currentState !== GameState.Minigame) {
      this.stateController.setState(GameState.Minigame);
    }
  }

  private releaseActiveScope(): void {
    if (!this.activeScopeId) return;
    this.assetManager.releaseScope(this.activeScopeId);
    this.activeScopeId = null;
  }

  private removeScene(): void {
    if (!this.scene) return;
    if (this.scene.root.parent) {
      this.scene.root.parent.removeChild(this.scene.root);
    }
    this.scene.destroy();
    this.scene = null;
  }

  protected resolveSession(): void {
    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.(this.lastResult);
  }
}
