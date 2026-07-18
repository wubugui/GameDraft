import type { EventBus } from '../core/EventBus';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { ActionDef, ConditionExpr, GameContext, IGameSystem } from '../data/types';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';

/**
 * 章节导演清单行（narrative_packages.json）。电影摄制模型：
 * - package 行：`when ∧ ¬done` 成立时「开拍」（置包 live + 执行 autoPlay）；`done` 成立时「收工」（置 dormant）。
 * - cue 行（无 package）：纯进场编排（如梦境开场），只在进场时机执行 autoPlay；必须带 scene（进场闩锁防重放）。
 * when/done 走现成条件语言（evaluateGraphCondition 全家福）——状态永存直接查询，不发明判据词汇。
 */
export interface NarrativePackageRow {
  id: string;
  /** 章节包名（编排 package 标）；缺省=cue 行（只编排不装卸） */
  package?: string;
  /** 进此场景的揭幕时机评估本行（cue 行必填；package 行可省=任何状态变化时评估） */
  scene?: string;
  /** 开拍条件（空=恒真） */
  when?: ConditionExpr[];
  /** 开拍动作（起对话/过场等；经 ActionExecutor 串行执行） */
  autoPlay?: ActionDef;
  /** 收工判据（空=不自动收工；cue 行的空 done=每次进场重放，忠实于旧 onEnter 语义） */
  done?: ConditionExpr[];
}

interface NarrativePackagesFile {
  packages?: NarrativePackageRow[];
}

/** 章节包 live/dormant 的窄控制口（Game 组装层注入 NarrativeStateManager 对应方法）。 */
export interface NarrativePackageControl {
  setNarrativePackageLive(packageId: string, live: boolean): Promise<void>;
  isNarrativePackageLive(packageId: string): boolean;
}

/**
 * 叙事章节导演：按清单在世界事件（scene:revealed / narrative:stateChanged）上评估开拍/收工。
 * 单向依赖：导演看世界与叙事记录；场景/时钟对导演零知识。自身无状态（live 集在叙事档、
 * done 可重查）——序列化空对象，延续镜像哲学。
 */
export class NarrativePackageDirector implements IGameSystem {
  private eventBus: EventBus;
  private actionExecutor: ActionExecutor;
  private control: NarrativePackageControl | null = null;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private assetManager!: AssetManager;
  private rows: NarrativePackageRow[] = [];
  private currentSceneId: string = '';
  private restoring: boolean = false;
  /** autoPlay 串行尾链：与 QuestManager 同款，防开拍演出与它处异步交错 */
  private playTail: Promise<void> = Promise.resolve();
  private onSceneRevealed: (p: { sceneId: string }) => void;
  private onStateChanged: () => void;

  constructor(eventBus: EventBus, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.actionExecutor = actionExecutor;
    this.onSceneRevealed = (p) => {
      this.currentSceneId = String(p?.sceneId ?? '').trim();
      if (!this.restoring) this.evaluate('sceneEntry');
    };
    this.onStateChanged = () => {
      if (!this.restoring) this.evaluate('stateTick');
    };
  }

  setControl(control: NarrativePackageControl | null): void {
    this.control = control;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  /** 由 Game 在分发存档前后调用（与 QuestManager 同款）：抑制半态评估；恢复完成后跑一轮收工清扫。 */
  setRestoring(v: boolean): void {
    this.restoring = v;
    if (!v) this.evaluate('stateTick'); // 旧档在新清单下可能有该收工的包；stateTick 不触发 cue 行，无重放风险
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.eventBus.on('scene:revealed', this.onSceneRevealed);
    this.eventBus.on('narrative:stateChanged', this.onStateChanged);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const file = await this.assetManager.loadJson<NarrativePackagesFile>(TEXT_URLS.narrativePackages);
      this.rows = (Array.isArray(file?.packages) ? file.packages : []).filter(
        (row): row is NarrativePackageRow => Boolean(row && typeof row === 'object' && typeof row.id === 'string'),
      );
    } catch {
      this.rows = []; // 清单缺省=没有导演编排，游戏照常（数据门警告由 validator 负责）
    }
  }

  private conditionsMet(conds: ConditionExpr[] | undefined): boolean {
    if (!conds?.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (!ctx) return false; // 工厂未注入时保守不开拍（装配期防误触发）
    return evaluateConditionExprList(conds, ctx);
  }

  /**
   * 评估清单。trigger='sceneEntry'：本场景的 scene 行参与开拍评估（进场闩锁）；
   * trigger='stateTick'：仅无 scene 的 package 行参与开拍。收工清扫两种触发都跑。
   */
  private evaluate(trigger: 'sceneEntry' | 'stateTick'): void {
    if (!this.control) return;
    for (const row of this.rows) {
      const pkg = String(row.package ?? '').trim();
      // 收工：live 包且 done 成立 → dormant（与开拍互斥判定，先收工再看是否别行要开拍）
      if (pkg && row.done?.length && this.control.isNarrativePackageLive(pkg) && this.conditionsMet(row.done)) {
        void this.control.setNarrativePackageLive(pkg, false);
        continue;
      }
      // 开拍评估门：scene 行只在进本场景那一拍；无 scene 行只在 stateTick（cue 行必有 scene，validator 拦）
      const sceneRow = Boolean(String(row.scene ?? '').trim());
      if (sceneRow && (trigger !== 'sceneEntry' || String(row.scene).trim() !== this.currentSceneId)) continue;
      if (!sceneRow && trigger !== 'stateTick') continue;
      if (pkg && this.control.isNarrativePackageLive(pkg)) continue;       // 已开拍（live 即闩锁）
      if (row.done?.length && this.conditionsMet(row.done)) continue;      // 已永远完成，不重拍
      if (!this.conditionsMet(row.when)) continue;
      this.beginShoot(row, pkg);
    }
  }

  /** 开拍：置包 live（走叙事队列）后串行执行 autoPlay。 */
  private beginShoot(row: NarrativePackageRow, pkg: string): void {
    const task = async (): Promise<void> => {
      try {
        if (pkg) await this.control?.setNarrativePackageLive(pkg, true);
        if (row.autoPlay) await this.actionExecutor.executeBatchAwait([row.autoPlay]);
      } catch (e) {
        console.warn(`NarrativePackageDirector: 开拍失败（${row.id}）`, e);
      }
    };
    this.playTail = this.playTail.then(task, task);
  }

  serialize(): object {
    return {}; // 无独立状态：live 集在叙事档、done 由记录重查、currentScene 由世界事件重建
  }

  deserialize(_data: object): void {}

  destroy(): void {
    this.eventBus.off('scene:revealed', this.onSceneRevealed);
    this.eventBus.off('narrative:stateChanged', this.onStateChanged);
    this.rows = [];
    this.currentSceneId = '';
    this.restoring = false;
    this.control = null;
    this.playTail = Promise.resolve();
  }
}
