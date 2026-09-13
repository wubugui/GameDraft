import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { FlagStore, FlagValue } from '../core/FlagStore';
import type {
  DocumentRevealDef,
  GameContext,
  IGameSystem,
} from '../data/types';
import type { QuestManager } from './QuestManager';
import type { ScenarioStateManager } from '../core/ScenarioStateManager';
import {
  evaluateConditionExpr,
  type ConditionEvalContext,
} from './graphDialogue/evaluateGraphCondition';
import { TEXT_URLS } from '../core/projectPaths';

export type DocumentRevealPhase = 'hidden' | 'blurred' | 'revealing' | 'revealed';

/**
 * 文档揭示自己的显示层。键是 **documentId**,与叠图动作(`showOverlayImage` 的 `id` 句柄)
 * 分属两张登记表、互不可见——作者永远不需要知道任何句柄,也不可能用 `hideOverlayImage`
 * 误收掉一份文档(2026-09-12 制作人定调:揭示只认揭示对象)。
 */
export interface DocumentLayerPresenter {
  /** 瞬时显示某张图(无动画) */
  show(
    documentId: string,
    imagePath: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
  ): Promise<void>;
  /** 揭示动画:模糊 → 清晰 */
  blend(
    documentId: string,
    fromPath: string,
    toPath: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
    durationMs: number,
    delayMs: number,
  ): Promise<void>;
  /** 收掉这份文档的显示层 */
  hide(documentId: string): void;
}

/**
 * 文档揭示。配置来自 document_reveals.json，条件与图对话共用 evaluateConditionExpr。
 *
 * **一个入口三态**（`revealDocument` 的全部语义，2026-09-12 制作人定调）：
 * 条件不满足 → 显示揭示前的图；条件满足且未揭示 → 播揭示动画（记档 / 写 flag / 响音效）；
 * 已揭示 → 瞬时显示揭示后的图（不重播、不响音效、不发事件）。`force` 只跳过条件判定。
 * 作者不需要、也不能用叠图动作参与其中——显示与收都走 documentId。
 */
export class DocumentRevealManager implements IGameSystem {
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private questManager: QuestManager;
  private scenarioState: ScenarioStateManager;
  private actionExecutor: ActionExecutor;
  private defs = new Map<string, DocumentRevealDef>();
  private revealed = new Set<string>();
  private revealing = new Set<string>();
  /** 已排期、尚未起播的揭示音效定时器；destroy / 读档必须清空（旧时间线不得发声） */
  private sfxTimers = new Set<ReturnType<typeof setTimeout>>();
  private presenter: DocumentLayerPresenter | null = null;
  private resolveConditionLiteral: ((raw: string) => string) | null = null;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  constructor(
    assetManager: AssetManager,
    eventBus: EventBus,
    flagStore: FlagStore,
    questManager: QuestManager,
    scenarioState: ScenarioStateManager,
    actionExecutor: ActionExecutor,
  ) {
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.questManager = questManager;
    this.scenarioState = scenarioState;
    this.actionExecutor = actionExecutor;
  }

  /** 须在 Game.start 中于 CutsceneManager 就绪后注入 */
  setLayerPresenter(presenter: DocumentLayerPresenter | null): void {
    this.presenter = presenter;
  }

  /** 与 UI 展示一致：Flag 条件 string 型 value 比较前解析 [tag:…]（须与 wireTextResolve 同步） */
  setResolveConditionLiteral(fn: ((raw: string) => string) | null): void {
    this.resolveConditionLiteral = fn;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  async loadDefinitions(): Promise<void> {
    this.defs.clear();
    try {
      const list = await this.assetManager.loadJson<DocumentRevealDef[]>(TEXT_URLS.documentReveals);
      if (!Array.isArray(list)) return;
      for (const d of list) {
        if (d && typeof d.id === 'string' && d.id.trim()) {
          this.defs.set(d.id.trim(), d);
        }
      }
    } catch (e) {
      console.warn('DocumentRevealManager: 无法加载 document_reveals.json', e);
    }
  }

  init(_ctx: GameContext): void {}

  update(_dt: number): void {}

  destroy(): void {
    this.defs.clear();
    this.revealed.clear();
    this.revealing.clear();
    this.clearPendingSfx();
    // 注入的回调闭包持有 CutsceneManager/Game 侧引用，销毁时必须放掉
    this.presenter = null;
    this.resolveConditionLiteral = null;
    this.conditionCtxFactory = null;
  }

  private clearPendingSfx(): void {
    for (const t of this.sfxTimers) clearTimeout(t);
    this.sfxTimers.clear();
  }

  /**
   * 揭示音效：与叠化同时起播（等过 delayMs），走统一动作通道 playSfx——
   * 因此过场内触发的揭示音效同样受过场 SFX 捕获管辖（过场收尾统一停，不留尾音）。
   * 不阻塞叠化：调用方不等待本方法。
   */
  private scheduleRevealSfx(def: DocumentRevealDef, delayMs: number): void {
    const sfxId = def.revealSfx?.trim();
    if (!sfxId) return;
    const params: Record<string, unknown> = { id: sfxId };
    const vol = def.revealSfxVolume;
    if (typeof vol === 'number' && Number.isFinite(vol)) params.volume = vol;
    const fire = (): void => {
      // fire-and-forget 但必须封口：playSfx 自身不阻塞叠化，失败只留痕不影响揭示。
      void this.actionExecutor
        .executeAwait({ type: 'playSfx', params })
        .catch((e) => console.warn(`DocumentRevealManager: reveal sfx ${sfxId} failed`, e));
    };
    if (!(delayMs > 0)) {
      fire();
      return;
    }
    const timer = setTimeout(() => {
      this.sfxTimers.delete(timer);
      fire();
    }, delayMs);
    this.sfxTimers.add(timer);
  }

  private ctx(): ConditionEvalContext {
    const injected = this.conditionCtxFactory?.();
    if (injected) return injected;
    const base: ConditionEvalContext = {
      flagStore: this.flagStore,
      questManager: this.questManager,
      scenarioState: this.scenarioState,
    };
    if (this.resolveConditionLiteral) {
      base.resolveConditionLiteral = this.resolveConditionLiteral;
    }
    return base;
  }

  getDocumentPhase(documentId: string): DocumentRevealPhase {
    const id = documentId.trim();
    if (!id || !this.defs.has(id)) return 'hidden';
    if (this.revealed.has(id)) return 'revealed';
    if (this.revealing.has(id)) return 'revealing';
    return 'blurred';
  }

  getDisplayImage(documentId: string): string | undefined {
    const id = documentId.trim();
    const def = this.defs.get(id);
    if (!def) return undefined;
    return this.revealed.has(id) ? def.clearImagePath : def.blurredImagePath;
  }

  isRevealed(documentId: string): boolean {
    return this.revealed.has(documentId.trim());
  }

  /**
   * 显示这份文档：条件不满足显示揭示前的图，该揭示未揭示则播揭示动画，已揭示直接显示清晰图。
   * 供 Action revealDocument / 对话 runActions 使用。
   *
   * @param opts.force 跳过 `revealCondition` 直接揭示；**不**让已揭示的重播动画。
   */
  async checkAndReveal(documentId: string, opts?: { force?: boolean }): Promise<void> {
    const id = documentId.trim();
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`DocumentRevealManager: 未知 documentId ${id}`);
      return;
    }
    const presenter = this.presenter;
    if (!presenter) {
      console.warn('DocumentRevealManager: 显示层未注入');
      return;
    }
    const px = def.xPercent ?? 50;
    const py = def.yPercent ?? 50;
    const pw = def.widthPercent ?? 40;

