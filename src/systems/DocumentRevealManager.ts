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

type BlendFn = (
  id: string,
  fromPath: string,
  toPath: string,
  xPercent: number,
  yPercent: number,
  widthPercent: number,
  durationMs: number,
  delayMs: number,
) => Promise<void>;

/**
 * 文档模糊到清晰的揭示；配置来自 document_reveals.json，条件与图对话共用 evaluateConditionExpr。
 */
export class DocumentRevealManager implements IGameSystem {
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private questManager: QuestManager;
  private scenarioState: ScenarioStateManager;
  private defs = new Map<string, DocumentRevealDef>();
  private revealed = new Set<string>();
  private revealing = new Set<string>();
  private blend: BlendFn | null = null;
  private resolveConditionLiteral: ((raw: string) => string) | null = null;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  constructor(
    assetManager: AssetManager,
    eventBus: EventBus,
    flagStore: FlagStore,
    questManager: QuestManager,
    scenarioState: ScenarioStateManager,
  ) {
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.questManager = questManager;
    this.scenarioState = scenarioState;
  }

  /** 须在 Game.start 中于 CutsceneManager 就绪后注入 */
  setBlendExecutor(fn: BlendFn): void {
    this.blend = fn;
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
    // 注入的回调闭包持有 CutsceneManager/Game 侧引用，销毁时必须放掉
    this.blend = null;
    this.resolveConditionLiteral = null;
    this.conditionCtxFactory = null;
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

  private overlayIdFor(def: DocumentRevealDef): string {
    const o = def.overlayId?.trim();
    if (o) return o;
    const id = def.id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return `docReveal_${id}`;
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
   * 条件满足则叠化揭示；已揭示则立即返回。供 Action revealDocument / 对话 runActions 使用。
   */
  async checkAndReveal(documentId: string): Promise<void> {
    const id = documentId.trim();
    const def = this.defs.get(id);
    if (!def) {
      console.warn(`DocumentRevealManager: 未知 documentId ${id}`);
      return;
    }
    if (this.revealed.has(id)) return;
    // 重入守卫：blend 动画期间重复触发同一揭示会双跑叠化并重发 document:revealed；
    // 直接忽略后到的请求（下方 finally 保证集合最终会被清掉）。
    if (this.revealing.has(id)) return;
    if (!evaluateConditionExpr(def.revealCondition, this.ctx())) return;
    const blendFn = this.blend;
    if (!blendFn) {
      console.warn('DocumentRevealManager: blend 未注入');
      return;
    }

    const oid = this.overlayIdFor(def);
    const x = def.xPercent ?? 50;
    const y = def.yPercent ?? 50;
    const w = def.widthPercent ?? 40;
    const dur = def.animation?.durationMs ?? 2000;
    const delay = def.animation?.delayMs ?? 0;

    this.revealing.add(id);
    this.eventBus.emit('document:revealed', { documentId: id });
    try {
      await blendFn(
        oid,
        def.blurredImagePath,
        def.clearImagePath,
        x,
        y,
        w,
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
    const raw = data as { revealed?: unknown };
    if (!Array.isArray(raw.revealed)) return;
    for (const x of raw.revealed) {
      if (typeof x === 'string' && x.trim()) this.revealed.add(x.trim());
    }
  }
}
