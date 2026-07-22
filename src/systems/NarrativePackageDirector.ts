import type { EventBus } from '../core/EventBus';
import type { AssetManager } from '../core/AssetManager';
import type { ConditionExpr, GameContext, IGameSystem } from '../data/types';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';

/**
 * 章节导演清单行（narrative_packages.json）。导演按里程碑/场景维护"当前活跃是哪些章节"这个
 * **纯组织标记**（livePackages），**既不触发演出、也不 gate 任何运行时行为**（2026-07-19 降级定案）：
 * - "进场演哪场戏"由策划在场景 `onEnter → startDialogueGraph 入口路由图` 里用图对话 switch 拍板；
 * - 图恒吃信号/恒跑 reactive，与章节被标活跃/非活跃无关（证据：无跨图信号串扰 + from-state 门 +
 *   无懒加载。见 NarrativeStateManager.listScannableGraphEntries）。
 *
 * 所以本导演的产物是"章节感知的组织/工具信息"（供 UI/编辑器/模拟器展示当前章节），非运行时必需机制。
 * 行语义：`when ∧ ¬done` 成立 → 标章节活跃；`done` 成立 → 标非活跃。when/done 走现成条件语言。
 * - 里程碑驱动行（无 scene）：在 narrative:stateChanged 上评估。
 * - 场景驱动行（有 scene）：进该场景时标活跃，其 done 达成时标非活跃。
 */
export interface NarrativePackageRow {
  id: string;
  /** 章节包名（编排 package 标，纯组织标签）——必配：清单是章节活跃度声明，无包的行无意义 */
  package?: string;
  /** 进此场景时标该章节活跃（场景驱动行）；缺省=里程碑驱动，在任何叙事状态变化时按 when/done 评估 */
  scene?: string;
  /** 标活跃条件（空=恒真，即只要没 done 就标活跃） */
  when?: ConditionExpr[];
  /** 标非活跃判据（空=不自动转非活跃，一直标活跃——validator 对无 done 的包行告警；纯组织标记，不影响行为） */
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
 * 叙事章节导演：按清单在世界事件（scene:revealed / narrative:stateChanged）上评估、维护"当前活跃章节"
 * 组织标记。**不触发演出、不 gate 行为**——仅产出章节感知的组织/工具信息（见清单行注释）。单向依赖：
 * 导演看世界与叙事记录；场景对导演零知识。自身无状态（活跃标记集在叙事档、done 可重查）——序列化空对象。
 */
export class NarrativePackageDirector implements IGameSystem {
  private eventBus: EventBus;
  private control: NarrativePackageControl | null = null;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private assetManager!: AssetManager;
  private rows: NarrativePackageRow[] = [];
  private currentSceneId: string = '';
  private restoring: boolean = false;
  private onSceneRevealed: (p: { sceneId: string }) => void;
  private onStateChanged: () => void;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
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

  /** 由 Game 在分发存档前后调用（与 QuestManager 同款）：抑制半态评估；恢复完成后跑一轮装卸清扫。 */
  setRestoring(v: boolean): void {
    this.restoring = v;
    if (!v) this.evaluate('stateTick'); // 旧档在新清单下按里程碑重算 live 集
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
      this.rows = []; // 清单缺省=没有章节包编排，游戏照常（数据门警告由 validator 负责）
    }
  }

  private conditionsMet(conds: ConditionExpr[] | undefined): boolean {
    if (!conds?.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (!ctx) return false; // 工厂未注入时保守不载（装配期防误载）
    return evaluateConditionExprList(conds, ctx);
  }

  /**
   * 评估清单。每行：done 成立 → 卸（dormant）；否则 when∧¬done ∧（场景匹配或里程碑驱动）→ 载（live）。
   * trigger='sceneEntry'：本场景的 scene 行参与载入；trigger='stateTick'：无 scene 的里程碑驱动行参与载入。
   * 卸载（收工）两种触发都跑，保证越过窗口的包及时 dormant。
   */
  private evaluate(trigger: 'sceneEntry' | 'stateTick'): void {
    if (!this.control) return;
    for (const row of this.rows) {
      const pkg = String(row.package ?? '').trim();
      if (!pkg) continue; // 无包行无意义（导演只管包）；validator 已拦
      // 收工：live 包且 done 成立 → dormant
      if (row.done?.length && this.control.isNarrativePackageLive(pkg) && this.conditionsMet(row.done)) {
        void this.control.setNarrativePackageLive(pkg, false);
        continue;
      }
      // 载入评估门：scene 行只在进本场景那一拍；无 scene 行（里程碑驱动）只在 stateTick
      const sceneRow = Boolean(String(row.scene ?? '').trim());
      if (sceneRow && (trigger !== 'sceneEntry' || String(row.scene).trim() !== this.currentSceneId)) continue;
      if (!sceneRow && trigger !== 'stateTick') continue;
      if (this.control.isNarrativePackageLive(pkg)) continue;         // 已 live
      if (row.done?.length && this.conditionsMet(row.done)) continue; // 已收工，不重载
      if (!this.conditionsMet(row.when)) continue;
      void this.control.setNarrativePackageLive(pkg, true);
    }
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
  }
}