    // 已揭示：瞬时显示揭示后的图。不叠化、不响音效、不发 document:revealed
    // ——这三样只属于「真的在播那一次动画」。
    if (this.revealed.has(id)) {
      await presenter.show(id, def.clearImagePath, px, py, pw);
      return;
    }
    // 重入守卫：blend 动画期间重复触发同一揭示会双跑叠化并重发 document:revealed；
    // 直接忽略后到的请求（下方 finally 保证集合最终会被清掉）。
    if (this.revealing.has(id)) return;
    // 条件不满足：显示揭示前的图，不记档、不写 flag、不响音效、不发事件。
    // 这一档必须**出图**——早期实现在这里直接 return，于是"没到条件"和"没配这条"
    // 在画面上都是一片空白，作者无从分辨。
    if (opts?.force !== true && !evaluateConditionExpr(def.revealCondition, this.ctx())) {
      await presenter.show(id, def.blurredImagePath, px, py, pw);
      return;
    }

    const dur = def.animation?.durationMs ?? 2000;
    const delay = def.animation?.delayMs ?? 0;

    this.revealing.add(id);
    // customSfx：本条自带揭示音效（revealSfx）时置真，AudioManager 据此跳过全局默认揭示音
    // （systemSfx.documentReveal），否则两条声音会叠着响。
    const hasCustomSfx = !!def.revealSfx?.trim();
    this.eventBus.emit('document:revealed', { documentId: id, customSfx: hasCustomSfx });
    this.scheduleRevealSfx(def, delay);
    try {
      await presenter.blend(
        id,
        def.blurredImagePath,
        def.clearImagePath,
        px,
        py,
        pw,
        dur,
        delay,
      );
      this.revealed.add(id);
      const rf = def.revealedFlag?.trim();
      if (rf) this.flagStore.set(rf, true as FlagValue);
    } catch (e) {
      console.warn(`DocumentRevealManager: reveal ${id} failed`, e);
    } finally {
      this.revealing.delete(id);
    }
  }

  /**
   * 收掉这份文档的显示层。只动显示，不碰「已揭示」状态——收掉之后再
   * `revealDocument` 会直接显示揭示后的图。
   */
  hideDocument(documentId: string): void {
    const id = documentId.trim();
    if (!id) return;
    if (!this.defs.has(id)) {
      console.warn(`DocumentRevealManager: 未知 documentId ${id}`);
      return;
    }
    this.presenter?.hide(id);
  }

  /** 供 Debug 面板只读展示（含运行时阶段，非存档形状） */
  debugSnapshot(): object {
    const phaseByDefId: Record<string, DocumentRevealPhase> = {};
    for (const id of this.defs.keys()) {
      phaseByDefId[id] = this.getDocumentPhase(id);
    }
    return {
      revealedInSave: [...this.revealed],
      revealingTransient: [...this.revealing],
      phaseByDefId,
    };
  }

  serialize(): object {
    return { revealed: [...this.revealed] };
  }

  deserialize(data: object): void {
    this.revealed.clear();
    this.revealing.clear();
    // 读档＝新时间线：上一条时间线排期的揭示音效不得在新档里响
    this.clearPendingSfx();
    const raw = data as { revealed?: unknown };
    if (!Array.isArray(raw.revealed)) return;
    for (const x of raw.revealed) {
      if (typeof x === 'string' && x.trim()) this.revealed.add(x.trim());
    }
  }
}
